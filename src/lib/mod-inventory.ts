import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AppliedPack } from "./modpack-applied";

/**
 * **What is installed, decided by the directory and not by memory.**
 *
 * `/api/mods/installed` was a bare `db.installedMod.findMany()`, and there was no `readdir`
 * anywhere in the mod code — so "what is installed" was whatever the app last remembered
 * writing, which is a different claim from what the server will load. The two can disagree
 * for reasons that are all ordinary:
 *
 * - someone dropped a jar in with the file browser, so there is a file and no row;
 * - a modpack apply's `removeMod` deleted the row and the `unlink` hit `ENOENT` (it is
 *   swallowed), so the row is gone and the jar is not — or the reverse, where the row
 *   survives a jar that was deleted out from under it;
 * - a restore put the jars back from an archive that carried no inventory, so the whole
 *   mod set is on disk with nothing in the database naming it
 *   (`/api/server/backups` says exactly this and points here for the recovery);
 * - an install landed inside a `mods.apply` window. `fileLaneBusy` is one-directional —
 *   it refuses an install that arrives *after* the apply started and cannot wait for one
 *   already in flight — so that jar survives the wipe and is in nobody's plan. See
 *   `docs/MINECRAFT.md`.
 *
 * None of those is an error. All of them are things an operator can act on **only if the
 * members are named**, which is why the three groups below carry file names rather than
 * counts.
 */

/** How a row got here. `null` is "not recorded" — the column is newer than some rows. */
export type ModProvenance = "pack" | "manual";

/** Does the row and the file agree? */
export type ModFileState =
  /** A row, and the jar it names is in the directory. */
  | "matched"
  /** A jar in the directory that no row names. */
  | "untracked"
  /** A row whose jar is not in the directory. */
  | "missing";

/** The `InstalledMod` columns this reconcile reads. Accepts the Prisma row as-is. */
export interface InstalledModRow {
  id: string;
  modrinthId: string;
  slug: string;
  name: string;
  version: string;
  fileName: string;
  mcVersion: string;
  loader: string;
  installedBy: string;
  installedAt: Date | string;
  source?: string | null;
  versionId?: string | null;
}

/**
 * One entry of the reconciled list — a row, a jar, or both.
 *
 * Shaped for the surface that renders it: every entry carries its name, its version, its
 * provenance, who installed it and when, and whether its file is actually there. An
 * untracked jar has a file and no row, so everything the row would have supplied is
 * `null` and `fileName` is all there is to call it by.
 */
export interface InventoryEntry {
  /** The `InstalledMod` id, or `null` for an untracked jar: there is no row to act on. */
  id: string | null;
  /** The mod's name where a row supplies one, otherwise the file name. */
  name: string;
  fileName: string;
  version: string | null;
  mcVersion: string | null;
  loader: string | null;
  modrinthId: string | null;
  slug: string | null;
  /** `"pack"`, `"manual"`, or `null` for a row written before the column existed. */
  source: ModProvenance | null;
  /** The Modrinth version id the row was created from, where one was recorded. */
  versionId: string | null;
  /** The raw `User.id`, kept so an unresolvable actor is still traceable. */
  installedBy: string | null;
  /**
   * The display name for `installedBy`, where the caller supplied one.
   *
   * `InstalledMod.installedBy` is a plain column with no relation, so this is a lookup the
   * caller does and passes in. `null` means the id did not resolve — the surface then says
   * nothing about who, rather than printing a cuid or guessing at a reason.
   */
  installedByName: string | null;
  /** ISO 8601, so the client needs no date parsing. */
  installedAt: string | null;
  state: ModFileState;
  /** Bytes, off `stat`. `null` when there is no file to stat. */
  sizeBytes: number | null;
  /** Lowercase hex sha512 — only when the caller asked for hashes. See `hashed`. */
  sha512: string | null;
}

export interface ModInventory {
  /**
   * One list, every entry in it: matched rows (newest first, the order the rows arrived
   * in), then untracked jars sorted by name.
   */
  mods: InventoryEntry[];
  /** File names, so each group can be acted on rather than merely counted. */
  matched: string[];
  untracked: string[];
  missing: string[];
  /**
   * Everything in the directory that is not a `.jar` — a sub-directory, a `.jar.disabled`,
   * a `.DS_Store`, a half-written `.tmp`. Not reported as untracked mods, because calling
   * `.DS_Store` an untracked mod is noise; listed rather than dropped, because silently
   * discarding what is in a directory is the habit this whole endpoint exists to break.
   */
  ignored: string[];
  /**
   * `false` means the mods directory does not exist. That is "nothing installed", not an
   * error — a Minecraft server that has never had a mod has no such directory — so every
   * row still reconciles (as `missing`) and nothing throws.
   */
  modsDirPresent: boolean;
  /** Whether `sha512` was computed. `false` leaves every entry's `sha512` null. */
  hashed: boolean;
  /** Sum of `sizeBytes` over the jars that are actually on disk. */
  totalBytes: number;
}

/**
 * **The whole `GET /api/mods/installed` answer: the reconcile plus the two records that
 * frame it.**
 *
 * One request, so the pack strip at the top of the page and the list under it are two
 * readers of *one* reading. They were going to be two components, and two components each
 * fetching the same endpoint is two readings that can disagree about the same server —
 * which is the failure the `matched`/`untracked`/`missing` groups are derived from one
 * list to avoid, one level up.
 */
export interface InstalledReading extends ModInventory {
  /**
   * The most recent recorded modpack apply, or `null` if none has been recorded.
   *
   * A record, not a measurement: it says a pack was applied, not that the jars on disk
   * are still that pack's. The `source` counts are what answer that. See
   * `src/lib/modpack-applied.ts`.
   */
  pack: AppliedPack | null;
  /**
   * What the server is configured to run, so the surface can compare the pack's target
   * against it. `null` when there is no `ServerConfig` row — a state that has to stay
   * distinguishable from "configured, and it agrees", because an absent reading rendered
   * as a disagreement is the mistake every settings surface in this app is built to avoid.
   */
  server: { mcVersion: string; loader: string } | null;
}

/**
 * **Hashing is opt-in (`hash: true`), and `stat` is not.** The reasoning, because the
 * default is the kind of choice that gets reversed by the next person otherwise:
 *
 * - the reconcile verdict does not need a hash. `matched` / `untracked` / `missing` is
 *   decided by comparing names against `readdir`, and no digest can change that answer.
 * - there is nothing to compare a digest against. `checkIntegrity` verifies a download
 *   against Modrinth's published sha512 *before* the jar is written and the digest is not
 *   kept, and no column on `InstalledMod` holds one. So a hash computed here answers
 *   "are these two jars the same bytes" — useful, because the two writers name files
 *   differently (`installMod` uses Modrinth's filename, the Technic path writes
 *   `<slug>.jar`) and the same mod can land twice under two names — and not "is this jar
 *   what the publisher shipped".
 * - cost. This endpoint is fetched on page mount. Production holds 3 jars / 5.8 MB, where
 *   hashing is free; a 166-mod pack is ~400 MB, where it is not, and that is the case the
 *   feature exists for.
 *
 * `stat` stays unconditional: it is one syscall per entry, and the size is itself
 * actionable — a 0-byte jar is a torn download, which is a thing to see without asking.
 */
export async function reconcileMods(
  rows: readonly InstalledModRow[],
  modsDir: string,
  opts: { hash?: boolean; actorNames?: Readonly<Record<string, string>> } = {}
): Promise<ModInventory> {
  const hash = opts.hash === true;
  const actorNames = opts.actorNames ?? {};
  const listing = await listModsDir(modsDir);

  const onDisk = new Set(listing.jars);
  const claimed = new Set<string>();
  const mods: InventoryEntry[] = [];

  for (const row of rows) {
    const present = onDisk.has(row.fileName);
    if (present) claimed.add(row.fileName);
    mods.push({
      id: row.id,
      name: row.name,
      fileName: row.fileName,
      version: row.version,
      mcVersion: row.mcVersion,
      loader: row.loader,
      modrinthId: row.modrinthId,
      slug: row.slug,
      source: normaliseSource(row.source),
      versionId: row.versionId ?? null,
      installedBy: row.installedBy,
      installedByName: actorNames[row.installedBy] ?? null,
      installedAt: isoOf(row.installedAt),
      state: present ? "matched" : "missing",
      sizeBytes: null,
      sha512: null,
    });
  }

  for (const jar of [...listing.jars].sort((a, b) => a.localeCompare(b))) {
    if (claimed.has(jar)) continue;
    mods.push({
      id: null,
      // An untracked jar has no row, so there is no mod name to show. The file name is
      // what it is called and what somebody would go looking for.
      name: jar,
      fileName: jar,
      version: null,
      mcVersion: null,
      loader: null,
      modrinthId: null,
      slug: null,
      source: null,
      versionId: null,
      installedBy: null,
      installedByName: null,
      installedAt: null,
      state: "untracked",
      sizeBytes: null,
      sha512: null,
    });
  }

  // Measure each jar once even when two rows name it, then fan the reading out — a
  // duplicated `fileName` is a state this reconcile should survive rather than bill twice.
  //
  // **Only names `readdir` returned are ever joined onto `modsDir`.** A non-`missing` entry
  // is one whose `fileName` was found in `onDisk`, and a directory entry's name cannot
  // contain a separator — so a row carrying `../../something` stays `missing` and is never
  // opened. Measuring straight off `row.fileName` without that gate would make the
  // database a path the filesystem follows.
  const measured = new Map<string, { size: number | null; sha512: string | null }>();
  for (const entry of mods) {
    if (entry.state === "missing") continue;
    if (!measured.has(entry.fileName)) {
      measured.set(entry.fileName, await measure(path.join(modsDir, entry.fileName), hash));
    }
    const m = measured.get(entry.fileName)!;
    entry.sizeBytes = m.size;
    entry.sha512 = m.sha512;
  }

  // The three groups are **derived from the one list**, so they cannot drift from it: a
  // reader that trusts `untracked` and a reader that filters `mods` get the same answer.
  const named = (state: ModFileState) =>
    mods.filter((m) => m.state === state).map((m) => m.fileName);

  let totalBytes = 0;
  for (const [, m] of measured) totalBytes += m.size ?? 0;

  return {
    mods,
    matched: named("matched"),
    untracked: named("untracked"),
    missing: named("missing"),
    ignored: listing.ignored,
    modsDirPresent: listing.present,
    hashed: hash,
    totalBytes,
  };
}

/** `"pack"` / `"manual"` or nothing. A column value this app does not know reads as
 *  "not recorded" rather than being printed through to the UI verbatim. */
function normaliseSource(value: string | null | undefined): ModProvenance | null {
  return value === "pack" || value === "manual" ? value : null;
}

function isoOf(value: Date | string): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function listModsDir(
  modsDir: string
): Promise<{ present: boolean; jars: string[]; ignored: string[] }> {
  let entries;
  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch (e) {
    // **ENOENT only.** A directory that is not there is "nothing installed"; an EACCES or
    // an EIO is a thing we cannot read, and answering "nothing installed" to that would
    // report every installed mod as missing and every jar as absent — the
    // success-after-reading-nothing shape this repo keeps paying for.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, jars: [], ignored: [] };
    }
    throw e;
  }
  const jars: string[] = [];
  const ignored: string[] = [];
  for (const entry of entries) {
    // **`!isDirectory()`, not `isFile()`.** `readdir` does not follow links, so a jar
    // reached through a symlink answers `isSymbolicLink()` and `isFile()` is false for it
    // — and the server loads it regardless, which makes "is it a regular file" the wrong
    // question. A directory called `extracted.jar` is the case worth excluding: nothing
    // loads it, and `stat`ing it for a size would report an inode's size as a jar's.
    if (!entry.isDirectory() && /\.jar$/i.test(entry.name)) jars.push(entry.name);
    else ignored.push(entry.name);
  }
  return { present: true, jars, ignored: ignored.sort((a, b) => a.localeCompare(b)) };
}

async function measure(
  file: string,
  hash: boolean
): Promise<{ size: number | null; sha512: string | null }> {
  let size: number | null = null;
  try {
    size = (await stat(file)).size;
  } catch {
    // The jar was listed a moment ago and is gone now, or cannot be stat'd. Its presence
    // is still what `readdir` reported — the state is not downgraded on the strength of a
    // failed `stat`, which would make a race look like a deleted mod.
    size = null;
  }
  if (!hash) return { size, sha512: null };
  try {
    const digest = createHash("sha512");
    for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
    return { size, sha512: digest.digest("hex") };
  } catch {
    return { size, sha512: null };
  }
}
