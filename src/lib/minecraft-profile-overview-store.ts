import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveSafeFilePath } from "./file-guard";
import { assertFileWriteActive } from "./operations";
import { MinecraftProfileError } from "./minecraft-profile-store";
import { minecraftProfileId } from "./minecraft-profile-path";
import { MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS, type MinecraftProfileTarget } from "./minecraft-profile-types";
import type { MinecraftProfileOverviewSource, MinecraftProfileOverviewState } from "./minecraft-profile-overview-types";

export const OVERVIEW_MAX_IMAGE = 5 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
export class MinecraftOverviewError extends MinecraftProfileError {
  constructor(message: string, status = 409, code = "overview_refused") { super(message, status, code); }
}
export interface OverviewSource extends MinecraftProfileOverviewSource {
  snapshotAt: string; sourceSavedAt: string | null;
  center: { x: number; z: number }; layout: "legacy" | "namespaced";
  files: { path: string; bytes: number; sha256: string }[];
}
export interface OverviewArtifact {
  revision: string; bytes: number; generatedAt: string; jobId: string;
  renderer: { name: string; version: string }; source: OverviewSource;
}
export interface OverviewRecord {
  format: 1; profileId: string; target: MinecraftProfileTarget;
  state: MinecraftProfileOverviewState; reason: string | null; updatedAt: string;
  jobId: string | null; operationId: string | null; retryAt: number;
  artifact: OverviewArtifact | null;
}
export interface OverviewJob {
  format: 1; id: string; profileId: string; target: MinecraftProfileTarget;
  source: OverviewSource; phase: "queued" | "rendering" | "complete" | "failed";
  createdAt: string; operationId: string | null;
  actor: { userId: string; name: string | null } | null;
}
export const overviewHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const overviewRoot = () => process.env.NODE_ENV === "production" ? "/app/data/minecraft-profile-overviews" : process.env.MC_PROFILE_OVERVIEWS_DIR || "/app/data/minecraft-profile-overviews";
const owner = (info: Awaited<ReturnType<typeof lstat>>) => info.uid === process.getuid?.() && info.gid === process.getgid?.();
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const states = new Set<MinecraftProfileOverviewState>(["waiting", "queued", "rendering", "ready", "stale", "failed", "unsupported", "unverified"]);
export function overviewTarget(value: unknown): value is MinecraftProfileTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as MinecraftProfileTarget;
  return typeof target.mcVersion === "string" && /^[0-9][A-Za-z0-9._-]{0,63}$/.test(target.mcVersion) &&
    MINECRAFT_PROFILE_LOADERS.includes(target.loader) && MINECRAFT_JAVA_VARIANTS.includes(target.javaVariant) &&
    (target.loaderVersion === null || typeof target.loaderVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(target.loaderVersion));
}
export function sameOverviewTarget(a: MinecraftProfileTarget, b: MinecraftProfileTarget) { return a.mcVersion === b.mcVersion && a.loader === b.loader && a.loaderVersion === b.loaderVersion && a.javaVariant === b.javaVariant; }
function source(value: unknown): value is OverviewSource {
  if (!value || typeof value !== "object") return false;
  const item = value as OverviewSource;
  return ["saved-copy", "checkpoint", "backup"].includes(item.kind) && typeof item.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}$/.test(item.id) && hex(item.sha256) && date(item.snapshotAt) && (item.sourceSavedAt === null || date(item.sourceSavedAt)) &&
    item.center && Number.isSafeInteger(item.center.x) && Number.isSafeInteger(item.center.z) && Math.abs(item.center.x) <= 30_000_000 && Math.abs(item.center.z) <= 30_000_000 && ["legacy", "namespaced"].includes(item.layout) &&
    Array.isArray(item.files) && item.files.length >= 2 && item.files.length <= 4096 && new Set(item.files.map(file => file.path)).size === item.files.length && item.files.every(file => /^(?:level\.dat|(?:dimensions\/minecraft\/overworld\/)?region\/(?:r\.-?\d+\.-?\d+\.mca|c\.-?\d+\.-?\d+\.mcc))$/.test(file.path) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= (file.path === "level.dat" ? 1024 * 1024 : 128 * 1024 * 1024) && hex(file.sha256)) && item.files.reduce((sum, file) => sum + file.bytes, 0) <= 256 * 1024 * 1024;
}
function artifact(value: unknown): value is OverviewArtifact {
  if (!value || typeof value !== "object") return false;
  const item = value as OverviewArtifact;
  try { minecraftProfileId(item.jobId); } catch { return false; }
  return hex(item.revision) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= OVERVIEW_MAX_IMAGE && date(item.generatedAt) && item.renderer && typeof item.renderer.name === "string" && item.renderer.name.length > 0 && item.renderer.name.length <= 80 && typeof item.renderer.version === "string" && item.renderer.version.length > 0 && item.renderer.version.length <= 80 && source(item.source);
}
export function validateOverviewRecord(value: unknown, id: string): OverviewRecord {
  if (!value || typeof value !== "object") throw new MinecraftOverviewError("Overview metadata is malformed", 503, "overview_unverified");
  const item = value as OverviewRecord;
  if (item.format !== 1 || item.profileId !== id || !overviewTarget(item.target) || !states.has(item.state) || !(item.reason === null || typeof item.reason === "string" && item.reason.length <= 1000) || !date(item.updatedAt) || !Number.isSafeInteger(item.retryAt) || item.retryAt < 0 || !(item.operationId === null || typeof item.operationId === "string" && item.operationId.length <= 180) || !(item.artifact === null || artifact(item.artifact))) throw new MinecraftOverviewError("Overview metadata is malformed", 503, "overview_unverified");
  if (item.jobId !== null) minecraftProfileId(item.jobId);
  return item;
}
export function validateOverviewJob(value: unknown, profileId: string, jobId: string): OverviewJob {
  if (!value || typeof value !== "object") throw new MinecraftOverviewError("Overview job is malformed", 503, "overview_unverified");
  const item = value as OverviewJob;
  if (item.format !== 1 || item.profileId !== profileId || item.id !== jobId || !overviewTarget(item.target) || !source(item.source) || !["queued", "rendering", "complete", "failed"].includes(item.phase) || !date(item.createdAt) || !(item.operationId === null || typeof item.operationId === "string") || !(item.actor === null || item.actor && typeof item.actor.userId === "string" && item.actor.userId.length > 0 && (item.actor.name === null || typeof item.actor.name === "string"))) throw new MinecraftOverviewError("Overview job is malformed", 503, "overview_unverified");
  return item;
}
/** All directories beneath the configured private root must be real and process-owned. */
export async function overviewPath(relative = "", createParents = false): Promise<string> {
  if (relative.includes("..") || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)) throw new MinecraftOverviewError("Invalid overview storage path", 400);
  const configured = path.resolve(overviewRoot()), parent = path.dirname(configured);
  const root = await resolveSafeFilePath(parent, path.basename(configured), { allowMissing: createParents, followFinalSymlink: false });
  if (!root) throw new MinecraftOverviewError("Private overview storage is not contained", 503, "overview_unverified");
  const directories = [root]; const parts = relative.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) directories.push(path.join(directories.at(-1)!, parts[i]));
  for (const directory of directories) {
    let info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (createParents && error.code === "ENOENT") return null; throw error; });
    if (!info) { assertFileWriteActive(); await mkdir(directory, { mode: 0o700 }); info = await lstat(directory); }
    if (!info.isDirectory() || info.isSymbolicLink() || !owner(info) || (info.mode & 0o777) !== 0o700) throw new MinecraftOverviewError("Overview storage requires owned private directories", 503, "overview_unverified");
  }
  const file = await resolveSafeFilePath(root, relative, { allowMissing: createParents, followFinalSymlink: false, allowRoot: true });
  if (!file) throw new MinecraftOverviewError("Overview storage is not contained", 503, "overview_unverified");
  return file;
}
export async function readOverviewBytes(relative: string, maximum: number): Promise<Buffer> {
  const file = await overviewPath(relative), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owner(info) || (info.mode & 0o777) !== 0o600 || info.size > maximum) throw new MinecraftOverviewError("Overview data is not an owned bounded regular file", 503, "overview_unverified");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.size > maximum || before.nlink !== 1 || !owner(before) || (before.mode & 0o777) !== 0o600) throw new MinecraftOverviewError("Overview data changed during admission", 503, "overview_unverified");
    const bytes = Buffer.alloc(before.size + 1); let total = 0;
    while (total < bytes.length) { const next = await handle.read(bytes, total, bytes.length - total, null); if (!next.bytesRead) break; total += next.bytesRead; }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new MinecraftOverviewError("Overview data changed during readback", 503, "overview_unverified");
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}
export async function readOverviewJSON(relative: string): Promise<unknown> { return JSON.parse((await readOverviewBytes(relative, MAX_JSON)).toString("utf8")); }
export async function writeOverviewBytes(relative: string, bytes: Buffer): Promise<void> {
  const target = await overviewPath(relative, true);
  await lstat(target).then(() => readOverviewBytes(relative, Math.max(bytes.length, MAX_JSON))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const temporary = `${relative}.write-${randomUUID()}`, temp = await overviewPath(temporary, true);
  assertFileWriteActive(); const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    assertFileWriteActive(); await rename(temp, target); await chmod(target, 0o600);
    const directory = await open(path.dirname(target), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    if (!(await readOverviewBytes(relative, bytes.length)).equals(bytes)) throw new MinecraftOverviewError("Overview publication failed byte readback", 503, "overview_unverified");
  } finally { await handle.close().catch(() => {}); await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
export async function writeOverviewJSON(relative: string, value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > MAX_JSON) throw new MinecraftOverviewError("Overview metadata exceeds its size limit", 413); await writeOverviewBytes(relative, bytes); }
export async function readOverviewRecord(id: string): Promise<OverviewRecord | null> {
  minecraftProfileId(id);
  try { return validateOverviewRecord(await readOverviewJSON(`${id}/overview.json`), id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeOverviewRecord(row: OverviewRecord) { validateOverviewRecord(row, minecraftProfileId(row.profileId)); await writeOverviewJSON(`${row.profileId}/overview.json`, row); }
export async function readOverviewJob(profileId: string, id: string): Promise<OverviewJob> { return validateOverviewJob(await readOverviewJSON(`${minecraftProfileId(profileId)}/jobs/${minecraftProfileId(id)}/job.json`), profileId, id); }
export async function writeOverviewJob(row: OverviewJob) { validateOverviewJob(row, minecraftProfileId(row.profileId), minecraftProfileId(row.id)); await writeOverviewJSON(`${row.profileId}/jobs/${row.id}/job.json`, row); }
export function minecraftOverviewInputManifest(profileId: string, jobId: string, target: MinecraftProfileTarget, source: OverviewSource) {
  return { format: 1, profileId, jobId, target, source: { kind: source.kind, id: source.id, sha256: source.sha256, snapshotAt: source.snapshotAt, sourceSavedAt: source.sourceSavedAt }, center: source.center, radius: 64, dimension: "overworld", layout: source.layout, files: source.files };
}
export async function verifyMinecraftOverviewManifest(profileId: string, jobId: string, target: MinecraftProfileTarget, source: OverviewSource): Promise<void> {
  const actual = await readOverviewJSON(`${profileId}/jobs/${jobId}/input/manifest.json`);
  if (JSON.stringify(actual) !== JSON.stringify(minecraftOverviewInputManifest(profileId, jobId, target, source))) throw new MinecraftOverviewError("The pinned overview manifest does not match its admitted source and target", 503, "overview_unverified");
}
export async function listOverviewProfiles(): Promise<string[]> {
  try { const names = await readdir(await overviewPath()); if (names.length > 256) throw new MinecraftOverviewError("Overview storage needs owner review", 429); return names.map(minecraftProfileId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
