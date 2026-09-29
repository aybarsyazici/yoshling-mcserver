import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { containerIsRunning, RUNTIME, withGameStopped } from "@/lib/game-manager";
import { sdtdSaveWorld } from "@/lib/telnet";
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
const SDTD_DIR = RUNTIME["7dtd"].dir; // .local/share/7DaysToDie (saves + GeneratedWorlds)
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config"; // serverfiles (sdtdserver.xml)
const BACKUP_DIR = "/app/data/backups-7dtd";
const XML_PATH = path.join(CONFIG_DIR, "sdtdserver.xml");
const TAR_TIMEOUT_MS = 240_000;

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
  /**
   * Whether the server was asked to write its save out before the copy.
   *
   * `false` = the server was stopped, so there was nothing to flush and the files on
   * disk were already at rest. `undefined` = an archive from before this was recorded,
   * i.e. genuinely unknown rather than "no".
   */
  flushed?: boolean;
}

async function isDir(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

function readGameWorld(xml: string): string {
  const m = xml.match(/<property\s+name="GameWorld"\s+value="([^"]*)"/i);
  return m ? m[1] : "";
}

/**
 * A backup's manifest — from the sidecar if there is one, else out of the tar.
 *
 * Reading the in-tar copy costs a full gzip decompression of a ~290 MB archive to get
 * ~100 bytes, and this is called once per archive by the GET **and** again by
 * `worldsUsedByBackups`, which the world-delete guard calls. Measured on production
 * 2026-09-29: `GET /api/7dtd/backups` took **7.9 s** to return 955 bytes of JSON for
 * six archives. That is the backups page's first paint.
 *
 * The in-tar copy is not going anywhere — it is what makes an archive self-describing
 * after it has been copied off the box, which the sidecar cannot be.
 */
async function backupManifest(file: string): Promise<Manifest | null> {
  const target = path.join(BACKUP_DIR, file);
  const sidecar = await readManifestSidecar<Manifest>(target);
  if (sidecar) return sidecar;
  // The tar is created with `-C <dir> .`, so members are stored as
  // "./manifest.json". Try both spellings to be safe across tar versions.
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
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const work = path.join(BACKUP_DIR, `.work-${stamp}`);
    let target = "";
    try {
      // Holds `files:7dtd`: two creates now serialise instead of colliding on the
      // same second-resolution `.work-${stamp}` directory, which each one begins by
      // `rm -rf`-ing. A power operation is still admitted over this, with a
      // confirmation naming the torn archive — Power off is the recovery path on this
      // box and must never be blocked by a four-minute `tar`.
      const backup = await runOperation(
        {
          kind: "backup.create",
          game: "7dtd",
          title: "Creating a backup",
          startedBy: session.user.name ? { name: session.user.name } : null,
        },
        async (op) => {
          await mkdir(BACKUP_DIR, { recursive: true });

          // Ask the game to write its save out before we copy it. No `create` path used
          // to do this, though every driver exposes a save and the *restore* paths all
          // use one, so a backup taken while people played copied files the server was
          // still midway through writing.
          //
          // Flush only — deliberately no `save-off` equivalent, because 7DTD has none.
          // Inventing a command that silently fails is the defect class being cleaned up.
          const flushed = await flushSaves(op);

          // Preemption is checked at EVERY step boundary from here on, not only after the
          // tar. Measured on production 2026-09-29 (on Project Zomboid, same shape): the
          // flag was set 94 s into a 9m 43s backup and the only check ran last, so the
          // app spent a further ~7m 55s writing an archive it had already decided to
          // delete, competing for disk with the operation that condemned it.
          refuseIfPreemptedEarly(op, "this backup");

          // Determine the active world from the config.
          let xml = "";
          try { xml = await readFile(XML_PATH, "utf-8"); } catch {}
          const gameWorld = readGameWorld(xml);

          // Stage the pieces in a work dir, then tar them together.
          await rm(work, { recursive: true, force: true });
          await mkdir(work, { recursive: true });

          // 1) Saves/ — `cp -a` rather than fs.cp because the game container runs as
          // a non-root user and the copy has to keep its ownership. A backup without
          // Saves/ is worthless, so refuse instead of writing one that looks fine.
          op.step("Copying the saves");
          const savesSrc = path.join(SDTD_DIR, "Saves");
          if (!(await isDir(savesSrc))) {
            throw new Error(`No Saves/ in ${SDTD_DIR} — the server has not generated a world yet.`);
          }
          await execFileAsync("cp", ["-a", savesSrc, work]);
          op.settle("Copied the saves");

          // The saves copy is the long one, so this boundary saves the most.
          refuseIfPreemptedEarly(op, "this backup");

          // 2) the custom world map, only if the active world is a custom one.
          const worldSrc = path.join(SDTD_DIR, "GeneratedWorlds", gameWorld);
          let includesWorldMap = false;
          op.step("Copying the world map");
          if (gameWorld && (await isDir(worldSrc))) {
            await mkdir(path.join(work, "GeneratedWorlds"), { recursive: true });
            await execFileAsync("cp", ["-a", worldSrc, path.join(work, "GeneratedWorlds")]);
            includesWorldMap = true;
            op.settle(`Copied the world map — ${gameWorld}`);
          } else {
            // Stock world (Navezgane/Pregen…) — it ships with the server, so there is
            // genuinely nothing to bundle and the archive is still a full restore
            // point. Deliberately NOT a `noop`: that would make the operation
            // `partial` and say "this is not a restore point", which would be false.
            op.settle(
              gameWorld
                ? `No custom map to copy — "${gameWorld}" ships with the server`
                : "No world map named in the config"
            );
          }

          // 3) sdtdserver.xml
          if (xml) await writeFile(path.join(work, "sdtdserver.xml"), xml, "utf-8");

          // 4) manifest
          // `flushed` goes in the manifest so a restore can say whether this archive came
          // from a quiesced world rather than leaving that to be assumed. Older bundles
          // have no such key, which reads as `undefined` — honestly "unknown".
          const manifest: Manifest = {
            createdAt: new Date().toISOString(),
            gameWorld,
            includesWorldMap,
            flushed,
          };
          await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

          const filename = `7dtd-${gameWorld || "world"}-${stamp}.tar.gz`.replace(/[^a-zA-Z0-9._-]/g, "_");
          target = path.join(BACKUP_DIR, filename);

          // The last boundary before a `tar` nothing can interrupt.
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

          // Only now: a sidecar for an archive the refusal above deleted would keep
          // `worldsUsedByBackups` refusing to delete a world nothing depends on.
          await writeManifestSidecar(target, manifest);

          const facts: OperationFact[] = [];
          if (size != null) facts.push({ label: "Size", value: formatBytes(size) });
          facts.push({
            label: "World map",
            value: includesWorldMap ? "included" : "not needed (stock world)",
          });
          facts.push({
            label: "Saves flushed first",
            value: flushed ? "yes" : "not needed — the server was not running",
          });
          return {
            facts,
            value: {
              name: filename,
              size: size ?? 0,
              createdAt: mtime.toISOString(),
              world: gameWorld || null,
              includesWorldMap,
            },
          };
        }
      );
      await logBackup(session.user.id, "backup_create", {
        name: backup.name,
        sizeBytes: backup.size,
        world: backup.world,
        includesWorldMap: backup.includesWorldMap,
      });
      return NextResponse.json({ success: true, backup });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz
      // that the listing would offer as restorable — and its sidecar has to go with it,
      // or the manifest outlives the archive it describes.
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
      // A running server holds the save in memory and writes it back on its next
      // autosave, so restoring underneath it changed nothing that survived — and
      // still reported success. `withGameStopped` saves + stops first, restores,
      // and starts again only if it was running; it also holds the control lock,
      // so a Power on can't race in halfway through and the banner can say what
      // is happening.
      const { restarted } = await withGameStopped(
        "7dtd",
        "restart",
        async (op) => {
          op.step("Restoring the saves from backup");
          op.detail(name);
          await restoreBundle(backupPath, m);
          op.settle(
            m?.includesWorldMap
              ? "Replaced the saves and the world map"
              : "Replaced the saves"
          );
          op.fact({ label: "Archive", value: name });
          if (m?.gameWorld) op.fact({ label: "World", value: m.gameWorld });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: session.user.name,
          restartOnFailure: false,
        }
      );
      await logBackup(session.user.id, "backup_restore", {
        name,
        world: m?.gameWorld ?? null,
        includesWorldMap: m?.includesWorldMap ?? false,
        restartedAfter: restarted,
      });
      return NextResponse.json({ success: true, restoredWorld: m?.gameWorld ?? null, restarted });
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
    const laneBusy = fileLaneBusy("7dtd");
    if (laneBusy) return laneBusy;

    // `stat` first, for the same reason the `restore` branch above does it: deleting a
    // name that isn't there answered **500** with the raw
    // `ENOENT: … lstat '/app/data/backups-7dtd/does-not-exist.tar.gz'`, which both
    // claims the server broke and prints a container path into the browser.
    const target = path.join(BACKUP_DIR, name);
    try {
      await stat(target);
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }

    try {
      await rm(target);
      await removeManifestSidecar(target);
      await logBackup(session.user.id, "backup_delete", { name });
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
 * `backup_*`. A restore replaces the save people play, and a restore does not even go
 * through `/api/games/control`, so it left no `server_stop`/`server_start` either:
 * "when did the world get replaced, and by whom" was unanswerable ten minutes later.
 *
 * `game` has to be in `details`: `/api/activity` selects each world's panel with
 * `contains "<game>"`, and an untagged row is shown to everyone.
 *
 * Logged rather than swallowed, following `mc-whitelist`'s precedent. Only ever called
 * after the work succeeded — a refused backup writes nothing, because a log of things
 * that did not happen is worse than no log.
 */
async function logBackup(
  userId: string,
  action: "backup_create" | "backup_restore" | "backup_delete",
  details: Record<string, unknown>
): Promise<void> {
  try {
    await db.activity.create({
      data: { userId, action, details: JSON.stringify({ game: "7dtd", ...details }) },
    });
  } catch (e) {
    console.error(`[7dtd/backups] could not write the ${action} activity row:`, e);
  }
}

/**
 * Ask 7DTD to write its save to disk before the copy, over telnet.
 *
 * Returns whether the flush was asked for at all — `false` means the container is not
 * running, which is a `noop` step rather than a failure. A telnet failure is recorded as
 * a warn and does NOT abort: a torn archive beats no archive, and an unreachable server
 * is exactly when someone wants a backup.
 *
 * No `save-off`: 7DTD has no such command, so there is nothing to pause and nothing to
 * re-enable in a `finally`.
 */
async function flushSaves(op: OpHandle): Promise<boolean> {
  op.step("Flushing the saves to disk");
  if (!(await containerIsRunning("7dtd").catch(() => false))) {
    // `done`, NOT `noop`: a stopped server's files are already consistent, which is the
    // best case for a backup. As `noop` this concluded `partial` and the summary read
    // "but part of it is missing. This is not a restore point." for a flawless archive.
    op.settle("The server is stopped — its files are already at rest");
    return false;
  }
  const t0 = Date.now();
  try {
    await sdtdSaveWorld();
    op.settle(`Flushed the saves — ${Date.now() - t0} ms`);
    return true;
  } catch (e) {
    op.settle("Could not flush the saves — the server did not answer over telnet");
    op.fact({
      label: "Save flush",
      value: `failed (${(e as Error).message}) — the archive may be torn`,
      verdict: "warn",
    });
    return true;
  }
}

/**
 * Extract the bundle, check each piece is really in it, and only then replace the
 * live copy. Every step below used to be `rm -rf <live>` followed by `cp … || true`
 * with the whole block wrapped in a swallow, so a bundle missing its `Saves/`
 * deleted the save, copied nothing, and answered `{success:true}`.
 */
async function restoreBundle(backupPath: string, m: Manifest | null): Promise<void> {
  const work = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", backupPath, "-C", work], { timeout: TAR_TIMEOUT_MS });

    // Saves/ (replace) — assert it exists BEFORE removing the live one.
    const savesSrc = path.join(work, "Saves");
    if (!(await isDir(savesSrc))) {
      throw new BadArchiveError("This backup has no Saves folder in it — nothing was changed.");
    }
    await rm(path.join(SDTD_DIR, "Saves"), { recursive: true, force: true });
    await execFileAsync("cp", ["-a", savesSrc, SDTD_DIR]);

    // The custom world map, if the bundle carries one.
    //
    // `m.gameWorld` is read out of a manifest.json *inside the archive*, so it is
    // attacker-controlled for anyone who can put a file in the backups directory.
    // Two lines below it reaches `rm(..., {recursive: true, force: true})` running
    // as root, where `"../.."` would climb out of GeneratedWorlds. Require it to be
    // a single path segment and nothing else.
    if (m?.includesWorldMap && m.gameWorld) {
      if (m.gameWorld !== path.basename(m.gameWorld) || m.gameWorld.startsWith(".")) {
        throw new BadArchiveError(
          `This backup's manifest names an unusable world ("${m.gameWorld}") — ` +
            `the saves were restored, the map was left alone.`
        );
      }
      const mapSrc = path.join(work, "GeneratedWorlds", m.gameWorld);
      if (!(await isDir(mapSrc))) {
        throw new BadArchiveError(
          `This backup says it carries the world map for "${m.gameWorld}" but does not — ` +
            `the saves were restored, the map was left alone.`
        );
      }
      const dest = path.join(SDTD_DIR, "GeneratedWorlds");
      await mkdir(dest, { recursive: true });
      await rm(path.join(dest, m.gameWorld), { recursive: true, force: true });
      await execFileAsync("cp", ["-a", mapSrc, dest]);
    }

    // sdtdserver.xml. Older bundles predate it, so absence is fine — a failed
    // write is not, and used to be swallowed.
    const xmlSrc = path.join(work, "sdtdserver.xml");
    const savedXml = await readFile(xmlSrc, "utf-8").catch(() => null);
    if (savedXml !== null) await writeFile(XML_PATH, savedXml, "utf-8");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
