// The backups directory, as a thing the app can reason about: where the archives
// live, how to read what an archive says about itself, and how to hand one back out.
//
// ## Why this exists
//
// Every one of these was written out per game — three `BACKUP_DIR` constants, two
// byte-identical `backupManifest()` readers with two different docstrings, three
// `.tar.gz` filters. `safeBackupName` was in that same state until it was pulled into
// `backup-archive.ts`, and the reason given there holds for all of it: three copies of
// one predicate is how a fix lands in two of them. The power control already drifted
// into three copies in this codebase and two of them missed a fix.

import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { execFile } from "child_process";
import path from "path";
import { Readable } from "stream";
import { promisify } from "util";
import type { GameId } from "@/lib/games";
import { readManifestSidecar, writeManifestSidecar } from "@/lib/backup-archive";

const execFileAsync = promisify(execFile);

/** Where each world's archives live, inside the web container's `web-data` volume. */
export const BACKUP_DIRS: Record<GameId, string> = {
  minecraft: "/app/data/backups",
  "7dtd": "/app/data/backups-7dtd",
  zomboid: "/app/data/backups-zomboid",
};

// The live game directories are deliberately NOT here. They come off `RUNTIME` in
// `game-manager`, which reaches Docker — and this module has to stay importable without
// it so `selectForPruning` and the schedule predicate can be tested with no container.
// `backup-create.ts` imports `RUNTIME` (it needs `containerIsRunning` anyway) and
// re-exports the three paths from there, so there is still exactly one definition.

/**
 * What every archive's manifest carries, whatever game wrote it.
 *
 * The per-game manifests extend this. Three fields are worth the note:
 *
 * - `flushed` — `false` means the server was stopped, so there was nothing to flush and
 *   the files were already at rest. `undefined` means an archive from before this was
 *   recorded: genuinely unknown rather than "no".
 * - `sha256` / `archiveBytes` — the checksum of the archive **file**, so they can only
 *   ever live in the sidecar; a hash of the tar cannot be inside the tar. An archive
 *   whose sidecar was lost therefore reads as *unrecorded*, which is why
 *   `verifyArchive` refuses only on a mismatch and never on an absence. Every one of
 *   the 15 archives on the box today predates this.
 * - `automatic` — written by the scheduler, which has no user to attribute. The archive
 *   itself is then able to say where it came from, which is the only place that answer
 *   survives being copied off the box.
 * - `members` — the top-level names in the tar, written by whoever wrote the tar. It
 *   exists because Minecraft now has two shapes of archive: a routine backup is
 *   `["world"]` and the one `install-modpack` takes before it deletes every jar is
 *   `["world", "mods"]`, and the listing has to be able to say which an archive is
 *   without decompressing it. `undefined` is an archive from before this was recorded.
 */
export interface BaseManifest {
  createdAt: string;
  flushed?: boolean;
  sha256?: string;
  archiveBytes?: number;
  /** Display name of whoever asked for it, or absent for a scheduled backup. */
  startedBy?: string;
  automatic?: boolean;
  members?: string[];
}

export interface ArchiveFile {
  name: string;
  /** Bytes, off `stat`. */
  size: number;
  /** `mtime` in epoch ms — the same clock `selectForPruning` orders by. */
  createdAtMs: number;
}

/**
 * Every archive in a backups directory, newest first.
 *
 * Only `.tar.gz`, which is also what keeps the `.manifest.json` sidecars and the
 * `.work-*` / `.restore-*` staging dirs out of every listing, every retention pass and
 * every schedule decision. A missing directory lists empty rather than throwing: it is
 * the state of a world nobody has ever backed up, not an error.
 */
export async function listArchives(dir: string): Promise<ArchiveFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: ArchiveFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".tar.gz")) continue;
    try {
      const s = await stat(path.join(dir, name));
      if (!s.isFile()) continue;
      out.push({ name, size: s.size, createdAtMs: s.mtime.getTime() });
    } catch {
      /* vanished between readdir and stat — a concurrent prune, not an error */
    }
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/**
 * A backup's manifest — from the sidecar if there is one, else out of the tar.
 *
 * Reading the in-tar copy costs a full gzip decompression of a ~290 MB archive to get
 * ~100 bytes, and it is called once per archive by each listing **and** again by
 * `worldsUsedByBackups`. Measured on production 2026-09-29: `GET /api/7dtd/backups`
 * took **7.9 s** to return 955 bytes of JSON for six archives. That is the backups
 * page's first paint.
 *
 * The in-tar copy is not going anywhere — it is what makes an archive self-describing
 * after it has been copied off the box, which a sidecar cannot be.
 *
 * The fallback **fills the sidecar in**, so archives that predate it get the speed-up on
 * their second listing rather than never. Best-effort, and only a manifest that actually
 * parsed is ever cached.
 */
export async function readBackupManifest<T>(dir: string, name: string): Promise<T | null> {
  const target = path.join(dir, name);
  const sidecar = await readManifestSidecar<T>(target);
  if (sidecar) return sidecar;
  // tar stores members as "./manifest.json" when created with `-C <dir> .`; try both
  // spellings to be safe across tar versions.
  for (const member of ["./manifest.json", "manifest.json"]) {
    try {
      const { stdout } = await execFileAsync("tar", ["-xzOf", target, member], {
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as T;
      await writeManifestSidecar(target, parsed);
      return parsed;
    } catch {
      /* try the other spelling */
    }
  }
  return null;
}

/**
 * Hand one archive back out over HTTP, as a stream.
 *
 * **Streamed, never buffered.** `/api/7dtd/world` does the other thing —
 * `Buffer.from(await file.arrayBuffer())` on an upload of up to 2 GB — and it is a
 * recorded defect: it blocks the event loop, which is what stalls the operation
 * heartbeat during a large upload. The archives here are 165–305 MB today and a
 * `readFile` of one would do the same on the way out, on a container with a 6 GB
 * `mem_limit` that also has to keep serving the dashboard.
 *
 * `Content-Length` is set from the same `stat` that proves the file is there, so a
 * browser can show real progress and a truncated transfer is detectable by the client
 * rather than silently arriving as a short file. The name is already through
 * `safeBackupName`, whose allowlist admits no quote and no newline, so quoting the
 * `filename` is enough — there is no header-injection surface left.
 */
export async function archiveResponse(dir: string, name: string): Promise<Response> {
  const target = path.join(dir, name);
  const s = await stat(target);
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(s.size),
      "Content-Disposition": `attachment; filename="${name}"`,
      // An archive is immutable but it is also not something a shared cache should ever
      // hold: it is the world's save data, behind a per-world permission check.
      "Cache-Control": "private, no-store",
    },
  });
}
