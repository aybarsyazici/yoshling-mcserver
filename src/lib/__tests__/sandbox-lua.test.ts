import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATION_ONLY,
  PRESET_ONLY,
  groupOrderFor,
  formatSandboxValue,
  parseSandboxLua,
  sandboxGroupOf,
  scopeOf,
  setSandboxValues,
} from "@/lib/sandbox-lua";

/**
 * The `SandboxVars.lua` parser, validator and writer.
 *
 * ## The fixture is real
 *
 * `fixtures/pz-sandboxvars.lua` is a **verbatim excerpt** of production's
 * `Server/yoshling_SandboxVars.lua`, read off the box on 2026-10-01 (74,711 bytes,
 * 1,803 lines, 742 options) and trimmed to 176 lines by deleting whole
 * option-plus-comment units — no line in it was retyped or edited. The file holds no
 * secrets; it is loot and zombie knobs.
 *
 * It was trimmed to keep the shapes that can actually break a writer, which is the
 * point of using the real file rather than one written to match the parser:
 *
 * - **`Strength` and `Farming` each appear twice**, in different tables and with
 *   different types: `ZombieLore.Strength = 2` (a zombie-damage enum) beside
 *   `MultiplierConfig.Strength = 1.0` (an XP rate), and top-level `Farming = 3` (a
 *   plant-growth enum) beside `MultiplierConfig.Farming = 1.0`. These are the only two
 *   collisions in the whole production file, and a `/^\s*Strength = /` style rewrite
 *   hits the wrong one and changes its type while doing so.
 * - **`StartYear` has no comment of its own** and sits directly under `DayLength`'s 27
 *   `-- N = Label` lines, so a parser that forgets to clear its pending comment block
 *   gives it 27 choices and a dropdown that means nothing.
 * - **`-- Default = 1 Hour, 30 Minutes`** is help, not a choice, and sits in the middle
 *   of lines that are.
 * - Min/Max on both an integer (`Min: -1 Max: 2147483647`) and a float
 *   (`Min: 0.00 Max: 4.00`); an empty string, a string full of commas, and a string
 *   with `:` and `;` in it; and `VERSION = 6` at the top.
 */
const LUA = readFileSync(path.join(__dirname, "fixtures/pz-sandboxvars.lua"), "utf-8");

function byName(name: string) {
  const found = parseSandboxLua(LUA).find((o) => o.name === name);
  if (!found) throw new Error(`fixture has no option ${name}`);
  return found;
}

describe("parseSandboxLua", () => {
  it("reads every option in the excerpt exactly once", () => {
    const options = parseSandboxLua(LUA);
    // 38 `Key = value` lines are in the fixture, including VERSION
    // (`grep -cE '^ +[A-Za-z_][A-Za-z0-9_]* = [^{]'`).
    expect(options).toHaveLength(38);
    expect(new Set(options.map((o) => o.name)).size).toBe(38);
  });

  it("keeps two options with the same key in different tables apart", () => {
    // The whole reason writes are block-scoped. Both exist, with their own types.
    expect(byName("ZombieLore.Strength")).toMatchObject({
      value: "2",
      type: "integer",
      block: "ZombieLore",
    });
    expect(byName("MultiplierConfig.Strength")).toMatchObject({
      value: "1.0",
      type: "float",
      block: "MultiplierConfig",
    });
    expect(byName("Farming")).toMatchObject({ value: "3", block: "" });
    expect(byName("MultiplierConfig.Farming")).toMatchObject({ value: "1.0" });
  });

  it("reads PZ's enum documentation off the comment lines", () => {
    const speed = byName("ZombieLore.Speed");
    expect(speed.choices).toEqual([
      { value: "1", label: "Sprinters" },
      { value: "2", label: "Fast Shamblers" },
      { value: "3", label: "Shamblers" },
      { value: "4", label: "Random" },
    ]);
    expect(speed.help).toBe("How fast zombies move. Default = Random");
  });

  it("does not mistake a 'Default = …' line for a choice", () => {
    // `-- Default = 1 Hour, 30 Minutes` precedes DayLength's 27 real choices. Read as a
    // choice it becomes an unselectable option labelled with the word "Default".
    const day = byName("DayLength");
    expect(day.choices).toHaveLength(27);
    expect(day.choices?.map((c) => c.value)).not.toContain("Default");
    expect(day.help).toBe("Default = 1 Hour, 30 Minutes");
  });

  it("does not carry a comment block onto the next, undocumented option", () => {
    // StartYear follows DayLength's 27 choice lines with no comment of its own.
    const startYear = byName("StartYear");
    expect(startYear.help).toBe("");
    expect(startYear.choices).toBeUndefined();
  });

  it("takes Min/Max from the comment, for ints and floats alike", () => {
    expect(byName("ElecShutModifier")).toMatchObject({ min: -1, max: 2147483647, type: "integer" });
    expect(byName("FoodLootNew")).toMatchObject({ min: 0, max: 4, type: "float" });
    expect(byName("ZombieLore.SprinterPercentage")).toMatchObject({ min: 0, max: 100 });
  });

  it("reads strings unquoted, including an empty one and one full of commas", () => {
    expect(byName("LootItemRemovalList")).toMatchObject({ value: "", type: "string" });
    expect(byName("WorldItemRemovalList").value).toContain("Base.Hat, Base.Glasses");
    expect(byName("STA_PryOpen.PryToolTagsList").value).toBe("base:crowbar:1.0;");
  });

  it("records the line and indentation of every option", () => {
    // Writes address the line directly, so these are not decoration.
    const lines = LUA.split("\n");
    for (const o of parseSandboxLua(LUA)) {
      expect(lines[o.line]).toContain(`${o.name.split(".").pop()} = `);
      expect(lines[o.line].startsWith(o.indent)).toBe(true);
    }
  });
});

describe("setSandboxValues", () => {
  it("rewrites one line and leaves the rest of the file byte-identical", () => {
    const { text, applied } = setSandboxValues(LUA, { "ZombieConfig.PopulationMultiplier": "1.2" });
    expect(applied).toEqual(["ZombieConfig.PopulationMultiplier"]);
    const before = LUA.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    expect(after[changed[0] as number]).toBe("        PopulationMultiplier = 1.2,");
  });

  it("writes the option in the named table and not its namesake elsewhere", () => {
    // The property: a write is scoped to one block. `MultiplierConfig.Strength` is an XP
    // multiplier; `ZombieLore.Strength` is how hard zombies hit. Writing 2.5 into the
    // wrong one makes the world unrecognisable and reports success.
    const { text } = setSandboxValues(LUA, { "MultiplierConfig.Strength": "2.5" });
    const after = parseSandboxLua(text);
    expect(after.find((o) => o.name === "MultiplierConfig.Strength")?.value).toBe("2.5");
    expect(after.find((o) => o.name === "ZombieLore.Strength")?.value).toBe("2");
    expect(text).toContain("        Strength = 2.5,");
    expect(text).toContain("        Strength = 2,");
  });

  it("writes a top-level option, not the same-named one inside a table", () => {
    const { text } = setSandboxValues(LUA, { Farming: "5" });
    const after = parseSandboxLua(text);
    expect(after.find((o) => o.name === "Farming")?.value).toBe("5");
    expect(after.find((o) => o.name === "MultiplierConfig.Farming")?.value).toBe("1.0");
  });

  it("reads back as the value it was asked to write", () => {
    const updates = {
      "ZombieLore.ZombiesFallDamage": "2.5",
      ElecShutModifier: "30",
      "Map.AllowMiniMap": "false",
      LootItemRemovalList: "Base.Hat, Base.Glasses",
    };
    const { text, applied, written } = setSandboxValues(LUA, updates);
    expect(applied.sort()).toEqual(Object.keys(updates).sort());
    const after = new Map(parseSandboxLua(text).map((o) => [o.name, o.value]));
    for (const name of applied) expect(after.get(name)).toBe(written[name]);
  });

  it("keeps a float looking like a float when a whole number is typed", () => {
    // PZ's own serialiser writes `1.0`, and the loader parses a double. `Global = 2`
    // still loads, but the file stops matching what the game would write, so the next
    // startup rewrite silently reformats it and a diff of the file is noise.
    const { text } = setSandboxValues(LUA, { "MultiplierConfig.Global": "2" });
    expect(text).toContain("        Global = 2.0,");
  });

  it("never writes VERSION", () => {
    // VERSION is the game's own format version — `zombie/SandboxOptions` stamps it and
    // `upgradeLuaTable` migrates from it. Writing it tells the loader to migrate a file
    // that was never migrated.
    const result = setSandboxValues(LUA, { VERSION: "7" });
    expect(result.applied).toEqual([]);
    expect(result.text).toBe(LUA);
    expect(result.rejected[0].error).toContain("VERSION");
  });

  it("refuses the character-creation presets nothing in the game reads", () => {
    for (const name of PRESET_ONLY) {
      const result = setSandboxValues(LUA, { [name]: "2" });
      expect(result.applied).toEqual([]);
      expect(result.text).toBe(LUA);
    }
  });

  it("refuses a value outside the comment's own Min/Max", () => {
    // `ZombiesCountBeforeDelete` is documented `Min: 0 Max: 5000`. The game clamps, so
    // writing 99999 would be accepted by the file, applied as 5000, and reported as
    // saved — the exact defect class this feature is most exposed to.
    const result = setSandboxValues(LUA, { "ZombieConfig.ZombiesCountBeforeDelete": "99999" });
    expect(result.applied).toEqual([]);
    expect(result.text).toBe(LUA);
    expect(result.rejected[0].error).toContain("between 0 and 5000");
  });

  it("allows the exact Min and Max, since the comment includes them", () => {
    const low = setSandboxValues(LUA, { FoodLootNew: "0" });
    const high = setSandboxValues(LUA, { FoodLootNew: "4" });
    expect(low.rejected).toEqual([]);
    expect(high.rejected).toEqual([]);
    expect(low.text).toContain("    FoodLootNew = 0.0,");
  });

  it("refuses a value an enum does not list", () => {
    // ZombieLore.Speed documents 1-4. 7 is not clamped to anything meaningful.
    const result = setSandboxValues(LUA, { "ZombieLore.Speed": "7" });
    expect(result.rejected[0].error).toContain("1, 2, 3, 4");
    expect(result.text).toBe(LUA);
  });

  it("refuses a type change", () => {
    expect(setSandboxValues(LUA, { "Map.AllowMiniMap": "3" }).rejected).toHaveLength(1);
    expect(setSandboxValues(LUA, { MuscleStrainFactor: "true" }).rejected).toHaveLength(1);
    // A whole-number option given a fraction: the loader truncates it.
    expect(setSandboxValues(LUA, { ElecShutModifier: "14.5" }).rejected[0].error).toContain(
      "whole number"
    );
  });

  it("refuses an option that is not in the file", () => {
    // A renamed or mod-removed option must not be appended. The .ini writer appends
    // unknown keys on purpose; Lua cannot — a key the loader does not know is dropped on
    // the next startup rewrite, so appending it would look like it saved and then vanish.
    const result = setSandboxValues(LUA, { NoSuchOption: "1" });
    expect(result.rejected[0].error).toContain("not an option");
    expect(result.text).toBe(LUA);
  });

  it("writes nothing at all when any one value is refused", () => {
    // All-or-nothing: a half-applied batch cannot be described honestly by one toast.
    const result = setSandboxValues(LUA, {
      FoodLootNew: "1.5",
      "ZombieConfig.ZombiesCountBeforeDelete": "99999",
    });
    expect(result.applied).toEqual([]);
    expect(result.text).toBe(LUA);
    expect(result.rejected).toHaveLength(1);
  });

  it("refuses a string that would break the file", () => {
    for (const bad of ['a"b', "a\\b", "a\nb"]) {
      const result = setSandboxValues(LUA, { LootItemRemovalList: bad });
      expect(result.applied).toEqual([]);
      expect(result.text).toBe(LUA);
    }
  });

  it("rewrites every option to its own value and reproduces the file byte for byte", () => {
    // The strongest statement available about the writer: for every option in the file,
    // parse → format → write is the identity. A value classified as the wrong type, a
    // float reformatted, a string requoted or a line's comma lost would all show up here
    // as a diff, and none of them would be visible in a test that checks one key.
    //
    // The same check was run once against the full production file (1,803 lines, 742
    // options, 739 of them writable) while this was written: 0 rejected and the output
    // byte-identical to the input. That file is not committed — it is 75 KB of one
    // server's settings — so the fixture is what guards the property from here on.
    const writable = parseSandboxLua(LUA).filter(
      (o) => o.name !== "VERSION" && !PRESET_ONLY.includes(o.name as (typeof PRESET_ONLY)[number])
    );
    const result = setSandboxValues(
      LUA,
      Object.fromEntries(writable.map((o) => [o.name, o.value]))
    );
    expect(result.rejected).toEqual([]);
    expect(result.applied).toHaveLength(writable.length);
    expect(result.text).toBe(LUA);
  });

  it("keeps the file parseable after a string write", () => {
    const { text } = setSandboxValues(LUA, { LootItemRemovalList: "Base.Hat;Base.Glasses" });
    expect(text).toContain('    LootItemRemovalList = "Base.Hat;Base.Glasses",');
    expect(parseSandboxLua(text)).toHaveLength(parseSandboxLua(LUA).length);
  });
});

describe("formatSandboxValue", () => {
  it("has no Min/Max to enforce when the comment declared none", () => {
    // `Map.MapAllKnown` is documented in prose with no Min/Max, so there is nothing to
    // check beyond its type. Inventing a range here would refuse legitimate values.
    const option = byName("Map.MapAllKnown");
    expect(option.min).toBeUndefined();
    expect(formatSandboxValue(option, "false")).toMatchObject({ ok: true, literal: "false" });
  });
});

describe("scope and grouping", () => {
  it("puts every option under a heading the panel will actually render", () => {
    // `config-panel.tsx` renders only the groups named in its `groupOrder` prop, so an
    // option whose group is missing from it is drawn nowhere — no error, no gap. This is
    // the property that keeps the 742-option file from quietly becoming 600.
    for (const option of parseSandboxLua(LUA)) {
      const scope = scopeOf(option);
      expect(groupOrderFor(scope)).toContain(sandboxGroupOf(option.name));
    }
  });

  it("sorts mod-added tables into the mods panel and the base game's into the world one", () => {
    expect(scopeOf(byName("ZombieConfig.RespawnHours"))).toBe("world");
    expect(scopeOf(byName("Map.AllowMiniMap"))).toBe("world");
    expect(scopeOf(byName("FoodLootNew"))).toBe("world");
    expect(scopeOf(byName("STA_PryOpen.PryToolTagsList"))).toBe("mods");
    expect(scopeOf(byName("ProximityInventory.ZombieOnly"))).toBe("mods");
  });

  it("names the start-date options as the creation-only ones", () => {
    // Only these four, and only because `zombie/GameTime` is the sole reader of them in
    // the jar and is also what loads the save's own clock from `map_t.bin`.
    for (const name of CREATION_ONLY) expect(() => byName(name)).not.toThrow();
    expect(CREATION_ONLY).toEqual(["StartYear", "StartMonth", "StartDay", "StartTime"]);
  });
});
