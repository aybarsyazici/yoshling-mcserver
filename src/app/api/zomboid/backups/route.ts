import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, writeFile, mkdir, cp } from "fs/promises";
import path from "path";
import { PZ_DIR, savePaths } from "@/lib/zomboid";

export const maxDuration = 300;

const execAsync = promisify(exec);
const BACKUP_DIR = "/app/data/backups-zomboid";

// A Project Zomboid backup is self-contained: restoring it rebuilds the world,
// the accounts and the settings exactly as they were.
//   Saves/Multiplayer/<name>/  – the world (map, players, builds)
//   db/<name>.db               – player accounts / whitelist
//   Server/<name>*             – .ini, SandboxVars.lua, spawnregions.lua
// manifest.json records the server name so a restore knows where things go.

interface Manifest {
  createdAt: string;
  serverName: string;
  includesWorld: boolean;
  includesDb: boolean;
}

/** Read the manifest out of a backup tar without extracting the whole thing. */
async function backupManifest(file: string): Promise<Manifest | null> {
  try {
    // tar stores members as "./manifest.json" when created with `-C <dir> .`;
    // try both spellings to be safe across tar versions.
    const target = JSON.stringify(path.join(BACKUP_DIR, file));
    const { stdout } = await execAsync(
      `tar -xzOf ${target} ./manifest.json 2>/dev/null || tar -xzOf ${target} manifest.json 2>/dev/null`,
      { maxBuffer: 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function GET() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  try {
    await mkdir(BACKUP_DIR, { recursive: true });
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
            world: m?.serverName ?? null,
            includesWorldMap: m?.includesWorld ?? false,
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
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  if (!hasPermission(gate.session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();

  if (action === "create") {
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const { name, world, db: dbFile, serverDir } = await savePaths();

      // Stage the pieces in a work dir, then tar them together.
      const work = path.join(BACKUP_DIR, `.work-${stamp}`);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });

      // 1) the world
      let includesWorld = false;
      try {
        await stat(world);
        await mkdir(path.join(work, "Saves", "Multiplayer"), { recursive: true });
        await cp(world, path.join(work, "Saves", "Multiplayer", name), { recursive: true });
        includesWorld = true;
      } catch {
        // never started — nothing to snapshot yet, still back up the config.
      }

      // 2) the player database
      let includesDb = false;
      try {
        await mkdir(path.join(work, "db"), { recursive: true });
        await cp(dbFile, path.join(work, "db", `${name}.db`));
        includesDb = true;
      } catch {}

      // 3) the server config trio (.ini + SandboxVars + spawnregions)
      await mkdir(path.join(work, "Server"), { recursive: true });
      try {
        for (const f of await readdir(serverDir)) {
          if (!f.startsWith(name)) continue;
          await cp(path.join(serverDir, f), path.join(work, "Server", f), { recursive: true });
        }
      } catch {}

      const manifest: Manifest = {
        createdAt: new Date().toISOString(),
        serverName: name,
        includesWorld,
        includesDb,
      };
      await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const filename = `zomboid-${name}-${stamp}.tar.gz`.replace(/[^a-zA-Z0-9._-]/g, "_");
      await execAsync(
        `tar -czf ${JSON.stringify(path.join(BACKUP_DIR, filename))} -C ${JSON.stringify(work)} .`,
        { timeout: 240000 }
      );
      await rm(work, { recursive: true, force: true });

      const s = await stat(path.join(BACKUP_DIR, filename));
      return NextResponse.json({
        success: true,
        backup: {
          name: filename,
          size: s.size,
          createdAt: s.mtime.toISOString(),
          world: name,
          includesWorldMap: includesWorld,
        },
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
      const name = m?.serverName ?? (await savePaths()).name;

      const work = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      await execAsync(`tar -xzf ${JSON.stringify(backupPath)} -C ${JSON.stringify(work)}`, {
        timeout: 240000,
      });

      // World (replace)
      const worldSrc = path.join(work, "Saves", "Multiplayer", name);
      try {
        await stat(worldSrc);
        const worldDest = path.join(PZ_DIR, "Saves", "Multiplayer", name);
        await rm(worldDest, { recursive: true, force: true });
        await mkdir(path.dirname(worldDest), { recursive: true });
        await cp(worldSrc, worldDest, { recursive: true });
      } catch {}

      // Player database
      try {
        await mkdir(path.join(PZ_DIR, "db"), { recursive: true });
        await cp(path.join(work, "db", `${name}.db`), path.join(PZ_DIR, "db", `${name}.db`), {
          force: true,
        });
      } catch {}

      // Config files
      try {
        await mkdir(path.join(PZ_DIR, "Server"), { recursive: true });
        for (const f of await readdir(path.join(work, "Server"))) {
          await cp(path.join(work, "Server", f), path.join(PZ_DIR, "Server", f), {
            recursive: true,
            force: true,
          });
        }
      } catch {}

      await rm(work, { recursive: true, force: true });
      return NextResponse.json({ success: true, restoredWorld: name });
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
