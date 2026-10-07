import { readFile, rm, writeFile } from "fs/promises";
import type { OpHandle } from "@/lib/operations";

/**
 * The parts of a backup route that are worth asserting on, in one place.
 *
 * `safeBackupName` used to be defined three times — once in each of the Minecraft,
 * 7 Days to Die and Project Zomboid backup routes — with three different docstrings
 * and identical bodies. Three copies of one security predicate is how a fix lands in
 * two of them: the same shape produced the power-control drift this project already
 * paid for. It also could not be tested, because a route module drags in
 * `next/server`, Prisma and the Docker CLI; extracting it is what makes the
 * assertion possible at all.
 */

/**
 * `backupName` arrives straight off a request body and is used both as a filesystem
 * path and as an argument to `tar`, so it has to be closed off before either. Two
 * near-misses this encodes, both real:
 *
 *   - `path.basename` alone stops `../../../etc/passwd` but leaves shell
 *     metacharacters intact, and quoting with `JSON.stringify` produces *double*
 *     quotes — inside which `sh` still runs `$(…)` and backticks.
 *   - `exec()` resolves on the *last* command's exit status, so `x.tar.gz; true`
 *     made a failed restore answer `{success:true}`.
 *
 * So: an allowlist, and `execFile` (argv array, no shell) for every command in the
 * routes. A space is admitted because `/api/7dtd/reset` names its pre-reset archive
 * after the world ("Reveo Valley") without sanitising it, and with no shell in the
 * picture a space is just a character.
 *
 * The three copies each paired the allowlist with a `name !== path.basename(name)`
 * pre-check. That is dropped, not lost: the allowlist admits no `/` and no `\` and
 * requires the first character to be `[A-Za-z0-9]`, so every input `basename` caught
 * (`../x`, `a/b`, `.`, `..`) is already rejected — and dropping it removes a
 * platform dependency, since `path.basename` treats `\` as a separator on win32 and
 * as an ordinary character on posix. Asserted both ways in
 * `__tests__/backup-names.test.ts`.
 */
export function safeBackupName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._ -]*\.tar\.gz$/.test(name) ? name : null;
}

/**
 * An archive the user's own request is wrong about, as opposed to a broken server.
 *
 * `restoreWorld`/`restoreBundle` throw when a valid-gzip archive turns out not to
 * contain what a restore needs. That is the user telling us about *their* file, and
 * it was answering **500** — "the server broke" — for a sentence that reads like
 * advice. The routes map this class to 400 and keep the sentence verbatim.
 */
export class BadArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArchiveError";
  }
}

/**
 * Refuse interrupted work before the next mutable/publication step begins.
 *
 * `refuseIfPreempted` in `lib/operations.ts` is the post-`tar` guard, and its message
 * ends "It has been deleted" — true there, because the route's `catch` does the `rm`.
 * Called at a step boundary it would be a lie: nothing exists to delete yet.
 *
 * Measured on production 2026-09-29: `op.preempted` was set 94 seconds into a
 * 9m 43s Project Zomboid backup, and the only check ran *after* the 291 MiB tar
 * finished — so the app spent a further ~7m 55s competing for disk with the
 * operation that had already condemned the result, then handed the user nothing.
 * Two of three PZ attempts that afternoon were preempted.
 *
 * Single-mod installation also calls this immediately before publishing a jar.
 * The message must not imply an archive exists or that earlier steps did nothing.
 */
export function refuseIfPreemptedEarly(op: OpHandle, what: string): void {
  if (!op.preempted) return;
  throw new Error(
    `A power operation interrupted ${what}, so this step was not continued. ` +
      `Try again once the server has settled.`
  );
}

/**
 * Where an archive's manifest sits *outside* the archive.
 *
 * Reading the embedded `./manifest.json` costs a full gzip stream decompression to
 * get ~100 bytes: measured on production, `GET /api/7dtd/backups` took **7.9 s** for
 * six 290 MB archives, and the world-delete guard (`worldsUsedByBackups`) does the
 * same walk again. That is the backups page's first paint.
 *
 * The sidecar is a cache, never the source of truth — the copy inside the tar is what
 * keeps an archive self-describing after it is copied off the box, so it stays.
 */
export function manifestSidecarPath(archivePath: string): string {
  return `${archivePath}.manifest.json`;
}

/** Write the sidecar. Never fatal: the archive is already complete and valid without it. */
export async function writeManifestSidecar(archivePath: string, manifest: unknown): Promise<void> {
  await writeFile(manifestSidecarPath(archivePath), JSON.stringify(manifest), "utf-8").catch(
    () => {}
  );
}

/** Read the sidecar, or `null` if there is none (every archive from before this existed). */
export async function readManifestSidecar<T>(archivePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(manifestSidecarPath(archivePath), "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Drop the sidecar.
 *
 * Called everywhere the archive itself is removed — the delete branch and both failure
 * `rm`s in create.
 *
 * An orphan sidecar is not *read* by anything (every caller enumerates `.tar.gz` and a
 * sidecar does not end in it), so this is not load-bearing today. What it prevents is
 * the resurrection case: a later archive written to the same name would silently adopt
 * the old file's manifest and report the wrong world. Names carry a
 * second-resolution timestamp, so that is unlikely rather than impossible — which is
 * exactly the kind of "unlikely" this codebase has been bitten by before.
 */
export async function removeManifestSidecar(archivePath: string): Promise<void> {
  await rm(manifestSidecarPath(archivePath), { force: true }).catch(() => {});
}
