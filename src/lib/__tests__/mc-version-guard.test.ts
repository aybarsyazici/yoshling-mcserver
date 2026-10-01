import { describe, it, expect } from "vitest";
import {
  isDowngrade,
  modVersionAdmits,
  versionChangeMismatches,
  versionChangeRefusal,
  type InstalledModFact,
} from "../mc-version-guard";

/**
 * Production, measured 2026-10-01: `InstalledMod` holds three rows, `level.dat` records
 * 26.1.2, and `ServerConfig` says fabric 26.1.2. Note `fabric-api` is stored as `26.1`
 * while the server runs `26.1.2` — that discrepancy is real, it is why the compatibility
 * test is prefix-wise, and it is the single most likely way a guard like this turns into
 * a dialog everybody clicks through.
 */
const LIVE_MODS: InstalledModFact[] = [
  { name: "Xaero's Minimap", mcVersion: "26.1.2", loader: "fabric" },
  { name: "Fabric API", mcVersion: "26.1", loader: "fabric" },
  { name: "Xaero's World Map", mcVersion: "26.1.2", loader: "fabric" },
];

const LIVE_WORLD = "26.1.2";

describe("the version the dropdown is guarded against", () => {
  /**
   * The property that matters most: **the configuration that is actually deployed is not
   * blocked.** A guard that fires on the live setup is a guard that gets confirmed
   * reflexively, and this repo has already paid for a warning nobody reads.
   */
  it("passes the live configuration", () => {
    expect(
      versionChangeMismatches({
        version: "26.1.2",
        loader: "fabric",
        worldVersion: LIVE_WORLD,
        mods: LIVE_MODS,
      })
    ).toEqual([]);
  });

  /**
   * The property this file exists for: a version the world cannot open, or that the
   * installed mods were not built for, must be reported before anything is written.
   * Before the fix the route validated nothing — `1.18.2` was two clicks away and answered
   * `{success:true}`.
   */
  it("reports the world and the mods when an older version is picked", () => {
    const req = {
      version: "1.21.4",
      loader: "fabric",
      worldVersion: LIVE_WORLD,
      mods: LIVE_MODS,
    };
    const mismatches = versionChangeMismatches(req);
    expect(mismatches.map((m) => m.kind)).toEqual(["world", "mod-version"]);
    // The refusal has to name the version on disk, the version chosen and a mod, because
    // "incompatible version" alone sends the reader to the wrong place.
    const refusal = versionChangeRefusal(req, mismatches);
    expect(refusal).toContain("26.1.2");
    expect(refusal).toContain("1.21.4");
    expect(refusal).toMatch(/Xaero|Fabric API/);
    // And it has to name the way through, or the control is merely broken in a new way.
    expect(refusal).toMatch(/confirm/i);
  });

  it("calls a downgrade a downgrade", () => {
    const mismatch = versionChangeMismatches({
      version: "1.21.4",
      loader: "fabric",
      worldVersion: LIVE_WORLD,
      mods: [],
    })[0];
    // An older version cannot open a newer world at all, while a newer one upgrades the
    // save format irreversibly. Different consequences, so different sentences.
    expect(mismatch.detail).toMatch(/older/);
    const upgrade = versionChangeMismatches({
      version: "26.3",
      loader: "fabric",
      worldVersion: LIVE_WORLD,
      mods: [],
    })[0];
    expect(upgrade.detail).toMatch(/upgrade the save format/);
  });

  it("reports a loader change against the installed mods", () => {
    const mismatches = versionChangeMismatches({
      version: "26.1.2",
      loader: "forge",
      worldVersion: LIVE_WORLD,
      mods: LIVE_MODS,
    });
    expect(mismatches.map((m) => m.kind)).toEqual(["mod-loader"]);
    expect(mismatches[0].detail).toMatch(/fabric/);
  });

  it("has no opinion when there is no world and no mod yet", () => {
    // A fresh install must be able to choose a version. Blocking that would make the first
    // save impossible, which is the way an over-eager guard gets deleted wholesale.
    expect(
      versionChangeMismatches({ version: "1.18.2", loader: "forge", worldVersion: null, mods: [] })
    ).toEqual([]);
  });
});

describe("mod compatibility", () => {
  it("admits a patch release for a mod declared against the minor line", () => {
    // `fabric-api` is stored as `26.1`; the server runs `26.1.2`. Equality here would flag
    // the healthiest mod on the box on every single save.
    expect(modVersionAdmits("26.1", "26.1.2")).toBe(true);
    expect(modVersionAdmits("26.1.2", "26.1.2")).toBe(true);
  });

  it("does not admit the other direction, or a different line", () => {
    // A mod built for a specific patch is the stricter statement, and guessing Minecraft's
    // compatibility promises is how under-reporting happens. Over-reporting costs one click.
    expect(modVersionAdmits("26.1.2", "26.1")).toBe(false);
    expect(modVersionAdmits("26.1.2", "1.21.4")).toBe(false);
    expect(modVersionAdmits("1.21", "1.21.4")).toBe(true);
    // `26.1` must not admit `26.11.x` — a prefix match on the raw string would.
    expect(modVersionAdmits("26.1", "26.11")).toBe(false);
  });

  it("treats an empty declaration as no claim", () => {
    expect(modVersionAdmits("", "26.1.2")).toBe(true);
  });
});

describe("version ordering across Minecraft's renumbering", () => {
  it("compares numerically, not lexically", () => {
    // The trap: "26.1.2" < "1.21.4" as strings, and "1.21.4" > "1.18.2" as strings. One of
    // those is right by accident and the other is wrong, which is worse than both being
    // wrong.
    expect(isDowngrade("1.21.4", "26.1.2")).toBe(true);
    expect(isDowngrade("26.1.2", "1.21.4")).toBe(false);
    expect(isDowngrade("1.18.2", "1.21.4")).toBe(true);
    expect(isDowngrade("1.21.4", "1.21")).toBe(false);
    expect(isDowngrade("26.1.2", "26.1.2")).toBe(false);
    // The pairs that actually discriminate: a two-digit segment. A string compare calls
    // 26.10 older than 26.2 and 1.10 older than 1.9, and the first five assertions above
    // happen to come out right either way — which is exactly how a wrong comparator
    // survives a test suite. (Verified: a lexical `target < current` passes all five.)
    expect(isDowngrade("26.10", "26.2")).toBe(false);
    expect(isDowngrade("26.2", "26.10")).toBe(true);
    expect(isDowngrade("1.10", "1.9")).toBe(false);
  });

  it("makes no claim about a version it cannot parse", () => {
    expect(isDowngrade("1.21.4-pre1", "26.1.2")).toBe(false);
    expect(isDowngrade("26.1.2", "snapshot")).toBe(false);
  });
});
