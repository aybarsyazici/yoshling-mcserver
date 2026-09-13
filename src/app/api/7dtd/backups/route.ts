import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";

export const maxDuration = 300;

const execAsync = promisify(exec);
const SDTD_DIR = RUNTIME["7dtd"].dir; // .local/share/7DaysToDie (saves + GeneratedWorlds)
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config"; // serverfiles (sdtdserver.xml)
const BACKUP_DIR = "/app/data/backups-7dtd";
const XML_PATH = path.join(CONFIG_DIR, "sdtdserver.xml");

// A self-contained 7DTD backup bundles three things so a restore fully rebuilds
// the world's state:
//   Saves/                    – game progress (players, explored chunks, builds)
//   GeneratedWorlds/<world>/   – the custom map itself (if the active world is custom)
//   sdtdserver.xml             – server settings (incl. which world/game is active)
// A manifest.json records the world name so the UI can show it and so world
// deletion can refuse to remove a world that a backup depends on.

interface Manifest {
  createdAt: string;
  gameWorld: string; // value of GameWorld at backup time
  includesWorldMap: boolean; // true if GeneratedWorlds/<gameWorld> was bundled
}

function readGameWorld(xml: string): string {
  const m = xml.match(/<property\s+name="GameWorld"\s+value="([^"]*)"/i);
  return m ? m[1] : "";
}

/** Parse the manifest embedded in a backup tar (without full extraction). */
async function backupManifest(file: string): Promise<Manifest | null> {
  try {
    // The tar is created with `-C <dir> .`, so members are stored as
    // "./manifest.json". Try both spellings to be safe across tar versions.
    const { stdout } = await execAsync(
      `tar -xzOf ${JSON.stringify(path.join(BACKUP_DIR, file))} ./manifest.json 2>/dev/null || ` +
        `tar -xzOf ${JSON.stringify(path.join(BACKUP_DIR, file))} manifest.json 2>/dev/null`,
      { maxBuffer: 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Which custom worlds are referenced by existing backups (for delete-guard). */
export async function worldsUsedByBackups(): Promise<Set<string>> {
  const used = new Set<string>();
  try {
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith(".tar.gz"));
    for (const f of files) {
      const m = await backupManifest(f);
      if (m?.includesWorldMap && m.gameWorld) used.add(m.gameWorld);
    }
  } catch {}
  return used;
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;

  try {
    await execAsync(`mkdir -p ${BACKUP_DIR}`);
    const entries = await readdir(BACKUP_DIR);
    const backups = await Promise.all(
      entries
        .filter((e) => e.endsWith(".tar.gz"))
        .map(async (name) => {
          const s = await stat(path.join(BACKUP_DIR, name));
          const m = await backupManifest(name);
          return {
            name,
            size: s.size,
            createdAt: s.mtime.toISOString(),
            world: m?.gameWorld ?? null,
            includesWorldMap: m?.includesWorldMap ?? false,
          };
        })
    );
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json(backups);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();

  if (action === "create") {
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

      // Determine the active world from the config.
      let xml = "";
      try { xml = await readFile(XML_PATH, "utf-8"); } catch {}
      const gameWorld = readGameWorld(xml);

      // Stage the pieces in a work dir, then tar them together.
      const work = path.join(BACKUP_DIR, `.work-${stamp}`);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });

      // 1) Saves/
      await execAsync(`cp -a ${JSON.stringify(path.join(SDTD_DIR, "Saves"))} ${JSON.stringify(work)}/ 2>/dev/null || true`);

      // 2) the custom world map, only if the active world is a custom one.
      const worldSrc = path.join(SDTD_DIR, "GeneratedWorlds", gameWorld);
      let includesWorldMap = false;
      try {
        await stat(worldSrc);
        await mkdir(path.join(work, "GeneratedWorlds"), { recursive: true });
        await execAsync(`cp -a ${JSON.stringify(worldSrc)} ${JSON.stringify(path.join(work, "GeneratedWorlds"))}/`);
        includesWorldMap = true;
      } catch {
        // stock world (Navezgane/Pregen…) — ships with the server, no need to bundle.
      }

      // 3) sdtdserver.xml
      if (xml) await writeFile(path.join(work, "sdtdserver.xml"), xml, "utf-8");

      // 4) manifest
      const manifest: Manifest = { createdAt: new Date().toISOString(), gameWorld, includesWorldMap };
      await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const filename = `7dtd-${gameWorld || "world"}-${stamp}.tar.gz`.replace(/[^a-zA-Z0-9._-]/g, "_");
      await execAsync(`tar -czf ${JSON.stringify(path.join(BACKUP_DIR, filename))} -C ${JSON.stringify(work)} .`, { timeout: 240000 });
      await rm(work, { recursive: true, force: true });

      const s = await stat(path.join(BACKUP_DIR, filename));
      return NextResponse.json({
        success: true,
        backup: { name: filename, size: s.size, createdAt: s.mtime.toISOString(), world: gameWorld || null, includesWorldMap },
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Backup failed" }, { status: 500 });
    }
  }

  if (action === "restore") {
    if (!backupName) return NextResponse.json({ error: "backupName required" }, { status: 400 });
    const backupPath = path.join(BACKUP_DIR, path.basename(backupName));
    try {
      await stat(backupPath);
      const m = await backupManifest(path.basename(backupName));
      const work = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      await execAsync(`tar -xzf ${JSON.stringify(backupPath)} -C ${JSON.stringify(work)}`, { timeout: 240000 });

      // Restore Saves/ (replace)
      await execAsync(`rm -rf ${JSON.stringify(path.join(SDTD_DIR, "Saves"))}`);
      await execAsync(`cp -a ${JSON.stringify(path.join(work, "Saves"))} ${JSON.stringify(SDTD_DIR)}/ 2>/dev/null || true`);

      // Restore the custom world map if present
      if (m?.includesWorldMap && m.gameWorld) {
        await mkdir(path.join(SDTD_DIR, "GeneratedWorlds"), { recursive: true });
        const wdest = path.join(SDTD_DIR, "GeneratedWorlds", m.gameWorld);
        await execAsync(`rm -rf ${JSON.stringify(wdest)}`);
        await execAsync(`cp -a ${JSON.stringify(path.join(work, "GeneratedWorlds", m.gameWorld))} ${JSON.stringify(path.join(SDTD_DIR, "GeneratedWorlds"))}/ 2>/dev/null || true`);
      }

      // Restore sdtdserver.xml
      try {
        const savedXml = await readFile(path.join(work, "sdtdserver.xml"), "utf-8");
        await writeFile(XML_PATH, savedXml, "utf-8");
      } catch {}

      await rm(work, { recursive: true, force: true });
      return NextResponse.json({ success: true, restoredWorld: m?.gameWorld ?? null });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Restore failed" }, { status: 500 });
    }
  }

  if (action === "delete") {
    if (!backupName) return NextResponse.json({ error: "backupName required" }, { status: 400 });
    try {
      await rm(path.join(BACKUP_DIR, path.basename(backupName)));
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
