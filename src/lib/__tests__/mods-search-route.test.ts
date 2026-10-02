import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModrinthSearchResult } from "@/lib/modrinth";

/**
 * **What `/api/mods/search` actually asks Modrinth for.**
 *
 * The route passed `serverSide: true` and then set `versions:` **only when the browser had a
 * modpack selected** — so the default search, which is every search anyone runs, was
 * unfiltered by Minecraft version and by loader — i.e. it listed mods for every version and
 * loader Modrinth publishes, each with an Install button, and `/api/mods/install` then refuses
 * the incompatible ones one at a time with "No compatible version found".
 *
 * The facet now defaults to the server's own version and loader, and widening is a word the
 * caller has to send (`any`) rather than a parameter it can omit. Both halves are pinned here,
 * because each is satisfied by a mutant that breaks the other: hardcoding the server version
 * passes every default test, and dropping the fallback passes every widening test.
 *
 * `buildFacets` is the **real** one — only `searchMods` is faked — so these assertions are on
 * the facet array Modrinth would have received, not on the route's intermediate variables.
 */

let signedIn = true;
let role = "ADMIN";
let games = "minecraft,7dtd,zomboid";
/** `null` is a server that has never been configured — a fresh install before the first save. */
let config: { mcVersion: string; modLoader: string } | null = {
  mcVersion: "26.1.2",
  modLoader: "fabric",
};

const EMPTY: ModrinthSearchResult = { hits: [], offset: 0, limit: 20, total_hits: 0 };

/** Takes its argument so `facets()` below can read it; returns an empty page of results. */
const searchMods = vi.fn(async (params: unknown) => (void params, EMPTY));

vi.mock("@/lib/modrinth", async (importOriginal) => {
  // `buildFacets` stays real on purpose: it is the thing that turns "mcVersion" into
  // `versions:26.1.2`, and a faked copy of it would let the route's defaulting be asserted
  // against a shape Modrinth never sees.
  const actual = await importOriginal<typeof import("@/lib/modrinth")>();
  return { ...actual, searchMods };
});

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () =>
    signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null
  ),
}));

vi.mock("@/lib/db", () => ({
  db: { serverConfig: { findUnique: vi.fn(async () => config) } },
}));

const { GET } = await import("@/app/api/mods/search/route");

interface Body {
  error?: string;
  filter?: { mcVersion: string | null; loader: string | null };
  total_hits?: number;
}

async function search(qs = "") {
  const res = await GET(new Request(`http://localhost/api/mods/search${qs}`) as never);
  return { status: res.status, body: (await res.json()) as Body };
}

/** The facet array the route handed `searchMods` — i.e. what Modrinth was asked. */
function facets(): string[][] {
  expect(searchMods).toHaveBeenCalledTimes(1);
  return (searchMods.mock.calls[0][0] as { facets: string[][] }).facets;
}

/** Always present, before and after this change. A facet it decides nothing about. */
const SERVER_SIDE = ["server_side:required", "server_side:optional"];

beforeEach(() => {
  vi.clearAllMocks();
  searchMods.mockResolvedValue(EMPTY);
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  config = { mcVersion: "26.1.2", modLoader: "fabric" };
});

// ── the default ──────────────────────────────────────────────────────────────

describe("a search with no version parameter is filtered to the server's own version", () => {
  /**
   * The whole facet array, by equality. A containment check would pass under a mutant that
   * also leaves the old unfiltered facets in place, and the *order* here is `buildFacets`'
   * own — pinning it means a reordering is a decision someone has to make deliberately.
   */
  it("sends versions: and categories: for the configured version and loader", async () => {
    await search();
    expect(facets()).toEqual([
      ["project_type:mod"],
      ["versions:26.1.2"],
      ["categories:fabric"],
      SERVER_SIDE,
    ]);
  });

  it("reports in the response what it filtered on", async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.body.filter).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
    // The Modrinth payload is still passed through — the filter is additive, not a wrapper.
    expect(res.body.total_hits).toBe(0);
  });

  /**
   * Lowercased, because the facet is a Modrinth **category slug** (`fabric`, `forge`,
   * `neoforge`) while `ServerConfig.modLoader` is whatever was saved — `/api/settings`
   * uppercases the value for compose's `TYPE` and stores the raw one, so both spellings
   * genuinely exist in this app. `categories:FABRIC` matches nothing and the symptom is an
   * empty mod browser with no stated cause.
   */
  it("lowercases the loader before using it as a category facet", async () => {
    config = { mcVersion: "26.1.2", modLoader: "FABRIC" };
    const res = await search();
    expect(facets()).toContainEqual(["categories:fabric"]);
    expect(res.body.filter).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
  });

  /** The default does not displace the other facets a caller can still ask for. */
  it("keeps a category facet alongside the version default", async () => {
    await search("?category=optimization&q=sodium");
    expect(facets()).toEqual([
      ["project_type:mod"],
      ["versions:26.1.2"],
      ["categories:fabric"],
      ["categories:optimization"],
      SERVER_SIDE,
    ]);
  });
});

// ── widening, deliberately ───────────────────────────────────────────────────

describe("widening is a word the caller has to send", () => {
  /**
   * `any` is the only thing that drops the facet. This is the complement that stops "always
   * filter on the server version" passing the block above — and it is the behaviour the
   * browser's "show all versions" control depends on.
   */
  it("drops both facets for version=any&loader=any", async () => {
    const res = await search("?version=any&loader=any");
    expect(facets()).toEqual([["project_type:mod"], SERVER_SIDE]);
    // Stated, not implied: `null` is how the page tells "no mods exist for this server" from
    // "no mods matched your search".
    expect(res.body.filter).toEqual({ mcVersion: null, loader: null });
  });

  it("widens only the axis that asked for it", async () => {
    await search("?version=any");
    expect(facets()).toEqual([["project_type:mod"], ["categories:fabric"], SERVER_SIDE]);
  });

  /** An explicit version still wins — this is the modpack filter's path. */
  it("honours an explicit version and loader over the server's", async () => {
    const res = await search("?version=1.21.1&loader=forge");
    expect(facets()).toEqual([
      ["project_type:mod"],
      ["versions:1.21.1"],
      ["categories:forge"],
      SERVER_SIDE,
    ]);
    expect(res.body.filter).toEqual({ mcVersion: "1.21.1", loader: "forge" });
  });

  /**
   * No `ServerConfig` row is a fresh install, and there is nothing to filter on. A search is
   * a read, so it widens rather than refusing — and it says so, which is what stops the page
   * claiming a version it did not use.
   */
  it("filters on nothing when the server has no configuration yet", async () => {
    config = null;
    const res = await search();
    expect(facets()).toEqual([["project_type:mod"], SERVER_SIDE]);
    expect(res.body.filter).toEqual({ mcVersion: null, loader: null });
    expect(res.status).toBe(200);
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe("who may search", () => {
  it("401s an unauthenticated request without asking Modrinth", async () => {
    signedIn = false;
    expect((await search()).status).toBe(401);
    expect(searchMods).not.toHaveBeenCalled();
  });

  it("403s a user who was never granted Minecraft", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await search()).status).toBe(403);
    expect(searchMods).not.toHaveBeenCalled();
  });

  /** A MEMBER may browse — read-only is the whole role, and searching is a read. */
  it("lets a MEMBER search", async () => {
    role = "MEMBER";
    games = "minecraft";
    expect((await search()).status).toBe(200);
    expect(searchMods).toHaveBeenCalledTimes(1);
  });
});
