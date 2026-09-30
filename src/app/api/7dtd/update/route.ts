import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";
import { patchServiceEnv, readCompose, writeCompose } from "@/lib/compose";
import { containerIsRunning, recreateService } from "@/lib/game-manager";
import { CoResidencyError, refuseCoResidency } from "@/lib/coresidency";
import { POWER_RESOURCES, runOperation } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";

// A Vercel-only hint: this deployment runs `node server.js`, so it does nothing here.
// The real cap is Cloudflare's ~100s origin read timeout. Left as documentation of
// intent; the operation registry is what actually survives the response being lost.
export const maxDuration = 300;

const execAsync = promisify(exec);
const CONTAINER = "yoshling-7dtd";
const APPID = "294420";
const APPMANIFEST = "/sevendtd-config/steamapps/appmanifest_294420.acf";

async function installedBuildId(): Promise<string | null> {
  try {
    const txt = await import("fs/promises").then((m) => m.readFile(APPMANIFEST, "utf-8"));
    return txt.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function branchInfo(branch: string): Promise<{ buildid: string | null }> {
  try {
    const res = await fetch(`https://api.steamcmd.net/v1/info/${APPID}`, { cache: "no-store" });
    const data = await res.json();
    const b = data?.data?.[APPID]?.depots?.branches?.[branch];
    return { buildid: b?.buildid ?? null };
  } catch {
    return { buildid: null };
  }
}

async function containerEnv(name: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execAsync(`docker inspect --format '{{json .Config.Env}}' ${name}`);
    const arr: string[] = JSON.parse(stdout.trim());
    const env: Record<string, string> = {};
    for (const e of arr) {
      const i = e.indexOf("=");
      if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
    }
    return env;
  } catch {
    return {};
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;

  const env = await containerEnv(CONTAINER);
  const branch = env.VERSION || "latest_experimental";
  const [installed, latest] = await Promise.all([installedBuildId(), branchInfo(branch)]);
  return NextResponse.json({
    branch,
    installedBuildId: installed,
    latestBuildId: latest.buildid,
    updateAvailable: !!(installed && latest.buildid && installed !== latest.buildid),
  });
}

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  // `server.update`: re-downloads the game build via SteamCMD and recreates the
  // container. Was a bare `role !== "ADMIN"`, which withheld the documented fix for
  // the #1 "stuck at Starting game" cause (client/server build mismatch) from the
  // MOD looking after this world — see docs/7-DAYS-TO-DIE.md.
  if (!hasPermission(session.user.role, "server.update")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    /**
     * This is the operation the whole ledger exists for.
     *
     * It was completely untracked: it called `recreateService()` directly, which takes
     * no lock and enters no record, so a ~17 GB SteamCMD download ran inside the
     * container for twenty minutes with nothing watching it and nothing refusing to
     * interleave — `powerOn("zomboid")` would cheerfully stop 7DTD mid-download. The
     * only feedback was `toast.success("Update started")`, gone in four seconds.
     *
     * Note what the operation can honestly claim: it proves the container was
     * recreated with `START_MODE=3`, which means the update was *requested*. The
     * installed build id cannot change until the download finishes, so a `warn` fact
     * is the truthful verdict and the synthetic boot operation carries the next twenty
     * minutes from the container's own log.
     */
    const result = await runOperation(
      {
        kind: "game.update",
        game: "7dtd",
        title: "Updating 7 Days to Die",
        resources: POWER_RESOURCES,
        startedBy: session.user.name ? { name: session.user.name } : null,
      },
      async (op) => {
        const [installedBefore] = await Promise.all([installedBuildId()]);

        /**
         * Refuse before touching anything if another world holds the box.
         *
         * `recreateService("7dtd", { start: true })` below **starts the container** —
         * that is how `START_MODE=3` gets to run SteamCMD. So this route was a start
         * path that never evicted: run it while Project Zomboid was up and the box had
         * two worlds on it, with a green "Update requested" and nothing anywhere saying
         * so. `POWER_RESOURCES` serialised it; serialising is not evicting.
         *
         * It **refuses** rather than evicting, and that asymmetry with `powerOn` is
         * deliberate. `powerOn` evicts because the user pressed Power on after a dialog
         * that named the world going down. Nobody pressing "Update" consented to
         * stopping someone else's game, and doing it anyway would be this codebase's
         * signature defect — a destructive action reported as a success — wearing a
         * fix's clothes. See `admitStart`'s `mayEvict` in `lib/coresidency.ts`.
         *
         * Inside the operation, not before it, so the refusal is recorded in the ledger
         * with the blocker named instead of vanishing into a 4-second toast. It runs
         * after admission, which is safe here precisely because admission holds
         * `POWER_RESOURCES`: no app path can start a world between this check and the
         * recreate. The remaining case is an out-of-band `docker start`, which is what
         * caused the 2026-09-26 overlap and is what the reporting side is for.
         */
        op.step("Checking the box has room");
        try {
          await refuseCoResidency("7dtd", containerIsRunning, "The update");
        } catch (e) {
          if (e instanceof CoResidencyError) {
            op.reject(
              `${e.running.length > 1 ? "Other worlds are" : "Another world is"} running — ` +
                `the update was not started`
            );
            op.fact({ label: "Power", value: "another world is running", verdict: "warn" });
          }
          throw e;
        }
        op.settle("Nothing else is running");

        op.step("Saving the world");
        // Best-effort: the server may not be up, and that is not a reason to refuse.
        let saved = false;
        try {
          const { sdtdSaveWorld } = await import("@/lib/telnet");
          await sdtdSaveWorld();
          saved = true;
        } catch {}
        op.settle(saved ? "Saved the world" : "No running server to save", {
          kind: saved ? "done" : "noop",
        });

        // START_MODE=3 is "update, then start". It's a one-shot: flip it in compose,
        // recreate through compose so the container keeps its labels, network alias
        // and mounts, then flip it back so the NEXT recreate is a normal start.
        //
        // This used to `docker rm -f` and hand-build a `docker run`, which produced a
        // container with no compose labels — the next `docker compose up` couldn't
        // adopt it, and the hardcoded volume/port list silently drifted from compose
        // (that's how the `sevendtd` network alias went missing once before).
        op.step("Requesting the update");
        const before = await readCompose();
        const version =
          /VERSION:\s*"?([^"\n]+)"?/
            .exec(before.slice(before.indexOf("  sevendtd:")))?.[1]
            ?.trim() ?? "latest_experimental";

        const up = patchServiceEnv(before, "sevendtd", { START_MODE: "3" });
        if (up.applied.length === 0) {
          throw new Error("Couldn't find START_MODE in the sevendtd service");
        }
        await writeCompose(up.text);

        try {
          await recreateService("7dtd", { start: true });
        } finally {
          // Always put it back, even if the recreate failed, so a later start isn't
          // stuck re-running the ~17GB update.
          await writeCompose(
            patchServiceEnv(await readCompose(), "sevendtd", { START_MODE: "1" }).text
          );
        }

        const latest = await branchInfo(version);
        const target = latest.buildid;
        op.settle(
          target && installedBefore
            ? `Requested the update — build ${installedBefore} → ${target}, downloading`
            : "Requested the update — SteamCMD is downloading"
        );
        op.detail("the download runs inside the container; watch the boot progress");

        // Amber by construction. All we proved is that we asked.
        op.fact({
          label: "Build",
          value:
            target && installedBefore
              ? `${installedBefore} → ${target} (downloading)`
              : "downloading",
          verdict: "warn",
        });
        op.fact({ label: "Branch", value: version });
        return { value: { version, from: installedBefore, to: target } };
      }
    );

    await db.activity
      .create({ data: { userId: session.user.id, action: "server_update", details: JSON.stringify({ game: "7dtd", branch: result.version }) } })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      message:
        "Update requested — the server is downloading the new build. Watch the strip at the top of the page.",
    });
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    // 409, not 500: nothing broke. Another world holds the box, the request was refused
    // before anything was touched, and the fix is an action the caller can take — which
    // is the same shape as every other conflict this app answers with 409.
    if (e instanceof CoResidencyError) {
      return NextResponse.json(
        { error: e.message, conflict: "coresidency", running: e.running },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: (e as Error).message || "Update failed" }, { status: 500 });
  }
}
