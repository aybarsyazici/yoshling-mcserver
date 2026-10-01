import { describe, expect, it, vi } from "vitest";
import { planModpackInstall, type PackMod } from "../mod-plan";
import { serverSideVerdict } from "../mod-admission";
import type { ModrinthVersion } from "../modrinth";

/**
 * **What a modpack apply decides, before anything is destroyed.**
 *
 * This is the code an adversarial review mutated to devastating effect while the suite
 * stayed green, because it lived inline in `/api/mods/install-modpack` and nothing could
 * reach it:
 *
 * - `if (!side.install)` → `if (false && !side.install)` **deletes the entire client-only
 *   filter**, restoring the exact pre-change behaviour the feature was written to fix, and
 *   762 tests passed.
 * - the denominator `serverModTotal(packSize, skipped)` → `plan.length`, which the route's
 *   own comment calls the alternative that "hides failures", and 762 tests passed.
 *
 * Both are now behaviour of `planModpackInstall`, with the two Modrinth calls injected, so
 * they are asserted rather than commented. No network, no Prisma, no mods directory.
 */

function mod(over: Partial<PackMod> & { name: string }): PackMod {
  return {
    slug: over.name.toLowerCase().replace(/\W+/g, "-"),
    modrinthId: "id-" + over.name,
    versionId: null,
    downloadUrl: null,
    ...over,
  };
}

function version(over: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return {
    id: "v1",
    version_number: "1.0.0",
    game_versions: ["26.1.2"],
    loaders: ["fabric"],
    files: [],
    dependencies: [],
    ...over,
  } as ModrinthVersion;
}

/** The real decision, so a wrong enum mapping reddens this file too rather than only its own. */
const realSide = async (v: ModrinthVersion) => serverSideVerdict({ environment: v.environment });

/** Every mod resolves to one version carrying the `environment` named after it. */
function resolver(byName: Record<string, string>) {
  return vi.fn(async (modrinthId: string) => {
    const name = modrinthId.replace(/^id-/, "");
    return [version({ environment: byName[name] })];
  });
}

describe("the client-only filter actually filters", () => {
  /**
   * **The mutant.** Sodium is `client_only`; it must be in `skipped` and NOT in `items`.
   *
   * Both halves matter. Asserting only `skipped` would pass for a plan that skipped it and
   * downloaded it anyway; asserting only `items` would pass for one that dropped it
   * silently, which is the 7DTD config route's documented defect ("Saved" for settings it
   * could not write).
   */
  it("keeps a client-only mod out of the plan and names it in skipped", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "Sodium" }), mod({ name: "Lithium" })],
      resolveVersions: resolver({ Sodium: "client_only", Lithium: "client_or_server" }),
      sideFor: realSide,
    });

    expect(plan.items.map((i) => i.mod.name)).toEqual(["Lithium"]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["Sodium"]);
    // And with a reason naming the declaration, not the word "skipped" on its own.
    expect(plan.skipped[0].reason).toMatch(/client_only/);
    expect(plan.errors).toEqual([]);
  });

  /**
   * `singleplayer_only` is the value the first enum table missed, and the live API has it
   * on projects whose `server_side` says **required** — so it is the one addition that can
   * only work if the version outranks the project. e4mc opens a singleplayer world to a
   * LAN; it has no business on a dedicated server.
   */
  it("skips singleplayer_only even though its project claims the server is required", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "e4mc" })],
      resolveVersions: resolver({ e4mc: "singleplayer_only" }),
      // The real `serverSideFor` would consult the project here only if the version were
      // undecided. It is decided, so a project saying `required` never gets a vote.
      sideFor: async (v) =>
        serverSideVerdict({ environment: v.environment, serverSide: "required" }),
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["e4mc"]);
  });

  /** A server mod is not filtered. The complement — a "filter" that drops everything also
   * satisfies the test above. */
  it("plans every mod that does run on a server", async () => {
    const names = [
      "client_and_server",
      "server_only",
      "server_only_client_optional",
      "dedicated_server_only",
      "client_or_server",
      "client_or_server_prefers_both",
      "client_only_server_optional",
    ];
    const plan = await planModpackInstall({
      mods: names.map((n) => mod({ name: n })),
      resolveVersions: resolver(Object.fromEntries(names.map((n) => [n, n]))),
      sideFor: realSide,
    });
    expect(plan.items).toHaveLength(names.length);
    expect(plan.skipped).toEqual([]);
  });

  /** A direct download has no side declaration to read, so it is planned, never filtered. */
  it("plans a direct download without asking anything about its side", async () => {
    const resolveVersions = vi.fn(async () => [version()]);
    const sideFor = vi.fn(realSide);
    const plan = await planModpackInstall({
      mods: [mod({ name: "Technic Thing", modrinthId: null, downloadUrl: "https://x/y.jar" })],
      resolveVersions,
      sideFor,
    });
    expect(plan.items).toEqual([
      { kind: "direct", mod: expect.objectContaining({ name: "Technic Thing" }), url: "https://x/y.jar" },
    ]);
    expect(resolveVersions).not.toHaveBeenCalled();
    expect(sideFor).not.toHaveBeenCalled();
  });
});

describe("the denominator is the pack minus the skips, never the plan's length", () => {
  /**
   * **The mutant.** 10 rows: 3 client-only, 2 that cannot be resolved, 5 installable.
   *
   * `total` must be **7**, not 5. `plan.items.length` is 5, and reporting that would let the
   * download loop install all five and announce "Installed 5 of 5 — complete" with two
   * failures listed underneath it. The two failures stay in the denominator because they
   * are mods that *should* be on this server and are not.
   */
  it("keeps unresolvable mods in the total and leaves the skips out", async () => {
    const plan = await planModpackInstall({
      mods: [
        mod({ name: "Sodium" }),
        mod({ name: "Iris" }),
        mod({ name: "Shaders" }),
        mod({ name: "Gone" }),
        mod({ name: "AlsoGone" }),
        ...["A", "B", "C", "D", "E"].map((n) => mod({ name: n })),
      ],
      resolveVersions: vi.fn(async (id: string) => {
        const name = id.replace(/^id-/, "");
        if (name === "Gone") return []; // no compatible version
        if (name === "AlsoGone") throw new Error("Modrinth returned 502");
        const env = ["Sodium", "Iris", "Shaders"].includes(name)
          ? "client_only"
          : "client_and_server";
        return [version({ environment: env })];
      }),
      sideFor: realSide,
    });

    expect(plan.items).toHaveLength(5);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.total).toBe(7);
    // The two losses are named, and named as failures rather than skips.
    expect(plan.errors).toEqual([
      "Gone: no compatible version",
      "AlsoGone: Modrinth returned 502",
    ]);
  });

  it("is the pack size when nothing is skipped", async () => {
    const plan = await planModpackInstall({
      mods: ["A", "B", "C"].map((n) => mod({ name: n })),
      resolveVersions: resolver({ A: "client_and_server", B: "server_only", C: "client_or_server" }),
      sideFor: realSide,
    });
    expect(plan.total).toBe(3);
  });

  /**
   * The all-client pack: `total: 0` and an empty plan, which is what lets the route refuse
   * before it tars a 215 MiB world and empties the mods directory.
   */
  it("gives an all-client pack an empty plan and a total of zero", async () => {
    const plan = await planModpackInstall({
      mods: ["Sodium", "Iris"].map((n) => mod({ name: n })),
      resolveVersions: resolver({ Sodium: "client_only", Iris: "singleplayer_only" }),
      sideFor: realSide,
    });
    expect(plan.items).toEqual([]);
    expect(plan.total).toBe(0);
    expect(plan.skipped).toHaveLength(2);
  });
});

describe("the rest of the plan's bookkeeping", () => {
  /** A row with neither a modrinthId nor a URL is the 224-dead-rows case: a failure, named,
   * pointing at the fix. */
  it("records a row with no download source as a failure that says to re-import", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "Orphan", modrinthId: null })],
      resolveVersions: vi.fn(async () => [version()]),
      sideFor: realSide,
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.errors[0]).toMatch(/Orphan: no download source recorded/);
    expect(plan.errors[0]).toMatch(/re-import/);
    // Still in the denominator — it is a mod that should be on the server and is not.
    expect(plan.total).toBe(1);
  });

  /** A pinned `versionId` wins over "newest compatible", or a pack cannot pin anything. */
  it("honours a pinned versionId and fails when the pin is gone", async () => {
    const versions = [version({ id: "new" }), version({ id: "pinned" })];
    const plan = await planModpackInstall({
      mods: [mod({ name: "Pinned", versionId: "pinned" }), mod({ name: "Stale", versionId: "x" })],
      resolveVersions: vi.fn(async () => versions),
      sideFor: realSide,
    });
    expect(plan.items).toHaveLength(1);
    const only = plan.items[0];
    expect(only.kind === "modrinth" && only.version.id).toBe("pinned");
    expect(plan.errors).toEqual(["Stale: no compatible version"]);
  });

  /** With no pin it takes the first version, which is the newest the API returned. */
  it("takes the newest version when nothing is pinned", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "Unpinned" })],
      resolveVersions: vi.fn(async () => [version({ id: "new" }), version({ id: "old" })]),
      sideFor: realSide,
    });
    const only = plan.items[0];
    expect(only.kind === "modrinth" && only.version.id).toBe("new");
  });

  /**
   * An `environment` value this app has no mapping for is collected, because that is the
   * "loud" half of failing safe — the mod is still installed (see below), but the stale
   * table has to reach the report or it never gets updated. `singleplayer_only` sat
   * unmapped in the live API through this feature's first draft and silently installed on
   * the server the exact kind of mod the feature exists to exclude.
   */
  it("collects an unrecognised environment while still installing the mod", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "FromTheFuture" }), mod({ name: "Normal" })],
      resolveVersions: resolver({
        FromTheFuture: "client_or_server_prefers_server",
        Normal: "client_and_server",
      }),
      sideFor: realSide,
    });
    expect(plan.unrecognised).toEqual([
      { name: "FromTheFuture", environment: "client_or_server_prefers_server" },
    ]);
    // Fail-safe: it is in the plan, not in skipped. A wrong skip is the expensive direction.
    expect(plan.items.map((i) => i.mod.name)).toEqual(["FromTheFuture", "Normal"]);
    expect(plan.skipped).toEqual([]);
  });

  /** The literal `"unknown"` is a mapped value meaning "this build says nothing", which is
   * not the same fact as "we cannot read what it said". It must not be reported as drift. */
  it("does not report a declared unknown as an unrecognised value", async () => {
    const plan = await planModpackInstall({
      mods: [mod({ name: "Quiet" })],
      resolveVersions: resolver({ Quiet: "unknown" }),
      sideFor: realSide,
    });
    expect(plan.unrecognised).toEqual([]);
  });

  /**
   * The progress callback is the operation's per-mod count. It has to fire once per mod in
   * pack order including the ones that get skipped, or the bar stalls on a pack that is
   * half client-only and the apply looks hung.
   */
  it("reports progress once per mod, in order, including the skipped ones", async () => {
    const seen: Array<[string, number]> = [];
    await planModpackInstall({
      mods: ["Sodium", "A", "Orphan"].map((n) =>
        n === "Orphan" ? mod({ name: n, modrinthId: null }) : mod({ name: n })
      ),
      resolveVersions: resolver({ Sodium: "client_only", A: "client_and_server" }),
      sideFor: realSide,
      onExamine: (m, i) => seen.push([m.name, i]),
    });
    expect(seen).toEqual([
      ["Sodium", 0],
      ["A", 1],
      ["Orphan", 2],
    ]);
  });

  it("plans nothing, and fails nothing, for an empty pack", async () => {
    const plan = await planModpackInstall({
      mods: [],
      resolveVersions: vi.fn(async () => []),
      sideFor: realSide,
    });
    expect(plan).toEqual({ items: [], skipped: [], errors: [], unrecognised: [], total: 0 });
  });
});
