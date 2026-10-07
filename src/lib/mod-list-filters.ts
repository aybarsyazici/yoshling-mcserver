/** Client-safe display predicates. Filtering never changes API data or its order. */
export interface ModFilterOption { value: string; label: string }
export type MinecraftModStateFilter = "all" | "matched" | "missing" | "untracked";
export type MinecraftModOriginFilter = "all" | "pack" | "manual" | "unrecorded";
export type ZomboidModStateFilter = "all" | "downloaded" | "pending" | "enabled" | "disabled" | "no-ids";

export const MINECRAFT_MOD_STATES = [
  { value: "all", label: "All file states" },
  { value: "matched", label: "Tracked jar present" },
  { value: "missing", label: "Missing jar" },
  { value: "untracked", label: "Untracked jar" },
] as const satisfies readonly ModFilterOption[];
export const MINECRAFT_MOD_ORIGINS = [
  { value: "all", label: "All origins" },
  { value: "pack", label: "From a pack" },
  { value: "manual", label: "Added individually" },
  { value: "unrecorded", label: "Origin not recorded" },
] as const satisfies readonly ModFilterOption[];
export const ZOMBOID_MOD_STATES = [
  { value: "all", label: "All Workshop states" },
  { value: "downloaded", label: "Downloaded" },
  { value: "pending", label: "Pending download" },
  { value: "enabled", label: "With enabled IDs" },
  { value: "disabled", label: "With disabled variants" },
  { value: "no-ids", label: "Without mod IDs" },
] as const satisfies readonly ModFilterOption[];

interface MinecraftFilterEntry {
  name: string;
  fileName: string;
  id?: string | null;
  modrinthId?: string | null;
  versionId?: string | null;
  slug?: string | null;
  state: "matched" | "missing" | "untracked";
  source?: string | null;
}
interface ZomboidFilterEntry {
  workshopId: string;
  title: string;
  provides: readonly string[];
  enabled: readonly string[];
  downloaded: boolean;
}
export function modTextMatches(query: string, values: readonly (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || values.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}
export function filterMinecraftMods<T extends MinecraftFilterEntry>(
  mods: readonly T[], query: string, state: MinecraftModStateFilter, origin: MinecraftModOriginFilter
): T[] {
  return mods.filter((mod) =>
    modTextMatches(query, [mod.name, mod.fileName, mod.id, mod.modrinthId, mod.versionId, mod.slug]) &&
    (state === "all" || mod.state === state) &&
    (origin === "all" || (origin === "unrecorded" ? mod.source !== "pack" && mod.source !== "manual" : mod.source === origin))
  );
}
export function filterZomboidMods<T extends ZomboidFilterEntry>(
  mods: readonly T[], query: string, state: ZomboidModStateFilter
): T[] {
  return mods.filter((mod) => {
    if (!modTextMatches(query, [mod.title, mod.workshopId, ...mod.provides, ...mod.enabled])) return false;
    switch (state) {
      case "all": return true;
      case "downloaded": return mod.downloaded;
      case "pending": return !mod.downloaded;
      case "enabled": return mod.enabled.length > 0;
      // Includes mixed enabled/disabled items; missing metadata cannot prove a disabled variant.
      case "disabled": return mod.provides.some((id) => !mod.enabled.includes(id));
      case "no-ids": return mod.provides.length === 0;
    }
  });
}
export function filterUnpairedModIds(ids: readonly string[], query: string): string[] {
  return ids.filter((id) => modTextMatches(query, [id]));
}
