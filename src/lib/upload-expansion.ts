import { spawn } from "node:child_process";
import { lstat, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import { MAX_WORLD_EXPANDED_BYTES, MAX_WORLD_EXPANDED_ENTRIES, WORLD_UPLOAD_DISK_RESERVE_BYTES } from "./sdtd-upload-limits";
import { formatBytes } from "./format";

export class UploadExpansionError extends Error {
  readonly status: 400 | 413 | 507;
  constructor(message: string, status: 400 | 413 | 507 = 413) {
    super(message);
    this.name = "UploadExpansionError";
    this.status = status;
  }
}
export interface ExpansionLimits { maxBytes: number; maxEntries: number; reserveBytes: number }
const defaults = (): ExpansionLimits => ({ maxBytes: MAX_WORLD_EXPANDED_BYTES, maxEntries: MAX_WORLD_EXPANDED_ENTRIES, reserveBytes: WORLD_UPLOAD_DISK_RESERVE_BYTES });

/** Read the individual rows and footer, rather than trusting only the ZIP's total. */
export function declaredZipExpansion(listing: string): { bytes: number; entries: number } {
  let bytes = 0;
  let entries = 0;
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+\S+\s+\S+\s+(\S.*)$/.exec(line);
    if (!row) continue;
    const length = Number(row[1]);
    if (!Number.isSafeInteger(length)) throw new UploadExpansionError("Zip declares an unreadable expanded size", 400);
    bytes += length;
    entries++;
    if (!Number.isSafeInteger(bytes)) throw new UploadExpansionError("Zip declares an unreadable expanded size", 400);
  }
  const footer = /^\s*(\d+)\s+(\d+)\s+files?\s*$/m.exec(listing);
  if (!footer || Number(footer[1]) !== bytes || Number(footer[2]) !== entries) {
    throw new UploadExpansionError("Zip's expanded size and entry count could not be verified", 400);
  }
  return { bytes, entries };
}

async function availableBytes(dir: string): Promise<number> {
  const space = await statfs(dir, { bigint: true });
  const bytes = space.bavail * space.bsize;
  if (bytes < BigInt(0)) throw new Error("Available extraction disk space could not be read");
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
}

export async function admitZipExpansion(listing: string, dir: string, limits = defaults()) {
  const declared = declaredZipExpansion(listing);
  if (declared.bytes > limits.maxBytes) throw new UploadExpansionError(`Zip exceeds the expanded size limit (${formatBytes(limits.maxBytes)})`);
  if (declared.entries > limits.maxEntries) throw new UploadExpansionError(`Zip exceeds the expanded entry-count limit (${limits.maxEntries.toLocaleString()})`);
  if (await availableBytes(dir) < declared.bytes + limits.reserveBytes) {
    throw new UploadExpansionError("Not enough free disk space to safely unpack this upload", 507);
  }
  return declared;
}

/** Count actual output without following links, checking early during the walk. */
async function checkExpandedTree(root: string, limits: ExpansionLimits): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop()!;
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      let entry;
      try { entry = await lstat(file); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      entries++;
      if (entry.isDirectory()) dirs.push(file);
      else bytes += entry.size;
      if (bytes > limits.maxBytes) throw new UploadExpansionError("Actual extracted bytes exceeded the expanded size limit; extraction was cancelled");
      if (entries > limits.maxEntries) throw new UploadExpansionError("Actual extracted entries exceeded the entry-count limit; extraction was cancelled");
    }
  }
  if (await availableBytes(root) < limits.reserveBytes) {
    throw new UploadExpansionError("Free disk space fell below the extraction reserve; extraction was cancelled", 507);
  }
  return { bytes, entries };
}

/**
 * Monitor expanded output and free space while a subprocess extracts. Kill and await
 * process closure before the caller cleans staging. Periodic observations can overshoot
 * a limit between scans; preflight reserves disk headroom and this is not an OS quota.
 */
export async function runBoundedExtraction(command: string, args: string[], options: {
  workDir: string;
  limits?: ExpansionLimits;
  pollMs?: number;
  timeoutMs?: number;
  checkInterrupted?: () => void;
}): Promise<{ stderr: string; bytes: number; entries: number }> {
  const limits = options.limits ?? defaults();
  options.checkInterrupted?.();
  await checkExpandedTree(options.workDir, limits);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let failed: Error | null = null;
    let observing: Promise<void> | null = null;
    const stop = (error: unknown) => {
      failed ??= error instanceof Error ? error : new Error(String(error));
      child.kill("SIGKILL");
    };
    const inspect = () => {
      if (observing || failed) return;
      observing = (async () => {
        options.checkInterrupted?.();
        await checkExpandedTree(options.workDir, limits);
      })().catch(stop).finally(() => { observing = null; });
    };
    const interval = setInterval(inspect, options.pollMs ?? 100);
    const timeout = setTimeout(() => stop(new Error("Zip extraction timed out; no extracted files were placed")), options.timeoutMs ?? 240_000);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024 * 1024) stop(new Error("Zip extraction produced too much diagnostic output"));
    });
    child.on("error", stop);
    child.on("close", async (code) => {
      clearInterval(interval);
      clearTimeout(timeout);
      await observing;
      try {
        if (failed) throw failed;
        if (code !== 0) throw new Error("Zip extraction failed; no extracted files were placed");
        options.checkInterrupted?.();
        const actual = await checkExpandedTree(options.workDir, limits);
        resolve({ stderr, ...actual });
      } catch (e) { reject(e); }
    });
  });
}
