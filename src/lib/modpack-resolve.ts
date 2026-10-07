/**
 * **Which build of a Modrinth modpack we are talking about, and what it needs.**
 *
 * `POST /api/modpacks/import` had this inline, and it is the only place the answer was
 * computed — so the dashboard could not say what a pack needs until *after* it had
 * created a `Modpack` row for it. That is how production ended up with 9 rows for 6
 * distinct packs, three of them `(re-imported)` duplicates: looking at a pack and taking
 * a pack were the same action.
 *
 * `GET /api/modpacks/preview` answers the same question **without writing anything**, and
 * it has to agree with the import exactly — a preview that resolves a different build
 * from the import that follows it is worse than no preview, because the comparison a user
 * read is then not the comparison that was applied. So the choice lives here and both
 * routes call it.
 *
 * Nothing in this module touches the network or the database; the versions are passed in.
 */

/** The part of a Modrinth version this module reads. Accepts `ModrinthVersion` as-is. */
export interface ResolvableVersion {
  id?: string;
  version_number?: string;
  game_versions?: string[];
  loaders?: string[];
  dependencies?: {
    version_id?: string | null;
    project_id?: string | null;
    dependency_type?: string;
  }[];
}

export interface ChosenVersion<V> {
  /** `null` when the project publishes no versions at all. */
  version: V | null;
  /**
   * Whether the chosen build lists the Minecraft version this server runs.
   *
   * The caller needs this as a separate fact rather than inferring it from
   * `game_versions[0]`: a build can list several Minecraft versions, so a pack that does
   * support 26.1.2 may still report `game_versions[0] === "26.1.1"`, and a comparison
   * against that first element alone would call a compatible pack incompatible.
   */
  matchedServerVersion: boolean;
}

/**
 * Prefer a build for the Minecraft version this server actually runs; fall back to the
 * newest.
 *
 * This was `versions[0]` unconditionally — the newest build, whatever it was for.
 * Measured 2026-09-30: re-importing Fabulously Optimized on a server configured for
 * 26.1.2 produced a pack pinned to **26.3**, even though the project publishes a 26.1.2
 * build, and the apply then (correctly) refused on a version mismatch. The repair
 * silently produced another unusable pack.
 *
 * The fall-back is deliberate — a pack you cannot install *yet* is still worth having on
 * the shelf — but `matchedServerVersion` says which happened, so a caller never has to
 * infer it from a number.
 */
export function chooseModpackVersion<V extends ResolvableVersion>(
  versions: readonly V[],
  wantMcVersion: string | null,
  wantLoader?: string | null
): ChosenVersion<V> {
  const compatible = wantMcVersion
    ? versions.filter((v) => v.game_versions?.includes(wantMcVersion))
    : [];
  const matching = wantLoader
    ? compatible.find(v => v.loaders?.some(loader => loader.toLowerCase() === wantLoader.toLowerCase())) ?? compatible[0]
    : compatible[0];
  const version = matching ?? versions[0] ?? null;
  return { version, matchedServerVersion: Boolean(matching) };
}

/** One mod a pack version says it ships. `versionId` is the pin, where there is one. */
export interface PackDependency {
  projectId: string;
  /** Exact build pin, validated/preserved by import and resolved directly on apply/export. */
  versionId: string | null;
}

/**
 * The mods a pack version ships, as Modrinth states them.
 *
 * A Modrinth modpack version lists its contents as `dependencies`, and only `required`
 * and `embedded` are contents — `optional` and `incompatible` are advice about other
 * mods. This list requires a project identity; entries without one are not
 * returned here. Import explicitly refuses such content requirements instead
 * of silently saving this shortened list as a complete pack.
 */
export function modDepsOf(version: ResolvableVersion | null | undefined): PackDependency[] {
  const deps = version?.dependencies ?? [];
  const out: PackDependency[] = [];
  for (const d of deps) {
    if (d.dependency_type !== "required" && d.dependency_type !== "embedded") continue;
    if (!d.project_id) continue;
    out.push({ projectId: d.project_id, versionId: d.version_id ?? null });
  }
  return out;
}

/** What a pack build needs to run. Both default to the strings the import writes. */
export interface PackNeeds {
  mcVersion: string;
  loader: string;
}

/**
 * The Minecraft version and loader a build declares.
 *
 * `"unknown"` / `"fabric"` match what `/api/modpacks/import` writes into
 * `Modpack.targetMcVersion` / `targetLoader`, so a preview and the row the apply reads
 * cannot describe the same build differently.
 */
export function packNeeds(
  version: ResolvableVersion | null | undefined,
  preferred: { mcVersion?: string | null; loader?: string | null } = {}
): PackNeeds {
  return {
    mcVersion: preferred.mcVersion && version?.game_versions?.includes(preferred.mcVersion)
      ? preferred.mcVersion : version?.game_versions?.[0] || "unknown",
    loader: (preferred.loader && version?.loaders?.find(loader => loader.toLowerCase() === preferred.loader!.toLowerCase()))
      || version?.loaders?.[0] || "fabric",
  };
}

/**
 * Can this build be applied to this server, and if not, why not.
 *
 * **This is a comparison, not the enforcement.** `/api/mods/install-modpack` refuses a
 * mismatch itself and keeps its own 409 — that refusal is what protects the server. What
 * this adds is that the comparison can be *shown before the button is pressed*: COBBLEVERSE
 * publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11, so on this 26.1.2 server
 * neither can ever install, and until now the only way to learn that was to apply a pack and
 * read a toast that disappeared.
 *
 * Loader comparison is case-insensitive: `ServerConfig.modLoader` holds whatever was saved
 * and `/api/settings` uppercases it for compose's `TYPE`, so `FABRIC` and `fabric` both
 * genuinely occur in this app — and `"FABRIC" !== "fabric"` would report every Fabric pack
 * as needing a different loader.
 */
export function packCompatibility(
  needs: PackNeeds,
  server: { mcVersion: string; loader: string }
): { ok: boolean; mcVersionMatches: boolean; loaderMatches: boolean } {
  const mcVersionMatches = needs.mcVersion === server.mcVersion;
  const loaderMatches = needs.loader.toLowerCase() === server.loader.toLowerCase();
  return { ok: mcVersionMatches && loaderMatches, mcVersionMatches, loaderMatches };
}

/**
 * Every Minecraft version this project publishes a pack build for, newest list first,
 * de-duplicated.
 *
 * Shown when a pack cannot be applied, because "it needs 1.21.1" on its own invites "then
 * which one should I pick" — and the answer is often "there is no build for this server at
 * all", which is a fact about the pack and not something to keep re-discovering. Capped by
 * the caller; a popular pack lists dozens.
 */
export function publishedMcVersions(versions: readonly ResolvableVersion[]): string[] {
  const seen = new Set<string>();
  for (const v of versions) for (const g of v.game_versions ?? []) seen.add(g);
  return [...seen];
}
