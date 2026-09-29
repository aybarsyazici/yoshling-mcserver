import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, writeFile, mkdir, cp } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { PZ_DIR, pzSave, savePaths } from "@/lib/zomboid";
import { containerIsRunning, withGameStopped } from "@/lib/game-manager";
import { refuseIfPreempted, runOperation, type OperationFact, type OpHandle } from "@/lib/operations";
import { conflictResponse, fileLaneBusy, isConflict } from "@/lib/operation-response";
import { formatBytes } from "@/lib/format";
import {
  BadArchiveError,
  readManifestSidecar,
  refuseIfPreemptedEarly,
  removeManifestSidecar,
  safeBackupName,
  writeManifestSidecar,
} from "@/lib/backup-archive";

export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const BACKUP_DIR = "/app/data/backups-zomboid";
const TAR_TIMEOUT_MS = 240_000;

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
  /**
   * Whether the server was asked to write the world out before the copy.
   *
   * `false` = the server was stopped, so there was nothing to flush and the files were
   * already at rest. `undefined` = an archive from before this was recorded, i.e.
   * genuinely unknown rather than "no".
   */
  flushed?: boolean;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

/**
 * Read a backup's manifest.
 *
 * The sidecar first, because reading the copy inside the tar means decompressing the
 * whole gzip stream to get ~100 bytes — the listing calls this once per archive, so
 * that cost lands on the backups page's first paint. The in-tar copy stays as the
 * fallback for every archive written before the sidecar existed, and as the thing that
 * keeps an archive self-describing once it has been copied off the box.
 */
async function backupManifest(file: string): Promise<Manifest | null> {
  const target = path.join(BACKUP_DIR, file);
  const sidecar = await readManifestSidecar<Manifest>(target);
  if (sidecar) return sidecar;
  // tar stores members as "./manifest.json" when created with `-C <dir> .`;
  // try both spellings to be safe across tar versions.
  for (const member of ["./manifest.json", "manifest.json"]) {
    try {
      const { stdout } = await execFileAsync("tar", ["-xzOf", target, member], {
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch {
      /* try the other spelling */
    }
  }
  return null;
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
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const work = path.join(BACKUP_DIR, `.work-${stamp}`);
    let target = "";
    try {
      // Measured on the box: 1.9 GB of Saves → **4 min 20 s** and a 198 MB archive.
      // Past Cloudflare's ~100s origin read timeout, so the client's own response is
      // not a reliable source of truth for the outcome — server-side tracking is the
      // only possible mechanism here, not a nicety. Holds `files:zomboid`, so a
      // restore can no longer run through the middle of the `cp -r` and tear it.
      const backup = await runOperation(
        {
          kind: "backup.create",
          game: "zomboid",
          title: "Creating a backup",
          startedBy: gate.session.user.name ? { name: gate.session.user.name } : null,
        },
        async (op) => {
          await mkdir(BACKUP_DIR, { recursive: true });
          const { name, world, db: dbFile, serverDir } = await savePaths();

          // Ask the game to write the world out before we copy it. No `create` path used
          // to do this, though every driver exposes a save and the *restore* paths all use
          // one, so a backup taken while people played copied files the server was still
          // midway through writing — and the copy here takes 4m 20s, which is a lot of
          // wall-clock for the world to be moving underneath.
          //
          // Flush only — deliberately no `save-off` equivalent, because Project Zomboid
          // has none. Inventing a command that silently fails is the defect class being
          // cleaned up.
          const flushed = await flushWorld(op);

          // Preemption is checked at EVERY step boundary from here on, not only after
          // the tar. Measured on production 2026-09-29: `op.preempted` was set 94 s into
          // a 9m 43s backup and the only check ran last, so the app spent a further
          // ~7m 55s copying 291 MiB it had already decided to throw away — competing for
          // disk with the power operation that condemned it — and then handed the user an
          // error. Refusing here costs nothing and leaves nothing behind.
          refuseIfPreemptedEarly(op, "this backup");

          // Stage the pieces in a work dir, then tar them together.
          await rm(work, { recursive: true, force: true });
          await mkdir(work, { recursive: true });

          // 1) the world
          op.step("Copying the world");
          op.detail(name);
          let includesWorld = false;
          if (await exists(world)) {
            await mkdir(path.join(work, "Saves", "Multiplayer"), { recursive: true });
            await cp(world, path.join(work, "Saves", "Multiplayer", name), { recursive: true });
            includesWorld = true;
            op.settle("Copied the world");
          } else {
            // Never started — nothing to snapshot yet. The config is still worth
            // keeping, but an archive with no world is NOT a restore point, and that
            // has to be visible rather than inferred from a 4 MB size.
            op.settle("No world on disk yet — nothing to copy", { kind: "noop" });
          }

          // The world copy is the long one (4m 20s for 1.9 GB), so this boundary is the
          // one that saves the most.
          refuseIfPreemptedEarly(op, "this backup");

          // 2) the player database
          op.step("Copying the player database");
          let includesDb = false;
          if (await exists(dbFile)) {
            await mkdir(path.join(work, "db"), { recursive: true });
            await cp(dbFile, path.join(work, "db", `${name}.db`));
            includesDb = true;
            op.settle("Copied the player database");
          } else {
            op.settle("No player database yet");
          }

          refuseIfPreemptedEarly(op, "this backup");

          // 3) the server config trio (.ini + SandboxVars + spawnregions)
          op.step("Copying the server config");
          await mkdir(path.join(work, "Server"), { recursive: true });
          let configFiles = 0;
          for (const f of await readdir(serverDir)) {
            if (!f.startsWith(name)) continue;
            await cp(path.join(serverDir, f), path.join(work, "Server", f), { recursive: true });
            configFiles++;
          }
          op.settle("Copied the server config", {
            count: { done: configFiles, noun: "files" },
          });

          const manifest: Manifest = {
            createdAt: new Date().toISOString(),
            serverName: name,
            includesWorld,
            includesDb,
            flushed,
          };
          await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

          const filename = `zomboid-${name}-${stamp}.tar.gz`.replace(/[^a-zA-Z0-9._-]/g, "_");
          target = path.join(BACKUP_DIR, filename);

          // The last boundary before ~10 minutes of `tar` that cannot be interrupted.
          refuseIfPreemptedEarly(op, "this backup");

          op.step("Compressing the archive");
          await execFileAsync("tar", ["-czf", target, "-C", work, "."], { timeout: TAR_TIMEOUT_MS });

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

          // Only now: a sidecar for an archive the refusal above deleted would describe
          // a file that is not there, and `worldsUsedByBackups`-style guards would keep
          // trusting it.
          await writeManifestSidecar(target, manifest);

          const facts: OperationFact[] = [];
          if (size != null) facts.push({ label: "Size", value: formatBytes(size) });
          facts.push({
            label: "World map",
            value: includesWorld ? "included" : "not included",
            // A config-only archive is not something you can restore a world from.
            verdict: includesWorld ? undefined : "warn",
          });
          facts.push({ label: "Player database", value: includesDb ? "included" : "not included" });
          facts.push({
            label: "World flushed first",
            value: flushed ? "yes" : "not needed — the server was not running",
          });
          return {
            facts,
            value: {
              name: filename,
              size: size ?? 0,
              createdAt: mtime.toISOString(),
              world: name,
              includesWorldMap: includesWorld,
            },
          };
        }
      );
      await logBackup(gate.session.user.id, "backup_create", {
        name: backup.name,
        sizeBytes: backup.size,
        world: backup.world,
        includesWorldMap: backup.includesWorldMap,
      });
      return NextResponse.json({ success: true, backup });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz
      // that the listing would offer as restorable — and its sidecar has to go with
      // it, or the manifest outlives the archive it describes.
      if (target) {
        await rm(target, { force: true }).catch(() => {});
        await removeManifestSidecar(target);
      }
      return NextResponse.json({ error: (e as Error).message || "Backup failed" }, { status: 500 });
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (action === "restore") {
    const name = safeBackupName(backupName);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    const backupPath = path.join(BACKUP_DIR, name);
    try {
      await stat(backupPath);
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }

    try {
      const m = await backupManifest(name);
      const serverName = m?.serverName ?? (await savePaths()).name;
      // A running server holds the world in memory and writes it back on its next
      // autosave, so restoring underneath it changed nothing that survived — and
      // still reported success. `withGameStopped` saves + stops first, restores,
      // and starts again only if it was running; it also holds the control lock,
      // so a Power on can't race in halfway through and the banner can say what
      // is happening.
      const { restarted } = await withGameStopped(
        "zomboid",
        "restart",
        async (op) => {
          op.step("Restoring the save from backup");
          op.detail(name);
          await restoreBundle(backupPath, serverName, m);
          op.settle("Replaced the world, the player database and the config");
          op.fact({ label: "Archive", value: name });
          op.fact({ label: "World", value: serverName });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: gate.session.user.name,
          restartOnFailure: false,
        }
      );
      await logBackup(gate.session.user.id, "backup_restore", {
        name,
        world: serverName,
        restartedAfter: restarted,
      });
      return NextResponse.json({ success: true, restoredWorld: serverName, restarted });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // The archive is wrong about itself — the user's own file, not a broken server.
      if (e instanceof BadArchiveError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      return NextResponse.json({ error: (e as Error).message || "Restore failed" }, { status: 500 });
    }
  }

  if (action === "delete") {
    const name = safeBackupName(backupName);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });

    // The lane, for the same reason the config endpoints take it: deleting an archive
    // while a restore reads it, or while a create writes into this directory, is the
    // case worth refusing. An `rm` is sub-second, so it gets the lane rather than a
    // `runOperation` record — a strip row and a completion toast for it would be noise.
    const laneBusy = fileLaneBusy("zomboid");
    if (laneBusy) return laneBusy;

    const target = path.join(BACKUP_DIR, name);
    try {
      await stat(target);
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }

    try {
      await rm(target);
      await removeManifestSidecar(target);
      await logBackup(gate.session.user.id, "backup_delete", { name });
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

/**
 * The durable half of this feature.
 *
 * The operation registry forgets a clean record in 10 minutes; `/activity` does not.
 * Until 2026-09-29 **no backup action of any kind had ever written a row** — verified
 * against the production DB, which held 182 rows across ten action types and not one
 * `backup_*`. A restore replaces the world people play, and ten minutes afterwards
 * nothing anywhere recorded that it happened or who did it. Every neighbouring
 * feature (file edits, mod installs, `set_memory`, power) already wrote one.
 *
 * `game` has to be in `details`: `/api/activity` selects each world's panel with
 * `contains "<game>"`, and an untagged row is shown to everyone.
 *
 * Logged rather than swallowed, following `mc-whitelist`'s precedent — "who restored
 * the world" is precisely the question this row exists to answer, so a row that failed
 * to write is worth a line in the container log.
 *
 * Only ever called after the work succeeded. A refused backup (bad archive, no world
 * member, preempted) writes nothing: a log of things that did not happen is worse than
 * no log.
 */
async function logBackup(
  userId: string,
  action: "backup_create" | "backup_restore" | "backup_delete",
  details: Record<string, unknown>
): Promise<void> {
  try {
    await db.activity.create({
      data: { userId, action, details: JSON.stringify({ game: "zomboid", ...details }) },
    });
  } catch (e) {
    console.error(`[zomboid/backups] could not write the ${action} activity row:`, e);
  }
}

/**
 * Ask Project Zomboid to write the world to disk before the copy, over RCON.
 *
 * Returns whether the flush was asked for at all — `false` means the container is not
 * running, which is a `noop` step rather than a failure. An RCON failure is recorded as a
 * warn and does NOT abort: a torn archive beats no archive, and an unreachable server is
 * exactly when someone wants a backup. (PZ wedging its game loop while the container
 * stays up is a state this box has actually been in — 2026-09-22.)
 *
 * The save itself is fast — ten consecutive `SaveAll` calls measured 94–156 ms on
 * 2026-09-29 — so this adds nothing meaningful to the 4m 20s copy.
 *
 * No `save-off`: Project Zomboid has no such command, so there is nothing to pause and
 * nothing to re-enable in a `finally`.
 */
async function flushWorld(op: OpHandle): Promise<boolean> {
  op.step("Flushing the world to disk");
  if (!(await containerIsRunning("zomboid").catch(() => false))) {
    // `done`, NOT `noop`: a stopped server's files are already consistent, which is the
    // best case for a backup. As `noop` this concluded `partial` and the summary read
    // "but part of it is missing. This is not a restore point." for a flawless archive.
    op.settle("The server is stopped — its files are already at rest");
    return false;
  }
  const t0 = Date.now();
  try {
    await pzSave();
    op.settle(`Flushed the world — ${Date.now() - t0} ms`);
    return true;
  } catch (e) {
    op.settle("Could not flush the world — the server did not answer over RCON");
    op.fact({
      label: "World flush",
      value: `failed (${(e as Error).message}) — the archive may be torn`,
      verdict: "warn",
    });
    return true;
  }
}

/**
 * Extract the bundle, check each piece is really in it, and only then replace the
 * live copy. Every step used to sit in its own `try {} catch {}`, so a bundle whose
 * world was missing — or a copy that failed halfway — removed the live save and
 * still answered `{success:true}`. What the manifest promises is now enforced:
 * absent-and-not-promised is skipped, absent-but-promised is a hard failure.
 */
async function restoreBundle(
  backupPath: string,
  serverName: string,
  m: Manifest | null
): Promise<void> {
  // The web container writes as root; the game runs as another uid (1000 on this
  // box). Neither `fs.cp` nor this bundle carries ownership — every member of the
  // existing backup is recorded root/root — so everything restored lands
  // root-owned and the server silently cannot write its own save afterwards.
  // (MC and 7DTD escape this: their pipelines are `tar`/`cp -a` throughout, which
  // do preserve it.) Take the ownership off the data dir and re-apply it.
  const { uid, gid } = await stat(PZ_DIR);
  const own = (p: string) => execFileAsync("chown", ["-R", `${uid}:${gid}`, p]);

  const work = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", backupPath, "-C", work], { timeout: TAR_TIMEOUT_MS });

    // World (replace) — assert it is in the archive BEFORE removing the live one.
    const worldSrc = path.join(work, "Saves", "Multiplayer", serverName);
    if (await exists(worldSrc)) {
      const worldDest = path.join(PZ_DIR, "Saves", "Multiplayer", serverName);
      await mkdir(path.dirname(worldDest), { recursive: true });
      await rm(worldDest, { recursive: true, force: true });
      await cp(worldSrc, worldDest, { recursive: true });
      await own(worldDest);
    } else if (m?.includesWorld !== false) {
      // Only a backup that recorded "no world" (server never started) may skip it.
      // `BadArchiveError`, so the route answers 400: this is the user's archive being
      // wrong, not the server breaking, and the sentence already reads like advice.
      throw new BadArchiveError(
        `This backup has no world for "${serverName}" in it — nothing was changed.`
      );
    }

    // Player database
    const dbSrc = path.join(work, "db", `${serverName}.db`);
    if (await exists(dbSrc)) {
      const dbDest = path.join(PZ_DIR, "db", `${serverName}.db`);
      await mkdir(path.dirname(dbDest), { recursive: true });
      await cp(dbSrc, dbDest, { force: true });
      await own(dbDest);
    } else if (m?.includesDb) {
      throw new BadArchiveError(
        `This backup says it carries the player database but does not — ` +
          `the world was restored, the accounts were left alone.`
      );
    }

    // Config files (.ini, SandboxVars, spawnregions). Older bundles may not have
    // the dir; a failed copy is a real error and used to be swallowed.
    const cfgSrc = path.join(work, "Server");
    if (await exists(cfgSrc)) {
      const cfgDest = path.join(PZ_DIR, "Server");
      await mkdir(cfgDest, { recursive: true });
      for (const f of await readdir(cfgSrc)) {
        await cp(path.join(cfgSrc, f), path.join(cfgDest, f), {
          recursive: true,
          force: true,
        });
      }
      await own(cfgDest);
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
