// Is this archive the file we wrote?
//
// ## Why a checksum, given `tar` already fails on a corrupt stream
//
// Because the cheapest way to find out was to extract it, and an extract is the point
// of no return for two of the three restores. The Minecraft restore used to
// `rm -rf world` *before* extracting, so a truncated archive left no world at all;
// that is fixed (it stages into `.restore-*` and renames), and the 7DTD and PZ paths
// stage too. But "stage first" only protects the world from an archive that fails
// loudly. It does nothing about an archive whose gzip stream is intact and whose
// *contents* are not what was backed up — a disk that returned a bad block, a file
// truncated and re-gzipped by a helpful transfer, a partial copy back onto the box.
//
// So: hash the archive once, at create time, when the bytes are known-good and already
// in the page cache; compare before a restore touches anything. ~305 MB hashes in
// about a second, against a restore that takes minutes.
//
// ## Absence is not failure
//
// The hash lives in the sidecar and nowhere else — a hash of the tar cannot be inside
// the tar. Every archive on the box today predates this, and an archive copied off the
// box and back loses its sidecar. So an unrecorded checksum is *unknown*, and
// `verifyArchive` says so rather than refusing: refusing would make every existing
// archive unrestorable, which would be this codebase's other documented defect shape —
// a guard that breaks the thing it was added to protect.

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { BadArchiveError } from "@/lib/backup-archive";

/**
 * sha256 of a file, streamed.
 *
 * Streamed for the same reason the download is: `readFile` on a 305 MB archive is
 * 305 MB of resident memory in a container with a `mem_limit`, and the event loop is
 * also serving the dashboard.
 */
export async function sha256File(target: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(target), hash);
  return hash.digest("hex");
}

/** Short form for a step label or a fact — the full 64 chars are noise on a row. */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

export type IntegrityResult =
  /** The recorded hash and the file agree. */
  | { state: "verified"; sha256: string }
  /**
   * Nothing was recorded for this archive, so there is nothing to check it against.
   * Reported, never treated as a pass — "I could not check" and "it is fine" are
   * different sentences and this codebase has a history of printing the second one.
   */
  | { state: "unrecorded"; why: string };

/**
 * Check an archive against what its manifest recorded, and refuse if they disagree.
 *
 * Throws `BadArchiveError` on a mismatch, which every backup route already maps to
 * **400** with the message verbatim: a corrupt archive is a fact about the user's file,
 * not the server breaking.
 *
 * Call this **before** the restore stops the world. A corrupt archive then costs nothing
 * at all — no downtime, no staging dir, no `rm` — which is the whole point of checking
 * cheaply first. The size is compared too: it is free, and it catches a truncation
 * without reading a byte.
 */
export async function verifyArchive(
  dir: string,
  name: string,
  recorded: { sha256?: string; archiveBytes?: number } | null
): Promise<IntegrityResult> {
  const target = path.join(dir, name);

  if (!recorded?.sha256) {
    return {
      state: "unrecorded",
      why: "this archive has no recorded checksum — it was made before they were written, or its sidecar was lost",
    };
  }

  if (typeof recorded.archiveBytes === "number") {
    const s = await stat(target);
    if (s.size !== recorded.archiveBytes) {
      throw new BadArchiveError(
        `This archive is ${s.size.toLocaleString()} bytes but was recorded as ` +
          `${recorded.archiveBytes.toLocaleString()} — it is truncated or has been ` +
          `replaced. Nothing was changed.`
      );
    }
  }

  const actual = await sha256File(target);
  if (actual !== recorded.sha256) {
    throw new BadArchiveError(
      `This archive does not match the checksum recorded when it was made ` +
        `(${shortHash(recorded.sha256)}… on record, ${shortHash(actual)}… on disk), so it ` +
        `cannot be trusted as a restore point. Nothing was changed.`
    );
  }
  return { state: "verified", sha256: actual };
}

/**
 * The fact to record on a restore, from a verification result.
 *
 * Deliberately **never** a `warn`. `summarize()`'s `backup.restore` branch appends every
 * warn fact it does not understand as an "Also, …" clause, and — worse — the whole
 * operation concludes `partial` on any warn at all. An archive from before checksums
 * existed is the normal case for all 15 archives currently on the box, and turning every
 * one of their restores amber would say something untrue about the restore.
 */
export function integrityFact(result: IntegrityResult): { label: string; value: string } {
  return {
    label: "Checksum",
    value:
      result.state === "verified"
        ? `verified (sha256 ${shortHash(result.sha256)}…)`
        : "not recorded for this archive, so it could not be checked",
  };
}
