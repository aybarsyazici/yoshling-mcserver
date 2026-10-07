import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm, mkdir, cp } from "fs/promises";
import path from "path";
import { PZ_DIR, savePaths } from "@/lib/zomboid";
import { withGameStopped } from "@/lib/game-manager";
import { conflictResponse, withGameFileWrite, isConflict } from "@/lib/operation-response";
import { BadArchiveError, removeManifestSidecar, safeBackupName } from "@/lib/backup-archive";
import {
  archiveResponse,
  BACKUP_DIRS,
  listArchives,
  readBackupManifest,
} from "@/lib/backup-store";
import { createBackup, type ZomboidManifest } from "@/lib/backup-create";
import { integrityFact, verifyArchive } from "@/lib/backup-integrity";
import { describePolicy, policyFor } from "@/lib/backup-retention";
import { readJournal, recordBackupEvent } from "@/lib/backup-log";
import { intervalMsFor, scheduleEnabled } from "@/lib/backup-schedule";

export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const BACKUP_DIR = BACKUP_DIRS.zomboid;
const TAR_TIMEOUT_MS = 240_000;

// A Project Zomboid backup is self-contained: restoring it rebuilds the world,
// the accounts and the settings exactly as they were.
//   Saves/Multiplayer/<name>/  – the world (map, players, builds)
//   db/<name>.db               – player accounts / whitelist
//   Server/<name>*             – .ini, SandboxVars.lua, spawnregions.lua
// manifest.json records the server name so a restore knows where things go. The shape
// lives in `lib/backup-create.ts`, next to the code that writes it.

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

const backupManifest = (file: string) => readBackupManifest<ZomboidManifest>(BACKUP_DIR, file);

export async function GET(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // ?download=<archive> — see the note in `/api/server/backups`. A PZ archive carries
  // the player database and the `.ini`, which holds the RCON and admin passwords, so it
  // is gated on `settings.edit` and not on read access to the world.
  const download = searchParams.get("download");
  if (download) {
    if (!hasPermission(gate.session.user.role, "settings.edit")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const name = safeBackupName(download);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    try {
      const response = await archiveResponse(BACKUP_DIR, name);
      await recordBackupEvent(
        "zomboid",
        "download",
        { userId: gate.session.user.id, name: gate.session.user.name ?? "" },
        { outcome: "ok", name },
        { action: "backup_download", details: { name } }
      );
      return response;
    } catch {
      return NextResponse.json({ error: "No such backup" }, { status: 404 });
    }
  }

  if (searchParams.get("meta")) {
    const policy = policyFor("zomboid");
    return NextResponse.json({
      policy,
      policyText: describePolicy(policy),
      schedule: {
        enabled: scheduleEnabled(),
        everyHours: Math.round(intervalMsFor("zomboid") / 3_600_000),
      },
      // See the note in `/api/server/backups`: the journal's `error` strings are raw
      // thrown messages and can carry container paths, so they follow `settings.edit`.
      journal: hasPermission(gate.session.user.role, "settings.edit")
        ? await readJournal("zomboid", 8)
        : [],
      // See the note in `/api/server/backups`.
      canDownload: hasPermission(gate.session.user.role, "settings.edit"),
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
          world: m?.serverName ?? null,
          includesWorldMap: m?.includesWorld ?? false,
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
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  if (!hasPermission(gate.session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();
  const actor = { userId: gate.session.user.id, name: gate.session.user.name ?? "" };

  if (action === "create") {
    try {
      // Measured on the box: 442,064 files / 1.9 GB of Saves → ~11 minutes and a ~290 MB
      // archive. Far past Cloudflare's ~100s origin read timeout, so the client's own
      // response is not a reliable source of truth for the outcome — server-side tracking
      // is the only possible mechanism here, not a nicety. The work lives in
      // `lib/backup-create.ts` so the scheduler takes the identical backup.
      const { backup, pruned } = await createBackup("zomboid", actor);
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
      const serverName = m?.serverName ?? (await savePaths()).name;

      // Checksum **before** `withGameStopped`. A Project Zomboid stop-and-start is the
      // most expensive thing this app does, and refusing a corrupt archive after paying
      // for it would be the wrong order. An archive with no recorded checksum is unknown
      // rather than bad, so it is reported as a fact, not refused.
      const integrity = await verifyArchive(BACKUP_DIR, name, m);

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
          op.fact(integrityFact(integrity));
          op.fact({ label: "World", value: serverName });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: gate.session.user.name,
          restartOnFailure: false,
        }
      );
      await recordBackupEvent(
        "zomboid",
        "restore",
        actor,
        { outcome: "ok", name, detail: serverName },
        {
          action: "backup_restore",
          details: { name, world: serverName, restartedAfter: restarted },
        }
      );
      return NextResponse.json({
        success: true,
        restoredWorld: serverName,
        restarted,
        checksum: integrity.state,
      });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A restore that half-happened leaves Project Zomboid powered off
      // (`restartOnFailure: false`), and until now the only durable trace of that was the
      // world being off. A conflict is excluded above: it never started.
      const error = (e as Error).message || "Restore failed";
      await recordBackupEvent(
        "zomboid",
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
    // A `backup.restore` declares every `files:` lane, which is what makes "never delete
    // the archive a restore is reading" enforced rather than assumed.
    return withGameFileWrite("zomboid", async () => {

      const target = path.join(BACKUP_DIR, name);
      try {
        await stat(target);
      } catch {
        return NextResponse.json({ error: "No such backup" }, { status: 404 });
      }

      try {
        assertFileWriteActive();
        await rm(target);
        await removeManifestSidecar(target);
        await recordBackupEvent(
          "zomboid",
          "delete",
          actor,
          { outcome: "ok", name },
          { action: "backup_delete", details: { name } }
        );
        return NextResponse.json({ success: true });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
      }

    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
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
  m: ZomboidManifest | null
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
  assertFileWriteActive();
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", backupPath, "-C", work], { timeout: TAR_TIMEOUT_MS });

    // World (replace) — assert it is in the archive BEFORE removing the live one.
    const worldSrc = path.join(work, "Saves", "Multiplayer", serverName);
    if (await exists(worldSrc)) {
      const worldDest = path.join(PZ_DIR, "Saves", "Multiplayer", serverName);
      await mkdir(path.dirname(worldDest), { recursive: true });
      assertFileWriteActive();
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
    assertFileWriteActive();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
