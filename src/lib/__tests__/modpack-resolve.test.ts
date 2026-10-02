import { describe, expect, it } from "vitest";
import {
  chooseModpackVersion,
  modDepsOf,
  packCompatibility,
  packNeeds,
  publishedMcVersions,
  type ResolvableVersion,
} from "@/lib/modpack-resolve";

/**
 * **Which build of a pack, and what it needs.**
 *
 * This logic was inline in `POST /api/modpacks/import`, which meant the only way to learn
 * what a pack needs was to create a `Modpack` row for it — and production has 9 rows for 6
 * distinct packs, three of them `(re-imported)` duplicates, because looking and taking were
 * the same act. `GET /api/modpacks/preview` answers the same question without writing, and
 * the two **must** resolve the same build: a preview that picked a different version from
 * the import behind it would make the comparison somebody read not the comparison that was
 * applied. One function, pinned here.
 */

function version(over: Partial<ResolvableVersion> = {}): ResolvableVersion {
  return {
    id: "v1",
    version_number: "1.0.0",
    game_versions: ["26.1.2"],
    loaders: ["fabric"],
    dependencies: [],
    ...over,
  };
}

describe("chooseModpackVersion", () => {
  it("prefers a build that lists the server's Minecraft version", () => {
    /**
     * This was `versions[0]` unconditionally. Measured 2026-09-30: re-importing Fabulously
     * Optimized on a server configured for 26.1.2 produced a pack pinned to **26.3**, even
     * though the project publishes a 26.1.2 build — so the apply correctly refused and the
     * "repair" had silently produced another unusable pack.
     */
    const newest = version({ id: "newest", game_versions: ["26.3"] });
    const wanted = version({ id: "wanted", game_versions: ["26.1.2"] });
    const chosen = chooseModpackVersion([newest, wanted], "26.1.2");
    expect(chosen.version?.id).toBe("wanted");
    expect(chosen.matchedServerVersion).toBe(true);
  });

  it("takes the newest when the server's version has no build, and says so", () => {
    // A pack you cannot install *yet* is still worth having on the shelf, but the caller
    // must be able to tell which happened rather than inferring it from a number.
    const newest = version({ id: "newest", game_versions: ["26.3"] });
    const older = version({ id: "older", game_versions: ["1.21.1"] });
    const chosen = chooseModpackVersion([newest, older], "26.1.2");
    expect(chosen.version?.id).toBe("newest");
    expect(chosen.matchedServerVersion).toBe(false);
  });

  it("matches a build that lists several Minecraft versions", () => {
    /**
     * The reason `matchedServerVersion` is a separate fact and not `game_versions[0] ===
     * want`: a build can list several versions, so comparing against the first element
     * alone would report a compatible pack as incompatible.
     */
    const multi = version({ id: "multi", game_versions: ["26.1.1", "26.1.2"] });
    const chosen = chooseModpackVersion([multi], "26.1.2");
    expect(chosen.version?.id).toBe("multi");
    expect(chosen.matchedServerVersion).toBe(true);
  });

  it("takes the newest when there is no version to want", () => {
    // No `ServerConfig` row. Nothing to narrow by, so the newest is the only answer — and
    // `matchedServerVersion` must not claim a match that was never checked.
    const chosen = chooseModpackVersion([version({ id: "a" }), version({ id: "b" })], null);
    expect(chosen.version?.id).toBe("a");
    expect(chosen.matchedServerVersion).toBe(false);
  });

  it("answers null for a project that publishes nothing", () => {
    expect(chooseModpackVersion([], "26.1.2")).toEqual({
      version: null,
      matchedServerVersion: false,
    });
  });
});

describe("modDepsOf", () => {
  it("takes required and embedded mods and nothing else", () => {
    // A Modrinth modpack version lists its *contents* as dependencies. `optional` and
    // `incompatible` are advice about other mods, not contents — counting them would make
    // the preview promise mods the apply will not install.
    const v = version({
      dependencies: [
        { project_id: "req", version_id: "rv", dependency_type: "required" },
        { project_id: "emb", version_id: null, dependency_type: "embedded" },
        { project_id: "opt", version_id: "ov", dependency_type: "optional" },
        { project_id: "inc", version_id: null, dependency_type: "incompatible" },
      ],
    });
    expect(modDepsOf(v)).toEqual([
      { projectId: "req", versionId: "rv" },
      { projectId: "emb", versionId: null },
    ]);
  });

  it("drops a dependency with no project id", () => {
    // A version-only pin we cannot resolve to a project. The import has always dropped it,
    // so counting it here would overstate the pack.
    const v = version({
      dependencies: [
        { project_id: null, version_id: "only-a-version", dependency_type: "required" },
      ],
    });
    expect(modDepsOf(v)).toEqual([]);
  });

  it("answers an empty list for no version at all", () => {
    expect(modDepsOf(null)).toEqual([]);
    expect(modDepsOf(undefined)).toEqual([]);
    expect(modDepsOf(version({ dependencies: undefined }))).toEqual([]);
  });

  it("keeps the version id, which is the pin the importer throws away", () => {
    // **566 of 569 production `ModpackMod` rows carry no `versionId`**, and
    // `dependencies[].version_id` was present and discarded. Surfacing the count is what
    // lets the preview say how much of a pack is unpinned instead of leaving it silent.
    const v = version({
      dependencies: [
        { project_id: "a", version_id: "pinned", dependency_type: "required" },
        { project_id: "b", version_id: null, dependency_type: "required" },
      ],
    });
    expect(modDepsOf(v).filter((d) => d.versionId == null)).toHaveLength(1);
  });
});

describe("packNeeds", () => {
  it("reads the first Minecraft version and loader", () => {
    expect(packNeeds(version({ game_versions: ["26.1.2"], loaders: ["fabric"] }))).toEqual({
      mcVersion: "26.1.2",
      loader: "fabric",
    });
  });

  it("falls back to the strings the import writes", () => {
    // `"unknown"` / `"fabric"` are what `/api/modpacks/import` puts in
    // `Modpack.targetMcVersion` / `targetLoader`, so a preview and the row the apply reads
    // cannot describe the same build differently.
    expect(packNeeds(version({ game_versions: [], loaders: [] }))).toEqual({
      mcVersion: "unknown",
      loader: "fabric",
    });
    expect(packNeeds(null)).toEqual({ mcVersion: "unknown", loader: "fabric" });
  });
});

describe("packCompatibility", () => {
  it("agrees when both halves match", () => {
    expect(
      packCompatibility({ mcVersion: "26.1.2", loader: "fabric" }, {
        mcVersion: "26.1.2",
        loader: "fabric",
      })
    ).toEqual({ ok: true, mcVersionMatches: true, loaderMatches: true });
  });

  it("reports the Minecraft version and the loader separately", () => {
    // Two different things to fix, so the surface has to be able to say which one is wrong.
    expect(
      packCompatibility({ mcVersion: "1.21.1", loader: "forge" }, {
        mcVersion: "26.1.2",
        loader: "fabric",
      })
    ).toEqual({ ok: false, mcVersionMatches: false, loaderMatches: false });
  });

  it("compares loaders case-insensitively", () => {
    /**
     * `ServerConfig.modLoader` holds whatever was saved and `/api/settings` uppercases it
     * for compose's `TYPE`, so `FABRIC` and `fabric` both genuinely occur in this app.
     * `"FABRIC" !== "fabric"` would report every Fabric pack as needing a different loader
     * — a refusal nobody could act on.
     */
    const result = packCompatibility({ mcVersion: "26.1.2", loader: "fabric" }, {
      mcVersion: "26.1.2",
      loader: "FABRIC",
    });
    expect(result.loaderMatches).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("refuses on the Minecraft version even when the loader agrees", () => {
    // COBBLEVERSE on this box: Fabric both sides, MC 1.21.1 against 26.1.2.
    expect(
      packCompatibility({ mcVersion: "1.21.1", loader: "fabric" }, {
        mcVersion: "26.1.2",
        loader: "fabric",
      })
    ).toEqual({ ok: false, mcVersionMatches: false, loaderMatches: true });
  });
});

describe("publishedMcVersions", () => {
  it("de-duplicates across builds", () => {
    // Shown when a pack cannot be applied, because "it needs 1.21.1" invites "then which
    // build should I pick" — and the answer is often "there is none for this server".
    expect(
      publishedMcVersions([
        version({ game_versions: ["1.21.1", "1.21.4"] }),
        version({ game_versions: ["1.21.1"] }),
      ])
    ).toEqual(["1.21.1", "1.21.4"]);
  });

  it("answers an empty list when nothing declares a version", () => {
    expect(publishedMcVersions([version({ game_versions: undefined })])).toEqual([]);
    expect(publishedMcVersions([])).toEqual([]);
  });
});
