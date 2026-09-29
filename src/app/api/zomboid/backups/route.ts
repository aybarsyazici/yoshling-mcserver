import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, writeFile, mkdir, cp } from "fs/promises";
import path from "path";
import { PZ_DIR, pzSave, savePaths } from "@/lib/zomboid";
import { containerIsRunning, withGameStopped } from "@/lib/game-manager";
import { refuseIfPreempted, runOperation, type OperationFact, type OpHandle } from "@/lib/operations";
import { conflictResponse, fileLaneBusy, isConflict } from "@/lib/operation-response";
import { formatBytes } from "@/lib/format";

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

/**
 * `backupName` arrives straight off the request body and is used both as a
 * filesystem path and as an argument to `tar`, so it has to be closed off before
 * either. `path.basename` + `JSON.stringify` — what this route used to do — is
 * not enough: basename stops traversal but leaves shell metacharacters intact,
 * and JSON quoting produces *double* quotes, inside which `sh` still runs `$(…)`
 * and backticks. So: an allowlist, and `execFile` (argv array, no shell) for
 * every command below. A space is admitted because `/api/7dtd/reset` names its
 * pre-reset archive after the world ("Reveo Valley") without sanitising it, and
 * with no shell in the picture a space is just a character.
 */
function safeBackupName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  if (name !== path.basename(name)) return null; // no directory part at all
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.tar\.gz$/.test(name)) return null;
  return name;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

/** Read the manifest out of a backup tar without extracting the whole thing. */
async function backupManifest(file: string): Promise<Manifest | null> {
  const target = path.join(BACKUP_DIR, file);
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
      return NextResponse.json({ success: true, backup });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz
      // that the listing would offer as restorable.
      if (target) await rm(target, { force: true }).catch(() => {});
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
      return NextResponse.json({ success: true, restoredWorld: serverName, restarted });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
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

    try {
      await rm(path.join(BACKUP_DIR, name));
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
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
    op.settle("The server is not running — nothing to flush", { kind: "noop" });
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
      throw new Error(
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
      throw new Error(
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
