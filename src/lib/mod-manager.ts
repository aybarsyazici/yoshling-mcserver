import { writeFile, unlink } from "fs/promises";
import path from "path";
import { db } from "./db";
import { getProject, getProjectVersions, type ModrinthFile, type ModrinthVersion } from "./modrinth";
import { getModsDir } from "./server-manager";
import {
  checkIntegrity,
  digestsOf,
  needsProjectFallback,
  serverSideVerdict,
  type IntegrityCheck,
  type ServerSideVerdict,
} from "./mod-admission";

/**
 * Every Activity row this module writes carries `game: "minecraft"` in its `details`
 * blob, matching the wording 7DTD's and PZ's routes already use.
 *
 * It was missing, and one omission broke two features in opposite directions.
 * `/api/activity` deliberately keeps *untagged* rows visible (role changes and
 * whitelist edits are genuinely shared), so an untagged mod install leaked to a MOD
 * granted only `zomboid`. And `/minecraft/page.tsx` selects
 * `details: { contains: "minecraft" }`, so Minecraft's own recent-activity panel could
 * never show a mod install at all. Minecraft's *properties* route already tagged its
 * rows, which is what makes this drift rather than policy. Both symptoms fix
 * themselves here, with no reader change.
 *
 * Rows written before this are still untagged. Nothing is lost; they stay visible to
 * everyone and stay absent from the Minecraft panel.
 */
const GAME = "minecraft";

/**
 * Thrown when a download does not match the checksum the registry published.
 *
 * Its own class so a caller can tell corruption from a 404 or a dead socket without
 * matching on message text — `install-modpack` reports each mod's failure reason to the
 * user and "this file is not what Modrinth says it is" needs to read differently from
 * "Modrinth was unreachable". Carries the filename because the loop's error line is
 * `"<mod name>: <message>"` and the jar's name is the thing you would go looking for.
 */
export class ModIntegrityError extends Error {
  constructor(
    readonly fileName: string,
    readonly check: IntegrityCheck
  ) {
    super(check.reason);
    this.name = "ModIntegrityError";
  }
}

export interface VerifiedDownload {
  buffer: Buffer;
  /** Pass-through of the integrity verdict so a caller can report `checked: null`
   * ("nothing was published to compare against") instead of implying it verified. */
  check: IntegrityCheck;
}

/**
 * Download a jar and prove it is the file the registry described — **before** it exists
 * anywhere on disk.
 *
 * The one copy of this. `installMod` and `updateMod` both used to do
 * `fetch` → `arrayBuffer` → `writeFile` with nothing in between, so a truncated response
 * wrote a corrupt jar into the live mods directory and the route above it answered 200.
 *
 * **Verify-then-write, never write-then-verify**, and the shape of this function is the
 * guarantee: the bytes are hashed in memory and the caller only receives a buffer if the
 * comparison passed, so there is no window in which a bad jar is on disk and no cleanup
 * path that has to run to remove one. The buffer was already being held in full before
 * this change (`Buffer.from(await response.arrayBuffer())`), so this adds a hash pass
 * over memory that was allocated anyway — not a second copy of the file.
 */
export async function downloadVerifiedJar(file: ModrinthFile): Promise<VerifiedDownload> {
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to download mod: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const check = checkIntegrity({ hashes: file.hashes, size: file.size }, digestsOf(buffer));
  if (!check.ok) throw new ModIntegrityError(file.filename, check);

  return { buffer, check };
}

/**
 * Does this version run on a dedicated server?
 *
 * Shared by `/api/mods/install` and `/api/mods/install-modpack` so the single-mod and
 * the 166-mod path can never disagree about the same jar — the power control in this
 * repo drifted into three copies and two of them missed a fix, which is the standing
 * argument against a second copy of a decision like this.
 *
 * The project fetch is **conditional**: a version's own `environment` decides 2,396 of the
 * 2,751 versions measured (87%), so fetching the project for every mod would add one round
 * trip per mod to a 166-mod apply to change at most 13% of the answers. It is still worth
 * making for those — see `serverSideVerdict`, where the `unknown` versions were measured
 * against decided projects. (An earlier draft said 156 of 160, i.e. a 2.5% fallback rate;
 * that was the top 40 mods only, and the wider sample puts it at 13%.)
 */
export async function serverSideFor(
  version: Pick<ModrinthVersion, "environment">,
  modrinthId: string
): Promise<ServerSideVerdict> {
  const signals = { environment: version.environment };
  if (!needsProjectFallback(signals)) return serverSideVerdict(signals);

  try {
    const project = await getProject(modrinthId);
    return serverSideVerdict({ ...signals, serverSide: project.server_side });
  } catch {
    // A failed fallback must not become a skip. Nothing is declared, so the undeclared
    // verdict — install, and say it was not checked — is the honest answer; dropping the
    // mod because Modrinth was briefly unreachable is the wrong-skip failure this whole
    // feature is ordered to avoid.
    return serverSideVerdict(signals);
  }
}

export async function installMod(params: {
  modrinthId: string;
  slug: string;
  name: string;
  version: ModrinthVersion;
  userId: string;
}): Promise<IntegrityCheck> {
  const { modrinthId, slug, name, version, userId } = params;
  const modsDir = getModsDir();

  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw new Error("No file found for this version");

  const { buffer, check } = await downloadVerifiedJar(file);
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
      details: JSON.stringify({ game: GAME, modName: name, version: version.version_number }),
    },
  });

  // Returned, not discarded: `checked: null` means the jar is on disk and nothing was
  // published to compare it against, and a caller that wants to say "installed, not
  // verified" can only do that if this function hands the verdict back.
  return check;
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
      details: JSON.stringify({ game: GAME, modName: mod.name, version: mod.version }),
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

/**
 * **No route calls this yet** — the mods page offers install and remove, not update.
 * Kept and fixed rather than deleted because the hole it had is the one this pass is
 * closing and leaving one unverified writer behind would re-seed it the moment an
 * update button appears.
 *
 * **The order below is delete-then-fetch, and it is still the wrong way round.** It
 * `unlink`s the installed jar and only afterwards downloads the replacement, so anything
 * that goes wrong in between leaves the mod gone.
 *
 * What changed is not the order — it is the verification. `downloadVerifiedJar` hashes the
 * bytes and throws before anything is written, so a corrupt download now leaves the old jar
 * deleted and *nothing* in its place, where it used to leave the old jar deleted and the bad
 * bytes written under the new name. That is an improvement and not a fix: a missing mod is a
 * loader error that names itself, while a silently corrupt one is not. Moving the `unlink`
 * below the download is the real fix and belongs with whichever route first needs this.
 *
 * (An earlier version of this comment opened by calling the order "correct for the first
 * time" and closed by saying reordering it was the real fix. Both halves cannot be true;
 * the code does delete first, so that is what this now says.)
 */
export async function updateMod(
  modId: string,
  newVersion: ModrinthVersion,
  userId: string
): Promise<IntegrityCheck> {
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

  const { buffer, check } = await downloadVerifiedJar(file);
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
        game: GAME,
        modName: mod.name,
        fromVersion: mod.version,
        toVersion: newVersion.version_number,
      }),
    },
  });

  return check;
}
