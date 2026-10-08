import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isPathInside, resolveSafeFilePath } from "./file-guard";

export function minecraftProfileId(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("A valid Minecraft profile ID is required");
  }
  return value;
}

export function minecraftStorageRoot(): string { return process.env.MC_SERVER_DIR || "/minecraft"; }
export function minecraftProfileCoverRoot(): string { return process.env.MC_PROFILE_COVER_DIR || "/app/data/minecraft-profile-covers"; }

type PathOptions = { allowRoot?: boolean; followFinalSymlink?: boolean; allowMissing?: boolean };

/** Managed directory identities cannot be aliases of another profile. */
async function managedBase(root: string, parts: string[]): Promise<string> {
  const canonical = await resolveSafeFilePath(root, "", { allowRoot: true });
  if (!canonical) throw new Error("The Minecraft storage root could not be admitted");
  let current = canonical;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Profile directories must be separate real directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

async function withinManagedBase(root: string, parts: string[], relative: string, options: PathOptions): Promise<string> {
  if (typeof relative !== "string" || relative.includes("..") || relative.includes("\0")) throw new Error("Invalid profile relative path");
  const base = await managedBase(root, parts);
  const request = path.join(...parts, relative);
  const followed = await resolveSafeFilePath(root, request, { allowMissing: options.allowMissing ?? true, allowRoot: true });
  if (!followed || !isPathInside(base, followed) || (options.allowRoot === false && followed === base)) {
    throw new Error("Refusing a path outside this Minecraft profile");
  }
  if (options.followFinalSymlink === false) {
    const entry = await resolveSafeFilePath(root, request, { allowMissing: options.allowMissing ?? true, followFinalSymlink: false });
    if (!entry || !isPathInside(base, entry)) throw new Error("Refusing a path outside this Minecraft profile");
    return entry;
  }
  return followed;
}

export async function minecraftProfilesRoot(): Promise<string> {
  return managedBase(minecraftStorageRoot(), ["profiles"]);
}

export async function minecraftProfilePath(id: string, relative = "", options: PathOptions = {}): Promise<string> {
  return withinManagedBase(minecraftStorageRoot(), ["profiles", minecraftProfileId(id)], relative, options);
}

export async function minecraftProfileServerPath(id: string, relative = "", options: PathOptions = {}): Promise<string> {
  return withinManagedBase(minecraftStorageRoot(), ["profiles", minecraftProfileId(id), "server"], relative, options);
}

export async function minecraftCoverPath(id: string, key: string, options: PathOptions = {}): Promise<string> {
  if (!/^[0-9a-f-]{36}\.png$/.test(key)) throw new Error("Invalid profile cover identity");
  return withinManagedBase(minecraftProfileCoverRoot(), [minecraftProfileId(id)], key, { allowRoot: false, ...options });
}

export async function minecraftCoverDirectory(id: string, options: PathOptions = {}): Promise<string> {
  return withinManagedBase(minecraftProfileCoverRoot(), [minecraftProfileId(id)], "", options);
}

const profileUUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const profileIdentity = new RegExp(`^${profileUUID}$`);
const profileStage = new RegExp(`^\\.(?:source|prepare)-${profileUUID}$|^\\.delete-${profileUUID}-${profileUUID}$`);

/** Inspect names without following producer-controlled entries or changing their ownership. */
export async function inspectMinecraftReservedProfileStorage(knownProfileIds: readonly string[] = []): Promise<{ managed: boolean; unknown: string[] }> {
  const root = await resolveSafeFilePath(minecraftStorageRoot(), "", { allowRoot: true });
  if (!root) throw new Error("The Minecraft storage root could not be admitted");
  const directory = path.join(root, "profiles");
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return { managed: false, unknown: [] };
  if (!info.isDirectory() || info.isSymbolicLink()) return { managed: false, unknown: ["profiles"] };
  const known = new Set(knownProfileIds);
  const unknown: string[] = [];
  let managed = false;
  for (const name of await readdir(directory)) {
    const entry = await lstat(path.join(directory, name));
    if (name === ".DS_Store" && entry.isFile()) continue;
    const identity = profileIdentity.exec(name)?.[0] === name, stage = profileStage.exec(name)?.[0] === name;
    // An orphan UUID/stage still looks private after metadata loss; readers refuse it.
    if (identity || stage || known.has(name)) managed = true;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !(stage || (identity && known.has(name)))) unknown.push(name);
  }
  return { managed, unknown };
}

/** Unknown contents in a legacy folder named profiles remain legacy data. */
export async function legacyMinecraftDataPresent(knownProfileIds: readonly string[] = []): Promise<boolean> {
  const root = await resolveSafeFilePath(minecraftStorageRoot(), "", { allowRoot: true });
  if (!root) throw new Error("The Minecraft storage root could not be admitted");
  if ((await readdir(root)).some(name => name !== "profiles" && name !== ".DS_Store")) return true;
  return (await inspectMinecraftReservedProfileStorage(knownProfileIds)).unknown.length > 0;
}

export async function managedMinecraftProfilesPresent(knownProfileIds: readonly string[] = []): Promise<boolean> {
  return (await inspectMinecraftReservedProfileStorage(knownProfileIds)).managed;
}
