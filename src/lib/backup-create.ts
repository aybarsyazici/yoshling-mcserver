// Taking a backup, for all three worlds.
//
// ## Why this is not in the route handlers any more
//
// Because a backup now has a second caller. The scheduler in `instrumentation.ts` has to
// take exactly the same backup a person does — same flush, same pre-emption boundaries,
// same checksum, same retention pass — and Next compiles route handlers and
// `instrumentation.ts` into separate module graphs, so reaching into a route module from
// the timer would drag `next/server` and NextAuth into the instrumentation graph for the
// sake of one function. (That separation is the same one that made
// `const LIVE = new Map()` in `operations.ts` not be one instance; see the note there.)
//
// The alternative — a second, "simpler" create for the scheduler — is the drift that this
// codebase has already paid for once: the power control existed in three copies and two
// of them missed the running-but-unreachable fix. An automatic backup that skipped the
// flush would be a torn archive nobody asked for.
//
// Every comment moved here came with its measurement; they are the record of why each
// line is the shape it is, so they are kept verbatim rather than summarised.

import { execFile } from "child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import type { GameId } from "@/lib/games";
import { formatBytes } from "@/lib/format";
import { containerIsRunning, RUNTIME } from "@/lib/game-manager";
import { sendCommand } from "@/lib/rcon";
import { sdtdSaveWorld } from "@/lib/telnet";
import { pzSave, savePaths } from "@/lib/zomboid";
import {
  OperationConflictError,
  refuseIfPreempted,
  runOperation,
  type OperationFact,
  type OpHandle,
} from "@/lib/operations";
import {
  refuseIfPreemptedEarly,
  removeManifestSidecar,
  writeManifestSidecar,
} from "@/lib/backup-archive";
import { BACKUP_DIRS, type BaseManifest } from "@/lib/backup-store";
import { sha256File, shortHash } from "@/lib/backup-integrity";
import { applyRetention } from "@/lib/backup-retention";
import { recordBackupEvent } from "@/lib/backup-log";
import { copyTreeCounting, countTree } from "@/lib/backup-copy";

const execFileAsync = promisify(execFile);
const TAR_TIMEOUT_MS = 300_000;

/**
 * The live game directories a backup reads from and a restore writes back into.
 *
 * Off `RUNTIME`, which already owns them, rather than re-deriving
 * `process.env.MC_SERVER_DIR || "/minecraft"` here: the create path and the restore path
 * are now in different files, and a second copy of that expression is one rename away
 * from a restore writing somewhere the backup never read. Exported for the routes, which
 * still own the restore halves.
 */
export const MC_DIR = RUNTIME.minecraft.dir;
/** `.local/share/7DaysToDie` — Saves + GeneratedWorlds. */
export const SDTD_DIR = RUNTIME["7dtd"].dir;
/** `serverfiles` — where `sdtdserver.xml` lives. A separate mount, so not in `RUNTIME`. */
export const SDTD_CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";
export const SDTD_XML_PATH = path.join(SDTD_CONFIG_DIR, "sdtdserver.xml");

// ── manifests ────────────────────────────────────────────────────────────────

/**
 * Minecraft has no in-tar manifest and deliberately still does not get one: its archive
 * is `tar -czf … -C MC_DIR world`, so the only member is `world/`, and the restore asserts
 * exactly that. Adding a `manifest.json` member would change the archive's shape for the
 * sake of metadata that the sidecar holds anyway.
 */
export type McManifest = BaseManifest;

export interface SevenDaysManifest extends BaseManifest {
  /** value of `GameWorld` at backup time */
  gameWorld: string;
  /** true if `GeneratedWorlds/<gameWorld>` was bundled */
  includesWorldMap: boolean;
}

export interface ZomboidManifest extends BaseManifest {
  serverName: string;
  includesWorld: boolean;
  includesDb: boolean;
}

// ── the public shape ─────────────────────────────────────────────────────────

export interface CreatedBackup {
  name: string;
  size: number;
  createdAt: string;
  world?: string | null;
  includesWorldMap?: boolean;
}

export interface CreateResult {
  backup: CreatedBackup;
  /** Archives the retention pass removed. Empty is the normal case. */
  pruned: string[];
}

/**
 * Who asked. `null` means the scheduler — an absence of an actor, not an unknown one.
 *
 * `userId` is here only because `Activity.userId` is a required foreign key; the
 * scheduler has no row to point at, which is why it writes to the journal alone. See
 * `backup-log.ts` for the three dishonest alternatives that were rejected.
 */
export type BackupActor = { userId: string; name: string } | null;

/**
 * Take a backup of one world, record what happened, and apply the retention policy.
 *
 * Throws on failure, having already written the durable record. Two exceptions are
 * deliberate:
 *
 *   - an `OperationConflictError` (the registry refused to admit this at all) writes
 *     **nothing**. Nothing was attempted and no file changed, and "a log of things that
 *     did not happen is worse than no log" is the rule the success-only logging was
 *     built on.
 *   - everything else — including a pre-emption that deleted a half-written archive — is
 *     recorded as a `failed` event, because a backup that started and did not finish is
 *     exactly what someone needs to find later, and the in-memory registry drops it
 *     after six hours.
 */
export async function createBackup(game: GameId, actor: BackupActor): Promise<CreateResult> {
  try {
    const result = await runOperation<CreateResult>(
      {
        kind: "backup.create",
        game,
        title: "Creating a backup",
        // `actor.name` can be empty (a Discord account with no display name), and an
        // empty attribution renders worse than none: the ledger would print "started by"
        // with nothing after it. Absent is the honest rendering of "we don't have a name".
        startedBy: actor?.name ? { name: actor.name } : null,
      },
      (op) => createBody(op, game, actor)
    );

    await recordBackupEvent(
      game,
      "create",
      actor,
      {
        outcome: "ok",
        name: result.backup.name,
        sizeBytes: result.backup.size,
        detail: result.backup.world ?? undefined,
      },
      {
        action: "backup_create",
        details: {
          name: result.backup.name,
          sizeBytes: result.backup.size,
          world: result.backup.world ?? null,
          includesWorldMap: result.backup.includesWorldMap ?? false,
          automatic: actor === null,
        },
      }
    );
    if (result.pruned.length > 0) {
      // Its own event, because it is its own destructive act: it deleted archives a
      // person had asked this app to keep, and "made a backup" is not a record of that.
      await recordBackupEvent(
        game,
        "prune",
        actor,
        { outcome: "ok", names: result.pruned },
        { action: "backup_prune", details: { names: result.pruned, count: result.pruned.length } }
      );
    }
    return result;
  } catch (e) {
    // Refused before it started: nothing was attempted, so nothing is recorded.
    if (e instanceof OperationConflictError) throw e;
    const error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
    await recordBackupEvent(
      game,
      "create",
      actor,
      { outcome: "failed", error },
      { action: "backup_failed", details: { what: "create", error, automatic: actor === null } }
    );
    throw e;
  }
}

function createBody(
  op: OpHandle,
  game: GameId,
  actor: BackupActor
): Promise<{ facts: OperationFact[]; value: CreateResult }> {
  switch (game) {
    case "minecraft":
      return createMinecraft(op, actor);
    case "7dtd":
      return createSevenDays(op, actor);
    case "zomboid":
      return createZomboid(op, actor);
  }
}

// ── the shared tail: prove it, publish it, prune ─────────────────────────────

/**
 * Everything between "the tar command returned" and "the archive is a restore point".
 *
 * The order is the part worth reading, and each boundary is there for a measured reason:
 *
 *  1. `stat` the file and settle the compress step with the real size. Without the
 *     read-back the operation has no evidence at all and concludes `unverified`, which is
 *     the correct visible price for claiming a backup exists without looking.
 *  2. `refuseIfPreempted` — a power operation admitted over this one means the world was
 *     saved and stopped mid-archive. Nothing can abort a `tar`, but publishing the result
 *     as a restore point would be exactly the "reports success after doing the wrong
 *     thing" defect, and the confirm dialog promised deletion.
 *  3. Hash it. ~305 MB takes about a second, against a create that takes minutes.
 *  4. `refuseIfPreempted` **again**, because step 3 is a second or two of new window and
 *     the two things below it are the publishing acts: the sidecar makes the archive
 *     look complete, and the prune deletes other people's archives. Neither should
 *     happen for an archive that is about to be thrown away.
 *  5. Sidecar, then retention.
 *
 * The sidecar is written only after the refusals for the reason already recorded in the
 * routes: one written earlier would outlive the archive that refusal deletes, and be
 * adopted by the next archive to land on the same name.
 */
async function sealArchive(
  op: OpHandle,
  opts: {
    game: GameId;
    target: string;
    filename: string;
    manifest: BaseManifest;
  }
): Promise<{
  size: number | null;
  createdAt: string;
  sha256: string | null;
  pruned: string[];
  facts: OperationFact[];
}> {
  let size: number | null = null;
  let mtime = new Date();
  try {
    const s = await stat(opts.target);
    size = s.size;
    mtime = s.mtime;
  } catch {}
  op.settle(size != null ? `Wrote the archive — ${formatBytes(size)}` : "Wrote the archive");

  refuseIfPreempted(op, "this backup");

  // The checksum, so a restore can refuse a corrupt archive **before** it touches the
  // live world rather than after. It can only live in the sidecar — a hash of the tar
  // cannot be inside the tar — so an archive that loses its sidecar reads as "unrecorded"
  // and a restore says so instead of pretending it checked.
  op.step("Checksumming the archive");
  let sha256: string | null = null;
  try {
    sha256 = await sha256File(opts.target);
    op.settle(`Checksummed the archive — sha256 ${shortHash(sha256)}…`);
  } catch (e) {
    // `done`, not `noop`, and no `warn` fact. The archive itself is complete and its size
    // was read back; all that is missing is the ability to verify it later, which the
    // restore already reports honestly as "not recorded". A `noop` step or a warn fact
    // here would make `summarize()` publish "Backup created — 304 MiB, but … This is not
    // a restore point." for an archive that is one.
    op.settle("Could not checksum the archive — it will restore without verification");
    console.error(`[backups] could not checksum ${opts.target}:`, e);
  }

  refuseIfPreempted(op, "this backup");

  await writeManifestSidecar(opts.target, {
    ...opts.manifest,
    ...(sha256 ? { sha256, archiveBytes: size ?? undefined } : {}),
  } satisfies BaseManifest);

  // The archive that was just written is named explicitly even though it is also the
  // newest (and the newest is never a prune candidate). Two guards for the one file that
  // must survive this is cheap, and it documents the intent at the call site.
  const prune = await applyRetention(op, opts.game, { protect: [opts.filename] });

  const facts: OperationFact[] = [];
  if (size != null) facts.push({ label: "Size", value: formatBytes(size) });
  if (sha256) facts.push({ label: "Checksum", value: `sha256 ${shortHash(sha256)}…` });
  return { size, createdAt: mtime.toISOString(), sha256, pruned: prune.deleted, facts };
}

/** What a manifest records about where the archive came from. */
function provenance(actor: BackupActor): Pick<BaseManifest, "startedBy" | "automatic"> {
  return actor ? { startedBy: actor.name } : { automatic: true };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

async function isDir(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

// ── Minecraft ────────────────────────────────────────────────────────────────

/**
 * Long enough for a real flush.
 *
 * `sendCommand` defaults to 3s, which is the right budget for `list` and far too short
 * for writing a 217 MB world — and the `tar` over the same directory was already raised
 * from 60s to 300s for being too tight. A 3s flush would put the everyday path down the
 * failure branch and stamp a warn fact on every backup.
 */
const FLUSH_RCON_TIMEOUT_MS = 120_000;

/**
 * Two separate facts, so they stop being carried by one boolean.
 *
 * `flushed` answers "is this archive consistent"; `mustResume` answers "did we disable
 * something that has to be put back". They diverge in exactly the case that matters: if
 * `save-off` lands and `save-all flush` then times out, the archive is NOT clean and
 * autosave IS off. One boolean had to pick, it returned `true`, and the record then said
 * "World flushed first: yes" directly above its own warn fact saying it could not flush.
 */
interface FlushResult {
  flushed: boolean;
  mustResume: boolean;
}

/**
 * Ask Minecraft to write the world out and stop writing to it, so `tar` reads a
 * consistent tree. Returns whether autosave was actually paused — the caller must
 * resume it in a `finally` if so.
 *
 * Minecraft is the only one of the three that can do the full dance, because `save-off`
 * genuinely exists in its command set. **Do not add a `save-off` equivalent to 7DTD or
 * Project Zomboid** — neither has one, and inventing a command that silently fails is the
 * defect class this repo keeps cleaning up. Those two get the flush alone.
 *
 * Failure here is deliberately non-fatal and recorded as a warn rather than thrown: a
 * torn archive is much better than no archive, and the world being unreachable over RCON
 * is precisely a moment when someone wants a backup.
 */
async function flushMinecraft(op: OpHandle): Promise<FlushResult> {
  op.step("Flushing the world to disk");
  if (!(await containerIsRunning("minecraft").catch(() => false))) {
    // `done`, NOT `noop`. A stopped server has nothing to flush, and its files on disk
    // are already consistent — which is the best case for a backup, not a shortfall.
    // As `noop` this settled to outcome `partial`, and with no warn fact to name the
    // summary read "Backup created — 217 MB, but part of it is missing. This is not a
    // restore point." in amber, for a flawless archive. Minecraft and 7 Days to Die are
    // both normally stopped, so that was the common path, not an edge case.
    op.settle("The server is stopped — its files are already at rest");
    return { flushed: true, mustResume: false };
  }
  const t0 = Date.now();
  let offLanded = false;
  try {
    // `save-off` first: it stops the autosave thread, so the `save-all flush` that
    // follows is the last write before the copy.
    await sendCommand("save-off", FLUSH_RCON_TIMEOUT_MS);
    offLanded = true;
    await sendCommand("save-all flush", FLUSH_RCON_TIMEOUT_MS);
    op.settle(`Flushed the world and paused autosave — ${Date.now() - t0} ms`);
    return { flushed: true, mustResume: true };
  } catch (e) {
    op.settle("Could not flush the world — the server did not answer over RCON");
    op.fact({
      label: "World flush",
      value: `failed (${(e as Error).message}) — the archive may be torn`,
      verdict: "warn",
    });
    // `mustResume` tracks whether `save-off` actually landed, rather than assuming it
    // did: re-enabling something never disabled is harmless, but claiming autosave was
    // paused when it was not is the lie this function already told once.
    return { flushed: false, mustResume: offLanded };
  }
}

async function resumeMinecraftAutosave(op: OpHandle): Promise<void> {
  try {
    await sendCommand("save-on", FLUSH_RCON_TIMEOUT_MS);
  } catch (e) {
    // `warn`, not `bad`. This is only reached when `save-off` landed, so autosave really
    // is off and it really does need attention — but a `bad` fact makes
    // `concludeOperation` return `failed`, and the archive itself is complete and
    // verified. Reporting a good backup as failed is the defect class this whole feature
    // exists to prevent; the sentence carries the urgency instead of the colour.
    op.fact({
      label: "Autosave",
      value:
        `still paused (${(e as Error).message}) — the backup is fine, but run ` +
        `\`save-on\` in the console or restart Minecraft, or progress since this ` +
        `backup will be lost`,
      verdict: "warn",
    });
  }
}

async function createMinecraft(
  op: OpHandle,
  actor: BackupActor
): Promise<{ facts: OperationFact[]; value: CreateResult }> {
  const dir = BACKUP_DIRS.minecraft;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `world-${stamp}.tar.gz`;
  const target = path.join(dir, filename);
  try {
    await mkdir(dir, { recursive: true });

    // Quiesce the world before reading it off disk. No `create` path used to do this,
    // though every driver exposes a save and the *restore* paths all use one, so a backup
    // taken while people played copied chunk files the server was still midway through
    // writing. `flushed` is recorded either way, so a restore can say whether the archive
    // came from a quiesced world rather than leaving that to be assumed.
    const { flushed, mustResume } = await flushMinecraft(op);

    try {
      // Refuse a doomed backup BEFORE the tar, not only after it. Deliberately *inside*
      // this `try`: throwing above it would skip the `finally` that re-enables autosave,
      // and leaving autosave off loses every minute of play since the backup — strictly
      // worse than the torn archive this whole step exists to prevent. (MC's world tars in
      // ~5s, so the saving here is small; the correctness of where the check sits is not.)
      refuseIfPreemptedEarly(op, "this backup");

      op.step("Compressing the archive");
      await execFileAsync("tar", ["-czf", target, "-C", MC_DIR, "world"], {
        timeout: TAR_TIMEOUT_MS,
      });
    } finally {
      // In a `finally`, and that is the load-bearing part: a failed `tar` that left
      // autosave switched off would lose every minute of play since the backup — strictly
      // worse than the torn archive this whole step exists to prevent. `mustResume`, not
      // `flushed`: the case they differ in is exactly the one that matters — `save-off`
      // landed and the flush then failed, so autosave is off and the archive is torn.
      if (mustResume) await resumeMinecraftAutosave(op);
    }

    const manifest: McManifest = {
      createdAt: new Date().toISOString(),
      flushed,
      ...provenance(actor),
    };
    const sealed = await sealArchive(op, { game: "minecraft", target, filename, manifest });

    const facts: OperationFact[] = [
      ...sealed.facts,
      { label: "World map", value: "included" },
      {
        label: "World flushed first",
        value: flushed
          ? mustResume
            ? "yes — autosave was paused for the copy"
            : "not needed — the server was stopped, so its files were already at rest"
          : "no — the server did not answer, so the archive may be torn",
      },
    ];
    return {
      facts,
      value: {
        backup: { name: filename, size: sealed.size ?? 0, createdAt: sealed.createdAt },
        pruned: sealed.pruned,
      },
    };
  } catch (e) {
    // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz behind, and
    // the listing would offer it as something you can restore. Its sidecar goes with it,
    // or the manifest outlives the archive it describes and is adopted by the next one.
    await rm(target, { force: true }).catch(() => {});
    await removeManifestSidecar(target);
    throw e;
  }
}

// ── 7 Days to Die ────────────────────────────────────────────────────────────

function readGameWorld(xml: string): string {
  const m = xml.match(/<property\s+name="GameWorld"\s+value="([^"]*)"/i);
  return m ? m[1] : "";
}

/**
 * Ask 7DTD to write its save to disk before the copy, over telnet.
 *
 * Returns whether the flush was asked for at all — `false` means the container is not
 * running. A telnet failure is recorded as a warn and does NOT abort: a torn archive
 * beats no archive, and an unreachable server is exactly when someone wants a backup.
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

async function createSevenDays(
  op: OpHandle,
  actor: BackupActor
): Promise<{ facts: OperationFact[]; value: CreateResult }> {
  const dir = BACKUP_DIRS["7dtd"];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const work = path.join(dir, `.work-${stamp}`);
  let target = "";
  try {
    await mkdir(dir, { recursive: true });

    // Ask the game to write its save out before we copy it. No `create` path used to do
    // this, though every driver exposes a save and the *restore* paths all use one, so a
    // backup taken while people played copied files the server was still midway through
    // writing.
    const flushed = await flushSaves(op);

    // Pre-emption is checked at EVERY step boundary from here on, not only after the tar.
    // Measured on production 2026-09-29 (on Project Zomboid, same shape): the flag was set
    // 94 s into a 9m 43s backup and the only check ran last, so the app spent a further
    // ~7m 55s writing an archive it had already decided to delete, competing for disk with
    // the operation that condemned it.
    refuseIfPreemptedEarly(op, "this backup");

    // Determine the active world from the config.
    let xml = "";
    try {
      xml = await readFile(SDTD_XML_PATH, "utf-8");
    } catch {}
    const gameWorld = readGameWorld(xml);

    // Stage the pieces in a work dir, then tar them together.
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });

    // 1) Saves/ — `cp -a` rather than fs.cp because the game container runs as a non-root
    // user and the copy has to keep its ownership. A backup without Saves/ is worthless,
    // so refuse instead of writing one that looks fine.
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
      // Stock world (Navezgane/Pregen…) — it ships with the server, so there is genuinely
      // nothing to bundle and the archive is still a full restore point. Deliberately NOT
      // a `noop`: that would make the operation `partial` and say "this is not a restore
      // point", which would be false.
      op.settle(
        gameWorld
          ? `No custom map to copy — "${gameWorld}" ships with the server`
          : "No world map named in the config"
      );
    }

    // 3) sdtdserver.xml
    if (xml) await writeFile(path.join(work, "sdtdserver.xml"), xml, "utf-8");

    // 4) manifest. `flushed` goes in it so a restore can say whether this archive came
    // from a quiesced world rather than leaving that to be assumed. Older bundles have no
    // such key, which reads as `undefined` — honestly "unknown".
    const manifest: SevenDaysManifest = {
      createdAt: new Date().toISOString(),
      gameWorld,
      includesWorldMap,
      flushed,
      ...provenance(actor),
    };
    await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

    const filename = `7dtd-${gameWorld || "world"}-${stamp}.tar.gz`.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
    target = path.join(dir, filename);

    // The last boundary before a `tar` nothing can interrupt.
    refuseIfPreemptedEarly(op, "this backup");

    op.step("Compressing the archive");
    await execFileAsync("tar", ["-czf", target, "-C", work, "."], { timeout: TAR_TIMEOUT_MS });

    const sealed = await sealArchive(op, { game: "7dtd", target, filename, manifest });

    const facts: OperationFact[] = [
      ...sealed.facts,
      { label: "World map", value: includesWorldMap ? "included" : "not needed (stock world)" },
      {
        label: "Saves flushed first",
        value: flushed ? "yes" : "not needed — the server was not running",
      },
    ];
    return {
      facts,
      value: {
        backup: {
          name: filename,
          size: sealed.size ?? 0,
          createdAt: sealed.createdAt,
          world: gameWorld || null,
          includesWorldMap,
        },
        pruned: sealed.pruned,
      },
    };
  } catch (e) {
    // A tar that died partway (timeout, disk full) leaves a truncated .tar.gz that the
    // listing would offer as restorable — and its sidecar has to go with it, or the
    // manifest outlives the archive it describes.
    if (target) {
      await rm(target, { force: true }).catch(() => {});
      await removeManifestSidecar(target);
    }
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Project Zomboid ──────────────────────────────────────────────────────────

/**
 * Ask Project Zomboid to write the world to disk before the copy, over RCON.
 *
 * Returns whether the flush was asked for at all — `false` means the container is not
 * running. An RCON failure is recorded as a warn and does NOT abort: a torn archive beats
 * no archive, and an unreachable server is exactly when someone wants a backup. (PZ
 * wedging its game loop while the container stays up is a state this box has actually
 * been in — 2026-09-22.)
 *
 * The save itself is fast — ten consecutive `SaveAll` calls measured 94–156 ms on
 * 2026-09-29 — so this adds nothing meaningful to the copy.
 *
 * No `save-off`: Project Zomboid has no such command, so there is nothing to pause and
 * nothing to re-enable in a `finally`.
 */
async function flushWorld(op: OpHandle): Promise<boolean> {
  op.step("Flushing the world to disk");
  if (!(await containerIsRunning("zomboid").catch(() => false))) {
    // `done`, NOT `noop`: see the note in `flushSaves`.
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

async function createZomboid(
  op: OpHandle,
  actor: BackupActor
): Promise<{ facts: OperationFact[]; value: CreateResult }> {
  const dir = BACKUP_DIRS.zomboid;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const work = path.join(dir, `.work-${stamp}`);
  let target = "";
  try {
    await mkdir(dir, { recursive: true });
    const { name, world, db: dbFile, serverDir } = await savePaths();

    const flushed = await flushWorld(op);

    // Pre-emption is checked at EVERY step boundary from here on, not only after the tar.
    // Measured on production 2026-09-29: `op.preempted` was set 94 s into a 9m 43s backup
    // and the only check ran last, so the app spent a further ~7m 55s copying 291 MiB it
    // had already decided to throw away — competing for disk with the power operation that
    // condemned it — and then handed the user an error.
    refuseIfPreemptedEarly(op, "this backup");

    // Stage the pieces in a work dir, then tar them together.
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });

    // 1) the world.
    //
    // Measured on production 2026-09-29: **442,064 files, 1.9 GB, ~11 minutes**, of which
    // this copy is ~10.5 — and it was one opaque "Copying the world" step for all of it,
    // the least informative row in the whole ledger and also the longest. The file count
    // is knowable with a metadata-only walk, so it is counted first and then reported as a
    // real `count` progress. No percentage of bytes and no ETA: those would be numbers
    // this cannot measure.
    // Always true by the time the copy returns — the `else` below refuses — but kept as a
    // manifest field because archives written before that refusal existed can have it
    // false, and `readBackupManifest` has to be able to say so.
    let includesWorld = false;
    let worldFiles = 0;
    if (await exists(world)) {
      op.step("Counting the world's files");
      op.detail(name);
      const total = await countTree(world);
      op.settle(`Counted ${total.toLocaleString()} files`);

      op.step("Copying the world");
      op.detail(name);
      const dest = path.join(work, "Saves", "Multiplayer", name);
      await mkdir(path.dirname(dest), { recursive: true });
      const copied = await copyTreeCounting(world, dest, (done, current) => {
        op.progress({ kind: "count", done, total, noun: "files" });
        op.detail(path.basename(current));
      });
      worldFiles = copied.files;
      includesWorld = true;
      op.settle(`Copied the world — ${copied.files.toLocaleString()} of ${total.toLocaleString()} files`, {
        count: { done: copied.files, total, noun: "files" },
      });
      // Back to indeterminate, or the file count keeps rendering as live progress through
      // the ten minutes of `tar` that follow, which is a number about the wrong step.
      op.progress({ kind: "indeterminate" });
      if (copied.skipped.length > 0) {
        // Named out loud rather than dropped. A save directory should contain nothing but
        // files, directories and symlinks; if it does, silently omitting it from the
        // archive is the defect shape this whole feature is built against.
        op.fact({
          label: "Not copied",
          value: `${copied.skipped.length} entries were neither file, directory nor symlink: ${copied.skipped
            .slice(0, 3)
            .join(", ")}`,
        });
      }
    } else {
      // **Refuse, rather than write a 4 MB archive of the config trio.**
      //
      // This used to settle "No world on disk yet — nothing to copy" as a `noop` and carry
      // on, and that had two consequences neither of which is visible from here. `partial`
      // is a *conclusion*, never a throw, so `runOperation` returned normally, the journal
      // recorded `outcome: "ok"` and the scheduler cleared its failure cooldown. And the
      // archive still took the never-pruned newest slot and still ran retention: simulated
      // against the real `selectForPruning`, five world archives plus one world-less newest
      // one at `keep: 5` selected a genuine restore point for deletion and kept the 4 MB
      // one. Repeat it daily and `keep` days later every real archive is gone, each step
      // logged as a success. It also reset the schedule clock, suppressing the next real
      // attempt for 24h.
      //
      // Refusing matches `createSevenDays` ("No Saves/ in …") and Minecraft (whose `tar -C
      // MC_DIR world` exits non-zero and is deleted in the catch), so all three creates now
      // agree that an archive with no world is not worth writing. It is reachable without
      // anyone doing anything odd: `serverName()` resolves the name by stat-then-guess and
      // prefers `servertest.ini` when the configured name's `.ini` is absent, so a rename
      // through the settings page or a config import that drops a second `.ini` lands here.
      // Loud is the correct answer to that, not a 4 MB archive.
      op.step("Copying the world");
      throw new Error(
        `No world at ${world} — Project Zomboid has not generated one for "${name}" yet, ` +
          `so there is nothing to back up. (If the server does have a world, the server ` +
          `name resolved here may be wrong — check which .ini is in ${serverDir}.)`
      );
    }

    // The world copy is the long one, so this boundary is the one that saves the most.
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
    op.settle("Copied the server config", { count: { done: configFiles, noun: "files" } });

    const manifest: ZomboidManifest = {
      createdAt: new Date().toISOString(),
      serverName: name,
      includesWorld,
      includesDb,
      flushed,
      ...provenance(actor),
    };
    await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest), "utf-8");

    const filename = `zomboid-${name}-${stamp}.tar.gz`.replace(/[^a-zA-Z0-9._-]/g, "_");
    target = path.join(dir, filename);

    // The last boundary before ~10 minutes of `tar` that cannot be interrupted.
    refuseIfPreemptedEarly(op, "this backup");

    op.step("Compressing the archive");
    await execFileAsync("tar", ["-czf", target, "-C", work, "."], { timeout: TAR_TIMEOUT_MS });

    const sealed = await sealArchive(op, { game: "zomboid", target, filename, manifest });

    const facts: OperationFact[] = [
      ...sealed.facts,
      // No `verdict: "warn"` branch any more: there is no path to here with
      // `includesWorld` false, because the copy step now throws instead of settling `noop`.
      // A warn that cannot fire is a claim the reader cannot check.
      { label: "World map", value: "included" },
      { label: "Player database", value: includesDb ? "included" : "not included" },
      {
        label: "World flushed first",
        value: flushed ? "yes" : "not needed — the server was not running",
      },
    ];
    if (worldFiles > 0) facts.push({ label: "Files copied", value: worldFiles.toLocaleString() });
    return {
      facts,
      value: {
        backup: {
          name: filename,
          size: sealed.size ?? 0,
          createdAt: sealed.createdAt,
          world: name,
          includesWorldMap: includesWorld,
        },
        pruned: sealed.pruned,
      },
    };
  } catch (e) {
    if (target) {
      await rm(target, { force: true }).catch(() => {});
      await removeManifestSidecar(target);
    }
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
