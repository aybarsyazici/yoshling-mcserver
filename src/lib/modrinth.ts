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

export async function getVersion(versionId: string): Promise<ModrinthVersion> {
  const res = await fetch(`${MODRINTH_BASE}/version/${versionId}`, {
    headers: {
      "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
    },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    throw new Error(`Modrinth getVersion failed: ${res.status}`);
  }

  return res.json();
}

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
