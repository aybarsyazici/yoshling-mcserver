import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { db } from "./db";
import { isRole, canAccessGame, hasPermission } from "./permissions";
import { discordUserId } from "./discord-identity";
import { isWhitelisted } from "./whitelist";
import { getMinecraftProfile, updateProfileRecord, type MinecraftProfileRecord } from "./minecraft-profile-store";
import { getMinecraftProfileRuntimeStatus } from "./minecraft-profile-activation";
import { minecraftActiveContext, assertMinecraftProfileCurrent } from "./minecraft-active-profile";
import { minecraftCoverPath } from "./minecraft-profile-path";
import { minecraftProfileDTO, minecraftProfileResponse } from "./minecraft-profile-http";
import { normalizeMinecraftProfileCover, writeMinecraftProfileCover, removeMinecraftProfileCover, PROFILE_COVER_MAX_BYTES, PROFILE_COVER_MAX_PIXELS } from "./minecraft-profile-cover";
import { assertFileWriteActive } from "./operations";
import { CaptureError, captureHash, createCapture, activeCapture, readCapture, writeCaptureJSON, clearActiveCapture, type CaptureRecord } from "./minecraft-profile-capture-store";
import type { MinecraftCaptureReceipt, MinecraftCaptureSession, MinecraftCaptureState } from "./minecraft-capture-types";
import { captureIngressActive } from "./minecraft-profile-capture-ingress";

export async function captureManager(userId: string, expectedDiscordId?: string): Promise<{ id: string; discordId: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, discordId: true, role: true, games: true } });
  if (!user || !discordUserId(user.discordId) || (expectedDiscordId && user.discordId !== expectedDiscordId) || !isRole(user.role) ||
      !canAccessGame(user.role, user.games, "minecraft") || !hasPermission(user.role, "settings.edit") || !(await isWhitelisted(user.discordId))) throw new CaptureError("The managing account is no longer authorized for Minecraft capture", 403, "capture_revoked");
  return { id: user.id, discordId: user.discordId };
}
export async function captureRuntime(profileId: string): Promise<{ profile: MinecraftProfileRecord; token: string }> {
  const profile = await getMinecraftProfile(profileId);
  if (!profile) throw new CaptureError("Profile not found", 404, "profile_not_found");
  if (profile.status !== "ready" || profile.mcVersion !== "26.1.2" || !["vanilla", "fabric"].includes(profile.loader)) throw new CaptureError("Client capture supports ready Minecraft 26.1.2 vanilla or Fabric profiles", 422, "capture_unsupported");
  const runtime = await getMinecraftProfileRuntimeStatus();
  if (!runtime.verified || runtime.state !== "running" || runtime.selectedProfileId !== profileId || runtime.appliedProfileId !== profileId) throw new CaptureError("Capture requires this profile to be applied, verified and running", 409, "capture_stale");
  const context = await minecraftActiveContext();
  await assertMinecraftProfileCurrent(context);
  if (context.profileId !== profileId || context.revision !== runtime.revision) throw new CaptureError("The Minecraft profile changed during capture verification", 409, "capture_stale");
  return { profile, token: context.token };
}
function session(row: CaptureRecord, state: MinecraftCaptureState, reason?: string): MinecraftCaptureSession {
  return { id: row.id, profileId: row.profileId, expiresAt: new Date(row.expiresAt).toISOString(), expectedRevision: row.expectedRevision, state, ...(reason ? { reason } : {}) };
}
export async function captureCompletion(row: CaptureRecord): Promise<MinecraftCaptureReceipt | null> {
  if (!row.intent) return null;
  const profile = await getMinecraftProfile(row.profileId);
  if (!profile || profile.revision !== row.intent.revision || profile.coverKey !== row.intent.key || profile.coverMime !== "image/png") return null;
  const file = await minecraftCoverPath(row.profileId, row.intent.key, { allowMissing: false, followFinalSymlink: false });
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.gid !== process.getgid?.() || info.size > 8 * 1024 * 1024 || (info.mode & 0o777) !== 0o600 || info.size !== row.intent.bytes) throw new CaptureError("The published capture file could not be verified", 503, "capture_unverified");
  const bytes = await readFile(file);
  if (captureHash(bytes) !== row.intent.sha256) throw new CaptureError("The published capture bytes no longer match their receipt", 503, "capture_unverified");
  const dto = await minecraftProfileDTO(profile);
  let warning = row.warning;
  if (row.previousCoverKey && row.previousCoverKey !== row.intent.key) {
    try {
      const previous = await minecraftCoverPath(row.profileId, row.previousCoverKey, { followFinalSymlink: false });
      const remains = await lstat(previous).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      if (remains) warning = "The screenshot was published; previous-file cleanup needs owner review.";
    } catch { warning = "The screenshot was published; previous-file cleanup could not be verified."; }
  }
  const persisted = await readCapture(row.id);
  await captureManager(row.userId, row.discordId);
  const latest = await getMinecraftProfile(row.profileId);
  if (!latest || latest.revision !== row.intent.revision || latest.coverKey !== row.intent.key || latest.coverMime !== "image/png" || JSON.stringify(persisted.intent) !== JSON.stringify(row.intent) || persisted.userId !== row.userId || persisted.profileId !== row.profileId) throw new CaptureError("The profile or capture changed during completion readback", 409, "capture_stale");
  return { session: session(row, "complete", warning), verified: true, profile: dto };
}
export async function liveCapture(row: CaptureRecord): Promise<MinecraftProfileRecord> {
  await captureManager(row.userId, row.discordId);
  if (row.cancelledAt !== undefined || Date.now() >= row.expiresAt) throw new CaptureError("Capture session expired or was cancelled; pair again", 410, "capture_expired");
  if (await activeCapture(row.profileId) !== row.id) throw new CaptureError("A newer capture session replaced this one; pair again", 409, "capture_stale");
  const current = await captureRuntime(row.profileId);
  if (current.token !== row.contextToken || current.profile.revision !== row.expectedRevision || current.profile.coverKey !== row.previousCoverKey) throw new CaptureError("The profile, runtime or cover changed after pairing; reload before capturing", 409, "capture_stale");
  return current.profile;
}
export async function mintCapture(profileId: string, userId: string, expectedRevision: number, replaceExisting: boolean) {
  const owner = await captureManager(userId), current = await captureRuntime(profileId);
  if (current.profile.revision !== expectedRevision) throw new CaptureError("The profile changed; reload before pairing", 409, "capture_stale");
  if (current.profile.coverKey && !replaceExisting) throw new CaptureError("Confirm replacing the existing world screenshot", 409, "capture_replacement_required");
  const { row, code } = await createCapture({ profileId, userId, discordId: owner.discordId, contextToken: current.token, expectedRevision, previousCoverKey: current.profile.coverKey, replaceExisting });
  return { session: { id: row.id, profileId, expiresAt: new Date(row.expiresAt).toISOString(), expectedRevision, command: `/yoshling pair ${code}` } };
}
export async function captureStatus(profileId: string, id: string, userId: string): Promise<MinecraftCaptureReceipt> {
  const row = await readCapture(id);
  if (row.profileId !== profileId || row.userId !== userId) throw new CaptureError("Capture session was not found", 404, "capture_missing");
  await captureManager(row.userId, row.discordId);
  try {
    if (row.intent && row.phase !== "complete" && captureIngressActive(row.id)) return { session: session(row, "uploading", "This image publication is being verified."), verified: false };
    const completed = await captureCompletion(row); if (completed) return completed;
    if (row.intent) return { session: session(row, "unverified", "An image publication was admitted but its completion is unverified. Inspect the current cover before pairing again."), verified: false };
    await liveCapture(row);
    return { session: session(row, row.phase === "paired" ? "paired" : "waiting"), verified: false };
  } catch (error) {
    if (error instanceof CaptureError) return { session: session(row, error.code === "capture_expired" ? "expired" : error.code === "capture_stale" ? "stale" : "unverified", error.message), verified: false };
    throw error;
  }
}
export async function cancelCapture(profileId: string, id: string, userId: string) {
  const row = await readCapture(id);
  if (row.profileId !== profileId || row.userId !== userId) throw new CaptureError("Capture session was not found", 404, "capture_missing");
  await captureManager(row.userId, row.discordId);
  row.cancelledAt = Date.now(); await writeCaptureJSON(`${id}.json`, row); await clearActiveCapture(row);
  const stored = await readCapture(id);
  if (stored.cancelledAt !== row.cancelledAt || await activeCapture(profileId) === id) throw new CaptureError("Capture cancellation could not be verified", 503, "capture_unverified");
  return { cancelled: true, sessionId: id };
}
export function validateCaptureClient(body: Record<string, unknown>): void {
  if (Object.keys(body).some(key => !["protocol", "minecraftVersion", "serverAddress"].includes(key)) || body.protocol !== 1 || body.minecraftVersion !== "26.1.2") throw new CaptureError("Client capture requires protocol 1 and Minecraft 26.1.2", 422, "capture_unsupported");
  if (typeof body.serverAddress !== "string" || !/^(?:mc\.yoshling\.xyz|89\.58\.50\.155)(?::25565)?$/.test(body.serverAddress.trim().toLowerCase())) throw new CaptureError("Connect to the configured Minecraft server on port 25565 before pairing", 422, "capture_wrong_server");
}
function clientContext(row: CaptureRecord, profileName: string) {
  return { protocol: 1, sessionId: row.id, profileId: row.profileId, profileName, contextToken: row.contextToken, profileRevision: row.expectedRevision,
    expiresAt: new Date(row.expiresAt).toISOString(), maxBytes: PROFILE_COVER_MAX_BYTES, maxPixels: PROFILE_COVER_MAX_PIXELS, uploadUrl: "https://yoshling.xyz/api/minecraft/capture" };
}
export async function pairCapture(row: CaptureRecord) {
  await captureManager(row.userId, row.discordId);
  const completed = await captureCompletion(row);
  if (completed) {
    if (row.phase !== "complete") { row.phase = "complete"; row.warning = completed.session.reason; await writeCaptureJSON(`${row.id}.json`, row); }
    return { ...clientContext(row, completed.profile!.name), state: "complete", verified: true, profile: completed.profile };
  }
  if (row.intent) throw new CaptureError("The prior image publication is unverified; inspect the current cover before pairing again", 409, "capture_unverified");
  const profile = await liveCapture(row);
  row.phase = "paired"; await writeCaptureJSON(`${row.id}.json`, row);
  return { ...clientContext(row, profile.name), state: "waiting" };
}
export function checkCaptureHeaders(request: Request, row: CaptureRecord): void {
  if (request.headers.get("X-Minecraft-Context") !== row.contextToken || request.headers.get("X-Minecraft-Profile") !== row.profileId || request.headers.get("X-Profile-Revision") !== String(row.expectedRevision)) throw new CaptureError("The client capture context does not match its paired profile", 409, "capture_stale");
}
export async function preflightCaptureUpload(request: Request, row: CaptureRecord) {
  await captureManager(row.userId, row.discordId); checkCaptureHeaders(request, row);
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/png") throw new CaptureError("Client captures must use image/png", 415, "capture_invalid_image");
  const completed = await captureCompletion(row);
  if (!completed && row.intent) throw new CaptureError("The prior image publication is unverified; it cannot be overwritten or retried", 409, "capture_unverified");
  if (!completed) { await liveCapture(row); if (row.phase !== "paired") throw new CaptureError("Pair this capture session before uploading an image", 409, "capture_not_paired"); }
}
export async function publishCapture(row: CaptureRecord, input: Buffer, output: Buffer) {
  row = await readCapture(row.id); await captureManager(row.userId, row.discordId);
  const inputHash = captureHash(input), completed = await captureCompletion(row);
  if (completed) {
    if (row.intent?.inputSha256 !== inputHash) throw new CaptureError("This session already captured a different image; pair again", 409, "capture_replay");
    if (row.phase !== "complete") { row.phase = "complete"; row.warning = completed.session.reason; await writeCaptureJSON(`${row.id}.json`, row); }
    return { protocol: 1, state: "complete", sessionId: row.id, profileId: row.profileId, verified: true, profile: completed.profile };
  }
  if (row.intent) throw new CaptureError("Image publication is unverified; retry cannot overwrite it", 409, "capture_unverified");
  await liveCapture(row);
  if (row.phase !== "paired") throw new CaptureError("Pair this capture session before uploading", 409, "capture_not_paired");
  const oldCover = row.previousCoverKey ? await minecraftCoverPath(row.profileId, row.previousCoverKey, { followFinalSymlink: false }) : null;
  if (oldCover && !row.replaceExisting) throw new CaptureError("Existing screenshot replacement was not confirmed", 409, "capture_replacement_required");
  row.intent = { key: `${randomUUID()}.png`, inputSha256: inputHash, sha256: captureHash(output), bytes: output.length, revision: row.expectedRevision + 1 };
  row.phase = "uploading"; await writeCaptureJSON(`${row.id}.json`, row);
  assertFileWriteActive(); await writeMinecraftProfileCover(row.profileId, row.intent.key, output);
  await captureManager(row.userId, row.discordId); assertFileWriteActive();
  await updateProfileRecord(row.profileId, row.expectedRevision, { coverKey: row.intent.key, coverMime: "image/png" });
  const verified = await captureCompletion(row);
  if (!verified) throw new CaptureError("Capture publication could not be confirmed", 503, "capture_unverified");
  if (oldCover) { try { await removeMinecraftProfileCover(oldCover); } catch { row.warning = "The screenshot was published; previous-file cleanup needs owner review."; } }
  row.phase = "complete"; await writeCaptureJSON(`${row.id}.json`, row);
  return { protocol: 1, state: "complete", sessionId: row.id, profileId: row.profileId, verified: true, profile: verified.profile };
}
export const normalizeCapture = (input: Buffer) => normalizeMinecraftProfileCover(input, true);
export function captureResponse(work: () => Promise<NextResponse>) { return minecraftProfileResponse(work); }
