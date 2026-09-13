import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { exec } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";

export const maxDuration = 300;

const execAsync = promisify(exec);
const CONTAINER = "yoshling-7dtd";
const IMAGE = "vinanrra/7dtd-server";
const APPID = "294420";
const APPMANIFEST = "/sevendtd-config/steamapps/appmanifest_294420.acf";

// Named volumes + ports must match docker-compose.yml's `sevendtd` service so a
// recreate is faithful. The LGSM config volume is intentionally omitted — it's
// regenerated from VERSION on boot.
const VOLUMES = [
  "yoshling_sdtd-server:/home/sdtdserver/serverfiles",
  "yoshling_sdtd-saves:/home/sdtdserver/.local/share/7DaysToDie",
  "yoshling_sdtd-backup:/home/sdtdserver/lgsm/backup",
  "yoshling_sdtd-log:/home/sdtdserver/log",
];
const PORTS = [
  "26900:26900/tcp", "26900:26900/udp", "26901:26901/udp", "26902:26902/udp",
  "8080:8080/tcp", "8081:8081/tcp",
];

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
    // Preserve the current env (VERSION/TELNET_PASSWORD/TZ) from the running/last
    // container so the recreate matches; override START_MODE to 3 (update+start).
    const env = await containerEnv(CONTAINER);
    const version = env.VERSION || "latest_experimental";
    const tz = env.TimeZone || "Europe/London";
    const telnetPw = env.TELNET_PASSWORD || process.env.SDTD_TELNET_PASSWORD || "yoshlingcontrol";

    // Save the world first if it's up (best-effort), then replace the container.
    try {
      const { sdtdSaveWorld } = await import("@/lib/telnet");
      await sdtdSaveWorld();
    } catch {}

    await execAsync(`docker rm -f ${CONTAINER}`).catch(() => {});

    const envArgs = [
      `-e START_MODE=3`,
      `-e VERSION=${JSON.stringify(version)}`,
      `-e TimeZone=${JSON.stringify(tz)}`,
      `-e TELNET_PASSWORD=${JSON.stringify(telnetPw)}`,
    ].join(" ");
    const volArgs = VOLUMES.map((v) => `-v ${v}`).join(" ");
    const portArgs = PORTS.map((p) => `-p ${p}`).join(" ");

    // --network yoshling_default + alias so the web app can still reach it as "sevendtd".
    const cmd =
      `docker run -d --name ${CONTAINER} --restart no ` +
      `--network yoshling_default --network-alias sevendtd ` +
      `${portArgs} ${envArgs} ${volArgs} ${IMAGE}`;
    await execAsync(cmd, { timeout: 60000 });

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
