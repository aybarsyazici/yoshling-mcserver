import { describe, expect, it } from "vitest";
import {
  packHeadline,
  packVersionNote,
  provenanceCounts,
  provenanceSentence,
} from "@/lib/mod-provenance";
import {
  APPLY_MODPACK_ACTION,
  appliedPackDetails,
  parseAppliedPack,
  type AppliedPack,
} from "@/lib/modpack-applied";
import type { InventoryEntry } from "@/lib/mod-inventory";

/**
 * **The two halves of the mods page's header: a measurement and a record.**
 *
 * `provenanceCounts` measures where each jar on the server came from — the question
 * `InstalledMod.source` finally makes answerable, because before it the only record of
 * "which of these did the pack put there" was in whoever had been watching.
 * `parseAppliedPack` reads the durable record of the apply itself.
 *
 * They are kept as **two facts and never joined**. `source` is `"pack"` / `"manual"` with
 * no pack id, so "78 jars from Big Pack" is not a sentence the data supports; "78 were
 * installed by a pack apply" is. The tests below pin that separation as much as the
 * arithmetic.
 */

function entry(over: Partial<InventoryEntry> & { fileName: string }): InventoryEntry {
  return {
    id: `row-${over.fileName}`,
    name: "Fabric API",
    version: "1",
    mcVersion: "26.1.2",
    loader: "fabric",
    modrinthId: "P7dR8mSH",
    slug: "fabric-api",
    source: "manual",
    versionId: null,
    installedBy: "u1",
    installedByName: "Aybars",
    installedAt: "2026-10-01T00:00:00.000Z",
    state: "matched",
    sizeBytes: 1024,
    sha512: null,
    ...over,
  };
}

const untracked = (fileName: string) =>
  entry({ fileName, id: null, name: fileName, source: null, state: "untracked" });
const missing = (fileName: string) =>
  entry({ fileName, state: "missing", sizeBytes: null });

function applied(over: Partial<AppliedPack> = {}): AppliedPack {
  return {
    packId: "pack-1",
    name: "Vanilla Perfected",
    appliedAt: "2026-09-30T10:00:00.000Z",
    appliedByName: "Aybars",
    installed: 78,
    total: 81,
    mcVersion: "26.1.2",
    loader: "fabric",
    ...over,
  };
}

describe("provenanceCounts", () => {
  it("splits the matched rows by how they were installed", () => {
    const counts = provenanceCounts({
      mods: [
        entry({ fileName: "a.jar", source: "pack" }),
        entry({ fileName: "b.jar", source: "pack" }),
        entry({ fileName: "c.jar", source: "manual" }),
        entry({ fileName: "d.jar", source: null }),
      ],
    });
    expect(counts).toEqual({
      jars: 4,
      fromPack: 2,
      ownInstall: 1,
      unrecorded: 1,
      untracked: 0,
      missing: 0,
    });
  });

  it("counts an untracked jar as a jar and a missing row as neither", () => {
    /**
     * **A `missing` row is not a jar**, and folding it in would report a mod the server
     * will not load as installed. An untracked jar *is* one — the server loads it — so it
     * belongs in the total even though this app did not put it there.
     */
    const counts = provenanceCounts({
      mods: [entry({ fileName: "a.jar" }), untracked("stranger.jar"), missing("gone.jar")],
    });
    expect(counts.jars).toBe(2);
    expect(counts.untracked).toBe(1);
    expect(counts.missing).toBe(1);
  });

  it("keeps jars equal to the sum of its four parts", () => {
    /**
     * The one arithmetic mistake that would make the header quietly wrong: a jar counted
     * twice, or in none of the groups, gives a sentence whose parts do not add up to its
     * own total. Checked over a deliberately awkward mix.
     */
    const counts = provenanceCounts({
      mods: [
        entry({ fileName: "a.jar", source: "pack" }),
        entry({ fileName: "b.jar", source: "manual" }),
        entry({ fileName: "c.jar", source: null }),
        // A value the enum does not know reads as "not recorded", never passed through.
        entry({ fileName: "d.jar", source: "something-else" as never }),
        untracked("e.jar"),
        missing("f.jar"),
      ],
    });
    expect(counts.fromPack + counts.ownInstall + counts.unrecorded + counts.untracked).toBe(
      counts.jars
    );
    expect(counts.unrecorded).toBe(2);
  });

  it("answers all zeroes for an empty server", () => {
    expect(provenanceCounts({ mods: [] })).toEqual({
      jars: 0,
      fromPack: 0,
      ownInstall: 0,
      unrecorded: 0,
      untracked: 0,
      missing: 0,
    });
  });
});

describe("provenanceSentence", () => {
  it("names every non-zero part and nothing else", () => {
    /**
     * Built from clauses rather than a branch per shape: four independent quantities would
     * be sixteen templates, which is how a reachable combination ends up with no wording.
     * And a server with no untracked jars must not be told it has none.
     */
    const sentence = provenanceSentence(
      provenanceCounts({
        mods: [
          entry({ fileName: "a.jar", source: "pack" }),
          entry({ fileName: "b.jar", source: "pack" }),
          entry({ fileName: "c.jar", source: "manual" }),
        ],
      })
    );
    expect(sentence).toBe("3 jars in the mods folder — 2 from a pack, 1 added one at a time.");
    expect(sentence).not.toMatch(/no record/);
    expect(sentence).not.toMatch(/did not install/);
  });

  it("pluralises the jar count", () => {
    // "1 jars in the mods folder" is the small wrongness that makes everything beside it
    // read as careless — the same bug a real production summary had with "1 mods updated".
    expect(provenanceSentence(provenanceCounts({ mods: [entry({ fileName: "a.jar" })] }))).toMatch(
      /^1 jar in the mods folder/
    );
  });

  it("says an untracked jar is one this dashboard did not install", () => {
    // Worded as a statement about this app, not about the file: the server loads an
    // untracked jar perfectly well, and calling it "unknown" invites deleting something
    // that works.
    const sentence = provenanceSentence(
      provenanceCounts({ mods: [untracked("stranger.jar")] })
    );
    expect(sentence).toContain("1 this dashboard did not install");
  });

  it("says there are no jars rather than listing nothing", () => {
    expect(provenanceSentence(provenanceCounts({ mods: [] }))).toBe(
      "There are no jars in the mods folder."
    );
  });

  it("does not count a missing row towards the jars", () => {
    expect(provenanceSentence(provenanceCounts({ mods: [missing("gone.jar")] }))).toBe(
      "There are no jars in the mods folder."
    );
  });
});

describe("packHeadline", () => {
  it("names the pack, when it was applied and by whom", () => {
    const counts = provenanceCounts({ mods: [entry({ fileName: "a.jar", source: "pack" })] });
    const head = packHeadline(applied(), counts);
    expect(head.named).toBe(true);
    expect(head.title).toBe("Vanilla Perfected");
    expect(head.detail).toMatch(/^Applied /);
    expect(head.detail).toContain("by Aybars");
    // The apply's own counts, which are a different claim from the counts on disk.
    expect(head.detail).toContain("78 of 81 mods installed");
  });

  it("leaves the actor out when the row carried no name", () => {
    const head = packHeadline(applied({ appliedByName: null }), provenanceCounts({ mods: [] }));
    expect(head.detail).not.toMatch(/ by /);
  });

  it("leaves the counts out when the row carried none", () => {
    // `null` must never render as `0 of 0`, which reads as a failed apply.
    const head = packHeadline(
      applied({ installed: null, total: null }),
      provenanceCounts({ mods: [] })
    );
    expect(head.detail).not.toMatch(/installed/);
    expect(head.detail).not.toMatch(/0 of 0/);
  });

  it("reports pack jars with no recorded apply as exactly that", () => {
    /**
     * The third state, and the reason this is a function rather than two branches: a server
     * whose jars were put there by an apply that predates the record. "No pack" would be
     * false; a pack name would be invented.
     */
    const counts = provenanceCounts({
      mods: [
        entry({ fileName: "a.jar", source: "pack" }),
        entry({ fileName: "b.jar", source: "pack" }),
      ],
    });
    const head = packHeadline(null, counts);
    expect(head.named).toBe(false);
    expect(head.title).toBe("A pack was applied, but not from here");
    expect(head.detail).toContain("2 jars");
    expect(head.detail).toMatch(/no record of which pack or when/);
  });

  it("says no pack applied when nothing came from one", () => {
    // Production today: three mods, each installed on its own.
    const counts = provenanceCounts({
      mods: [entry({ fileName: "a.jar", source: "manual" })],
    });
    const head = packHeadline(null, counts);
    expect(head.title).toBe("No pack applied");
    expect(head.detail).toMatch(/added on its own, not by a pack/);
  });

  it("invites an action on an empty server rather than stating an absence twice", () => {
    const head = packHeadline(null, provenanceCounts({ mods: [] }));
    expect(head.title).toBe("No pack applied");
    expect(head.detail).toMatch(/Add a mod, or apply a pack/);
  });
});

describe("packVersionNote", () => {
  it("reports a pack applied for a version the server no longer runs", () => {
    // Real drift: the version dropdown can be changed after an apply and the jars do not
    // move with it. Nothing surfaced this before.
    expect(
      packVersionNote(applied({ mcVersion: "1.21.1" }), {
        mcVersion: "26.1.2",
        loader: "fabric",
      })
    ).toMatch(/applied for Minecraft 1\.21\.1; the server is set to 26\.1\.2/);
  });

  it("says nothing when the two agree", () => {
    expect(packVersionNote(applied(), { mcVersion: "26.1.2", loader: "fabric" })).toBe(null);
  });

  it("says nothing when there is nothing to compare", () => {
    /**
     * Three ways there is no comparison, and all three must answer `null` rather than a
     * disagreement — an absent reading rendered as drift is the mistake every settings
     * surface in this app is built to avoid.
     */
    expect(packVersionNote(null, { mcVersion: "26.1.2", loader: "fabric" })).toBe(null);
    expect(packVersionNote(applied(), null)).toBe(null);
    expect(
      packVersionNote(applied({ mcVersion: null }), { mcVersion: "26.1.2", loader: "fabric" })
    ).toBe(null);
  });
});

describe("parseAppliedPack", () => {
  /** The real producer, so the two cannot drift apart. */
  const details = () =>
    appliedPackDetails({
      game: "minecraft",
      packId: "pack-1",
      packName: "Vanilla Perfected",
      installed: 78,
      total: 81,
      mcVersion: "26.1.2",
      loader: "fabric",
    });

  it("reads back what the apply route writes", () => {
    expect(
      parseAppliedPack({
        action: APPLY_MODPACK_ACTION,
        details: details(),
        createdAt: new Date("2026-09-30T10:00:00Z"),
        user: { username: "Aybars" },
      })
    ).toEqual({
      packId: "pack-1",
      name: "Vanilla Perfected",
      appliedAt: "2026-09-30T10:00:00.000Z",
      appliedByName: "Aybars",
      installed: 78,
      total: 81,
      mcVersion: "26.1.2",
      loader: "fabric",
    });
  });

  it("carries the game tag the activity filter reads", () => {
    // `/api/activity` drops rows for worlds the viewer cannot open by reading
    // `details.game`. An untagged mod row once leaked to a MOD granted only `zomboid`.
    expect(JSON.parse(details()).game).toBe("minecraft");
  });

  it("refuses a row of another kind", () => {
    // The lookup filters on the action, but the parser must not trust its caller: one
    // mis-aimed query would otherwise put a mod install on the header as a pack.
    expect(
      parseAppliedPack({
        action: "install_mod",
        details: details(),
        createdAt: new Date(),
        user: null,
      })
    ).toBe(null);
  });

  it("refuses a blob that will not parse, rather than inventing a pack", () => {
    /**
     * `Activity.details` is free-text JSON written by several routes over several months.
     * "Unknown pack" on the header would be a pack nobody applied.
     */
    for (const details of ["{not json", "null", '"a string"', "[1,2]", ""]) {
      expect(
        parseAppliedPack({ action: APPLY_MODPACK_ACTION, details, createdAt: new Date() })
      ).toBe(null);
    }
  });

  it("refuses a blob with no usable pack name", () => {
    expect(
      parseAppliedPack({
        action: APPLY_MODPACK_ACTION,
        details: JSON.stringify({ game: "minecraft", packName: "   " }),
        createdAt: new Date(),
      })
    ).toBe(null);
  });

  it("answers null for no row at all", () => {
    expect(parseAppliedPack(null)).toBe(null);
    expect(parseAppliedPack(undefined)).toBe(null);
  });

  it("leaves unrecorded fields null rather than defaulting them", () => {
    // `installed: 0, total: 0` reads as a failed apply, so an absent count has to stay
    // absent all the way to the surface.
    expect(
      parseAppliedPack({
        action: APPLY_MODPACK_ACTION,
        details: JSON.stringify({ game: "minecraft", packName: "Old Pack" }),
        createdAt: new Date("2026-09-30T10:00:00Z"),
        user: { username: "" },
      })
    ).toEqual({
      packId: null,
      name: "Old Pack",
      appliedAt: "2026-09-30T10:00:00.000Z",
      appliedByName: null,
      installed: null,
      total: null,
      mcVersion: null,
      loader: null,
    });
  });

  it("refuses a row whose timestamp cannot be read", () => {
    // The header's sentence opens with the date, so a row with no usable one is not a
    // record to state anything from.
    expect(
      parseAppliedPack({
        action: APPLY_MODPACK_ACTION,
        details: details(),
        createdAt: "not a date",
      })
    ).toBe(null);
  });
});
