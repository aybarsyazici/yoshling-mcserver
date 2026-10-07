import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **`GET /api/modpacks/preview` and the pack search's version facet.**
 *
 * Two routes, one subject: can this pack be applied to *this* server, and is the list you
 * are choosing from made of packs that can be.
 *
 * The preview exists because the only way to learn what a pack needs was to press
 * **Import**, which creates a `Modpack` row, and then **Install to Server**, which answers
 * a 409 in a toast that lives four seconds. COBBLEVERSE publishes only MC 1.21.1 and
 * `Hoplite` only up to 1.21.11, so on this 26.1.2 server that refusal is the *normal*
 * outcome — and production has **9 `Modpack` rows for 6 distinct packs**, three of them
 * `(re-imported)` duplicates, which is what a flow where looking and taking are the same
 * act produces.
 *
 * `modpack-resolve` is **not** mocked: only `auth`, Prisma and Modrinth are. A faked
 * resolver would leave "the preview describes a different build from the import" green,
 * which is the one failure that makes a preview worse than none.
 */

let signedIn = true;
let role = "ADMIN";
let games = "minecraft,7dtd,zomboid";
let serverConfig: { mcVersion: string; modLoader: string } | null = {
  mcVersion: "26.1.2",
  modLoader: "fabric",
};

/** Everything either route wrote. Both are reads; this must stay empty. */
const writes: string[] = [];

interface Version {
  id: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: string }[];
}
let versions: Version[] = [];
let versionsThrows = false;
/** The facet array Modrinth would actually have received. */
let lastFacets: string[][] | undefined;

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () =>
    signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    serverConfig: { findUnique: vi.fn(async () => serverConfig) },
    modpack: {
      // Echoes the row back, so the import's answer can be compared with the preview's.
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push("modpack.create");
        const created = data.mods as { create: unknown[] } | undefined;
        return { id: "pack-new", ...data, mods: created?.create ?? [] };
      }),
    },
    activity: {
      create: vi.fn(async () => {
        writes.push("activity.create");
        return {};
      }),
    },
  },
}));

vi.mock("@/lib/modrinth", () => ({
  getVersion: vi.fn(async (id: string) => {
    const pack = versions.find(v => v.dependencies.some(d => d.version_id === id));
    const dependency = pack?.dependencies.find(d => d.version_id === id);
    return { id, project_id: dependency?.project_id, game_versions: pack?.game_versions || [], loaders: pack?.loaders || [] };
  }),
  getProjectVersions: vi.fn(async () => {
    if (versionsThrows) throw new Error("Modrinth unreachable");
    return versions;
  }),
  getProject: vi.fn(async (id: string) => ({
    id,
    project_id: id,
    slug: `slug-${id}`,
    title: `Mod ${id}`,
  })),
  searchMods: vi.fn(async (params: { facets?: string[][] }) => {
    lastFacets = params.facets;
    return { hits: [], total_hits: 0 };
  }),
}));

vi.mock("@/lib/game-gate", async (importOriginal) => importOriginal());

const { GET: PREVIEW } = await import("@/app/api/modpacks/preview/route");
const { GET: SEARCH } = await import("@/app/api/modpacks/search/route");
const { POST: IMPORT } = await import("@/app/api/modpacks/import/route");

function version(over: Partial<Version> = {}): Version {
  return {
    id: "v1",
    version_number: "6.6.0",
    game_versions: ["26.1.2"],
    loaders: ["fabric"],
    dependencies: [],
    ...over,
  };
}

async function preview(qs: string) {
  const res = await PREVIEW(
    new Request(`http://localhost/api/modpacks/preview${qs}`) as never
  );
  return { status: res.status, body: await res.json() };
}

async function search(qs = "") {
  const res = await SEARCH(new Request(`http://localhost/api/modpacks/search${qs}`) as never);
  return { status: res.status, body: await res.json() };
}

async function importPack(modrinthId = "abc") {
  const res = await IMPORT(
    new Request("http://localhost/api/modpacks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modrinthId, name: "Fabulously Optimized" }),
    }) as never
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  serverConfig = { mcVersion: "26.1.2", modLoader: "fabric" };
  versions = [version()];
  versionsThrows = false;
  writes.length = 0;
  lastFacets = undefined;
});

describe("the preview compares the pack against the server", () => {
  it("answers compatible for a build of the server's own version and loader", async () => {
    const { status, body } = await preview("?modrinthId=abc");
    expect(status).toBe(200);
    expect(body.needs).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
    expect(body.server).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
    expect(body.compatibility).toEqual({
      ok: true,
      mcVersionMatches: true,
      loaderMatches: true,
    });
    expect(body.matchedServerVersion).toBe(true);
  });

  it("answers incompatible, and names the versions the pack does publish", async () => {
    // COBBLEVERSE's shape: nothing for 26.1.2 at all.
    versions = [
      version({ id: "a", game_versions: ["1.21.1"] }),
      version({ id: "b", game_versions: ["1.21.0"] }),
    ];
    const { body } = await preview("?modrinthId=cobbleverse");
    expect(body.compatibility.ok).toBe(false);
    expect(body.compatibility.mcVersionMatches).toBe(false);
    expect(body.matchedServerVersion).toBe(false);
    // "It needs 1.21.1" invites "then which build should I pick", and often the answer is
    // "there is none for this server" — which is a fact about the pack.
    expect(body.publishedMcVersions).toEqual(["1.21.1", "1.21.0"]);
  });

  it("declines to compare when there is no ServerConfig row", async () => {
    /**
     * A fresh install. `null` rather than a guessed verdict: an absent reading rendered as
     * a disagreement is the mistake every settings surface in this app is built to avoid,
     * and rendering it as agreement would be worse.
     */
    serverConfig = null;
    const { body } = await preview("?modrinthId=abc");
    expect(body.server).toBe(null);
    expect(body.compatibility).toBe(null);
  });

  it("counts the mods the apply would install, by the import's own rule", async () => {
    versions = [
      version({
        dependencies: [
          { project_id: "a", version_id: "av", dependency_type: "required" },
          { project_id: "b", version_id: null, dependency_type: "embedded" },
          { project_id: "c", version_id: "cv", dependency_type: "optional" },
          { project_id: null, version_id: "dv", dependency_type: "required" },
        ],
      }),
    ];
    const { body } = await preview("?modrinthId=abc");
    expect(body.modCount).toBe(2);
    // 566 of 569 production `ModpackMod` rows are unpinned, so an apply installs the
    // newest matching build rather than what the author shipped. Stated, not silent.
    expect(body.unpinnedCount).toBe(1);
  });

  it("writes nothing at all", async () => {
    // The whole reason this route exists beside the import.
    await preview("?modrinthId=abc");
    expect(writes).toEqual([]);
  });

  it("refuses a request with no pack", async () => {
    expect((await preview("")).status).toBe(400);
  });

  it("says Modrinth lists no versions rather than answering an empty pack", async () => {
    // Distinguishable from "unreachable": they lead to different next steps.
    versions = [];
    const { status, body } = await preview("?modrinthId=abc");
    expect(status).toBe(404);
    expect(body.error).toMatch(/lists no versions/);
  });

  it("answers 502 when Modrinth could not be read", async () => {
    versionsThrows = true;
    const { status, body } = await preview("?modrinthId=abc");
    expect(status).toBe(502);
    expect(body.error).toMatch(/Modrinth unreachable/);
  });
});

describe("the preview's gates", () => {
  it("401s a visitor", async () => {
    signedIn = false;
    expect((await preview("?modrinthId=abc")).status).toBe(401);
  });

  it("403s a MOD who does not hold Minecraft", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await preview("?modrinthId=abc")).status).toBe(403);
  });

  it("answers a MEMBER who holds Minecraft — it is a read", async () => {
    // Deliberate, and the same shape as `/api/modpacks/search` and `[id]/export`: the pack
    // data is public Modrinth and the server's own version is already in
    // `/api/mods/search`'s `filter`. `tests/change-pack-dialog.test.tsx` pins that a MEMBER
    // gets no control to act on it.
    role = "MEMBER";
    games = "minecraft";
    expect((await preview("?modrinthId=abc")).status).toBe(200);
  });
});

describe("the preview and the import resolve the same build", () => {
  /**
   * **The drift guard, and the reason `modpack-resolve.ts` exists.**
   *
   * A preview that described a different build from the import behind it would be worse
   * than no preview: the comparison somebody read would not be the comparison that was
   * applied. The function is pinned by `modpack-resolve.test.ts`, but that cannot tell
   * whether either *route* still calls it — and a mutation that replaced the import's call
   * with `versions[0]` survived the whole suite, because `/api/modpacks/import` had no
   * behavioural test of any kind.
   *
   * Asserted as "the two agree" rather than each against a literal, which is the pattern
   * `docs/OPERATIONS.md` sets out for the power control's three surfaces: a third reader
   * then fails loudly instead of silently missing a fix.
   */
  const AWKWARD: Version[] = [
    // Newest first, as Modrinth returns them — and the newest is *not* for this server.
    version({ id: "newest", version_number: "7.0.0", game_versions: ["26.3"] }),
    version({
      id: "forThisServer",
      version_number: "6.6.0",
      game_versions: ["26.1.1", "26.1.2"],
      dependencies: [
        { project_id: "a", version_id: "av", dependency_type: "required" },
        { project_id: "b", version_id: null, dependency_type: "embedded" },
        { project_id: "c", version_id: "cv", dependency_type: "optional" },
      ],
    }),
  ];

  it("agrees on the version, the loader and the mod count", async () => {
    versions = AWKWARD;
    const shown = (await preview("?modrinthId=abc")).body;
    const taken = (await importPack()).body;

    expect(taken.targetMcVersion).toBe(shown.needs.mcVersion);
    expect(taken.targetLoader).toBe(shown.needs.loader);
    expect(taken.matchedServerVersion).toBe(shown.matchedServerVersion);
    expect(taken.mods).toHaveLength(shown.modCount);
  });

  it("both take the build for this server, not the newest", async () => {
    /**
     * Measured 2026-09-30: re-importing Fabulously Optimized on a server configured for
     * 26.1.2 produced a pack pinned to **26.3**, even though the project publishes a 26.1.2
     * build — so the apply correctly refused and the "repair" had silently produced another
     * unusable pack. Pinned on both routes, because either one drifting is the bug.
     */
    versions = AWKWARD;
    expect((await preview("?modrinthId=abc")).body.versionNumber).toBe("6.6.0");
    expect((await importPack()).body.matchedServerVersion).toBe(true);
    expect((await importPack()).body.targetMcVersion).toBe("26.1.2");
  });

  it("agrees that nothing matches when the pack has no build for this server", async () => {
    versions = [version({ id: "old", game_versions: ["1.21.1"] })];
    const shown = (await preview("?modrinthId=abc")).body;
    const taken = (await importPack()).body;
    expect(shown.matchedServerVersion).toBe(false);
    expect(taken.matchedServerVersion).toBe(false);
    expect(taken.targetMcVersion).toBe(shown.needs.mcVersion);
  });

  it("only the import writes", async () => {
    versions = AWKWARD;
    await preview("?modrinthId=abc");
    expect(writes).toEqual([]);
    await importPack();
    expect(writes).toEqual(["modpack.create"]);
  });
});

describe("the pack search is faceted on what the server runs", () => {
  it("facets on the server's version and loader when nothing was asked for", async () => {
    /**
     * This route sent `versions:` and `categories:` only when the caller passed them, and
     * the one caller never did — so the pack browser listed every modpack Modrinth
     * publishes against a 26.1.2 Fabric server, and the apply refused them one at a time.
     * The identical defect `/api/mods/search` was fixed for, one route along.
     */
    const { body } = await search();
    expect(lastFacets).toEqual([
      ["project_type:modpack"],
      ["versions:26.1.2"],
      ["categories:fabric"],
    ]);
    expect(body.filter).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
  });

  it("widens only on the literal `any`", async () => {
    // An omission must never mean "every version" again: that is the whole bug.
    const { body } = await search("?version=any");
    expect(lastFacets).toEqual([["project_type:modpack"], ["categories:fabric"]]);
    expect(body.filter.mcVersion).toBe(null);
  });

  it("lowercases the loader facet", async () => {
    /**
     * Modrinth's loader facet is a *category slug* (`fabric`), while `ServerConfig.modLoader`
     * holds whatever was saved — `/api/settings` uppercases it for compose's `TYPE`, so both
     * spellings genuinely exist here. `categories:FABRIC` matches nothing and the symptom is
     * an empty browser with no stated cause.
     */
    serverConfig = { mcVersion: "26.1.2", modLoader: "FABRIC" };
    await search();
    expect(lastFacets).toContainEqual(["categories:fabric"]);
  });

  it("widens rather than refusing when there is no ServerConfig row", async () => {
    // A search is a read, and an empty pack browser is a worse answer than an unfiltered
    // one — but `filter` is what tells the two apart.
    serverConfig = null;
    const { body } = await search();
    expect(lastFacets).toEqual([["project_type:modpack"]]);
    expect(body.filter).toEqual({ mcVersion: null, loader: null });
  });

  it("403s a MOD who does not hold Minecraft", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await search()).status).toBe(403);
  });
});
