import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { stat, rm, mkdir } from "fs/promises";
import path from "path";
import { getMinecraftTarget, withGameStopped } from "@/lib/game-manager";
import { isConflict, conflictResponse, withGameFileWrite } from "@/lib/operation-response";
import {
  BadArchiveError,
  removeManifestSidecar,
  safeBackupName,
} from "@/lib/backup-archive";
import { archiveResponse, BACKUP_DIRS, listArchives, readBackupManifest } from "@/lib/backup-store";
import { createBackup, MC_DIR, type McManifest } from "@/lib/backup-create";
import {
  describeMembers,
  manifestIncludesMods,
  restoreMinecraftArchive,
} from "@/lib/mc-archive";
import { integrityFact, verifyArchive } from "@/lib/backup-integrity";
import { describePolicy, policyFor } from "@/lib/backup-retention";
import { readJournal, recordBackupEvent } from "@/lib/backup-log";
import { intervalMsFor, scheduleEnabled } from "@/lib/backup-schedule";
import { validateMcRollbackMetadata } from "@/lib/mc-rollback-metadata";

// A restore now saves + stops the world, swaps the files and starts it again, so
// the request lives as long as a graceful stop plus an extract.
export const maxDuration = 300;

const BACKUP_DIR = BACKUP_DIRS.minecraft;

/**
 * Long enough for a big world. Was 60s, which is a coin-toss for a 170 MB world
 * on a busy box; the restore holds the control lock and the lock heartbeats, so
 * a long tar can't lose it partway through.
 */
const TAR_TIMEOUT_MS = 300_000;

/** Sidecars are fast; pack rollback metadata also survives inside downloaded tar files. */
async function mcManifest(name: string): Promise<McManifest | null> {
  return readBackupManifest<McManifest>(BACKUP_DIR, name);
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const { searchParams } = new URL(request.url);

  // ?download=<archive> — hand one archive out so a backup can live somewhere other
  // than the box that might lose it.
  //
  // Gated like the mutations (`settings.edit`), not like the listing: an archive is the
  // world's full save data plus, for the other two games, the player database and the
  // server config — i.e. the most sensitive single file this app can produce. A MEMBER may
  // see that backups exist; taking one off the box is a different act.
  const download = searchParams.get("download");
  if (download) {
    if (!hasPermission(session.user.role, "settings.edit")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const name = safeBackupName(download);
    if (!name) return NextResponse.json({ error: "Invalid backup name" }, { status: 400 });
    try {
      const response = await archiveResponse(BACKUP_DIR, name);
      // Recorded before the stream is returned, because once the body is streaming this
      // handler is done and there is no later point to log from. A download is the one
      // backup action with no visible trace at all otherwise.
      await recordBackupEvent(
        "minecraft",
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

  // ?meta=1 — the retention policy, the schedule and the durable journal, for the page's
  // header. A separate parameter rather than a changed response shape, so the listing
  // stays the plain array every existing caller expects.
  if (searchParams.get("meta")) {
    const policy = policyFor("minecraft");
    return NextResponse.json({
      policy,
      policyText: describePolicy(policy),
      schedule: {
        enabled: scheduleEnabled(),
        everyHours: Math.round(intervalMsFor("minecraft") / 3_600_000),
      },
      // The journal only for someone who could also take or restore a backup: its `error`
      // strings are raw thrown messages and can carry container paths
      // (`ENOENT … /app/data/backups/…`), which is the class of leak the file-browser GETs
      // were fixed for. The policy and the schedule stay visible to anyone who can see the
      // world, because "why did an archive disappear" is a fair question for a reader.
      journal: hasPermission(session.user.role, "settings.edit")
        ? await readJournal("minecraft", 8)
        : [],
      // Whether the Download button should be rendered at all.
      //
      // The download endpoint requires `settings.edit`; the button did not know that, and
      // it carried `download="<archive>.tar.gz"` — so a viewer without the capability got
      // a 27-byte file called `world-2026-09-29T19-35-16.tar.gz` containing
      // `{"error":"Forbidden"}` and a completed-download indicator. Success reported after
      // doing nothing, by this round's own new feature. The `download` attribute is gone
      // too (`archiveResponse` sets Content-Disposition, so the filename still comes out
      // right on the success path, and an error now renders in the tab where it can be
      // read) — but not offering an action that will be refused is the better half of the
      // fix.
      canDownload: hasPermission(session.user.role, "settings.edit"),
    });
  }

  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const backups = await Promise.all(
      (await listArchives(BACKUP_DIR)).map(async (a) => {
        // A sidecar read, not a `tar -xzO`: it is a ~150-byte file, so unlike 7DTD's and
        // PZ's in-tar fallback this costs nothing per archive.
        const m = await mcManifest(a.name);
        return {
          name: a.name,
          size: a.size,
          createdAt: new Date(a.createdAtMs).toISOString(),
          verifiable: Boolean(m?.sha256),
          automatic: m?.automatic ?? false,
          // Whether a restore of this one would bring the installed jars back.
          //
          // Routine backups are world-only and the archive `install-modpack` takes before
          // it deletes every jar is not, and the two are listed side by side under names
          // that both end in `.tar.gz` — so without this the page cannot tell you which of
          // the two things in front of you is the one that undoes a modpack apply. Read off
          // the manifest's `members`, never by opening the tar: that costs a full gzip
          // decompression per archive (measured at 7.9 s for one listing).
          includesMods: manifestIncludesMods(m),
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
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();
  const actor = { userId: session.user.id, name: session.user.name ?? "" };

  if (action === "create") {
    try {
      // The work itself lives in `lib/backup-create.ts`, because the scheduler in
      // `instrumentation.ts` has to take the *same* backup — same flush, same pre-emption
      // boundaries, same checksum, same retention pass. A second, simpler create for the
      // timer is the drift this codebase has already paid for with the power control.
      const { backup, pruned } = await createBackup("minecraft", actor);
      return NextResponse.json({ success: true, backup, pruned });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
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
      // Checksum first, and **before** `withGameStopped`. A corrupt archive then costs
      // nothing at all — no downtime, no staging dir, no `rm` — which is the whole point of
      // checking cheaply. Getting this the other way round is the shape the old
      // `rm -rf world`-then-extract had, and the one worth never repeating.
      //
      // An archive with no recorded checksum is *unknown*, not *bad*: every archive on the
      // box today predates them. It is reported as a fact rather than refused.
      const integrity = await verifyArchive(BACKUP_DIR, name, await mcManifest(name));

      // What the restore actually put back, in words, read out of the archive rather than
      // assumed from the request. An archive taken before a modpack apply carries `mods`
      // as well as `world`; every other Minecraft archive carries only `world` and leaves
      // the live mods directory alone. The step label, the fact, the durable row and the
      // response all come from this one value, so none of them can claim the jars came
      // back when they did not.
      let replaced = "";
      let restoredMods = 0;
      let inventoryKnown = false;
      let provenanceRecorded = false;
      // Resolve and validate recorded metadata before downtime. A missing legacy
      // inventory or target stays explicitly unknown; a modern archive can recover
      // its record from manifest.json even if the downloaded tar lost its sidecar.
      const manifest = await mcManifest(name);
      validateMcRollbackMetadata(manifest);
      if (manifest?.minecraftTarget) {
        const current = await getMinecraftTarget();
        if (!current || current.mcVersion !== manifest.minecraftTarget.mcVersion ||
            current.loader !== manifest.minecraftTarget.loader.toLowerCase()) {
          return NextResponse.json({ error: "This archive records a different Minecraft target. Review and explicitly set the server version/loader before restoring; nothing was replaced.",
            recordedTarget: manifest.minecraftTarget }, { status: 409 });
        }
      }

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
          const result = await restoreMinecraftArchive({
            archivePath: backupPath,
            mcDir: MC_DIR,
            timeoutMs: TAR_TIMEOUT_MS,
          });
          replaced = describeMembers(result.replaced);
          op.settle(`Replaced ${replaced}`);
          op.fact({ label: "Archive", value: name });
          op.fact({ label: "Replaced", value: replaced });
          op.fact(integrityFact(integrity));

          // **Put the inventory back with the jars.** `removeMod` deletes each
          // `InstalledMod` row along with its file, so restoring only the directory left the
          // Mods page claiming nothing was installed while the jars sat on disk — the files
          // were reversible and the app's record of them was not, which is a quieter version
          // of the same defect the restore was fixed for.
          //
          // The rows come out of the manifest because they cannot be reconstructed: a
          // filename does not carry a Modrinth project id. Only an archive taken by a modpack
          // apply has them; a routine world-only backup has nothing to say about mods and is
          // left alone.
          if (result.replaced.includes("mods")) {
            if (Array.isArray(manifest?.installedMods)) {
              const rows = manifest.installedMods.map(m => ({
                ...(m.id ? { id: m.id } : {}),
                modrinthId: m.modrinthId, slug: m.slug, name: m.name, version: m.version,
                fileName: m.fileName, mcVersion: m.mcVersion, loader: m.loader,
                source: m.source ?? null, versionId: m.versionId ?? null,
                // Legacy absent ownership remains unknown rather than becoming the
                // current viewer's historical installation attribution.
                installedBy: m.installedBy ?? "",
                ...(m.installedAt ? { installedAt: new Date(m.installedAt) } : {}),
                ...(m.updatedAt ? { updatedAt: new Date(m.updatedAt) } : {}),
              }));
              await db.$transaction(async (tx: Pick<typeof db, "installedMod">) => {
                await tx.installedMod.deleteMany();
                if (rows.length) await tx.installedMod.createMany({ data: rows });
                const after = await tx.installedMod.findMany();
                const project = (m: typeof rows[number]) => ({
                  modrinthId: m.modrinthId, slug: m.slug, name: m.name, version: m.version,
                  fileName: m.fileName, mcVersion: m.mcVersion, loader: m.loader,
                  source: m.source ?? null, versionId: m.versionId ?? null, installedBy: m.installedBy,
                });
                const expected = rows.map(project).sort((a, b) => a.fileName.localeCompare(b.fileName));
                const found: ReturnType<typeof project>[] = after.map(project);
                found.sort((a, b) => a.fileName.localeCompare(b.fileName));
                if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error("Restored mod inventory readback failed; the server remains stopped");
                for (const wanted of rows) {
                  const actual = after.find((row: typeof wanted) => row.fileName === wanted.fileName);
                  if (wanted.id && actual?.id !== wanted.id) throw new Error("Restored inventory identity readback failed");
                  for (const key of ["installedAt", "updatedAt"] as const) {
                    if (wanted[key] && actual?.[key]?.getTime() !== wanted[key].getTime()) throw new Error("Restored inventory history readback failed");
                  }
                }
              });
              restoredMods = rows.length;
              inventoryKnown = true;
              provenanceRecorded = manifest.installedMods.every(m => Object.hasOwn(m, "source") && Object.hasOwn(m, "versionId") &&
                Object.hasOwn(m, "installedBy") && Object.hasOwn(m, "installedAt"));
              op.fact({ label: "Mod inventory", value: `${rows.length} restored and read back` });
              if (!provenanceRecorded) {
                op.fact({ label: "Provenance", value: "The archive did not record complete provenance, version pins or installation history", verdict: "warn" });
              }
            } else {
              op.fact({ label: "Mod inventory", value: "Unknown: this archive has no usable recorded inventory", verdict: "warn" });
            }
          }
          if (!manifest?.minecraftTarget) op.fact({ label: "Recorded target", value: "Unknown: this archive has no usable recorded Minecraft target", verdict: "warn" });
        },
        {
          kind: "backup.restore",
          title: "Restoring a backup",
          startedBy: session.user.name,
          // A half-replaced world is worse than a stopped one: the game would rewrite
          // the mess on its first autosave. Staying down keeps the archive usable.
          restartOnFailure: false,
          beforeStop: async () => {
            if (!manifest?.minecraftTarget) return;
            const actual = await getMinecraftTarget();
            if (actual.mcVersion !== manifest.minecraftTarget.mcVersion || actual.loader !== manifest.minecraftTarget.loader.toLowerCase()) {
              throw new Error("The Minecraft target changed before restore admission. No files were replaced or server stopped.");
            }
          },
        }
      );
      await recordBackupEvent(
        "minecraft",
        "restore",
        actor,
        { outcome: "ok", name, detail: integrity.state },
        // `replaced` in the durable row, because the registry drops the record after six
        // hours and "did that restore put the mods back" is a question asked later.
        { action: "backup_restore", details: { name, restartedAfter: restarted, replaced } }
      );
      return NextResponse.json({ success: true, restarted, checksum: integrity.state, replaced,
        restoredMods: inventoryKnown ? restoredMods : null, inventoryKnown, provenanceRecorded,
        recordedTarget: manifest?.minecraftTarget ?? null,
      });
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // A restore that started and did not finish is the single most important thing in
      // this feature to be able to find later, and until now nothing recorded one: the
      // registry drops the record after six hours and `/activity` only ever saw successes.
      // A conflict is excluded above — it never started, and a log of things that did not
      // happen is worse than no log.
      const error = (e as Error).message || "Restore failed";
      await recordBackupEvent(
        "minecraft",
        "restore",
        actor,
        { outcome: "failed", name, error },
        { action: "backup_failed", details: { what: "restore", name, error } }
      );
      // A valid gzip archive that turns out not to contain a `world/` folder is the
      // user being wrong about their own file, and it answered **500** — "the server
      // broke" — for a sentence that reads like advice. The message is unchanged; only
      // the status was a lie.
      if (e instanceof BadArchiveError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      return NextResponse.json({ error }, { status: 500 });
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
    // restore is reading it, or while a create is writing into the same directory. A
    // `backup.restore` declares every `files:` lane, so "never delete the archive an
    // operation is mid-restore from" is this check and not a hope.
    return withGameFileWrite("minecraft", async () => {

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
          "minecraft",
          "delete",
          actor,
          { outcome: "ok", name },
          { action: "backup_delete", details: { name } }
        );
        return NextResponse.json({ success: true });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 500 });
      }

    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
