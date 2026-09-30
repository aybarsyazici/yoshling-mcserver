// A recursive copy that can say how far it has got.
//
// ## Why not `fs.cp`
//
// Because `fs.cp(src, dest, {recursive: true})` is one await that returns when it is
// finished and tells you nothing in between. Measured on production 2026-09-29: a
// Project Zomboid backup copies **442,064 files (1.9 GB) in ~11 minutes**, and 10.5 of
// those minutes are a single step reading "Copying the world". That row is the least
// informative thing in the whole operation ledger, and it is the longest.
//
// File count *is* knowable here — a `readdir` walk is metadata only — so this reports a
// real count rather than a percentage of anything. `op.progress({kind:"count"})` already
// exists and is already rendered; nothing here invents a number it cannot measure, which
// is why there is no byte total and no ETA.
//
// ## Why hand-rolling it is not a downgrade
//
// `fs.cp` is itself implemented in JavaScript in Node's `internal/fs/cp` — the same
// `readdir` + `copyFile` recursion — so this is the same order of work, not a slower
// reimplementation of a native call. Three behaviours, and the third was got wrong first
// time:
//
//   - **timestamps are not preserved**, exactly as `fs.cp` does not preserve them
//     (`preserveTimestamps` defaults to false);
//   - **ownership is not preserved**, also as before. The PZ restore path already knows
//     this and re-applies ownership from `PZ_DIR` with `chown -R` afterwards, because the
//     web container writes as root and the game runs as uid 1000;
//   - **directory modes ARE preserved**, because `fs.cp` preserves them and the first
//     version of this did not. Measured: a source `inner/` at 0700 copied by `fs.cp` came
//     out 0700 and by a bare `mkdir(to, {recursive: true})` came out 0755, because `mkdir`
//     takes 0777 & ~umask and Node's own `internal/fs/cp` follows its `mkdir` with a
//     `setDestMode(dest, srcMode)` this walk had no equivalent of. File modes survive
//     either way — `copyFile` carries them. The drift was toward *more* permissive over
//     every directory in a 442,064-file world, and the comment claiming parity with
//     `fs.cp` ("the archive is byte-for-byte the same shape the previous implementation
//     produced") was never checked. One `lstat` per directory against a per-file
//     `copyFile` is not a cost worth trading a false claim for.
//
// Symlinks are recreated as symlinks rather than followed: following one inside a save
// directory would copy its target into the archive and, on restore, write through it.
// Anything that is neither a file, a directory nor a symlink (a socket, a fifo) is
// counted as skipped and reported — silently omitting part of a save is precisely the
// "reports success after doing nothing" shape.

import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from "fs/promises";
import path from "path";

/** Every file, symlink and other non-directory entry under `src`. Directories excluded. */
export async function countTree(src: string): Promise<number> {
  let total = 0;
  const stack = [src];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A directory that vanished or cannot be read is not a count this can produce.
      // The copy will hit the same thing and report it as skipped.
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else total++;
    }
  }
  return total;
}

export interface CopyTreeResult {
  /** Files and symlinks actually written. */
  files: number;
  /** Directories created. */
  dirs: number;
  /** Entries deliberately not copied, with the first few named. */
  skipped: string[];
}

/**
 * Copy `src` to `dest`, calling `onProgress(done)` as it goes.
 *
 * `onProgress` is throttled by the caller's `everyFiles` / `everyMs`, because
 * `op.progress()` also refreshes the operation heartbeat and calling it 442,064 times
 * would turn a copy into a write-amplification test on the registry. The defaults report
 * roughly twice a second on this box's rate.
 */
export async function copyTreeCounting(
  src: string,
  dest: string,
  onProgress: (done: number, currentPath: string) => void,
  opts: { everyFiles?: number; everyMs?: number } = {}
): Promise<CopyTreeResult> {
  const everyFiles = opts.everyFiles ?? 500;
  const everyMs = opts.everyMs ?? 500;

  let files = 0;
  let dirs = 0;
  const skipped: string[] = [];
  let lastReportAt = 0;
  let lastReportCount = 0;

  async function walk(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    // Match the source's mode, as `fs.cp` does. Best-effort: a mode that could not be
    // applied is not a reason to abandon a backup, and the restore re-applies ownership
    // over the whole tree afterwards anyway.
    await chmod(to, (await lstat(from)).mode & 0o7777).catch(() => {});
    dirs++;
    const entries = await readdir(from, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) {
        await walk(s, d);
        continue;
      }
      if (e.isSymbolicLink()) {
        await symlink(await readlink(s), d);
        files++;
      } else if (e.isFile()) {
        await copyFile(s, d);
        files++;
      } else {
        // Named, up to a bound: a fact listing 4,000 sockets is not a fact.
        if (skipped.length < 10) skipped.push(s);
        continue;
      }
      const now = Date.now();
      if (files - lastReportCount >= everyFiles || now - lastReportAt >= everyMs) {
        lastReportCount = files;
        lastReportAt = now;
        onProgress(files, s);
      }
    }
  }

  await walk(src, dest);
  // Always report the final figure, so the last thing recorded is the total and not
  // whatever the throttle happened to have emitted.
  onProgress(files, dest);
  return { files, dirs, skipped };
}
