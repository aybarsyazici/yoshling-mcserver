import { describe, expect, it } from "vitest";
import { filterMinecraftMods, filterZomboidMods, filterUnpairedModIds, modTextMatches } from "@/lib/mod-list-filters";

const minecraft = Object.freeze([
  Object.freeze({ id: "row-one", name: "Copper Tools", fileName: "copper[v1].jar", slug: "copper-tools", modrinthId: "ProjectCopper", versionId: "BuildCopper", state: "matched" as const, source: "pack" }),
  Object.freeze({ id: "row-two", name: "Quartz Library", fileName: "quartz.jar", slug: "quartz-lib", modrinthId: "ProjectQuartz", versionId: null, state: "missing" as const, source: "pack" }),
  Object.freeze({ id: "row-three", name: "Map Helper", fileName: "map-helper.jar", slug: "map-helper", modrinthId: "MapProject", versionId: null, state: "matched" as const, source: "manual" }),
  Object.freeze({ id: "row-four", name: "Legacy Mod", fileName: "legacy.jar", slug: null, modrinthId: null, versionId: null, state: "matched" as const, source: null }),
  Object.freeze({ id: null, name: "loose.jar", fileName: "loose.jar", slug: null, modrinthId: null, versionId: null, state: "untracked" as const, source: null }),
]);
const pz = Object.freeze([
  Object.freeze({ workshopId: "111111", title: "Variant Tools", provides: Object.freeze(["VariantB42", "VariantB41"]), enabled: Object.freeze(["VariantB42"]), downloaded: true }),
  Object.freeze({ workshopId: "222222", title: "Pending Library", provides: Object.freeze(["PendingLib"]), enabled: Object.freeze(["PendingLib"]), downloaded: false }),
  Object.freeze({ workshopId: "333333", title: "Unknown IDs", provides: Object.freeze([]), enabled: Object.freeze([]), downloaded: true }),
  Object.freeze({ workshopId: "444444", title: "Disabled Extras", provides: Object.freeze(["Extras"]), enabled: Object.freeze([]), downloaded: true }),
]);
describe("Minecraft display filters", () => {
  it.each(["Copper", "COPPER", "  copper  ", "ProjectCopper", "BuildCopper", "row-one", "copper-tools", "copper[v1].jar"])("matches %s from actual names/IDs/filenames", (query) => {
    expect(filterMinecraftMods(minecraft, query, "all", "all")).toEqual([minecraft[0]]);
  });
  it("treats regex punctuation as literal text", () => { expect(filterMinecraftMods(minecraft, "[v1]", "all", "all")).toEqual([minecraft[0]]); });
  it.each(["matched", "missing", "untracked"] as const)("filters the actual %s file state", (state) => {
    expect(filterMinecraftMods(minecraft, "", state, "all")).toEqual(minecraft.filter((m) => m.state === state));
  });
  it("combines query, state and origin without counting a missing jar as present", () => {
    expect(filterMinecraftMods(minecraft, "quartz", "missing", "pack")).toEqual([minecraft[1]]);
    expect(filterMinecraftMods(minecraft, "quartz", "matched", "pack")).toEqual([]);
    expect(filterMinecraftMods(minecraft, "copper", "matched", "manual")).toEqual([]);
  });
  it.each(["pack", "manual", "unrecorded"] as const)("filters %s recorded origins", (origin) => {
    const expected = origin === "unrecorded" ? [minecraft[3], minecraft[4]] : minecraft.filter((m) => m.source === origin);
    expect(filterMinecraftMods(minecraft, "", "all", origin)).toEqual(expected);
  });
  it("keeps input order, entry identity and all source values untouched", () => {
    const before = JSON.stringify(minecraft);
    const all = filterMinecraftMods(minecraft, " \t ", "all", "all");
    expect(all).toEqual(minecraft); all.forEach((entry, i) => expect(entry).toBe(minecraft[i])); expect(JSON.stringify(minecraft)).toBe(before);
  });
});
describe("PZ display filters", () => {
  it.each(["Variant Tools", "VARIANT", " 111111 ", "variantb41", "VariantB42"])("finds %s in supplied/enabled IDs without enabling it", (query) => {
    expect(filterZomboidMods(pz, query, "all")).toEqual([pz[0]]);
  });
  it("uses actual download state independently of configured enabled IDs", () => {
    expect(filterZomboidMods(pz, "", "pending")).toEqual([pz[1]]);
    expect(filterZomboidMods(pz, "", "downloaded")).toEqual([pz[0], pz[2], pz[3]]);
    expect(filterZomboidMods(pz, "", "enabled")).toEqual([pz[0], pz[1]]);
  });
  it("includes mixed and fully disabled variants but cannot infer them from missing metadata", () => {
    expect(filterZomboidMods(pz, "", "disabled")).toEqual([pz[0], pz[3]]);
    expect(filterZomboidMods(pz, "", "no-ids")).toEqual([pz[2]]);
  });
  it("combines state and text without sorting the configured list", () => {
    expect(filterZomboidMods(pz, "library", "downloaded")).toEqual([]);
    expect(filterZomboidMods(pz, "", "all")).toEqual(pz);
    expect(pz[0].enabled).toEqual(["VariantB42"]);
  });
  it("text-searches unpaired IDs in their original order", () => {
    expect(filterUnpairedModIds(["ZuluLoose", "AlphaLoose", "Other"], " loose ")).toEqual(["ZuluLoose", "AlphaLoose"]);
    expect(filterUnpairedModIds(["ZuluLoose"], "missing")).toEqual([]);
  });
});
it("ignores absent search fields and matches a blank query", () => {
  expect(modTextMatches("nope", [undefined, null])).toBe(false); expect(modTextMatches(" ", [])).toBe(true);
});
