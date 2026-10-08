import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, open, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { minecraftProfilePath, minecraftProfileServerPath } from "./minecraft-profile-path";
import { getMinecraftProfileRuntimeStatus } from "./minecraft-profile-activation";
import { assertFileWriteActive } from "./operations";
import { getMinecraftProfile } from "./minecraft-profile-store";
import { overviewHash, overviewPath, verifyMinecraftOverviewManifest, MinecraftOverviewError, type OverviewSource } from "./minecraft-profile-overview-store";
import type { MinecraftProfileTarget } from "./minecraft-profile-types";

export const OVERVIEW_SOURCE_MAX_BYTES = 256 * 1024 * 1024;
export const OVERVIEW_RADIUS = 64;
const MAX_LEVEL = 1024 * 1024, MAX_INFLATED_LEVEL = 16 * 1024 * 1024;
/** A bounded NBT reader; no speculative spawn or saved-time fallback. */
export function parseOverviewLevel(input: Buffer): { center: { x: number; z: number }; sourceSavedAt: string | null } {
  let bytes: Buffer;
  try { bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: MAX_INFLATED_LEVEL }) : input; }
  catch { throw new MinecraftOverviewError("The saved world metadata could not be decoded safely", 422, "overview_source_invalid"); }
  if (input.length > MAX_LEVEL || bytes.length > MAX_INFLATED_LEVEL) throw new MinecraftOverviewError("The saved world metadata exceeds its overview limit", 413, "overview_source_invalid");
  let at = 0, tags = 0;
  const need = (count: number) => { if (!Number.isSafeInteger(count) || count < 0 || at + count > bytes.length) throw new Error("NBT truncated"); };
  const number = (size: number, read: (position: number) => number) => { need(size); const value = read(at); at += size; return value; };
  const string = () => { const size = number(2, position => bytes.readUInt16BE(position)); need(size); if (size > 8192) throw new Error("NBT string oversized"); const value = bytes.toString("utf8", at, at + size); at += size; return value; };
  function payload(type: number, depth: number): unknown {
    if (++tags > 100_000 || depth > 32) throw new Error("NBT exceeds parser budget");
    if (type === 1) return number(1, position => bytes.readInt8(position));
    if (type === 2) return number(2, position => bytes.readInt16BE(position));
    if (type === 3) return number(4, position => bytes.readInt32BE(position));
    if (type === 4) { need(8); const value = bytes.readBigInt64BE(at); at += 8; return value; }
    if (type === 5) return number(4, position => bytes.readFloatBE(position));
    if (type === 6) return number(8, position => bytes.readDoubleBE(position));
    if (type === 8) return string();
    if (type === 7 || type === 11 || type === 12) {
      const length = number(4, position => bytes.readInt32BE(position)), size = type === 7 ? 1 : type === 11 ? 4 : 8;
      if (length < 0 || length > 1_000_000) throw new Error("NBT array oversized"); need(length * size);
      if (type === 11 && length === 3) return [number(4, p => bytes.readInt32BE(p)), number(4, p => bytes.readInt32BE(p)), number(4, p => bytes.readInt32BE(p))];
      at += length * size; return null;
    }
    if (type === 9) { const child = number(1, p => bytes.readUInt8(p)), length = number(4, p => bytes.readInt32BE(p)); if (length < 0 || length > 100_000) throw new Error("NBT list oversized"); for (let i = 0; i < length; i++) payload(child, depth + 1); return null; }
    if (type === 10) {
      const result: Record<string, unknown> = Object.create(null);
      for (;;) { const child = number(1, p => bytes.readUInt8(p)); if (child === 0) return result; const name = string(); if (Object.hasOwn(result, name)) throw new Error("NBT duplicate field"); result[name] = payload(child, depth + 1); }
    }
    throw new Error("Unknown NBT type");
  }
  try {
    if (number(1, p => bytes.readUInt8(p)) !== 10) throw new Error("NBT root is not compound"); string();
    const root = payload(10, 0) as Record<string, unknown>, data = root.Data as Record<string, unknown>;
    if (!data || typeof data !== "object") throw new Error("NBT Data missing");
    const spawn = data.spawn as { dimension?: unknown; pos?: unknown } | undefined;
    const center = spawn ? (spawn.dimension === "minecraft:overworld" && Array.isArray(spawn.pos) && spawn.pos.length === 3 ? { x: spawn.pos[0], z: spawn.pos[2] } : null) : { x: data.SpawnX, z: data.SpawnZ };
    if (!center || !Number.isSafeInteger(center.x) || !Number.isSafeInteger(center.z) || Math.abs(center.x as number) > 30_000_000 || Math.abs(center.z as number) > 30_000_000) throw new Error("NBT Overworld spawn missing");
    const saved = data.LastPlayed;
    const sourceSavedAt = typeof saved === "bigint" && saved > BigInt(0) && saved <= BigInt(8_640_000_000_000_000) ? new Date(Number(saved)).toISOString() : null;
    return { center: center as { x: number; z: number }, sourceSavedAt };
  } catch { throw new MinecraftOverviewError("The saved Overworld spawn could not be verified", 422, "overview_source_invalid"); }
}
async function regular(file: string, maximum: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new MinecraftOverviewError("Overview sources require bounded regular files without links", 422, "overview_source_invalid");
  return info;
}
async function directory(file: string) { const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink()) throw new MinecraftOverviewError("Overview sources refuse directory aliases", 422, "overview_source_invalid"); }
export async function hashOverviewSourceFile(file: string, maximum: number): Promise<{ bytes: number; sha256: string }> {
  const initial = await regular(file, maximum), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); if (before.ino !== initial.ino || before.dev !== initial.dev || before.size !== initial.size) throw new MinecraftOverviewError("Overview source changed during admission", 409, "overview_source_changed");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false })) { bytes += chunk.length; if (bytes > maximum) throw new MinecraftOverviewError("Overview source exceeds its byte limit", 413); hash.update(chunk); }
    const after = await handle.stat(); if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new MinecraftOverviewError("Overview source changed during readback", 409, "overview_source_changed");
    return { bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function boundedLevel(file: string): Promise<Buffer> {
  const info = await regular(file, MAX_LEVEL), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await handle.stat(); if (before.ino !== info.ino || before.dev !== info.dev || before.size > MAX_LEVEL) throw new MinecraftOverviewError("World metadata changed", 409); const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await handle.read(bytes); const after = await handle.stat(); if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new MinecraftOverviewError("World metadata changed", 409); return bytes.subarray(0, bytesRead); } finally { await handle.close(); }
}
async function copySourceFile(source: string, relative: string, expected: { bytes: number; sha256: string }, destination: string): Promise<void> {
  const to = await overviewPath(destination, true), initial = await regular(source, 128 * 1024 * 1024), from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW), target = await open(to, "wx", 0o600);
  try {
    const admitted = await from.stat(); if (admitted.ino !== initial.ino || admitted.dev !== initial.dev || admitted.size !== expected.bytes) throw new MinecraftOverviewError("World changed before copy", 409, "overview_source_changed");
    let bytes = 0; const hash = createHash("sha256");
    const guard = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; if (bytes > expected.bytes) return done(new MinecraftOverviewError("World changed during copy", 409, "overview_source_changed")); hash.update(chunk); done(null, chunk); } });
    assertFileWriteActive(); await pipeline(createReadStream(source, { fd: from.fd, autoClose: false }), guard, createWriteStream(to, { fd: target.fd, autoClose: false }));
    await target.sync();
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256 || JSON.stringify(await hashOverviewSourceFile(to, 128 * 1024 * 1024)) !== JSON.stringify({ bytes: expected.bytes, sha256: expected.sha256 })) throw new MinecraftOverviewError(`The saved copy of ${relative} failed readback`, 503, "overview_unverified");
  } finally { await from.close(); await target.close(); }
}
async function snapshotWorld(world: string, profileId: string, jobId: string, origin: { kind: OverviewSource["kind"]; id: string; snapshotAt?: string }, expectedFiles?: { path: string; bytes: number; sha256: string | null }[]): Promise<OverviewSource | null> {
  try { await directory(world); await regular(path.join(world, "level.dat"), MAX_LEVEL); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const level = await boundedLevel(path.join(world, "level.dat")), details = parseOverviewLevel(level);
  const namespaced = path.join(world, "dimensions", "minecraft", "overworld");
  let layout: OverviewSource["layout"] = "legacy";
  try { await directory(path.join(world, "dimensions")); await directory(path.join(world, "dimensions", "minecraft")); await directory(namespaced); layout = "namespaced"; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const regionRelative = layout === "namespaced" ? "dimensions/minecraft/overworld/region" : "region", region = path.join(world, regionRelative);
  try { await directory(region); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const minX = Math.floor((details.center.x - OVERVIEW_RADIUS) / 512), maxX = Math.floor((details.center.x + OVERVIEW_RADIUS) / 512), minZ = Math.floor((details.center.z - OVERVIEW_RADIUS) / 512), maxZ = Math.floor((details.center.z + OVERVIEW_RADIUS) / 512);
  const names = await readdir(region); if (names.length > 50_000) throw new MinecraftOverviewError("The region directory exceeds its overview admission budget", 413);
  const selected = names.filter(name => {
    let match = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
    if (match) return Number(match[1]) >= minX && Number(match[1]) <= maxX && Number(match[2]) >= minZ && Number(match[2]) <= maxZ;
    match = /^c\.(-?\d+)\.(-?\d+)\.mcc$/.exec(name);
    return !!match && Math.floor(Number(match[1]) / 32) >= minX && Math.floor(Number(match[1]) / 32) <= maxX && Math.floor(Number(match[2]) / 32) >= minZ && Math.floor(Number(match[2]) / 32) <= maxZ;
  }).sort();
  if (!selected.some(name => name.endsWith(".mca"))) return null;
  if (selected.length + 1 > 4096) throw new MinecraftOverviewError("The spawn overview exceeds its file budget", 413);
  let admittedBytes = 0;
  for (const relative of ["level.dat", ...selected.map(name => `${regionRelative}/${name}`)]) {
    admittedBytes += (await regular(path.join(world, relative), relative === "level.dat" ? MAX_LEVEL : 128 * 1024 * 1024)).size;
    if (admittedBytes > OVERVIEW_SOURCE_MAX_BYTES) throw new MinecraftOverviewError("The spawn overview exceeds its 256 MiB disk budget", 413);
  }
  const files: OverviewSource["files"] = []; let total = 0;
  for (const relative of ["level.dat", ...selected.map(name => `${regionRelative}/${name}`)]) {
    const file = path.join(world, relative), maximum = relative === "level.dat" ? MAX_LEVEL : 128 * 1024 * 1024, receipt = await hashOverviewSourceFile(file, maximum);
    if ((total += receipt.bytes) > OVERVIEW_SOURCE_MAX_BYTES) throw new MinecraftOverviewError("The spawn overview exceeds its 256 MiB disk budget", 413);
    const recorded = expectedFiles?.find(entry => entry.path === `world/${relative}`);
    if (expectedFiles && (!recorded || recorded.bytes !== receipt.bytes || recorded.sha256 !== receipt.sha256)) throw new MinecraftOverviewError("The checkpoint does not match its recorded world files", 422, "overview_source_invalid");
    files.push({ path: relative, ...receipt });
  }
  if (files[0].sha256 !== overviewHash(level)) throw new MinecraftOverviewError("World metadata changed during selection", 409, "overview_source_changed");
  const root = await overviewPath("", true), space = await statfs(root); if (space.bavail * space.bsize < total + 1024 ** 3) throw new MinecraftOverviewError("Overview generation requires its snapshot space and 1 GiB free", 507, "overview_no_space");
  for (const file of files) { assertFileWriteActive(); await copySourceFile(path.join(world, file.path), file.path, file, `${profileId}/jobs/${jobId}/input/world/${file.path}`); }
  for (const file of files) { assertFileWriteActive(); if (JSON.stringify(await hashOverviewSourceFile(path.join(world, file.path), file.path === "level.dat" ? MAX_LEVEL : 128 * 1024 * 1024)) !== JSON.stringify({ bytes: file.bytes, sha256: file.sha256 })) throw new MinecraftOverviewError("World files changed during snapshot; the copy is unverified", 409, "overview_source_changed"); }
  return { ...origin, snapshotAt: new Date().toISOString(), ...details, layout, files, sha256: overviewHash(JSON.stringify(files)) };
}
/** Called under Minecraft's file lane. It never saves, pauses, stops or starts a game. */
export async function copyMinecraftOverviewSource(profileId: string, jobId: string): Promise<OverviewSource | null> {
  const before = await getMinecraftProfileRuntimeStatus();
  if (!before.verified || before.state === "unknown" || before.state === "starting") throw new MinecraftOverviewError("Minecraft identity or startup must settle before taking an overview copy", 409, "overview_deferred");
  const selectedRunning = before.selectedProfileId === profileId && before.state === "running";
  let result: OverviewSource | null;
  if (selectedRunning) {
    const { latestMinecraftOverviewArchive, copyMinecraftOverviewArchive } = await import("./minecraft-profile-overview-archive");
    const profile = await getMinecraftProfile(profileId), archive = profile ? await latestMinecraftOverviewArchive(profile) : null;
    if (archive) {
      result = await copyMinecraftOverviewArchive(profileId, jobId, archive);
      const after = await getMinecraftProfileRuntimeStatus();
      if (!after.verified || after.revision !== before.revision || after.selectedProfileId !== before.selectedProfileId || after.appliedProfileId !== before.appliedProfileId) throw new MinecraftOverviewError("Minecraft identity changed during archived snapshot", 409, "overview_source_changed");
      return result;
    }
    let root: string;
    try { root = await minecraftProfilePath(profileId, "checkpoints", { allowMissing: false, followFinalSymlink: false }); await directory(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MinecraftOverviewError("Waiting for a verified saved checkpoint or a stopped world", 409, "overview_deferred"); throw error; }
    const names = (await readdir(root)).filter(name => /^\d{13}-[0-9a-f-]{36}$/.test(name)).sort().reverse();
    if (!names.length) throw new MinecraftOverviewError("Waiting for a verified saved checkpoint or a stopped world", 409, "overview_deferred");
    const checkpoint = await minecraftProfilePath(profileId, `checkpoints/${names[0]}`, { allowMissing: false, followFinalSymlink: false }); await directory(checkpoint);
    const metadata = await boundedCheckpoint(path.join(checkpoint, "checkpoint.json"));
    if (metadata.profileId !== profileId || metadata.formatVersion !== 1 || !Array.isArray(metadata.files)) throw new MinecraftOverviewError("The profile checkpoint metadata could not be verified", 422, "overview_source_invalid");
    await directory(path.join(checkpoint, "server"));
    result = await snapshotWorld(path.join(checkpoint, "server", "world"), profileId, jobId, { kind: "checkpoint", id: names[0] }, metadata.files);
  } else {
    const server = await minecraftProfileServerPath(profileId, "", { allowMissing: false, followFinalSymlink: false }); await directory(server);
    result = await snapshotWorld(path.join(server, "world"), profileId, jobId, { kind: "saved-copy", id: jobId });
  }
  const after = await getMinecraftProfileRuntimeStatus();
  if (!after.verified || after.state !== before.state || after.revision !== before.revision || after.selectedProfileId !== before.selectedProfileId || after.appliedProfileId !== before.appliedProfileId || after.containerState !== before.containerState) throw new MinecraftOverviewError("Minecraft state changed during snapshot; the copy is unverified", 409, "overview_source_changed");
  return result;
}
async function boundedCheckpoint(file: string): Promise<{ formatVersion?: unknown; profileId?: unknown; files?: { path: string; bytes: number; sha256: string | null }[] }> {
  const info = await regular(file, 16 * 1024 * 1024), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await handle.stat(); if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw new MinecraftOverviewError("Checkpoint changed during admission", 409); const bytes = Buffer.alloc(before.size + 1); let total = 0; while (total < bytes.length) { const next = await handle.read(bytes, total, bytes.length - total, null); if (!next.bytesRead) break; total += next.bytesRead; } const after = await handle.stat(); if (total !== info.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new MinecraftOverviewError("Checkpoint changed during readback", 409); return JSON.parse(bytes.subarray(0, total).toString("utf8")); } finally { await handle.close(); }
}
/** Recheck immutable input immediately before and after the worker. */
export async function verifyMinecraftOverviewInput(profileId: string, jobId: string, source: OverviewSource, target: MinecraftProfileTarget): Promise<void> {
  await verifyMinecraftOverviewManifest(profileId, jobId, target, source);
  for (const file of source.files) {
    const input = await overviewPath(`${profileId}/jobs/${jobId}/input/world/${file.path}`);
    if (JSON.stringify(await hashOverviewSourceFile(input, 128 * 1024 * 1024)) !== JSON.stringify({ bytes: file.bytes, sha256: file.sha256 })) throw new MinecraftOverviewError("The overview's pinned source changed", 503, "overview_unverified");
  }
  if (source.sha256 !== overviewHash(JSON.stringify(source.files))) throw new MinecraftOverviewError("The overview source manifest changed", 503, "overview_unverified");
}
