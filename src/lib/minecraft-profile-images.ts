import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import type { MinecraftProfileOverviewDTO, MinecraftProfileOverviewRequestReceipt } from "@/lib/minecraft-profile-overview-types";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const nullableText = (v: unknown) => v === null || text(v);
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const states = ["waiting", "queued", "rendering", "ready", "stale", "failed", "unsupported", "unverified"];

export function parseMinecraftProfileOverview(value: unknown, id: string): MinecraftProfileOverviewDTO | null {
  if (!object(value) || typeof value.state !== "string" || !states.includes(value.state) || value.dimension !== "overworld" ||
    !nullableText(value.imageUrl) || !(value.revision === null || hash(value.revision)) || !nullableDate(value.generatedAt) || !nullableDate(value.snapshotAt) || !nullableDate(value.sourceSavedAt) || !nullableText(value.operationId) || !nullableText(value.reason)) return null;
  if (value.renderer !== null && (!object(value.renderer) || !text(value.renderer.name) || !text(value.renderer.version))) return null;
  if (value.source !== null && (!object(value.source) || typeof value.source.kind !== "string" || !["saved-copy", "checkpoint", "backup"].includes(value.source.kind) || !text(value.source.id) || !hash(value.source.sha256))) return null;
  if (value.imageUrl !== null && (!hash(value.revision) || value.imageUrl !== `/api/minecraft/profiles/${encodeURIComponent(id)}/overview/image?revision=${value.revision}` || !date(value.generatedAt) || !date(value.snapshotAt) || value.renderer === null || value.source === null || !["ready", "stale", "failed", "queued", "rendering", "unverified"].includes(value.state))) return null;
  if (value.state === "ready" && value.imageUrl === null) return null;
  return value as unknown as MinecraftProfileOverviewDTO;
}
export function parseMinecraftProfileOverviewRead(value: unknown, id: string): MinecraftProfileOverviewDTO | null {
  return object(value) && value.profileId === id ? parseMinecraftProfileOverview(value.overview, id) : null;
}
export function parseMinecraftProfileOverviewRequest(value: unknown, id: string): MinecraftProfileOverviewRequestReceipt | null {
  if (!object(value) || value.profileId !== id || !text(value.operationId) || !(value.jobId === null || text(value.jobId)) || !parseMinecraftProfileOverview(value.overview, id)) return null;
  return value as unknown as MinecraftProfileOverviewRequestReceipt;
}
export const overviewDate = (value: string) => new Date(value).toLocaleString();
export const overviewStateLabel = (overview: MinecraftProfileOverviewDTO) => ({ waiting: "Waiting for a saved-world overview", queued: "Overview queued", rendering: "Rendering world overview", ready: "Generated world overview", stale: "Older world overview", failed: "Overview generation failed", unsupported: "Overview unavailable for this target", unverified: "Latest overview result unverified" }[overview.state]);
export function profileImagePresentation(profile: MinecraftProfileDTO) {
  if (profile.coverUrl) return { kind: "custom" as const, url: profile.coverUrl, label: "Custom cover", timestamp: null, detail: null };
  const overview = parseMinecraftProfileOverview(profile.overview, profile.id);
  if (overview?.imageUrl) return { kind: "generated" as const, url: overview.imageUrl, label: "Generated world overview", timestamp: overview.generatedAt, detail: overview.state === "ready" ? null : overviewStateLabel(overview) };
  return { kind: "illustration" as const, url: null, label: "World illustration", timestamp: null, detail: overview ? overview.reason || overviewStateLabel(overview) : profile.overview === undefined ? "Overview status not available" : "Overview could not be verified" };
}
