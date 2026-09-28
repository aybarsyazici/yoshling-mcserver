import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, mkdir, rename } from "fs/promises";
import path from "path";
import { ControlBusyError, setControlStage, withGameStopped } from "@/lib/game-manager";

// A restore now saves + stops the world, swaps the files and starts it again, so
// the request lives as long as a graceful stop plus an extract.
export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const BACKUP_DIR = "/app/data/backups";

/**
 * Long enough for a big world. Was 60s, which is a coin-toss for a 170 MB world
 * on a busy box; the restore holds the control lock and the lock heartbeats, so
 * a long tar can't lose it partway through.
 */
const TAR_TIMEOUT_MS = 300_000;

/**
 * `backupName` arrives straight off the request body and is used both as a
 * filesystem path and as an argument to `tar`, so it has to be closed off before
 * either. Two near-misses to avoid repeating:
 *
 *   - `path.basename` alone stops `../../../etc/passwd` but leaves shell
 *     metacharacters intact, and quoting with `JSON.stringify` produces *double*
 *     quotes — inside which `sh` still runs `$(…)` and backticks.
 *   - `exec()` resolves on the *last* command's exit status, so `x.tar.gz; true`
 *     made a failed restore answer `{success:true}`.
 *
 * So: an allowlist, and `execFile` (argv array, no shell) for every command
 * below. A space is admitted because `/api/7dtd/reset` names its pre-reset
 * archive after the world ("Reveo Valley") without sanitising it, and with no
 * shell in the picture a space is just a character.
 */
function safeBackupName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  if (name !== path.basename(name)) return null; // no directory part at all
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.tar\.gz$/.test(name)) return null;
  return name;
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const entries = await readdir(BACKUP_DIR);
    const backups = await Promise.all(
      entries
        .filter((e) => e.endsWith(".tar.gz"))
        .map(async (name) => {
          const filePath = path.join(BACKUP_DIR, name);
          const s = await stat(filePath);
          return {
            name,
            size: s.size,
            createdAt: s.mtime.toISOString(),
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
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();

  if (action === "create") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `world-${timestamp}.tar.gz`;
    const target = path.join(BACKUP_DIR, filename);
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      await execFileAsync("tar", ["-czf", target, "-C", MC_DIR, "world"], {
        timeout: TAR_TIMEOUT_MS,
      });

      const s = await stat(target);

      return NextResponse.json({
        success: true,
        backup: { name: filename, size: s.size, createdAt: s.mtime.toISOString() },
      });
    } catch (e) {
      // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz
      // behind, and the listing would offer it as something you can restore.
      await rm(target, { force: true }).catch(() => {});
      return NextResponse.json({ error: (e as Error).message || "Backup failed" }, { status: 500 });
    }
  }

  if (action === "restore") {
    const name = safeBackupName(backupName);
    if (!name) {
      return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    }

    const backupPath = path.join(BACKUP_DIR, name);
    try {
      await stat(backupPath);
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }

    try {
      // A running server holds the world in memory and writes it back on its next
      // autosave, so restoring underneath it changed nothing that survived — and
      // still reported success. `withGameStopped` saves + stops first, restores,
      // and starts again only if it was running; it also holds the control lock,
      // so a Power on can't race in halfway through and the banner can say what
      // is happening.
      const { restarted } = await withGameStopped("minecraft", "restart", async () => {
        setControlStage("Restoring the world from backup");
        await restoreWorld(backupPath);
      });
      return NextResponse.json({ success: true, restarted });
    } catch (e) {
      if (e instanceof ControlBusyError) {
        return NextResponse.json(
          { error: `Busy: ${e.lock.game} is ${e.lock.action}ing. Try again in a moment.`, busy: e.lock },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: (e as Error).message || "Restore failed" }, { status: 500 });
    }
  }

  if (action === "delete") {
    const name = safeBackupName(backupName);
    if (!name) {
      return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    }

    try {
      await rm(path.join(BACKUP_DIR, name));
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

/**
 * Extract into a staging dir and only then swap the world in.
 *
 * This used to `rm -rf world` *first* and extract second, so a truncated or
 * wrong-shaped archive — or a full disk — left no world at all. 7DTD and PZ
 * already extract before they replace; this brings MC in line. The staging dir
 * lives inside MC_DIR so the final step is a same-device rename: the live world
 * only disappears once its replacement is complete on disk.
 */
async function restoreWorld(backupPath: string): Promise<void> {
  const work = path.join(MC_DIR, `.restore-${Date.now()}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", backupPath, "-C", work], { timeout: TAR_TIMEOUT_MS });

    // MC backups are `tar -czf … -C MC_DIR world`, so the member is `world/`.
    const extracted = path.join(work, "world");
    const isDir = await stat(extracted)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!isDir) {
      throw new Error("This backup has no world folder in it — nothing was changed.");
    }

    await rm(path.join(MC_DIR, "world"), { recursive: true, force: true });
    await rename(extracted, path.join(MC_DIR, "world"));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
