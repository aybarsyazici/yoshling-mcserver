import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, mkdir, rename } from "fs/promises";
import path from "path";
import { containerIsRunning, withGameStopped } from "@/lib/game-manager";
import { sendCommand } from "@/lib/rcon";
import { refuseIfPreempted, runOperation, type OperationFact, type OpHandle } from "@/lib/operations";
import { conflictResponse, fileLaneBusy, isConflict } from "@/lib/operation-response";
import { formatBytes } from "@/lib/format";

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
      // Tracked as an operation even though a 217 MB Minecraft world tars in ~5s:
      // the classification is made here, at the moment the work is entered, not by
      // the caller — and the same code path takes 4m 20s for Project Zomboid's 1.9 GB.
      // A duration cutoff applied at the call site structurally cannot get that right.
      // It holds `files:minecraft`, so two creates serialise and a restore cannot run
      // through the middle of a `tar` and tear the archive.
      const backup = await runOperation(
        {
          kind: "backup.create",
          game: "minecraft",
          title: "Creating a backup",
          startedBy: session.user.name ? { name: session.user.name } : null,
        },
        async (op) => {
          await mkdir(BACKUP_DIR, { recursive: true });

          // Quiesce the world before reading it off disk. No `create` path used to do
          // this, though every driver exposes a save and the *restore* paths all use one,
          // so a backup taken while people played copied chunk files the server was
          // still midway through writing. `flushed` is recorded either way, so a restore
          // can say whether the archive came from a quiesced world rather than leaving
          // that to be assumed.
          const flushed = await flushMinecraft(op);

          op.step("Compressing the archive");
          try {
            await execFileAsync("tar", ["-czf", target, "-C", MC_DIR, "world"], {
              timeout: TAR_TIMEOUT_MS,
            });
          } finally {
            // In a `finally`, and that is the load-bearing part: a failed `tar` that left
            // autosave switched off would lose every minute of play since the backup —
            // strictly worse than the torn archive this whole step exists to prevent.
            if (flushed) await resumeMinecraftAutosave(op);
          }

          // Read the size back off disk. Without this the operation has no evidence
          // and renders `unverified` — which is the correct, visible price for
          // claiming a backup exists without looking.
          let size: number | null = null;
          let mtime = new Date();
          try {
            const s = await stat(target);
            size = s.size;
            mtime = s.mtime;
          } catch {}
          op.settle(size != null ? `Wrote the archive — ${formatBytes(size)}` : "Wrote the archive");

          // A power operation admitted over this one means the world was saved and
          // stopped mid-archive. Nothing can abort the `tar`, but publishing the result
          // as a restore point would be exactly the "reports success after doing the
          // wrong thing" defect — and the confirm dialog promised deletion. The `catch`
          // below does the `rm`.
          refuseIfPreempted(op, "this backup");

          const facts: OperationFact[] = [];
          if (size != null) facts.push({ label: "Size", value: formatBytes(size) });
          facts.push({ label: "World map", value: "included" });
          facts.push({
            label: "World flushed first",
            value: flushed
              ? "yes — autosave was paused for the copy"
              : "not needed — the server was not running",
          });
          return {
            facts,
            value: { name: filename, size: size ?? 0, createdAt: mtime.toISOString() },
          };
        }
      );

      return NextResponse.json({ success: true, backup });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
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
      const { restarted } = await withGameStopped(
        "minecraft",
        "restart",
        async (op) => {
          op.step("Restoring the world from backup");
          op.detail(name);
          await restoreWorld(backupPath);
          op.settle("Replaced the world folder");
          op.fact({ label: "Archive", value: name });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: session.user.name,
          // A half-replaced world is worse than a stopped one: the game would rewrite
          // the mess on its first autosave. Staying down keeps the archive usable.
          restartOnFailure: false,
        }
      );
      return NextResponse.json({ success: true, restarted });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      return NextResponse.json({ error: (e as Error).message || "Restore failed" }, { status: 500 });
    }
  }

  if (action === "delete") {
    const name = safeBackupName(backupName);
    if (!name) {
      return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    }

    // Delete was the one backup mutation outside the registry entirely — no lane, no
    // record, and the client wrote its own `toast.success("Backup deleted")`, which is
    // the single thing every other path here is structurally forbidden from doing.
    //
    // It gets the lane rather than a full `runOperation`: an `rm` is sub-second, so a
    // strip row and a completion toast for it would be noise, and that is exactly the
    // case `fileLaneBusy` exists for (the seven config endpoints use it for the same
    // reason). What the lane buys is the case that matters — deleting an archive while a
    // restore is reading it, or while a create is writing into the same directory.
    const laneBusy = fileLaneBusy("minecraft");
    if (laneBusy) return laneBusy;

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
 * Ask Minecraft to write the world out and stop writing to it, so `tar` reads a
 * consistent tree. Returns whether autosave was actually paused — the caller must
 * resume it in a `finally` if so.
 *
 * Minecraft is the only one of the three that can do the full dance, because
 * `save-off` genuinely exists in its command set. **Do not add a `save-off`
 * equivalent to 7DTD or Project Zomboid** — neither has one, and inventing a command
 * that silently fails is the defect class this pass is cleaning up. Those two get the
 * flush alone.
 *
 * Failure here is deliberately non-fatal and recorded as a warn rather than thrown: a
 * torn archive is much better than no archive, and the world being unreachable over RCON
 * is precisely a moment when someone wants a backup.
 */
async function flushMinecraft(op: OpHandle): Promise<boolean> {
  op.step("Flushing the world to disk");
  if (!(await containerIsRunning("minecraft").catch(() => false))) {
    op.settle("The server is not running — nothing to flush", { kind: "noop" });
    return false;
  }
  const t0 = Date.now();
  try {
    // `save-off` first: it stops the autosave thread, so the `save-all flush` that
    // follows is the last write before the copy.
    await sendCommand("save-off");
    await sendCommand("save-all flush");
    op.settle(`Flushed the world and paused autosave — ${Date.now() - t0} ms`);
    return true;
  } catch (e) {
    // `save-off` may have landed even though a later call threw, so report `true` and
    // let the caller's `finally` re-enable autosave regardless. Re-enabling something
    // that was never disabled is a harmless no-op; the reverse loses progress.
    op.settle("Could not flush the world — the server did not answer over RCON");
    op.fact({
      label: "World flush",
      value: `failed (${(e as Error).message}) — the archive may be torn`,
      verdict: "warn",
    });
    return true;
  }
}

async function resumeMinecraftAutosave(op: OpHandle): Promise<void> {
  try {
    await sendCommand("save-on");
  } catch (e) {
    // The one outcome worth shouting about: the world is running with autosave off and
    // nothing else will turn it back on.
    op.fact({
      label: "Autosave",
      value:
        `could not be re-enabled (${(e as Error).message}) — run \`save-on\` in the ` +
        `console, or restart the server, or progress since this backup will be lost`,
      verdict: "bad",
    });
  }
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
