import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { BACKUP_DIRS } from "./backup-store";
import { safeBackupName } from "./backup-archive";
import { resolveSafeFilePath } from "./file-guard";
import { assertFileWriteActive } from "./operations";
import type { MinecraftProfileRecord } from "./minecraft-profile-store";
import { parseOverviewLevel, OVERVIEW_RADIUS, OVERVIEW_SOURCE_MAX_BYTES, hashOverviewSourceFile } from "./minecraft-profile-overview-source";
import { overviewHash, overviewPath, MinecraftOverviewError, type OverviewSource } from "./minecraft-profile-overview-store";

export interface MinecraftOverviewArchive { profileId: string; archivePath: string; name: string; sha256: string; bytes: number; flushed: boolean; snapshotAt: string }
const MAX_ARCHIVE = 4 * 1024 ** 3, MAX_EXPANDED = 8 * 1024 ** 3, MAX_ENTRIES = 250_000;
const backupRoot = () => process.env.NODE_ENV !== "production" && process.env.MC_OVERVIEW_BACKUPS_DIR ? process.env.MC_OVERVIEW_BACKUPS_DIR : BACKUP_DIRS.minecraft;
type BodyWriter = ((chunk: Buffer) => Promise<void>) & { finish?: () => Promise<void> };
async function regular(file: string, maximum: number) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new MinecraftOverviewError("The overview archive is not a bounded regular file", 422, "overview_source_invalid"); return info; }
/** Stream our sealed TAR without shell extraction; only chosen regular-file bodies are written. */
async function scanArchive(archive: MinecraftOverviewArchive, onFile: (name: string, bytes: number) => Promise<BodyWriter | null>): Promise<void> {
  const initial = await regular(archive.archivePath, MAX_ARCHIVE);
  if (initial.size !== archive.bytes || !/^[a-f0-9]{64}$/.test(archive.sha256) || !archive.flushed) throw new MinecraftOverviewError("The backup has no verified flushed overview receipt", 422, "overview_source_invalid");
  const handle = await open(archive.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash("sha256");
  let compressed = 0, expanded = 0, entries = 0;
  const raw = handle.createReadStream({ autoClose: false });
  const budget = new Transform({ transform(chunk: Buffer, _encoding, done) { compressed += chunk.length; if (compressed > MAX_ARCHIVE) return done(new MinecraftOverviewError("Overview archive exceeds its byte budget", 413)); hash.update(chunk); done(null, chunk); } });
  const gunzip = createGunzip(); raw.pipe(budget).pipe(gunzip);
  const deadline = setTimeout(() => gunzip.destroy(new MinecraftOverviewError("Overview archive inspection exceeded two minutes", 409, "overview_deferred")), 120_000);
  raw.on("error", error => gunzip.destroy(error)); budget.on("error", error => gunzip.destroy(error));
  const iterator = gunzip[Symbol.asyncIterator](); let current: Buffer = Buffer.alloc(0), offset = 0;
  async function next(): Promise<boolean> { if (offset < current.length) return true; const item = await iterator.next(); if (item.done) return false; current = item.value as Buffer; offset = 0; expanded += current.length; if (expanded > MAX_EXPANDED) throw new MinecraftOverviewError("Overview archive exceeds its expanded inspection budget", 413); return true; }
  async function take(count: number): Promise<Buffer | null> { const bytes = Buffer.alloc(count); let total = 0; while (total < count) { if (!await next()) { if (total === 0) return null; throw new MinecraftOverviewError("Overview archive is truncated", 422); } const size = Math.min(count - total, current.length - offset); current.copy(bytes, total, offset, offset + size); offset += size; total += size; } return bytes; }
  async function body(count: number, write: ((chunk: Buffer) => Promise<void>) | null) { let left = count; while (left > 0) { if (!await next()) throw new MinecraftOverviewError("Overview archive is truncated", 422); const size = Math.min(left, current.length - offset), bytes = current.subarray(offset, offset + size); if (write) await write(bytes); offset += size; left -= size; } }
  const text = (header: Buffer, start: number, size: number) => new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(start, start + size)).replace(/\0[\s\S]*$/, "");
  const octal = (value: string) => { if (!/^[0-7]+$/.test(value.trim())) throw new MinecraftOverviewError("Overview TAR metadata is unsupported", 422); const number = Number.parseInt(value.trim(), 8); if (!Number.isSafeInteger(number) || number < 0) throw new MinecraftOverviewError("Overview TAR size is invalid", 422); return number; };
  try {
    const admitted = await handle.stat(); if (admitted.ino !== initial.ino || admitted.dev !== initial.dev || admitted.size !== initial.size) throw new MinecraftOverviewError("The sealed archive changed during admission", 409);
    for (;;) {
      const header = await take(512); if (!header) throw new MinecraftOverviewError("Overview TAR has no closing record", 422);
      if (header.every(byte => byte === 0)) { while (await next()) { if (!current.subarray(offset).every(byte => byte === 0)) throw new MinecraftOverviewError("Overview TAR has unexpected trailing data", 422); offset = current.length; } break; }
      if (++entries > MAX_ENTRIES) throw new MinecraftOverviewError("Overview archive exceeds its entry budget", 413);
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== octal(text(header, 148, 8))) throw new MinecraftOverviewError("Overview TAR checksum is invalid", 422);
      const prefix = text(header, 345, 155), entry = `${prefix ? `${prefix}/` : ""}${text(header, 0, 100)}`.replace(/^\.\//, ""), kind = String.fromCharCode(header[156] || 48), bytes = octal(text(header, 124, 12));
      if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..") || !["0", "5", "x"].includes(kind)) throw new MinecraftOverviewError("Overview archives refuse links, special files and unsafe paths", 422, "overview_source_invalid");
      if (kind === "x") {
        if (bytes > 16_384) throw new MinecraftOverviewError("Overview TAR extension is oversized", 422);
        const extension = await take(bytes); if (!extension || /(?:^|\n)\d+ (?:path|linkpath)=/.test(extension.toString("utf8"))) throw new MinecraftOverviewError("Overview TAR path extensions are unsupported", 422);
      } else { const writer = kind === "0" ? await onFile(entry, bytes) : null; await body(bytes, writer); await writer?.finish?.(); }
      const padding = (512 - bytes % 512) % 512; if (padding) { const skipped = await take(padding); if (!skipped || !skipped.every(byte => byte === 0)) throw new MinecraftOverviewError("Overview TAR padding is invalid", 422); }
    }
    const after = await handle.stat(); if (compressed !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || hash.digest("hex") !== archive.sha256) throw new MinecraftOverviewError("The sealed overview archive changed or failed checksum readback", 422, "overview_source_invalid");
  } finally { clearTimeout(deadline); raw.destroy(); budget.destroy(); gunzip.destroy(); await handle.close(); }
}
export async function copyMinecraftOverviewArchive(profileId: string, jobId: string, archive: MinecraftOverviewArchive): Promise<OverviewSource | null> {
  if (archive.profileId !== profileId || !safeBackupName(archive.name) || !archive.flushed) throw new MinecraftOverviewError("The overview backup belongs to another profile or was not flushed", 422, "overview_source_invalid");
  const configured = path.resolve(backupRoot()), relative = path.relative(configured, path.resolve(archive.archivePath));
  if (relative !== archive.name && relative !== `profiles/${profileId}/${archive.name}`) throw new MinecraftOverviewError("The overview backup path does not belong to this profile's archive storage", 422, "overview_source_invalid");
  const admitted = await resolveSafeFilePath(configured, relative, { followFinalSymlink: false });
  if (!admitted) throw new MinecraftOverviewError("The overview backup path is not contained", 422, "overview_source_invalid");
  for (const prefix of relative === archive.name ? [] : ["profiles", `profiles/${profileId}`]) { const info = await lstat(path.join(configured, prefix)); if (!info.isDirectory() || info.isSymbolicLink()) throw new MinecraftOverviewError("The overview archive namespace refuses aliases", 422); }
  archive = { ...archive, archivePath: admitted };
  const names: { path: string; bytes: number }[] = []; const level: Buffer[] = [];
  await scanArchive(archive, async (name, bytes) => {
    if (name === "world/level.dat") { if (bytes > 1024 * 1024) throw new MinecraftOverviewError("Archived level metadata exceeds its overview limit", 413); return async chunk => { level.push(Buffer.from(chunk)); }; }
    if (/^world\/(?:dimensions\/minecraft\/overworld\/)?region\/(?:r\.-?\d+\.-?\d+\.mca|c\.-?\d+\.-?\d+\.mcc)$/.test(name)) names.push({ path: name.slice(6), bytes });
    return null;
  });
  if (!level.length) return null;
  const details = parseOverviewLevel(Buffer.concat(level)), layout = names.some(file => file.path.startsWith("dimensions/")) ? "namespaced" : "legacy";
  const minX = Math.floor((details.center.x - OVERVIEW_RADIUS) / 512), maxX = Math.floor((details.center.x + OVERVIEW_RADIUS) / 512), minZ = Math.floor((details.center.z - OVERVIEW_RADIUS) / 512), maxZ = Math.floor((details.center.z + OVERVIEW_RADIUS) / 512);
  const selected = names.filter(file => {
    if ((layout === "namespaced") !== file.path.startsWith("dimensions/")) return false;
    const match = /\/(r|c)\.(-?\d+)\.(-?\d+)\.(?:mca|mcc)$/.exec(file.path)!;
    const factor = match[1] === "r" ? 1 : 32, x = Math.floor(Number(match[2]) / factor), z = Math.floor(Number(match[3]) / factor);
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (!selected.some(file => file.path.endsWith(".mca"))) return null;
  if (selected.length > 4095 || selected.some(file => file.bytes < 1 || file.bytes > 128 * 1024 * 1024) || selected.reduce((sum, file) => sum + file.bytes, Buffer.concat(level).length) > OVERVIEW_SOURCE_MAX_BYTES || new Set(selected.map(file => file.path)).size !== selected.length) throw new MinecraftOverviewError("The archived spawn overview exceeds its file/disk budget", 413);
  const root = await overviewPath("", true), space = await statfs(root), total = selected.reduce((sum, file) => sum + file.bytes, Buffer.concat(level).length);
  if (space.bavail * space.bsize < total + 1024 ** 3) throw new MinecraftOverviewError("Not enough disk space for the archived overview copy", 507, "overview_no_space");
  const files: OverviewSource["files"] = [], handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    await scanArchive(archive, async (name, bytes) => {
      const relative = name.slice(6); if (name !== "world/level.dat" && !selected.some(file => file.path === relative && file.bytes === bytes)) return null;
      if (files.some(file => file.path === relative)) throw new MinecraftOverviewError("Overview TAR contains duplicate source files", 422);
      const destination = await overviewPath(`${profileId}/jobs/${jobId}/input/world/${relative}`, true); assertFileWriteActive(); const handle = await open(destination, "wx", 0o600); handles.push(handle);
      const hash = createHash("sha256"); files.push({ path: relative, bytes, sha256: "" });
      return Object.assign(async (chunk: Buffer) => { assertFileWriteActive(); hash.update(chunk); await handle.write(chunk); }, { finish: async () => { await handle.sync(); await handle.close(); files.find(file => file.path === relative)!.sha256 = hash.digest("hex"); } });
    });
    files.sort((a, b) => a.path === "level.dat" ? -1 : b.path === "level.dat" ? 1 : a.path.localeCompare(b.path));
    if (files.length !== selected.length + 1 || files[0].sha256 !== overviewHash(Buffer.concat(level))) throw new MinecraftOverviewError("The archived source file set changed during copy", 422);
    for (const file of files) { const current = await hashOverviewSourceFile(await overviewPath(`${profileId}/jobs/${jobId}/input/world/${file.path}`), 128 * 1024 * 1024); if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) throw new MinecraftOverviewError("Archived overview source failed byte readback", 503, "overview_unverified"); }
    return { kind: "backup", id: archive.name, sha256: overviewHash(JSON.stringify(files)), snapshotAt: new Date().toISOString(), ...details, layout, files };
  } finally { for (const handle of handles) await handle.close().catch(() => {}); }
}
/** Only profile-bound, explicitly flushed sealed receipts qualify; legacy unrecorded backups remain unknown. */
export async function latestMinecraftOverviewArchive(profile: MinecraftProfileRecord): Promise<MinecraftOverviewArchive | null> {
  const root = backupRoot();
  const parts = profile.sourceKind === "legacy" ? [] : ["profiles", profile.id]; let directory = root;
  try {
    for (const part of parts) { directory = path.join(directory, part); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new MinecraftOverviewError("Overview backup directories refuse aliases", 422); }
    const names = (await readdir(directory)).filter(name => safeBackupName(name)).sort().reverse();
    for (const name of names) {
      const target = await resolveSafeFilePath(directory, name, { followFinalSymlink: false }); if (!target) throw new MinecraftOverviewError("Overview backup path is not contained", 422);
      const sidecar = await regular(`${target}.manifest.json`, 1024 * 1024).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }); if (!sidecar) continue;
      const handle = await open(`${target}.manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: unknown;
      try { const bytes = Buffer.alloc(sidecar.size + 1); const { bytesRead } = await handle.read(bytes); if (bytesRead !== sidecar.size) throw new MinecraftOverviewError("Backup metadata changed during readback", 422); value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); } finally { await handle.close(); }
      const meta = value as { minecraftProfileId?: unknown; flushed?: unknown; sha256?: unknown; archiveBytes?: unknown; createdAt?: unknown; members?: unknown };
      if (meta.minecraftProfileId === profile.id && meta.flushed === true && typeof meta.sha256 === "string" && /^[a-f0-9]{64}$/.test(meta.sha256) && typeof meta.archiveBytes === "number" && Number.isSafeInteger(meta.archiveBytes) && typeof meta.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt)) && Array.isArray(meta.members) && meta.members.length === 1 && meta.members[0] === "world") return { profileId: profile.id, archivePath: target, name, bytes: meta.archiveBytes, sha256: meta.sha256, flushed: true, snapshotAt: meta.createdAt };
    }
    return null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
