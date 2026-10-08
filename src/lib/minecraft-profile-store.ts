import { randomUUID } from "node:crypto";
import type { MinecraftProfile, MinecraftRuntime, Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { gameDataPath } from "./game-data-path";
import { assertFileWriteActive } from "./operations";
import { inspectMinecraftReservedProfileStorage, legacyMinecraftDataPresent, managedMinecraftProfilesPresent, minecraftProfileId, minecraftProfileServerPath, minecraftStorageRoot } from "./minecraft-profile-path";
import {
  MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS,
  type MinecraftJavaVariant, type MinecraftProfileDTO, type MinecraftProfileLoader,
  type MinecraftProfileSourceKind, type MinecraftProfileStatus,
} from "./minecraft-profile-types";

export class MinecraftProfileError extends Error {
  constructor(message: string, public status = 409, public code = "profile_refused") { super(message); }
}

export type MinecraftProfileRecord = Omit<MinecraftProfile, "loader" | "javaVariant" | "status" | "sourceKind"> & {
  loader: MinecraftProfileLoader; javaVariant: MinecraftJavaVariant;
  status: MinecraftProfileStatus; sourceKind: MinecraftProfileSourceKind;
};
export type MinecraftRuntimeRecord = MinecraftRuntime;

export interface CreateProfileRecordInput {
  id?: string; name: string; description?: string; status?: MinecraftProfileStatus;
  mcVersion: string; loader: MinecraftProfileLoader; loaderVersion?: string | null; javaVariant: MinecraftJavaVariant;
  sourceKind: MinecraftProfileSourceKind; sourceRef?: string | null; sourceVersionId?: string | null;
  sourceTitle?: string | null; createdBy: string;
}
export type UpdateProfileRecordInput = Partial<Pick<MinecraftProfileRecord,
  "name" | "description" | "status" | "mcVersion" | "loader" | "loaderVersion" | "javaVariant" |
  "preparationError" | "coverKey" | "coverMime" | "lastPlayedAt"
>>;

function profileSchemaMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: { table?: unknown; modelName?: unknown }; message?: unknown };
  if ((error as { name?: unknown }).name === "DriverAdapterError" && typeof value.message === "string" &&
      /^(?:SQLITE_ERROR:\s*)?no such table:\s*(?:main\.)?Minecraft(?:Profile|Runtime)$/.test(value.message.trim())) return true;
  if (value.code !== "P2021") return false;
  const table = typeof value.meta?.table === "string" ? value.meta.table : value.meta?.modelName;
  return typeof table === "string" && /(?:^|\.)Minecraft(?:Profile|Runtime)$/.test(table.replace(/["`]/g, ""));
}

/** Known pre-migration absence only; other DB errors remain errors. No row is seeded. */
export async function readMinecraftRuntime(): Promise<{ schemaReady: boolean; runtime: MinecraftRuntimeRecord | null }> {
  if (!db.minecraftRuntime || !db.minecraftProfile) return { schemaReady: false, runtime: null };
  try {
    await db.minecraftProfile.count();
    return { schemaReady: true, runtime: await db.minecraftRuntime.findUnique({ where: { id: "main" } }) };
  } catch (error) {
    if (profileSchemaMissing(error)) return { schemaReady: false, runtime: null };
    throw error;
  }
}

export async function requireMinecraftProfileSchema(): Promise<void> {
  if (!(await readMinecraftRuntime()).schemaReady) throw new MinecraftProfileError("Minecraft profiles require the reviewed database migration before use", 503, "profile_migration_required");
}

function cleanName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new MinecraftProfileError("Profile name must contain 1–80 display characters", 400, "invalid_profile");
  return value.trim();
}

function validateTarget(value: { mcVersion: string; loader: string; loaderVersion: string | null; javaVariant: string }): void {
  if (!/^[0-9][A-Za-z0-9._-]{0,63}$/.test(value.mcVersion) ||
      !MINECRAFT_PROFILE_LOADERS.includes(value.loader as MinecraftProfileLoader) ||
      !MINECRAFT_JAVA_VARIANTS.includes(value.javaVariant as MinecraftJavaVariant) ||
      (value.loaderVersion !== null && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.loaderVersion))) {
    throw new MinecraftProfileError("The profile target is incomplete or invalid", 400, "invalid_profile");
  }
}

function record(value: MinecraftProfile): MinecraftProfileRecord {
  minecraftProfileId(value.id);
  validateTarget(value);
  if (!["preparing", "ready", "failed"].includes(value.status) || !["legacy", "vanilla", "saved-set", "modrinth"].includes(value.sourceKind)) throw new MinecraftProfileError("Stored profile metadata is invalid", 503, "profile_invalid");
  return value as MinecraftProfileRecord;
}

export async function getMinecraftProfile(id: string): Promise<MinecraftProfileRecord | null> {
  minecraftProfileId(id);
  await requireMinecraftProfileSchema();
  const value = await db.minecraftProfile.findUnique({ where: { id } });
  return value ? record(value) : null;
}

export async function listMinecraftProfiles(): Promise<MinecraftProfileRecord[]> {
  await requireMinecraftProfileSchema();
  return (await db.minecraftProfile.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(record);
}

export async function getMinecraftRuntime(): Promise<MinecraftRuntimeRecord | null> {
  await requireMinecraftProfileSchema();
  return db.minecraftRuntime.findUnique({ where: { id: "main" } });
}

function matches(value: MinecraftProfile, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, item]) => {
    const stored = value[key as keyof MinecraftProfile];
    return item instanceof Date ? stored instanceof Date && stored.getTime() === item.getTime() : stored === item;
  });
}

export async function createProfileRecord(input: CreateProfileRecordInput): Promise<MinecraftProfileRecord> {
  await requireMinecraftProfileSchema();
  const id = minecraftProfileId(input.id ?? randomUUID());
  const target = { mcVersion: input.mcVersion, loader: input.loader, loaderVersion: input.loaderVersion ?? null, javaVariant: input.javaVariant };
  validateTarget(target);
  if ((input.description?.length ?? 0) > 2000) throw new MinecraftProfileError("Profile description is too long", 400, "invalid_profile");
  const data = { id, name: cleanName(input.name), description: input.description ?? "", status: input.status ?? "preparing", ...target,
    sourceKind: input.sourceKind, sourceRef: input.sourceRef ?? null, sourceVersionId: input.sourceVersionId ?? null,
    sourceTitle: input.sourceTitle ?? null, createdBy: input.createdBy };
  assertFileWriteActive();
  return db.$transaction(async tx => {
    const created = await tx.minecraftProfile.create({ data });
    const stored = await tx.minecraftProfile.findUnique({ where: { id } });
    if (!stored || !matches(stored, data) || stored.revision !== 1) throw new Error("Profile creation readback failed");
    return record(created);
  });
}

export async function updateProfileRecord(id: string, expectedRevision: number, patch: UpdateProfileRecordInput): Promise<MinecraftProfileRecord> {
  minecraftProfileId(id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new MinecraftProfileError("The current profile revision is required", 400, "invalid_revision");
  await requireMinecraftProfileSchema();
  const update = { ...patch };
  if (update.name !== undefined) update.name = cleanName(update.name);
  if ((update.description?.length ?? 0) > 2000) throw new MinecraftProfileError("Profile description is too long", 400, "invalid_profile");
  assertFileWriteActive();
  return db.$transaction(async tx => {
    const before = await tx.minecraftProfile.findUnique({ where: { id } });
    if (!before) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    validateTarget({ ...before, ...update });
    const changed = await tx.minecraftProfile.updateMany({ where: { id, revision: expectedRevision }, data: { ...update, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new MinecraftProfileError("This profile changed; reload before saving", 409, "profile_stale");
    const stored = await tx.minecraftProfile.findUnique({ where: { id } });
    if (!stored || stored.revision !== expectedRevision + 1 || !matches(stored, update)) throw new Error("Profile update readback failed");
    return record(stored);
  });
}

export async function selectMinecraftProfile(id: string, expectedRevision?: string, options: { adoptLegacyInventory?: boolean } = {}): Promise<MinecraftRuntimeRecord> {
  minecraftProfileId(id);
  await requireMinecraftProfileSchema();
  assertFileWriteActive();
  return db.$transaction(async tx => {
    const profile = await tx.minecraftProfile.findUnique({ where: { id } });
    if (!profile || profile.status !== "ready") throw new MinecraftProfileError("Only a verified ready profile can be selected");
    record(profile);
    const runtime = await tx.minecraftRuntime.findUnique({ where: { id: "main" } });
    if (expectedRevision !== undefined && expectedRevision !== (runtime?.revision ?? "0")) throw new MinecraftProfileError("The selected profile changed; reload before switching", 409, "profile_stale");
    if (options.adoptLegacyInventory && (runtime?.selectedProfileId || profile.sourceKind !== "legacy")) throw new MinecraftProfileError("Legacy inventory can only be adopted into the initial legacy profile");
    if (options.adoptLegacyInventory) {
      const legacy = await tx.installedMod.findMany({ where: { profileId: null }, orderBy: { id: "asc" } });
      // This association is not a jar update. Raw parameterized SQL preserves @updatedAt history.
      const assigned = await tx.$executeRaw`UPDATE "InstalledMod" SET "profileId" = ${id} WHERE "profileId" IS NULL`;
      const stored = await tx.installedMod.findMany({ where: { id: { in: legacy.map(row => row.id) } }, orderBy: { id: "asc" } });
      if (assigned !== legacy.length || JSON.stringify(stored) !== JSON.stringify(legacy.map(row => ({ ...row, profileId: id })))) throw new Error("Legacy inventory association readback failed");
    }
    const revision = randomUUID();
    const selected = await tx.minecraftRuntime.upsert({ where: { id: "main" }, create: { id: "main", selectedProfileId: id, revision }, update: { selectedProfileId: id, revision } });
    await tx.serverConfig.upsert({ where: { id: "main" }, create: { id: "main", mcVersion: profile.mcVersion, modLoader: profile.loader }, update: { mcVersion: profile.mcVersion, modLoader: profile.loader } });
    const readback = await tx.minecraftRuntime.findUnique({ where: { id: "main" } });
    const mirror = await tx.serverConfig.findUnique({ where: { id: "main" } });
    if (!readback || readback.selectedProfileId !== id || readback.revision !== revision || mirror?.mcVersion !== profile.mcVersion || mirror.modLoader !== profile.loader) throw new Error("Profile selection readback failed");
    return selected;
  });
}

export const commitProfileActivation = selectMinecraftProfile;

export async function deleteProfileRecord(id: string, expectedRevision: number): Promise<void> {
  await requireMinecraftProfileSchema();
  minecraftProfileId(id);
  assertFileWriteActive();
  await db.$transaction(async tx => {
    const runtime = await tx.minecraftRuntime.findUnique({ where: { id: "main" } });
    if (runtime?.selectedProfileId === id) throw new MinecraftProfileError("The selected profile cannot be deleted");
    await tx.installedMod.deleteMany({ where: { profileId: id } });
    const deleted = await tx.minecraftProfile.deleteMany({ where: { id, revision: expectedRevision } });
    if (deleted.count !== 1) throw new MinecraftProfileError("This profile changed; reload before deleting", 409, "profile_stale");
    if (await tx.minecraftProfile.findUnique({ where: { id } })) throw new Error("Profile deletion readback failed");
  });
}

export function toMinecraftProfileDTO(profile: MinecraftProfileRecord): MinecraftProfileDTO {
  return { id: profile.id, name: profile.name, description: profile.description, status: profile.status,
    target: { mcVersion: profile.mcVersion, loader: profile.loader, loaderVersion: profile.loaderVersion, javaVariant: profile.javaVariant },
    source: { kind: profile.sourceKind, ref: profile.sourceRef, versionId: profile.sourceVersionId, title: profile.sourceTitle },
    coverUrl: profile.coverKey ? `/api/minecraft/profiles/${profile.id}/cover?v=${profile.revision}` : null,
    revision: profile.revision, createdAt: profile.createdAt.toISOString(), updatedAt: profile.updatedAt.toISOString(),
    lastPlayedAt: profile.lastPlayedAt?.toISOString() ?? null, error: profile.preparationError };
}

export const profileToDTO = toMinecraftProfileDTO;

/** Reserve the namespace only after proving it contains our own identities/staging. */
export async function assertMinecraftReservedProfileStorage(): Promise<void> {
  await requireMinecraftProfileSchema();
  const rows = await db.minecraftProfile.findMany({ select: { id: true } });
  const storage = await inspectMinecraftReservedProfileStorage(rows.map(row => row.id));
  if (storage.unknown.length) throw new MinecraftProfileError("The existing Minecraft profiles folder contains unrecognized data or aliases. Owner review is required before profile creation or adoption; no game data was changed.", 409, "profile_storage_collision");
}

export async function requiresMinecraftAdoption(): Promise<boolean> {
  await requireMinecraftProfileSchema();
  const runtime = await getMinecraftRuntime();
  const rows = await db.minecraftProfile.findMany({ select: { id: true } });
  return !runtime?.selectedProfileId && await legacyMinecraftDataPresent(rows.map(row => row.id));
}

export async function getMinecraftActiveProfileContext(): Promise<{ schemaReady: boolean; profileId: string | null; root: string; profile: MinecraftProfileRecord | null }> {
  const state = await readMinecraftRuntime();
  if (!state.schemaReady || !state.runtime?.selectedProfileId) {
    const rows = state.schemaReady ? await db.minecraftProfile.findMany({ select: { id: true } }) : [];
    if (await managedMinecraftProfilesPresent(rows.map(row => row.id)) || rows.length > 0) {
      throw new MinecraftProfileError("Minecraft profile identity is unavailable; select or recover the profile before accessing game files", 409, "profile_selection_required");
    }
    return { schemaReady: state.schemaReady, profileId: null, root: await gameDataPath(minecraftStorageRoot(), "", { allowRoot: true }), profile: null };
  }
  const profile = await getMinecraftProfile(state.runtime.selectedProfileId);
  if (!profile || profile.status !== "ready") throw new MinecraftProfileError("The selected profile is unavailable or incomplete");
  return { schemaReady: true, profileId: profile.id, root: await minecraftProfileServerPath(profile.id, "", { allowMissing: false }), profile };
}

export async function getMinecraftDataRoot(): Promise<string> { return (await getMinecraftActiveProfileContext()).root; }
export const minecraftServerDataRoot = getMinecraftDataRoot;
export async function activeMinecraftServerPath(relative = "", options: { allowRoot?: boolean; followFinalSymlink?: boolean; allowMissing?: boolean } = {}): Promise<string> {
  return gameDataPath(await getMinecraftDataRoot(), relative, options);
}

export type MinecraftProfileTransaction = Prisma.TransactionClient;
