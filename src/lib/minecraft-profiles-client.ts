import { MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS, type MinecraftProfileDTO, type MinecraftProfilesDTO, type MinecraftProfileDetailDTO, type MinecraftProfileRuntimeDTO, type MinecraftProfileCapabilities, type MinecraftProfileWorldSettingsDTO } from "@/lib/minecraft-profile-types";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export function isMinecraftProfile(value: unknown): value is MinecraftProfileDTO {
  if (!object(value) || !text(value.id) || !/^[a-zA-Z0-9_-]+$/.test(value.id) || !text(value.name) || typeof value.description !== "string" || !["preparing", "ready", "failed"].includes(String(value.status))) return false;
  const target = value.target, source = value.source;
  return object(target) && text(target.mcVersion) && MINECRAFT_PROFILE_LOADERS.some(loader => loader === target.loader) &&
    nullableText(target.loaderVersion) && MINECRAFT_JAVA_VARIANTS.some(java => java === target.javaVariant) &&
    object(source) && ["legacy", "vanilla", "saved-set", "modrinth"].includes(String(source.kind)) && nullableText(source.ref) && nullableText(source.versionId) && nullableText(source.title) &&
    (value.coverUrl === null || (text(value.coverUrl) && value.coverUrl.split("?")[0] === `/api/minecraft/profiles/${encodeURIComponent(value.id)}/cover` && !value.coverUrl.includes("\\"))) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    (value.modCount === undefined || (typeof value.modCount === "number" && Number.isSafeInteger(value.modCount) && value.modCount >= 0)) &&
    (value.error === null || typeof value.error === "string") && date(value.createdAt) && date(value.updatedAt) && (value.lastPlayedAt === null || date(value.lastPlayedAt));
}
function runtime(value: unknown): value is MinecraftProfileRuntimeDTO {
  return object(value) && nullableText(value.selectedProfileId) && nullableText(value.appliedProfileId) && typeof value.verified === "boolean" &&
    ["legacy", "stopped", "running", "starting", "unknown"].includes(String(value.state)) && text(value.revision) &&
    (value.reason === undefined || typeof value.reason === "string");
}
function capabilities(value: unknown): value is MinecraftProfileCapabilities {
  return object(value) && ["read", "manage", "start", "switch"].every(key => typeof value[key] === "boolean");
}
export function parseMinecraftProfiles(value: unknown): MinecraftProfilesDTO | null {
  if (!object(value) || !Array.isArray(value.profiles) || !value.profiles.every(isMinecraftProfile) ||
      new Set(value.profiles.map(profile => profile.id)).size !== value.profiles.length || !runtime(value.runtime) || !capabilities(value.capabilities) || typeof value.requiresAdoption !== "boolean") return null;
  const profiles = value.profiles;
  if ([value.runtime.selectedProfileId, value.runtime.appliedProfileId].some(id => id !== null && !profiles.some(profile => profile.id === id))) return null;
  return value as unknown as MinecraftProfilesDTO;
}
export function parseMinecraftProfileDetail(value: unknown, id: string): MinecraftProfileDetailDTO | null {
  return object(value) && isMinecraftProfile(value.profile) && value.profile.id === id && runtime(value.runtime) && capabilities(value.capabilities) ? value as unknown as MinecraftProfileDetailDTO : null;
}
export function parseProfileWorldSettings(value: unknown, id: string): MinecraftProfileWorldSettingsDTO | null {
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
  if (!object(value) || value.profileId !== id || !object(value.properties) || !Object.entries(value.properties).every(([key, v]) => text(key) && typeof v === "string") ||
      !strings(value.editableKeys) || !strings(value.creationOnlyKeys) || !strings(value.lockedKeys) || typeof value.worldGenerated !== "boolean" || typeof value.editable !== "boolean") return null;
  return value as unknown as MinecraftProfileWorldSettingsDTO;
}
export const profileSourceLabel = (profile: MinecraftProfileDTO) => profile.source.title || ({ legacy: "Existing world", vanilla: "Vanilla", "saved-set": "Saved mod set", modrinth: "Modrinth pack" }[profile.source.kind]);
export const profileLastPlayed = (profile: MinecraftProfileDTO) => profile.lastPlayedAt ? new Date(profile.lastPlayedAt).toLocaleString() : "Not recorded";
