import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveSafeFilePath } from "./file-guard";
import { assertFileWriteActive } from "./operations";
import { MinecraftProfileError } from "./minecraft-profile-store";
import { minecraftProfileId } from "./minecraft-profile-path";

export const CAPTURE_TTL_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000, MAX_GRANTS = 256;
export interface CaptureIntent { key: string; inputSha256: string; sha256: string; bytes: number; revision: number }
export interface CaptureRecord {
  format: 1; id: string; profileId: string; userId: string; discordId: string; secretHash: string;
  createdAt: number; expiresAt: number; expectedRevision: number; contextToken: string; previousCoverKey: string | null;
  replaceExisting: boolean; phase: "waiting" | "paired" | "uploading" | "complete"; cancelledAt?: number;
  intent?: CaptureIntent; warning?: string;
}
export class CaptureError extends MinecraftProfileError {
  constructor(message: string, status = 409, code = "capture_refused") { super(message, status, code); }
}
export function captureHash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export function captureDirectory(): string {
  return process.env.NODE_ENV === "production" ? "/app/data/minecraft-profile-captures" : process.env.MC_PROFILE_CAPTURES_DIR || "/app/data/minecraft-profile-captures";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const owner = (info: Awaited<ReturnType<typeof lstat>>) => info.uid === process.getuid?.() && info.gid === process.getgid?.();
export async function captureRoot(create = false): Promise<string> {
  const configured = path.resolve(captureDirectory()), parent = path.dirname(configured);
  const safe = await resolveSafeFilePath(parent, path.basename(configured), { allowMissing: create, followFinalSymlink: false, allowRoot: false });
  if (!safe) throw new CaptureError("Private capture storage could not be admitted", 503, "capture_unverified");
  let info = await lstat(safe).catch((error: NodeJS.ErrnoException) => { if (create && error.code === "ENOENT") return null; throw error; });
  if (!info) { assertFileWriteActive(); await mkdir(safe, { mode: 0o700 }); info = await lstat(safe); }
  if (!info.isDirectory() || info.isSymbolicLink() || !owner(info) || (info.mode & 0o777) !== 0o700) throw new CaptureError("Capture storage requires an owned private directory", 503, "capture_unverified");
  return safe;
}
async function filePath(name: string, missing = false): Promise<string> {
  if (!/^(?:active-)?[a-f0-9-]{36}\.json$/.test(name) && !/^\.write-[a-f0-9-]{36}\.json$/.test(name)) throw new CaptureError("Invalid capture storage identity", 400);
  const root = await captureRoot(missing), file = await resolveSafeFilePath(root, name, { allowMissing: missing, followFinalSymlink: false });
  if (!file) throw new CaptureError("Capture storage path is not contained", 503, "capture_unverified");
  return file;
}
async function readJSON(name: string): Promise<unknown> {
  const file = await filePath(name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owner(info) || (info.mode & 0o777) !== 0o600 || info.size > 16_384) throw new CaptureError("The capture record is not an owned regular file", 503, "capture_unverified");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stored = await handle.stat();
    if (stored.ino !== info.ino || stored.dev !== info.dev || !stored.isFile() || stored.nlink !== 1 || !owner(stored) || (stored.mode & 0o777) !== 0o600 || stored.size > 16_384) throw new CaptureError("Capture storage changed while read", 503, "capture_unverified");
    const bytes = Buffer.alloc(16_385); let total = 0;
    while (total < bytes.length) { const next = await handle.read(bytes, total, bytes.length - total, null); if (!next.bytesRead) break; total += next.bytesRead; }
    const after = await handle.stat();
    if (total > 16_384 || total !== stored.size || after.size !== stored.size || after.mtimeMs !== stored.mtimeMs) throw new CaptureError("Capture record changed or exceeds its byte limit", 503, "capture_unverified");
    return JSON.parse(bytes.subarray(0, total).toString("utf8"));
  }
  finally { await handle.close(); }
}
export async function writeCaptureJSON(name: string, value: unknown): Promise<void> {
  const target = await filePath(name, true);
  await lstat(target).then(async () => { await readJSON(name); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const root = await captureRoot(), temporary = await filePath(`.write-${randomUUID()}.json`, true), bytes = JSON.stringify(value);
  assertFileWriteActive(); const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8"); await handle.sync(); await handle.close();
    assertFileWriteActive(); await rename(temporary, target); await chmod(target, 0o600);
    const directory = await open(root, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    if (JSON.stringify(await readJSON(name)) !== bytes) throw new CaptureError("Capture record publication could not be read back", 503, "capture_unverified");
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
function record(value: unknown): CaptureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CaptureError("Capture record is malformed", 503, "capture_unverified");
  const row = value as CaptureRecord;
  if (row.format !== 1 || typeof row.id !== "string" || row.id.length !== 36 || !uuid.test(row.id) || typeof row.profileId !== "string" || row.profileId.length !== 36 || !uuid.test(row.profileId) ||
      typeof row.userId !== "string" || !row.userId || typeof row.discordId !== "string" || !row.discordId || !hex(row.secretHash) ||
      !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt - row.createdAt !== CAPTURE_TTL_MS ||
      !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || typeof row.contextToken !== "string" || !row.contextToken.startsWith(`${row.profileId}@`) ||
      typeof row.replaceExisting !== "boolean" || !(row.previousCoverKey === null || typeof row.previousCoverKey === "string") || !["waiting", "paired", "uploading", "complete"].includes(row.phase) ||
      (row.cancelledAt !== undefined && !Number.isSafeInteger(row.cancelledAt)) || (row.warning !== undefined && typeof row.warning !== "string")) throw new CaptureError("Capture record is malformed", 503, "capture_unverified");
  if (row.intent && (!/^[a-f0-9-]{36}\.png$/.test(row.intent.key) || !hex(row.intent.sha256) || !hex(row.intent.inputSha256) || !Number.isSafeInteger(row.intent.bytes) || row.intent.bytes < 1 || row.intent.bytes > 8 * 1024 * 1024 || row.intent.revision !== row.expectedRevision + 1)) throw new CaptureError("Capture intent is malformed", 503, "capture_unverified");
  if ((row.phase === "uploading" || row.phase === "complete") && !row.intent) throw new CaptureError("Capture intent is missing", 503, "capture_unverified");
  return row;
}
export async function readCapture(id: string): Promise<CaptureRecord> {
  minecraftProfileId(id);
  try { const row = record(await readJSON(`${id}.json`)); if (row.id !== id) throw new CaptureError("Capture record identity does not match its storage path", 503, "capture_unverified"); return row; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CaptureError("Capture session was not found", 404, "capture_missing"); throw error; }
}
export async function activeCapture(profileId: string): Promise<string | null> {
  minecraftProfileId(profileId);
  try {
    const value = await readJSON(`active-${profileId}.json`);
    if (!value || typeof value !== "object" || (value as { profileId?: unknown }).profileId !== profileId || (value as { format?: unknown }).format !== 1) throw new CaptureError("Active capture pointer is malformed", 503, "capture_unverified");
    return minecraftProfileId((value as { id: string }).id);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function clearActiveCapture(row: CaptureRecord): Promise<void> {
  if (await activeCapture(row.profileId) !== row.id) return;
  assertFileWriteActive(); await unlink(await filePath(`active-${row.profileId}.json`));
  if (await activeCapture(row.profileId) === row.id) throw new CaptureError("Capture cancellation could not be verified", 503, "capture_unverified");
}
export async function cleanupCaptures(now = Date.now()): Promise<void> {
  const root = await captureRoot(true), names = await readdir(root);
  for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const row = await readCapture(name.slice(0, -5));
    if (row.phase !== "uploading" && now > row.expiresAt + RETENTION_MS) { assertFileWriteActive(); await unlink(await filePath(name)); }
  }
  const remaining = (await readdir(root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (remaining.length >= MAX_GRANTS) throw new CaptureError("Capture session storage is full; expired or unverified sessions need owner review", 429, "capture_capacity");
}
export async function createCapture(input: Omit<CaptureRecord, "format" | "id" | "secretHash" | "createdAt" | "expiresAt" | "phase">): Promise<{ row: CaptureRecord; code: string }> {
  await cleanupCaptures(); const id = randomUUID(), secret = randomBytes(16), createdAt = Date.now();
  const row: CaptureRecord = { ...input, format: 1, id, secretHash: captureHash(secret), createdAt, expiresAt: createdAt + CAPTURE_TTL_MS, phase: "waiting" };
  await writeCaptureJSON(`${id}.json`, row);
  await writeCaptureJSON(`active-${row.profileId}.json`, { format: 1, profileId: row.profileId, id });
  if (await activeCapture(row.profileId) !== id) throw new CaptureError("Capture activation could not be verified", 503, "capture_unverified");
  return { row, code: Buffer.concat([Buffer.from(id.replaceAll("-", ""), "hex"), secret]).toString("base64url") };
}
export async function bearerCapture(request: Request): Promise<CaptureRecord> {
  const header = request.headers.get("Authorization"), code = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new CaptureError("Invalid capture authorization", 401, "capture_unauthorized");
  const bytes = Buffer.from(code, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== code) throw new CaptureError("Invalid capture authorization", 401, "capture_unauthorized");
  const hexId = bytes.subarray(0, 16).toString("hex"), id = `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`;
  let row: CaptureRecord; try { row = await readCapture(id); } catch (error) { if (error instanceof CaptureError && error.status === 404) throw new CaptureError("Invalid capture authorization", 401, "capture_unauthorized"); throw error; }
  if (!timingSafeEqual(Buffer.from(row.secretHash, "hex"), Buffer.from(captureHash(bytes.subarray(16)), "hex"))) throw new CaptureError("Invalid capture authorization", 401, "capture_unauthorized");
  if (row.cancelledAt !== undefined || Date.now() >= row.expiresAt) throw new CaptureError("Capture session expired or was cancelled; pair again", 410, "capture_expired");
  return row;
}
