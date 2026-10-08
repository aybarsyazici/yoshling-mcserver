import type { MinecraftProfileOverviewDTO } from "./minecraft-profile-overview-types";
/** Client-safe contracts. Display names never identify filesystem paths. */
export const MINECRAFT_PROFILE_LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt"] as const;
export type MinecraftProfileLoader = typeof MINECRAFT_PROFILE_LOADERS[number];
export const MINECRAFT_JAVA_VARIANTS = ["java8", "java11", "java17", "java21", "java25"] as const;
export type MinecraftJavaVariant = typeof MINECRAFT_JAVA_VARIANTS[number];
export type MinecraftProfileStatus = "preparing" | "ready" | "failed";
export type MinecraftProfileSourceKind = "legacy" | "vanilla" | "saved-set" | "modrinth";

export interface MinecraftProfilePackBuild {
  id: string;
  name: string;
  versionNumber: string;
  mcVersions: string[];
  loaders: string[];
  publishedAt: string;
  supported: boolean;
  reason?: string;
}

export interface MinecraftProfileTarget {
  mcVersion: string;
  loader: MinecraftProfileLoader;
  loaderVersion: string | null;
  javaVariant: MinecraftJavaVariant;
}

export interface MinecraftProfileDTO {
  id: string;
  name: string;
  description: string;
  status: MinecraftProfileStatus;
  target: MinecraftProfileTarget;
  source: { kind: MinecraftProfileSourceKind; ref: string | null; versionId: string | null; title: string | null };
  coverUrl: string | null;
  /** Independent saved-world rendering; absent on legacy/synchronous receipts. */
  overview?: MinecraftProfileOverviewDTO;
  /** Exact active jar count when physically inspected; absent means unknown. */
  modCount?: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastPlayedAt: string | null;
  error: string | null;
}

export interface MinecraftProfileRuntimeDTO {
  selectedProfileId: string | null;
  appliedProfileId: string | null;
  verified: boolean;
  state: "legacy" | "stopped" | "running" | "starting" | "unknown";
  reason?: string;
  revision: string;
  containerState?: string;
  identityStatus?: "checked" | "legacy" | "unknown";
}

export interface MinecraftProfileCapabilities {
  read: boolean;
  manage: boolean;
  start: boolean;
  switch: boolean;
}

export interface MinecraftProfilesDTO {
  profiles: MinecraftProfileDTO[];
  runtime: MinecraftProfileRuntimeDTO;
  requiresAdoption: boolean;
  capabilities: MinecraftProfileCapabilities;
}

export interface MinecraftProfileDetailDTO {
  profile: MinecraftProfileDTO;
  runtime: MinecraftProfileRuntimeDTO;
  capabilities: MinecraftProfileCapabilities;
}

export type CreateMinecraftProfileSource =
  | { kind: "vanilla"; mcVersion: string; loader?: MinecraftProfileLoader; loaderVersion?: string }
  | { kind: "saved-set"; ref: string; loaderVersion?: string }
  | { kind: "modrinth"; ref: string; versionId?: string };

export interface CreateMinecraftProfileInput {
  name: string;
  description?: string;
  source: CreateMinecraftProfileSource;
  javaVariant?: MinecraftJavaVariant;
  settings?: Record<string, string>;
}

export interface MinecraftProfileWorldSettingsDTO {
  profileId: string;
  properties: Record<string, string>;
  editableKeys: string[];
  creationOnlyKeys: string[];
  lockedKeys: string[];
  worldGenerated: boolean;
  editable: boolean;
}

export interface MinecraftProfileWorldSettingsReceipt {
  profileId: string;
  applied: string[];
  ignored: string[];
  properties: Record<string, string>;
}
