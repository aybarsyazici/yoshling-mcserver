import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { stat, rm, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { withGameStopped } from "@/lib/game-manager";
import { conflictResponse, fileLaneBusy, isConflict } from "@/lib/operation-response";
import { BadArchiveError, removeManifestSidecar, safeBackupName } from "@/lib/backup-archive";
import {
  archiveResponse,
  BACKUP_DIRS,
  listArchives,
  readBackupManifest,
} from "@/lib/backup-store";
import {
  createBackup,
  SDTD_DIR,
  SDTD_XML_PATH,
  type SevenDaysManifest,
} from "@/lib/backup-create";
import { integrityFact, verifyArchive } from "@/lib/backup-integrity";
import { describePolicy, policyFor } from "@/lib/backup-retention";
import { readJournal, recordBackupEvent } from "@/lib/backup-log";
import { intervalMsFor, scheduleEnabled } from "@/lib/backup-schedule";

export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const BACKUP_DIR = BACKUP_DIRS["7dtd"];
const TAR_TIMEOUT_MS = 240_000;

// A self-contained 7DTD backup bundles three things so a restore fully rebuilds
// the world's state:
//   Saves/                    – game progress (players, explored chunks, builds)
//   GeneratedWorlds/<world>/   – the custom map itself (if the active world is custom)
//   sdtdserver.xml             – server settings (incl. which world/game is active)
// A manifest.json records the world name so the UI can show it and so world
// deletion can refuse to remove a world that a backup depends on. The shape lives in
// `lib/backup-create.ts`, next to the code that writes it.

async function isDir(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

const backupManifest = (file: string) =>
  readBackupManifest<SevenDaysManifest>(BACKUP_DIR, file);

/** Which custom worlds are referenced by existing backups (for delete-guard). */
export async function worldsUsedByBackups(): Promise<Set<string>> {
  const used = new Set<string>();
  for (const a of await listArchives(BACKUP_DIR)) {
    const m = await backupManifest(a.name);
    if (m?.includesWorldMap && m.gameWorld) used.add(m.gameWorld);
  }
  return used;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;

  const { searchParams } = new URL(request.url);

  // ?download=<archive> — see the note in `/api/server/backups`. Gated on
  // `settings.edit` rather than on mere read access: a 7DTD archive is the whole save
  // plus `sdtdserver.xml`, which contains the telnet password.
  const download = searchParams.get("download");
  if (download) {
    if (!hasPermission(session.user.role, "settings.edit")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const name = safeBackupName(download);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    try {
      const response = await archiveResponse(BACKUP_DIR, name);
      await recordBackupEvent(
        "7dtd",
        "download",
        { userId: session.user.id, name: session.user.name ?? "" },
        { outcome: "ok", name },
        { action: "backup_download", details: { name } }
      );
      return response;
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }
  }

  if (searchParams.get("meta")) {
    const policy = policyFor("7dtd");
    return NextResponse.json({
      policy,
      policyText: describePolicy(policy),
      schedule: {
        enabled: scheduleEnabled(),
        everyHours: Math.round(intervalMsFor("7dtd") / 3_600_000),
      },
      // See the note in `/api/server/backups`: the journal's `error` strings are raw
      // thrown messages and can carry container paths, so they follow `settings.edit`.
      journal: hasPermission(session.user.role, "settings.edit")
        ? await readJournal("7dtd", 8)
        : [],
    });
  }

  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const backups = await Promise.all(
      (await listArchives(BACKUP_DIR)).map(async (a) => {
        const m = await backupManifest(a.name);
        return {
          name: a.name,
          size: a.size,
          createdAt: new Date(a.createdAtMs).toISOString(),
          world: m?.gameWorld ?? null,
          includesWorldMap: m?.includesWorldMap ?? false,
          verifiable: Boolean(m?.sha256),
          automatic: m?.automatic ?? false,
        };
      })
    );
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
  const actor = { userId: session.user.id, name: session.user.name ?? "" };

  if (action === "create") {
    try {
      // The work lives in `lib/backup-create.ts` so the scheduler takes the same backup —
      // same telnet flush, same pre-emption boundaries, same checksum, same retention.
      const { backup, pruned } = await createBackup("7dtd", actor);
      return NextResponse.json({ success: true, backup, pruned });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      return NextResponse.json({ error: (e as Error).message || "Backup failed" }, { status: 500 });
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

    const m = await backupManifest(name);
    try {
      // Checksum **before** the world is stopped: a corrupt archive then costs no
      // downtime at all. An archive with no recorded checksum is unknown, not bad —
      // every archive on the box today predates them — so it is reported, not refused.
      const integrity = await verifyArchive(BACKUP_DIR, name, m);

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
            m?.includesWorldMap ? "Replaced the saves and the world map" : "Replaced the saves"
          );
          op.fact({ label: "Archive", value: name });
          op.fact(integrityFact(integrity));
          if (m?.gameWorld) op.fact({ label: "World", value: m.gameWorld });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: session.user.name,
          restartOnFailure: false,
        }
      );
      await recordBackupEvent(
        "7dtd",
        "restore",
        actor,
        { outcome: "ok", name, detail: m?.gameWorld ?? integrity.state },
        {
          action: "backup_restore",
          details: {
            name,
            world: m?.gameWorld ?? null,
            includesWorldMap: m?.includesWorldMap ?? false,
            restartedAfter: restarted,
          },
        }
      );
      return NextResponse.json({
        success: true,
        restoredWorld: m?.gameWorld ?? null,
        restarted,
        checksum: integrity.state,
      });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A failed restore is the thing people need to find an hour later, and nothing used
      // to record one. A conflict is excluded above: it never started.
      const error = (e as Error).message || "Restore failed";
      await recordBackupEvent(
        "7dtd",
        "restore",
        actor,
        { outcome: "failed", name, error },
        { action: "backup_failed", details: { what: "restore", name, error } }
      );
      // The archive is wrong about itself — the user's own file, not a broken server.
      if (e instanceof BadArchiveError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      return NextResponse.json({ error }, { status: 500 });
    }
  }

  if (action === "delete") {
    const name = safeBackupName(backupName);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });

    // The lane, for the same reason the config endpoints take it: deleting an archive
    // while a restore reads it, or while a create writes into this directory, is the
    // case worth refusing. An `rm` is sub-second, so it gets the lane rather than a
    // `runOperation` record — a strip row and a completion toast for it would be noise.
    // `backup.restore` declares every `files:` lane, so this is also what makes "never
    // delete the archive a restore is reading" true rather than hoped for.
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
      await recordBackupEvent(
        "7dtd",
        "delete",
        actor,
        { outcome: "ok", name },
        { action: "backup_delete", details: { name } }
      );
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

/**
 * Extract the bundle, check each piece is really in it, and only then replace the
 * live copy. Every step below used to be `rm -rf <live>` followed by `cp … || true`
 * with the whole block wrapped in a swallow, so a bundle missing its `Saves/`
 * deleted the save, copied nothing, and answered `{success:true}`.
 */
async function restoreBundle(backupPath: string, m: SevenDaysManifest | null): Promise<void> {
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
    if (savedXml !== null) await writeFile(SDTD_XML_PATH, savedXml, "utf-8");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
