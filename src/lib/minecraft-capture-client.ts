import { isMinecraftProfile } from "@/lib/minecraft-profiles-client";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import type { MinecraftCaptureCompanionManifest, MinecraftCaptureGrant, MinecraftCaptureReceipt } from "@/lib/minecraft-capture-types";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function sessionBase(v: unknown, profileId: string): v is Record<string, unknown> {
  return object(v) && identifier(v.id) && v.profileId === profileId && typeof v.expiresAt === "string" && Number.isFinite(Date.parse(v.expiresAt)) && revision(v.expectedRevision);
}
export function parseMinecraftCaptureGrant(value: unknown, profileId: string, expectedRevision: number): MinecraftCaptureGrant | null {
  if (!object(value) || !sessionBase(value.session, profileId) || value.session.expectedRevision !== expectedRevision || typeof value.session.command !== "string" || !/^\/yoshling pair [a-zA-Z0-9_-]{43}$/.test(value.session.command)) return null;
  return value.session as unknown as MinecraftCaptureGrant;
}
export function parseMinecraftCaptureReceipt(value: unknown, grant: MinecraftCaptureGrant): MinecraftCaptureReceipt | null {
  if (!object(value) || !sessionBase(value.session, grant.profileId) || value.session.id !== grant.id || value.session.expiresAt !== grant.expiresAt || value.session.expectedRevision !== grant.expectedRevision || typeof value.session.state !== "string" || !["waiting", "paired", "uploading", "complete", "expired", "stale", "unverified"].includes(value.session.state) || typeof value.verified !== "boolean" || (value.session.reason !== undefined && typeof value.session.reason !== "string")) return null;
  if (value.session.state === "complete" && (!value.verified || !isMinecraftProfile(value.profile) || value.profile.id !== grant.profileId || !value.profile.coverUrl || value.profile.revision !== grant.expectedRevision + 1)) return null;
  if (value.verified && value.session.state !== "complete") return null;
  return value as unknown as MinecraftCaptureReceipt;
}
export function parseMinecraftCaptureCompanion(value: unknown): MinecraftCaptureCompanionManifest | null {
  if (!object(value) || value.version !== "0.1.0" || value.loader !== "fabric" || !Array.isArray(value.minecraftVersions) || !value.minecraftVersions.every(v => typeof v === "string") || !value.minecraftVersions.includes("26.1.2") || typeof value.fileName !== "string" || !/^[a-zA-Z0-9_+.-]+\.jar$/.test(value.fileName) || ![`/companions/${value.fileName}`, `/companions/${encodeURIComponent(value.fileName)}`].includes(String(value.downloadUrl)) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0 || Number(value.bytes) > 32 * 1024 * 1024) return null;
  return value as unknown as MinecraftCaptureCompanionManifest;
}
/** A capture changes only cover/revision/update time; unrelated metadata must remain canonical. */
export function sameCaptureMetadata(a: MinecraftProfileDTO, b: MinecraftProfileDTO): boolean {
  const metadata = (p: MinecraftProfileDTO) => [p.id, p.name, p.description, p.status, p.target.mcVersion, p.target.loader, p.target.loaderVersion, p.target.javaVariant, p.source.kind, p.source.ref, p.source.versionId, p.source.title, p.modCount ?? null, p.createdAt, p.lastPlayedAt, p.error];
  return JSON.stringify(metadata(a)) === JSON.stringify(metadata(b));
}
