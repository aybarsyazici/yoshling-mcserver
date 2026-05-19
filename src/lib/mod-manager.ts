import { writeFile, unlink, readdir } from "fs/promises";
import path from "path";
import { db } from "./db";
import { getProjectVersions, type ModrinthVersion } from "./modrinth";
import { getModsDir } from "./server-manager";

export async function installMod(params: {
  modrinthId: string;
  slug: string;
  name: string;
  version: ModrinthVersion;
  userId: string;
}): Promise<void> {
  const { modrinthId, slug, name, version, userId } = params;
  const modsDir = getModsDir();

  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw new Error("No file found for this version");

  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to download mod: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(modsDir, file.filename);
  await writeFile(filePath, buffer);

  await db.installedMod.create({
    data: {
      modrinthId,
      slug,
      name,
      version: version.version_number,
      fileName: file.filename,
      mcVersion: version.game_versions[0] || "unknown",
      loader: version.loaders[0] || "unknown",
      installedBy: userId,
    },
  });

  await db.activity.create({
    data: {
      userId,
      action: "install_mod",
      details: JSON.stringify({ modName: name, version: version.version_number }),
    },
  });
}

export async function removeMod(modId: string, userId: string): Promise<void> {
  const mod = await db.installedMod.findUnique({ where: { id: modId } });
  if (!mod) throw new Error("Mod not found");

  const modsDir = getModsDir();
  const filePath = path.join(modsDir, mod.fileName);

  try {
    await unlink(filePath);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  await db.installedMod.delete({ where: { id: modId } });

  await db.activity.create({
    data: {
      userId,
      action: "remove_mod",
      details: JSON.stringify({ modName: mod.name, version: mod.version }),
    },
  });
}

export async function checkForUpdates(): Promise<
  Array<{
    installedMod: { id: string; name: string; version: string; modrinthId: string };
    latestVersion: ModrinthVersion | null;
    hasUpdate: boolean;
  }>
> {
  const installedMods = await db.installedMod.findMany();
  const results = [];

  for (const mod of installedMods) {
    try {
      const versions = await getProjectVersions(mod.modrinthId, {
        loaders: [mod.loader],
        game_versions: [mod.mcVersion],
      });

      const latest = versions[0] || null;
      const hasUpdate = latest
        ? latest.version_number !== mod.version
        : false;

      results.push({
        installedMod: {
          id: mod.id,
          name: mod.name,
          version: mod.version,
          modrinthId: mod.modrinthId,
        },
        latestVersion: latest,
        hasUpdate,
      });
    } catch {
      results.push({
        installedMod: {
          id: mod.id,
          name: mod.name,
          version: mod.version,
          modrinthId: mod.modrinthId,
        },
        latestVersion: null,
        hasUpdate: false,
      });
    }
  }

  return results;
}

export async function updateMod(
  modId: string,
  newVersion: ModrinthVersion,
  userId: string
): Promise<void> {
  const mod = await db.installedMod.findUnique({ where: { id: modId } });
  if (!mod) throw new Error("Mod not found");

  const modsDir = getModsDir();

  // Remove old file
  try {
    await unlink(path.join(modsDir, mod.fileName));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  // Download new file
  const file = newVersion.files.find((f) => f.primary) || newVersion.files[0];
  if (!file) throw new Error("No file found for this version");

  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to download mod: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(modsDir, file.filename), buffer);

  await db.installedMod.update({
    where: { id: modId },
    data: {
      version: newVersion.version_number,
      fileName: file.filename,
      mcVersion: newVersion.game_versions[0] || mod.mcVersion,
      loader: newVersion.loaders[0] || mod.loader,
    },
  });

  await db.activity.create({
    data: {
      userId,
      action: "update_mod",
      details: JSON.stringify({
        modName: mod.name,
        fromVersion: mod.version,
        toVersion: newVersion.version_number,
      }),
    },
  });
}
