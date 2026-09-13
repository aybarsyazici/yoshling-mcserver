import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { exec } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";
import { patchServiceEnv, readCompose, writeCompose } from "@/lib/compose";
import { recreateService } from "@/lib/game-manager";

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
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  try {
    // Save the world first if it's up (best-effort).
    try {
      const { sdtdSaveWorld } = await import("@/lib/telnet");
      await sdtdSaveWorld();
    } catch {}

    // START_MODE=3 is "update, then start". It's a one-shot: flip it in compose,
    // recreate through compose so the container keeps its labels, network alias
    // and mounts, then flip it back so the NEXT recreate is a normal start.
    //
    // This used to `docker rm -f` and hand-build a `docker run`, which produced a
    // container with no compose labels — the next `docker compose up` couldn't
    // adopt it, and the hardcoded volume/port list silently drifted from compose
    // (that's how the `sevendtd` network alias went missing once before).
    const before = await readCompose();
    const version = /VERSION:\s*"?([^"\n]+)"?/.exec(
      before.slice(before.indexOf("  sevendtd:"))
    )?.[1]?.trim() ?? "latest_experimental";

    const up = patchServiceEnv(before, "sevendtd", { START_MODE: "3" });
    if (up.applied.length === 0) {
      return NextResponse.json(
        { error: "Couldn't find START_MODE in the sevendtd service" },
        { status: 500 }
      );
    }
    await writeCompose(up.text);

    try {
      await recreateService("7dtd", { start: true });
    } finally {
      // Always put it back, even if the recreate failed, so a later start isn't
      // stuck re-running the ~17GB update.
      await writeCompose(patchServiceEnv(await readCompose(), "sevendtd", { START_MODE: "1" }).text);
    }

    await db.activity
      .create({ data: { userId: session.user.id, action: "server_update", details: JSON.stringify({ game: "7dtd", branch: version }) } })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      message: "Update started. The server is downloading the latest build and will come back online in a few minutes.",
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Update failed" }, { status: 500 });
  }
}
