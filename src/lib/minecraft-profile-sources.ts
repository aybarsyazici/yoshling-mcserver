import type { ModrinthVersion } from "./modrinth";
import type { MinecraftProfilePackBuild } from "./minecraft-profile-types";
import { profileDownloadUrl } from "./minecraft-profile-pack";

/** This is registry-declared target metadata; preparation verifies the actual pack index. */
export function minecraftProfilePackBuilds(projectId: string, versions: ModrinthVersion[]): MinecraftProfilePackBuild[] {
  if (!Array.isArray(versions) || versions.length > 10_000) throw new Error("The pack build list could not be read safely.");
  return versions.map(version => {
    if (!version || version.project_id !== projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(version.id) ||
        typeof version.name !== "string" || !version.name || typeof version.version_number !== "string" || !version.version_number ||
        !Array.isArray(version.game_versions) || !version.game_versions.every(value => typeof value === "string" && value.length > 0 && value.length <= 64) ||
        !Array.isArray(version.loaders) || !version.loaders.every(value => typeof value === "string" && value.length > 0) ||
        !Number.isFinite(Date.parse(version.date_published))) throw new Error("The pack build metadata is incomplete.");
    const artifact = version.files?.find(file => {
      if (!file.filename?.endsWith(".mrpack") || !/^[a-f\d]{40}$/i.test(file.hashes?.sha1 ?? "") || !/^[a-f\d]{128}$/i.test(file.hashes?.sha512 ?? "") || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 256 * 1024 ** 2) return false;
      try { profileDownloadUrl(file.url); return true; } catch { return false; }
    });
    return { id: version.id, name: version.name, versionNumber: version.version_number, mcVersions: version.game_versions,
      loaders: version.loaders, publishedAt: version.date_published, supported: Boolean(artifact),
      ...(artifact ? {} : { reason: "No checksum-published .mrpack within the supported archive size and HTTPS registries." }) };
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
