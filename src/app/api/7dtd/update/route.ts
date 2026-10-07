import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";
import { patchServiceEnv, readCompose, readServiceEnv, writeCompose } from "@/lib/compose";
import { gameContainerState, recreateService, startGameForOperation, stopGameForOperation } from "@/lib/game-manager";
import { CoResidencyError } from "@/lib/coresidency";
import { otherGames, GAMES, type GameId } from "@/lib/games";
import { claimOperationPower, runOperation } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { gameDataPath } from "@/lib/game-data-path";

// A Vercel-only hint: this deployment runs `node server.js`, so it does nothing here.
// The real cap is Cloudflare's ~100s origin read timeout. Left as documentation of
// intent; the operation registry is what actually survives the response being lost.
export const maxDuration = 300;

const execAsync = promisify(exec);
const CONTAINER = "yoshling-7dtd";
const APPID = "294420";
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";
const stoppedStates = new Set(["exited", "created", "missing"]);

async function refuseRunningPeers(): Promise<void> {
  const running: GameId[] = [];
  for (const game of otherGames("7dtd")) {
    if (!stoppedStates.has(await gameContainerState(game))) running.push(game);
  }
  if (running.length) {
    throw new CoResidencyError(
      `${running.map((game) => GAMES[game].name).join(" and ")} ${running.length > 1 ? "are" : "is"} active, so the update cannot start 7 Days to Die. Use Power on to switch servers.`,
      running
    );
  }
}

async function installedBuildId(): Promise<string | null> {
  try {
    const file = await gameDataPath(CONFIG_DIR, "steamapps/appmanifest_294420.acf");
    const txt = await import("fs/promises").then((m) => m.readFile(file, "utf-8"));
    return txt.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function branchInfo(branch: string): Promise<{ buildid: string | null; error: string | null }> {
  try {
    const resolved = branch === "stable" ? "public" : branch;
    const res = await fetch(`https://api.steamcmd.net/v1/info/${APPID}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Steam lookup returned ${res.status}`);
    const data = await res.json();
    const build = data?.data?.[APPID]?.depots?.branches?.[resolved]?.buildid;
    if ((typeof build !== "string" && typeof build !== "number") || !/^\d+$/.test(String(build))) {
      throw new Error("Steam did not report a valid build for the configured branch");
    }
    return { buildid: String(build), error: null };
  } catch {
    return { buildid: null, error: "The latest Steam build could not be checked" };
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

  // The created container may still carry the previous branch after a Compose edit.
  // The explicit update action targets the configured branch, so its lookup must too.
  let branch: string | null = null;
  try { branch = readServiceEnv(await readCompose(), "sevendtd", "VERSION"); } catch {}
  const [installed, latest] = await Promise.all([installedBuildId(), branch
    ? branchInfo(branch) : Promise.resolve({ buildid: null, error: "The configured Steam branch could not be read" })]);
  const checked = Boolean(installed && latest.buildid);
  return NextResponse.json({
    branch,
    resolvedBranch: branch === "stable" ? "public" : branch,
    installedBuildId: installed,
    latestBuildId: latest.buildid,
    updateAvailable: checked ? installed !== latest.buildid : null,
    lookupStatus: checked ? "checked" : "unknown",
    checkError: latest.error || (!installed ? "The installed Steam build could not be read" : null),
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
    // Says why. `sdtd-maintenance.tsx` toasts `data.error` verbatim, and the config routes
    // one directory over already carry this note: a bare "Forbidden" is how the power-button
    // gate got reported as a bug before it explained itself.
    return NextResponse.json(
      { error: "Re-downloading the game build needs the admin or moderator role." },
      { status: 403 }
    );
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
        resources: ["files:7dtd"],
        startedBy: session.user.name ? { name: session.user.name } : null,
      },
      async (op) => {
        const [installedBefore] = await Promise.all([installedBuildId()]);

        // Updates never evict another world. Plan under the target file lane,
        // then claim power and repeat strict state checks before saving/stopping.
        // An unavailable state is not evidence that the host or target is stopped.
        op.step("Checking the box has room");
        try {
          await refuseRunningPeers();
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

        const preflightState = await gameContainerState("7dtd");
        if (preflightState !== "running" && !stoppedStates.has(preflightState)) {
          throw new Error(`Cannot update 7 Days to Die while its container is ${preflightState}.`);
        }
        claimOperationPower(op);
        await refuseRunningPeers();
        const initialState = await gameContainerState("7dtd");
        if (initialState !== "running" && !stoppedStates.has(initialState)) {
          throw new Error(`Cannot update 7 Days to Die while its container is ${initialState}.`);
        }
        if (initialState === "running") await stopGameForOperation(op, "7dtd");
        if (!stoppedStates.has(await gameContainerState("7dtd"))) {
          throw new Error("7 Days to Die was not verified stopped; its update configuration was not changed.");
        }

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
        const version = readServiceEnv(before, "sevendtd", "VERSION");
        if (!version) throw new Error("The configured 7 Days to Die Steam branch could not be read");

        const up = patchServiceEnv(before, "sevendtd", { START_MODE: "3" });
        if (up.applied.length === 0) {
          throw new Error("Couldn't find START_MODE in the sevendtd service");
        }
        try {
          await writeCompose(up.text);
          if (readServiceEnv(await readCompose(), "sevendtd", "START_MODE") !== "3") {
            throw new Error("The update mode could not be read back from compose; no container was recreated.");
          }
          if (!stoppedStates.has(await gameContainerState("7dtd"))) {
            throw new Error("7 Days to Die came up before recreation; its container was not replaced.");
          }
          await recreateService("7dtd", { start: false });
          if (!stoppedStates.has(await gameContainerState("7dtd"))) {
            throw new Error("The recreated update container was not verified stopped.");
          }
          if ((await containerEnv(CONTAINER)).START_MODE !== "3") {
            throw new Error("The recreated container does not report START_MODE=3; the update was not started.");
          }
          op.settle("Prepared the stopped container with update mode 3");
          await refuseRunningPeers();
          await startGameForOperation(op, "7dtd");
        } finally {
          // Always put it back, even if the recreate failed, so a later start isn't
          // stuck re-running the ~17GB update.
          const normal = patchServiceEnv(await readCompose(), "sevendtd", { START_MODE: "1" });
          if (!normal.applied.length) throw new Error("Could not restore START_MODE=1 in compose");
          await writeCompose(normal.text);
          if (readServiceEnv(await readCompose(), "sevendtd", "START_MODE") !== "1") {
            throw new Error("START_MODE=1 could not be verified after requesting the update");
          }
        }

        op.step("Reading the requested build");
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
        if (await gameContainerState("7dtd") !== "running") {
          op.fact({ label: "Power", value: "powered off", verdict: "bad" });
          throw new Error("7 Days to Die was observed powered off after the update request; the download could not be confirmed running.");
        }
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
    // Another world owns the host. A late refusal can follow stopped-container
    // preparation, so the error promises only that the update was not started.
    if (e instanceof CoResidencyError) {
      return NextResponse.json(
        { error: e.message, conflict: "coresidency", running: e.running },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: (e as Error).message || "Update failed" }, { status: 500 });
  }
}
