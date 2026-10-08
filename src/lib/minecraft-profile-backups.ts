import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { BACKUP_DIRS, type BaseManifest } from "./backup-store";
import { getMinecraftProfile } from "./minecraft-profile-store";
import { type MinecraftActiveContext, MinecraftActiveProfileError } from "./minecraft-active-profile";

/** The adopted legacy profile retains access to the existing archive directory. */
export async function minecraftBackupDirectory(context: MinecraftActiveContext): Promise<string> {
  if (!context.profileId) return BACKUP_DIRS.minecraft;
  const profile = await getMinecraftProfile(context.profileId);
  if (!profile) throw new MinecraftActiveProfileError("The selected Minecraft profile is missing.");
  if (profile.sourceKind === "legacy") return BACKUP_DIRS.minecraft;
  await mkdir(BACKUP_DIRS.minecraft, { recursive: true });
  const root = await realpath(BACKUP_DIRS.minecraft);
  let directory = root;
  for (const part of ["profiles", context.profileId]) {
    directory = path.join(directory, part);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MinecraftActiveProfileError("Profile backup directories must be separate real directories.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return directory;
}
export async function assertMinecraftArchiveProfile(context: MinecraftActiveContext, manifest: BaseManifest | null): Promise<void> {
  if (manifest?.minecraftProfileId) {
    if (manifest.minecraftProfileId !== context.profileId) throw new MinecraftActiveProfileError("This backup belongs to another Minecraft profile. Select that profile before restoring.");
  } else if (context.profileId) {
    const profile = await getMinecraftProfile(context.profileId);
    if (profile?.sourceKind !== "legacy") throw new MinecraftActiveProfileError("This backup has no profile identity and cannot be restored into this profile.");
  }
}

export async function minecraftBackupJournalScope(context: MinecraftActiveContext): Promise<{ id: string; includeLegacy: boolean } | undefined> {
  if (!context.profileId) return undefined;
  const profile = await getMinecraftProfile(context.profileId);
  if (!profile) throw new MinecraftActiveProfileError("The selected Minecraft profile is missing.");
  return { id: profile.id, includeLegacy: profile.sourceKind === "legacy" };
}
