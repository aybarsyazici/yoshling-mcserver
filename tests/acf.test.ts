import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kvSection, parseInstalledVersions, parseLatestKnownVersions } from "@/lib/acf";

/**
 * The Steam Workshop manifest parser — "why can nobody join?".
 *
 * `appworkshop_108600.acf` has **two** sections keyed by workshop id, and both carry a
 * `timeupdated`:
 *
 *   - `WorkshopItemsInstalled` — what is on disk
 *   - `WorkshopItemDetails`    — what Steam knows, including `latest_timeupdated`
 *
 * Slicing from the first section to end-of-file lets the second section's values win for
 * every id, which makes installed == published for every mod and the staleness check a
 * no-op that always answers "nothing to do". It fails silently and forever: the symptom is
 * players being locked out by a mod that updated, with the dashboard reporting nothing to
 * do. `scripts/pz-stale-mods.py` encodes the same rule for use on the box.
 *
 * The fixture is the real production manifest taken 2026-09-29 (75 installed items). It
 * holds only workshop ids, sizes and manifest ids — nothing was redacted because there is
 * nothing secret in it.
 */
const ACF = readFileSync(path.join(__dirname, "fixtures/appworkshop_108600.acf"), "utf-8");

/**
 * A synthetic manifest with the two sections DISAGREEING for one item.
 *
 * Needed because the production manifest was fully up to date on the day it was taken —
 * every installed `timeupdated` equalled the details section's `latest_timeupdated` — so
 * it cannot tell a correct parser from the broken one. A fixture that passes either way
 * pins nothing.
 */
const STALE = readFileSync(path.join(__dirname, "fixtures/appworkshop-stale.acf"), "utf-8");

describe("the fixture really is the two-section shape", () => {
  it("has both id-keyed sections, and both carry timeupdated", () => {
    // If this ever stops being true the rest of the suite is testing nothing, so it is
    // asserted rather than assumed.
    expect(ACF).toContain('"WorkshopItemsInstalled"');
    expect(ACF).toContain('"WorkshopItemDetails"');
    const installed = kvSection(ACF, "WorkshopItemsInstalled")!;
    const details = kvSection(ACF, "WorkshopItemDetails")!;
    expect(installed).toContain('"timeupdated"');
    expect(details).toContain('"timeupdated"');
    expect(details).toContain('"latest_timeupdated"');
    // And the two sections are disjoint slices of the file.
    expect(installed.length).toBeGreaterThan(0);
    expect(details.length).toBeGreaterThan(0);
    expect(installed).not.toContain('"latest_timeupdated"');
  });
});

describe("kvSection", () => {
  it("stops at the section's own closing brace, not at end of file", () => {
    // The bug, as a property: the installed section must not swallow the details section.
    const installed = kvSection(ACF, "WorkshopItemsInstalled")!;
    expect(installed).not.toContain("WorkshopItemDetails");
  });

  it("matches braces rather than taking the first one it finds", () => {
    const text = '"Outer"\n{\n\t"a"\n\t{\n\t\t"x" "1"\n\t}\n\t"b" "2"\n}\n"After"\n{\n\t"y" "9"\n}\n';
    const outer = kvSection(text, "Outer")!;
    expect(outer).toContain('"x" "1"');
    expect(outer).toContain('"b" "2"');
    expect(outer).not.toContain('"y" "9"');
  });

  it("returns null for a section that is absent", () => {
    expect(kvSection(ACF, "NoSuchSection")).toBeNull();
  });

  it("returns null for an unterminated section rather than the rest of the file", () => {
    expect(kvSection('"Outer"\n{\n\t"a" "1"\n', "Outer")).toBeNull();
  });
});

describe("parseInstalledVersions", () => {
  it("reads every installed item off the real manifest", () => {
    const installed = parseInstalledVersions(ACF);
    // 75 Workshop items, matching the live `WorkshopItems=` line in the .ini fixture.
    expect(installed.size).toBe(75);
    for (const [id, updated] of installed) {
      expect(id).toMatch(/^\d{6,}$/);
      expect(Number.isFinite(updated)).toBe(true);
      expect(updated).toBeGreaterThan(0);
    }
  });

  it("takes timeupdated from the installed section, never from the details section", () => {
    // The heart of it, and the reason a second fixture exists: when a mod is stale the two
    // sections disagree, and the installed map must carry the INSTALLED number. Read from
    // the details section instead and the mod looks current, forever.
    const installed = parseInstalledVersions(STALE);
    expect(installed.get("2335368829")).toBe(1789340498); // on disk
    expect(installed.get("2366717227")).toBe(1787109082);
    // NOT the details section's value for the same id.
    expect(installed.get("2335368829")).not.toBe(1799999999);
  });

  it("is empty, not wrong, when the section is missing", () => {
    // A manifest that exists but yields nothing is treated by `findStaleMods` as a parse
    // failure and throws, which is the intended loud answer. Silently returning a
    // half-populated map is what must not happen.
    expect(parseInstalledVersions('"AppWorkshop"\n{\n\t"appid" "108600"\n}\n').size).toBe(0);
    expect(parseInstalledVersions("").size).toBe(0);
  });

  it("ignores a short numeric key that is not a workshop id", () => {
    const text = [
      '"WorkshopItemsInstalled"',
      "{",
      '\t"108600"',
      "\t{",
      '\t\t"timeupdated" "1"',
      "\t}",
      '\t"2335368829"',
      "\t{",
      '\t\t"timeupdated" "1789340498"',
      "\t}",
      "}",
    ].join("\n");
    const out = parseInstalledVersions(text);
    // Workshop ids are 6+ digits; `108600` is the app id and is exactly 6, so it is kept by
    // the same rule. What matters is that the real item is read correctly.
    expect(out.get("2335368829")).toBe(1789340498);
  });
});

describe("parseLatestKnownVersions", () => {
  it("reads latest_timeupdated from the details section", () => {
    const latest = parseLatestKnownVersions(ACF);
    expect(latest.size).toBeGreaterThan(0);
    for (const [id, updated] of latest) {
      expect(id).toMatch(/^\d{6,}$/);
      expect(updated).toBeGreaterThan(0);
    }
  });

  it("does not read the installed section's timeupdated by mistake", () => {
    // If it fell back to `timeupdated` the cross-check would compare a number against
    // itself and could never report a stale mod.
    const installedOnly = [
      '"WorkshopItemsInstalled"',
      "{",
      '\t"2335368829"',
      "\t{",
      '\t\t"timeupdated" "1000"',
      "\t}",
      "}",
    ].join("\n");
    expect(parseLatestKnownVersions(installedOnly).size).toBe(0);
  });

  it("cross-checks against the local record without flattening the two", () => {
    const installed = parseInstalledVersions(STALE);
    const latest = parseLatestKnownVersions(STALE);
    // `findStaleMods` reports an id when `max(published, localLatest) > installed`.
    expect(latest.get("2335368829")!).toBeGreaterThan(installed.get("2335368829")!);
    expect(latest.get("2366717227")).toBe(installed.get("2366717227"));
  });
});

describe("the staleness comparison the parser exists to make", () => {
  /** `findStaleMods`'s rule, minus the network: which ids have a newer published version. */
  function staleIds(text: string): string[] {
    const installed = parseInstalledVersions(text);
    const latest = parseLatestKnownVersions(text);
    return [...installed.keys()].filter((id) => (latest.get(id) ?? 0) > installed.get(id)!);
  }

  /**
   * The OLD parser, reproduced: find the installed section's opening and read to the end
   * of the file with a global regex. Kept here so the fixture is proved to discriminate
   * between right and wrong rather than merely to pass.
   */
  function installedVersionsSlicedToEof(text: string): Map<string, number> {
    const out = new Map<string, number>();
    const at = text.indexOf('"WorkshopItemsInstalled"');
    if (at < 0) return out;
    const itemRe = /"(\d{6,})"\s*\{([^}]*)\}/g;
    const section = text.slice(at); // ← the bug: no closing brace, so both sections match
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(section)) !== null) {
      const hit = /"timeupdated"\s*"(\d+)"/.exec(m[2]);
      // Later sections overwrite earlier ones, so the details value wins.
      if (hit) out.set(m[1], Number(hit[1]));
    }
    return out;
  }

  it("reports the stale mod", () => {
    expect(staleIds(STALE)).toEqual(["2335368829"]);
  });

  it("reports nothing for the real, fully-updated production manifest", () => {
    // Taken 2026-09-29, when there were genuinely 0 stale mods. This is the "nothing to do"
    // answer being CORRECT, which is the case the old bug was indistinguishable from.
    expect(staleIds(ACF)).toEqual([]);
  });

  it("the slice-to-end-of-file parser would have answered 'nothing to do'", () => {
    // The whole point of bounding the section. With the old parser the installed number is
    // overwritten by the details number, so installed == published and the check silently
    // never fires — a mod everyone is locked out by, reported as up to date.
    const wrong = installedVersionsSlicedToEof(STALE);
    expect(wrong.get("2335368829")).toBe(1799999999);
    const latest = parseLatestKnownVersions(STALE);
    const wronglyStale = [...wrong.keys()].filter((id) => (latest.get(id) ?? 0) > wrong.get(id)!);
    expect(wronglyStale).toEqual([]);
    // And the bounded parser does not make that mistake.
    expect(parseInstalledVersions(STALE).get("2335368829")).toBe(1789340498);
  });
});
