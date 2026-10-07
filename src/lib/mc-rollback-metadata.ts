import path from "path";
import { BadArchiveError } from "./backup-archive";
import type { BaseManifest } from "./backup-store";

/** Validate recorded metadata before any game data or inventory can be replaced. */
export function validateMcRollbackMetadata(manifest: BaseManifest | null): void {
  if (!manifest) return;
  if (manifest.minecraftTarget !== undefined) {
    const target = manifest.minecraftTarget;
    if (!target || typeof target.mcVersion !== "string" || !target.mcVersion.trim() ||
        typeof target.loader !== "string" || !target.loader.trim()) {
      throw new BadArchiveError("The archive has invalid recorded target metadata; nothing was replaced");
    }
  }
  if (manifest.installedMods === undefined) return;
  if (!Array.isArray(manifest.installedMods)) throw new BadArchiveError("The archive has invalid inventory metadata; nothing was replaced");
  for (const row of manifest.installedMods) {
    if (!row || typeof row !== "object" || ["modrinthId", "slug", "name", "version", "fileName", "mcVersion", "loader"]
      .some(key => typeof (row as unknown as Record<string, unknown>)[key] !== "string")) {
      throw new BadArchiveError("The archive has an invalid inventory row; nothing was replaced");
    }
    if (!row.fileName || [".", ".."].includes(row.fileName) || row.fileName.includes("\0") ||
        path.basename(row.fileName) !== row.fileName || row.fileName.includes("\\")) {
      throw new BadArchiveError("The archive has an unsafe inventory filename; nothing was replaced");
    }
    for (const key of ["source", "versionId"] as const) {
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") {
        throw new BadArchiveError("The archive has invalid provenance metadata; nothing was replaced");
      }
    }
    if (row.installedBy !== undefined && typeof row.installedBy !== "string") throw new BadArchiveError("The archive has invalid owner metadata; nothing was replaced");
    if (row.id !== undefined && (typeof row.id !== "string" || !row.id)) throw new BadArchiveError("The archive has invalid inventory identity; nothing was replaced");
    for (const key of ["installedAt", "updatedAt"] as const) {
      if (row[key] !== undefined && (typeof row[key] !== "string" || Number.isNaN(new Date(row[key]).getTime()))) {
        throw new BadArchiveError("The archive has invalid installation history; nothing was replaced");
      }
    }
  }
}
