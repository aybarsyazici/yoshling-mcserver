import path from "node:path";
import { createHash } from "node:crypto";
import { Entry, fromBufferPromise, openPromise } from "yauzl";
import { createReadStream, constants } from "node:fs";
import { lstat, open as openFile, rm } from "node:fs/promises";
import type { MinecraftProfileLoader } from "./minecraft-profile-types";

export const PROFILE_PACK_LIMITS = { archive: 256 * 1024 ** 2, file: 128 * 1024 ** 2, total: 2 * 1024 ** 3, entries: 20_000 };
/** Properties are later parsed and rendered by editors; large payloads belong in separate pack files. */
export const PROFILE_PROPERTIES_LIMITS = { bytes: 1024 ** 2, keys: 1024, lines: 4096 };
export interface ProfilePackFile {
  path: string;
  hashes: { sha1: string; sha512: string };
  downloads: string[];
  fileSize: number;
  env?: { client: string; server: string };
}
export interface ProfilePackIndex {
  name: string;
  versionId: string;
  target: { mcVersion: string; loader: MinecraftProfileLoader; loaderVersion: string | null };
  files: ProfilePackFile[];
}

/** Apply the same lexical rule to ZIP members and downloaded index destinations. */
export function profilePackPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value) ||
      path.posix.isAbsolute(value) || /^[a-z]:/i.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("The modpack contains an unsafe file path.");
  }
  return value;
}

const DOWNLOAD_HOSTS = new Set(["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
export function profileDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error("The pack download URL is outside the supported HTTPS registries.");
  }
  return url;
}

/** Bound redirects, time and bytes; registry metadata cannot fetch private endpoints. */
export async function downloadProfileFile(urlValue: string, limit: number, expected?: { size: number; sha512: string; sha1: string }, assertActive?: () => void): Promise<Buffer> {
  if (limit > 8 * 1024 ** 2) throw new Error("Use streamed profile downloads for large files.");
  let url = profileDownloadUrl(urlValue);
  const signal = AbortSignal.timeout(120_000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    assertActive?.();
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirect === 5) throw new Error("Too many pack download redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Pack download redirect has no destination.");
      url = profileDownloadUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Pack download failed (${response.status}).`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) { await response.body.cancel(); throw new Error("Pack download exceeds its byte limit."); }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        assertActive?.();
        size += chunk.byteLength;
        if (size > limit) throw new Error("Pack download exceeds its byte limit.");
        chunks.push(Buffer.from(chunk));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const buffer = Buffer.concat(chunks, size);
    if (expected && (size !== expected.size ||
        createHash("sha512").update(buffer).digest("hex") !== expected.sha512.toLowerCase() ||
        createHash("sha1").update(buffer).digest("hex") !== expected.sha1.toLowerCase())) {
      throw new Error("Pack download does not match its published size and checksums.");
    }
    return buffer;
  }
  throw new Error("Pack download did not complete.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The modpack index is invalid.");
  return value as Record<string, unknown>;
}
function pin(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z\d][a-z\d._+\-]{0,119}$/i.test(value) || /^(latest|stable|release)$/i.test(value)) {
    throw new Error("The pack must declare exact Minecraft and loader versions.");
  }
  return value;
}

export function parseProfilePackIndex(raw: unknown): ProfilePackIndex {
  const index = record(raw);
  if (index.formatVersion !== 1 || index.game !== "minecraft" || typeof index.name !== "string" || !index.name.trim() ||
      typeof index.versionId !== "string" || !index.versionId || !Array.isArray(index.files) || index.files.length > PROFILE_PACK_LIMITS.entries) {
    throw new Error("Only complete Minecraft format-1 Modrinth packs are supported.");
  }
  const dependencies = record(index.dependencies);
  const loaderKeys = { "fabric-loader": "fabric", "forge": "forge", "neoforge": "neoforge", "quilt-loader": "quilt" } as const;
  const loaders = Object.keys(dependencies).filter(key => key !== "minecraft");
  if (loaders.length > 1 || loaders.some(key => !(key in loaderKeys))) throw new Error("The pack has unsupported or conflicting loader requirements.");
  const loaderKey = loaders[0] as keyof typeof loaderKeys | undefined;
  const files: ProfilePackFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const rawFile of index.files) {
    const file = record(rawFile);
    const destination = profilePackPath(file.path);
    if (seen.has(destination)) throw new Error("The pack index repeats a file destination.");
    seen.add(destination);
    const hashes = record(file.hashes);
    if (!/^[a-f\d]{40}$/i.test(String(hashes.sha1)) || !/^[a-f\d]{128}$/i.test(String(hashes.sha512)) ||
        !Number.isSafeInteger(file.fileSize) || Number(file.fileSize) < 0 || Number(file.fileSize) > PROFILE_PACK_LIMITS.file ||
        !Array.isArray(file.downloads) || file.downloads.length < 1 || file.downloads.length > 8 || file.downloads.some(value => typeof value !== "string")) {
      throw new Error("The pack contains an unverifiable or oversized file.");
    }
    const downloads = file.downloads as string[];
    if (destination === "server.properties" && Number(file.fileSize) > PROFILE_PROPERTIES_LIMITS.bytes) throw new Error("server.properties exceeds its 1 MiB editor-safe limit.");
    downloads.forEach(profileDownloadUrl);
    let env: ProfilePackFile["env"];
    if (file.env !== undefined) {
      const value = record(file.env);
      if (!["required", "optional", "unsupported"].includes(String(value.server)) || !["required", "optional", "unsupported"].includes(String(value.client))) {
        throw new Error("The pack contains an unknown server environment declaration.");
      }
      env = { server: String(value.server), client: String(value.client) };
    }
    bytes += Number(file.fileSize);
    if (bytes > PROFILE_PACK_LIMITS.total) throw new Error("The pack exceeds the total byte limit.");
    files.push({ path: destination, hashes: hashes as ProfilePackFile["hashes"], downloads, fileSize: Number(file.fileSize), env });
  }
  return { name: index.name.trim(), versionId: index.versionId, target: {
    mcVersion: pin(dependencies.minecraft), loader: loaderKey ? loaderKeys[loaderKey] : "vanilla",
    loaderVersion: loaderKey ? pin(dependencies[loaderKey]) : null,
  }, files };
}

/** No filesystem extraction: validate every member, then return bounded regular bytes. */
export async function readProfilePackArchive(buffer: Buffer): Promise<{ index: ProfilePackIndex; overrides: Map<string, Buffer> }> {
  if (buffer.length > 8 * 1024 ** 2) throw new Error("Use disk-backed profile archive inspection for large files.");
  if (buffer.length > PROFILE_PACK_LIMITS.archive) throw new Error("Pack archive exceeds its byte limit.");
  const zip = await fromBufferPromise(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const ordinary = new Map<string, Buffer>();
  const server = new Map<string, Buffer>();
  const seen = new Set<string>();
  let index: ProfilePackIndex | undefined;
  let bytes = 0;
  let count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (++count > PROFILE_PACK_LIMITS.entries) throw new Error("Pack archive contains too many entries.");
      const directory = entry.fileName.endsWith("/");
      const name = profilePackPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) || entry.isEncrypted()) throw new Error("Pack archive contains a link, special file or encrypted member.");
      if (seen.has(name)) throw new Error("Pack archive repeats a member path.");
      seen.add(name);
      bytes += entry.uncompressedSize;
      if (entry.uncompressedSize > 8 * 1024 ** 2 || bytes > 8 * 1024 ** 2) throw new Error("Pack archive exceeds its expanded byte limit.");
      if (directory) continue;
      if (name !== "modrinth.index.json" && !name.startsWith("overrides/") && !name.startsWith("server-overrides/")) continue;
      if (name === "modrinth.index.json" && entry.uncompressedSize > 8 * 1024 ** 2) throw new Error("Pack index exceeds its byte limit.");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let actual = 0;
      for await (const chunk of stream) {
        actual += chunk.length;
        if (actual > entry.uncompressedSize || actual > PROFILE_PACK_LIMITS.file) throw new Error("Pack member exceeds its declared byte limit.");
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks, actual);
      if (actual !== entry.uncompressedSize) throw new Error("Pack member is truncated.");
      if (name === "modrinth.index.json") index = parseProfilePackIndex(JSON.parse(content.toString("utf8")));
      else {
        const prefix = name.startsWith("server-overrides/") ? "server-overrides/" : "overrides/";
        (prefix === "overrides/" ? ordinary : server).set(profilePackPath(name.slice(prefix.length)), content);
      }
    }
  } finally { zip.close(); }
  if (!index) throw new Error("Pack archive has no Modrinth index.");
  for (const [name, content] of server) ordinary.set(name, content);
  return { index, overrides: ordinary };
}

/** Stream receipts contain hashes, never the file's contents. */
export interface ProfileFileReceipt { bytes: number; sha1: string; sha512: string }
export interface ProfilePackOverride {
  member: string; size: number;
  compressedSize: number; compressionMethod: number; generalPurposeBitFlag: number;
  relativeOffsetOfLocalHeader: number;
}
export interface ProfilePackFileArchive { index: ProfilePackIndex; overrides: Map<string, ProfilePackOverride> }

/** Independently read the stored file without retaining its contents. */
export async function hashProfileFile(file: string, assertActive?: () => void): Promise<ProfileFileReceipt> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Profile readback requires a regular file.");
  const sha1 = createHash("sha1"), sha512 = createHash("sha512");
  let bytes = 0;
  const input = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of createReadStream(file, { fd: input.fd, autoClose: false })) {
      assertActive?.(); bytes += chunk.length; sha1.update(chunk); sha512.update(chunk);
    }
  } finally { await input.close(); }
  if (bytes !== info.size) throw new Error("Profile file changed during readback.");
  return { bytes, sha1: sha1.digest("hex"), sha512: sha512.digest("hex") };
}

/** Await every disk write before reading another chunk; verify using a fresh disk stream. */
export async function writeVerifiedProfileStream(file: string, chunks: AsyncIterable<Uint8Array>, limit: number,
  expected?: { size: number; sha1: string; sha512: string }, assertActive?: () => void,
  reserveSpace?: (remaining: number) => Promise<void>): Promise<ProfileFileReceipt> {
  const output = await openFile(file, "wx", 0o600);
  let complete = false, bytes = 0;
  const sha1 = createHash("sha1"), sha512 = createHash("sha512");
  try {
    for await (const chunk of chunks) {
      assertActive?.();
      bytes += chunk.byteLength;
      if (bytes > limit || (expected && bytes > expected.size)) throw new Error("Profile file exceeds its byte limit.");
      await reserveSpace?.(expected ? expected.size - bytes + chunk.byteLength : chunk.byteLength);
      sha1.update(chunk); sha512.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await output.write(chunk, offset, chunk.byteLength - offset);
        if (written.bytesWritten < 1) throw new Error("Profile file write made no progress.");
        offset += written.bytesWritten;
      }
    }
    const receipt = { bytes, sha1: sha1.digest("hex"), sha512: sha512.digest("hex") };
    if (expected && (bytes !== expected.size || receipt.sha1 !== expected.sha1.toLowerCase() || receipt.sha512 !== expected.sha512.toLowerCase())) throw new Error("Pack download does not match its published size and checksums.");
    await output.close();
    const stored = await hashProfileFile(file, assertActive);
    if (JSON.stringify(stored) !== JSON.stringify(receipt)) throw new Error("Profile file readback failed.");
    assertActive?.(); complete = true;
    return stored;
  } finally {
    await output.close().catch(() => {});
    if (!complete) await rm(file, { force: true });
  }
}

/** Production downloads are streamed into private staging, including the .mrpack itself. */
export async function downloadProfileFileToPath(urlValue: string, file: string, limit: number,
  expected?: { size: number; sha1: string; sha512: string }, assertActive?: () => void,
  reserveSpace?: (remaining: number) => Promise<void>): Promise<ProfileFileReceipt> {
  let url = profileDownloadUrl(urlValue);
  const signal = AbortSignal.timeout(120_000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    assertActive?.();
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirect === 5) throw new Error("Too many pack download redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Pack download redirect has no destination.");
      url = profileDownloadUrl(new URL(location, url).toString()); continue;
    }
    if (!response.ok || !response.body) throw new Error(`Pack download failed (${response.status}).`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) { await response.body.cancel(); throw new Error("Pack download exceeds its byte limit."); }
    const reader = response.body.getReader();
    async function* chunks() {
      while (true) { const next = await reader.read(); if (next.done) break; yield next.value; }
    }
    try { return await writeVerifiedProfileStream(file, chunks(), limit, expected, assertActive, reserveSpace); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  throw new Error("Pack download did not complete.");
}

/** Validate the entire ZIP and small index first. Retain only compact override descriptors. */
export async function inspectProfilePackArchiveFile(file: string, assertActive?: () => void): Promise<ProfilePackFileArchive> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > PROFILE_PACK_LIMITS.archive) throw new Error("Pack archive is unsafe or exceeds its byte limit.");
  const zip = await openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  const ordinary = new Map<string, ProfilePackOverride>(), server = new Map<string, ProfilePackOverride>(), seen = new Set<string>();
  let index: ProfilePackIndex | undefined, bytes = 0, count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      assertActive?.();
      if (++count > PROFILE_PACK_LIMITS.entries) throw new Error("Pack archive contains too many entries.");
      const directory = entry.fileName.endsWith("/"), name = profilePackPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) || entry.isEncrypted() || !entry.canDecodeFileData()) throw new Error("Pack archive contains a link, special file, encrypted or unsupported member.");
      if (seen.has(name)) throw new Error("Pack archive repeats a member path.");
      seen.add(name); bytes += entry.uncompressedSize;
      if (entry.uncompressedSize > PROFILE_PACK_LIMITS.file || bytes > PROFILE_PACK_LIMITS.total) throw new Error("Pack archive exceeds its expanded byte limit.");
      if (directory) continue;
      if (name === "modrinth.index.json") {
        if (entry.uncompressedSize > 8 * 1024 ** 2) throw new Error("Pack index exceeds its byte limit.");
        const chunks: Buffer[] = []; let actual = 0;
        for await (const chunk of await zip.openReadStreamPromise(entry)) {
          assertActive?.(); actual += chunk.length;
          if (actual > entry.uncompressedSize || actual > 8 * 1024 ** 2) throw new Error("Pack index exceeds its byte limit.");
          chunks.push(Buffer.from(chunk));
        }
        if (actual !== entry.uncompressedSize) throw new Error("Pack index is truncated.");
        index = parseProfilePackIndex(JSON.parse(Buffer.concat(chunks, actual).toString("utf8")));
      } else if (name.startsWith("overrides/") || name.startsWith("server-overrides/")) {
        const prefix = name.startsWith("server-overrides/") ? "server-overrides/" : "overrides/";
        if (name.slice(prefix.length) === "server.properties" && entry.uncompressedSize > PROFILE_PROPERTIES_LIMITS.bytes) throw new Error("server.properties exceeds its 1 MiB editor-safe limit.");
        const descriptor = { member: name, size: entry.uncompressedSize, compressedSize: entry.compressedSize,
          compressionMethod: entry.compressionMethod, generalPurposeBitFlag: entry.generalPurposeBitFlag, relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader };
        (prefix === "overrides/" ? ordinary : server).set(profilePackPath(name.slice(prefix.length)), descriptor);
      }
    }
  } finally { zip.close(); }
  if (!index) throw new Error("Pack archive has no Modrinth index.");
  for (const [name, entry] of server) ordinary.set(name, entry);
  return { index, overrides: ordinary };
}

/** Open one validated member and stream it directly to an exclusive regular staged file. */
export async function streamProfilePackOverride(archive: string, descriptor: ProfilePackOverride, destination: string,
  assertActive?: () => void, reserveSpace?: (remaining: number) => Promise<void>): Promise<ProfileFileReceipt> {
  const zip = await openPromise(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  const entry = Object.assign(new Entry(), descriptor, { fileName: descriptor.member, uncompressedSize: descriptor.size });
  const stream = await zip.openReadStreamPromise(entry).catch(error => { zip.close(); throw error; });
  try {
    const receipt = await writeVerifiedProfileStream(destination, stream, PROFILE_PACK_LIMITS.file, undefined, assertActive, reserveSpace);
    if (receipt.bytes !== descriptor.size) { await rm(destination, { force: true }); throw new Error("Pack member is truncated."); }
    return receipt;
  } finally { stream.destroy(); zip.close(); }
}
