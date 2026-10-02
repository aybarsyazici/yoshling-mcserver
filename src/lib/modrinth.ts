const MODRINTH_BASE = "https://api.modrinth.com/v2";

export interface ModrinthProject {
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  project_type: string;
  downloads: number;
  icon_url: string | null;
  project_id: string;
  author: string;
  versions: string[];
  follows: number;
  date_created: string;
  date_modified: string;
  license: string;
  gallery: string[];
}

export interface ModrinthSearchResult {
  hits: ModrinthProject[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  downloads: number;
  files: ModrinthFile[];
  dependencies: ModrinthDependency[];
  /**
   * Which side of the game this specific build runs on — the field that decides whether
   * a jar belongs in the *server's* mods directory, and which nothing in this app read
   * until 2026-10-01.
   *
   * A single string, **not** the `env: {client, server}` object the `.mrpack` format
   * uses. Measured against `/v2/project/<id>/version` across **527 projects / 2,751
   * versions**: present on 2,751 of 2,751, with **ten** distinct values. The enum, each
   * value's count and what each one says about the *server* live in
   * `ENVIRONMENT_TO_SERVER` in `src/lib/mod-admission.ts`, which owns the mapping — do not
   * copy the list here, because two copies of an enum Modrinth can extend is how one of
   * them goes stale.
   *
   * **Do not re-narrow this.** It said six values over 160 versions of the 40
   * most-downloaded mods, and that sample *missed three of the ten* — including
   * `singleplayer_only`, the one value whose absence changes an answer from skip to
   * install, on exactly the kind of mod the filter exists to exclude. The sampling that
   * found them is written out next to the table.
   *
   * Optional here only so a cached or older response that lacks the field falls through to
   * the project-level `server_side` instead of crashing.
   */
  environment?: string;
}

export interface ModrinthFile {
  hashes: { sha1: string; sha512: string };
  url: string;
  filename: string;
  size: number;
  primary: boolean;
}

export interface ModrinthDependency {
  version_id: string | null;
  project_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export async function searchMods(params: {
  query?: string;
  facets?: string[][];
  offset?: number;
  limit?: number;
  index?: string;
}): Promise<ModrinthSearchResult> {
  const searchParams = new URLSearchParams();

  if (params.query) searchParams.set("query", params.query);
  if (params.offset) searchParams.set("offset", String(params.offset));
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.index) searchParams.set("index", params.index);

  if (params.facets && params.facets.length > 0) {
    const facetString = JSON.stringify(params.facets.map((f) => f));
    searchParams.set("facets", facetString);
  }

  const res = await fetch(
    `${MODRINTH_BASE}/search?${searchParams.toString()}`,
    {
      headers: {
        "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
      },
      next: { revalidate: 300 },
    }
  );

  if (!res.ok) {
    throw new Error(`Modrinth search failed: ${res.status}`);
  }

  return res.json();
}

export async function getProject(idOrSlug: string): Promise<ModrinthProject> {
  const res = await fetch(`${MODRINTH_BASE}/project/${idOrSlug}`, {
    headers: {
      "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
    },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    throw new Error(`Modrinth getProject failed: ${res.status}`);
  }

  return res.json();
}

export async function getProjectVersions(
  idOrSlug: string,
  params?: { loaders?: string[]; game_versions?: string[] }
): Promise<ModrinthVersion[]> {
  const searchParams = new URLSearchParams();

  if (params?.loaders) {
    searchParams.set("loaders", JSON.stringify(params.loaders));
  }
  if (params?.game_versions) {
    searchParams.set("game_versions", JSON.stringify(params.game_versions));
  }

  const res = await fetch(
    `${MODRINTH_BASE}/project/${idOrSlug}/version?${searchParams.toString()}`,
    {
      headers: {
        "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
      },
      next: { revalidate: 300 },
    }
  );

  if (!res.ok) {
    throw new Error(`Modrinth getProjectVersions failed: ${res.status}`);
  }

  return res.json();
}

// `getVersion(versionId)` — GET /version/<id> — used to sit here with no caller.
// Everything that needs a version picks one out of `getProjectVersions`, which is
// already filtered by loader and game version, so a single-version fetch by id had
// nowhere to be used: the id only ever comes *from* that list.

export function buildFacets(params: {
  mcVersion?: string;
  loader?: string;
  category?: string;
  projectType?: string;
  serverSide?: boolean;
}): string[][] {
  const facets: string[][] = [];

  if (params.projectType) {
    facets.push([`project_type:${params.projectType}`]);
  } else {
    facets.push([`project_type:mod`]);
  }

  if (params.mcVersion) {
    facets.push([`versions:${params.mcVersion}`]);
  }

  if (params.loader) {
    facets.push([`categories:${params.loader}`]);
  }

  if (params.category) {
    facets.push([`categories:${params.category}`]);
  }

  if (params.serverSide) {
    facets.push([`server_side:required`, `server_side:optional`]);
  }

  return facets;
}
