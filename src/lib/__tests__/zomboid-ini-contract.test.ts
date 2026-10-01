import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Relative, not `@/lib/...`, matching the other suites: these then run under a bare
// `npx vitest run` with no config at all.
import {
  CARD_OWNED_KEYS,
  canonicalKey,
  canonicalKeyIndex,
  classifyLiveOptions,
  describeIniSave,
  parseShowOptions,
  restartKeysIn,
  sameOptionValue,
  type PzIniSaveReport,
} from "../zomboid-ini-contract";
import { INFRA_KEYS, setIniValues } from "../zomboid";

/**
 * The contract around the .ini writer. Every assertion here pins a *property* of the
 * contract, not a string the UI happens to render today — the one exception being the
 * two "never says X" assertions, which are about words on purpose, because the words
 * are the defect: this project's recurring failure is a success sentence nobody checked
 * against the facts.
 *
 * Fixtures are shaped like the real file. The live `yoshling.ini` was read on
 * 2026-10-01: 144 `Key=Value` lines, LF endings, a `#` comment block above most keys,
 * and PZ's own habit of writing `;`-separated lists with a trailing separator.
 */
const INI = [
  "# Players can hurt and kill other players",
  "PVP=true",
  "",
  "# Min: 1 Max: 100",
  "MaxPlayers=32",
  "",
  "# RCON password (Pick a strong password)",
  "RCONPassword=secret-not-the-real-one",
  "",
  "# The port for the RCON (Remote Console) Min: 0 Max: 65535 Default: 27015",
  "RCONPort=27015",
  "",
  "# Default starting port for player data. Min: 0 Max: 65535 Default: 16261",
  "DefaultPort=16261",
  "",
  "# Min: 0 Max: 65535 Default: 16262",
  "UDPPort=16262",
  "",
  "# Enter the mod loading ID here.",
  "Mods=\\MoodleFramework;\\StarlitLibrary",
  "",
  "# Enter the foldername of the mod found in media\\maps\\",
  "Map=map_distanciado;Muldraugh, KY",
  "",
  "# Reset ID determines if the server has undergone a soft-reset.",
  "ResetID=4389967",
  "",
].join("\n");

describe("setIniValues append policy", () => {
  it("rewrites a key the file has, in place, leaving its comment alone", () => {
    const { text, applied, appended, ignored } = setIniValues(INI, { MaxPlayers: "16" });
    expect(applied).toEqual(["MaxPlayers"]);
    expect(appended).toEqual([]);
    expect(ignored).toEqual([]);
    expect(text).toContain("# Min: 1 Max: 100\nMaxPlayers=16");
  });

  it("refuses to invent a key when append is off, and names it as ignored", () => {
    // The bug: `PUT {"Maxplayerz":"99"}` appended the line and answered
    // `{"applied":["Maxplayerz"]}`. Before `append` existed there was no way to express
    // this at all, so this assertion could not have been written, let alone passed.
    const { text, applied, appended, ignored } = setIniValues(
      INI,
      { PVP: "false", Maxplayerz: "99" },
      { append: false }
    );
    expect(applied).toEqual(["PVP"]);
    expect(appended).toEqual([]);
    expect(ignored).toEqual(["Maxplayerz"]);
    expect(text).not.toContain("Maxplayerz");
  });

  it("still appends by default, because the import and the mod writer need it to", () => {
    // Not an accident of the implementation — a requirement. `/api/zomboid/config/import`
    // puts `RCONPassword` back into an uploaded .ini that may not have one, and
    // `writeMapOrder`/`writeModState` create their key in a file the game has not
    // finished filling in. All three discard the result, so a default of `false` would
    // turn them into silent no-ops.
    const { text, applied } = setIniValues(INI, { RCONPassword: "moved-in" });
    expect(applied).toEqual(["RCONPassword"]);
    const fresh = setIniValues("PVP=true\n", { RCONPassword: "moved-in" });
    expect(fresh.appended).toEqual(["RCONPassword"]);
    expect(fresh.text).toContain("RCONPassword=moved-in");
    expect(text).toContain("RCONPassword=moved-in");
  });
});

describe("INFRA_KEYS", () => {
  it("contains only keys the real server .ini actually has", () => {
    // The list used to end with SteamPort1 and SteamPort2, which are not Build 42 server
    // options: the production file's 144 keys contain neither (checked 2026-10-01) and
    // `showoptions` does not report them either, so two of the six entries locked and
    // preserved nothing. A lock list that is a third fiction invites trusting the rest.
    //
    // The oracle is deliberately the **production config**, not this test's own fixture:
    // the claim being pinned is about what the game has, which only the real file can
    // answer. `tests/zomboid-ini.test.ts` reads the same copy, taken 2026-09-29.
    const real = readFileSync(
      path.join(__dirname, "../../../tests/fixtures/pz-server.ini"),
      "utf-8"
    );
    const keys = new Set(real.split(/\r?\n/).flatMap((l) => /^([A-Za-z0-9_]+)=/.exec(l)?.[1] ?? []));
    expect(keys.size).toBe(144);
    for (const key of INFRA_KEYS) {
      expect(keys.has(key), `${key} is not a key the server .ini has`).toBe(true);
    }
  });
});

describe("canonicalKey", () => {
  const index = canonicalKeyIndex(["RCONPassword", "Mods", "MaxPlayers", "Map"]);

  it("resolves a differently-cased name to the file's own spelling", () => {
    // This is what makes the lock case-insensitive. `rconpassword` used to miss a
    // `LOCKED` set keyed on `RCONPassword`, get appended as a second line, and be
    // reported as applied — two lines for one setting, and the game reads the other one.
    expect(canonicalKey(index, "rconpassword")).toBe("RCONPassword");
    expect(canonicalKey(index, "MODS")).toBe("Mods");
    expect(canonicalKey(index, "mAp")).toBe("Map");
  });

  it("has no entry for a key the file does not have", () => {
    expect(canonicalKey(index, "maxplayerz")).toBeUndefined();
  });

  it("drops a name that two file keys claim, rather than guessing", () => {
    // No such pair exists in the live file (checked across all 144 keys), but picking one
    // of two arbitrarily would write to whichever happened to be seen first.
    expect(canonicalKey(canonicalKeyIndex(["Seed", "seed"]), "seed")).toBeUndefined();
  });
});

describe("the owned and restart key sets", () => {
  it("locks Map alongside Mods and WorkshopItems, and names an owner for each", () => {
    // Map was the omission, and the worst of the three: `pz/search_folder.sh` regenerates
    // `Map=` on every boot from what is installed, so a stock or mistyped name saved in
    // "All settings" was deleted by the very restart the toast asked for.
    expect(Object.keys(CARD_OWNED_KEYS).sort()).toEqual(["Map", "Mods", "WorkshopItems"]);
    for (const owner of Object.values(CARD_OWNED_KEYS)) expect(owner).not.toBe("");
  });

  it("calls for a restart only for the keys a reload cannot carry", () => {
    // The caption said "restart to apply" for all of them. The live file has 144 keys;
    // these are the ones a boot is genuinely needed for.
    expect(restartKeysIn(["MaxPlayers", "PVP", "ResetID", "DefaultPort"])).toEqual([
      "ResetID",
      "DefaultPort",
    ]);
    expect(restartKeysIn(["MaxPlayers", "PVP", "PauseEmpty", "PublicName"])).toEqual([]);
  });

  it("matches restart keys case-insensitively too", () => {
    expect(restartKeysIn(["resetid"])).toEqual(["resetid"]);
  });
});

/**
 * `showoptions` as the live server answers it, read on 2026-10-01. The header line, the
 * `* ` prefix, the one masked value, and the decimal form the game uses for floats are
 * all copied from the real reply.
 */
const SHOW_OPTIONS = [
  "List of Server Options:",
  "* MaxPlayers=32",
  "* PVP=true",
  "* SpeedLimit=70.0",
  "* ClientActionLogs=ISEnterVehicle;ISExitVehicle;",
  "* BadWordReplacement=[HIDDEN]",
].join("\n");

describe("parseShowOptions", () => {
  it("reads the game's reply and skips its header", () => {
    const live = parseShowOptions(SHOW_OPTIONS);
    expect(live.get("MaxPlayers")).toBe("32");
    expect(live.get("SpeedLimit")).toBe("70.0");
    expect(live.has("List of Server Options")).toBe(false);
  });
});

describe("sameOptionValue", () => {
  it("accepts the forms the game normalises rather than crying wolf", () => {
    // A false failure is the same defect as a false success wearing the other hat. The
    // game reports SpeedLimit, FastForwardMultiplier and the PVP damage modifiers with a
    // decimal, and writes its `;` lists with a trailing separator a user will not retype.
    expect(sameOptionValue("70", "70.0")).toBe(true);
    expect(sameOptionValue("ISEnterVehicle", "ISEnterVehicle;")).toBe(true);
    expect(sameOptionValue("TRUE", "true")).toBe(true);
  });

  it("still reports a genuinely different value as different", () => {
    expect(sameOptionValue("16", "32")).toBe(false);
    expect(sameOptionValue("true", "false")).toBe(false);
    // Not numbers, so no numeric shortcut may make these equal.
    expect(sameOptionValue("Muldraugh, KY", "Riverside, KY")).toBe(false);
  });
});

describe("classifyLiveOptions", () => {
  const live = parseShowOptions(SHOW_OPTIONS);

  it("proves a key the game now reports at the value we wrote", () => {
    expect(classifyLiveOptions({ MaxPlayers: "32" }, live)).toEqual({
      verified: ["MaxPlayers"],
      unverified: [],
      stale: [],
    });
  });

  it("treats a key the game withholds as unverifiable, not as rejected", () => {
    // Measured: the game reports 137 of the file's 144 keys and withholds `Password`,
    // `RCONPassword`, `RCONPort`, `DiscordToken` and the three `Discord*Channel` keys.
    // Calling an absent key "rejected" would invent a failure; calling it verified would
    // invent a success. It is neither.
    const out = classifyLiveOptions({ Password: "hunter2", BadWordReplacement: "x" }, live);
    expect(out.unverified.sort()).toEqual(["BadWordReplacement", "Password"]);
    expect(out.verified).toEqual([]);
    expect(out.stale).toEqual([]);
  });

  it("reports a key the game still shows at the old value as stale", () => {
    expect(classifyLiveOptions({ MaxPlayers: "16" }, live).stale).toEqual(["MaxPlayers"]);
  });
});

const report = (over: Partial<PzIniSaveReport> = {}): PzIniSaveReport => ({
  applied: [],
  ignored: [],
  locked: [],
  restartNeeded: [],
  live: null,
  ...over,
});

describe("describeIniSave", () => {
  it("never claims a save when nothing was written", () => {
    // `applied: []` used to toast a green "Settings saved. Restart Project Zomboid to
    // apply." — the single sentence this whole change exists to remove.
    const { tone, message } = describeIniSave(report({ ignored: ["Maxplayerz"] }));
    expect(tone).toBe("warning");
    expect(message).toMatch(/^Nothing was saved\./);
    expect(message).toContain("Maxplayerz");
    expect(message).not.toMatch(/\bSaved \d/);
  });

  it("names the refused keys next to the ones that landed", () => {
    const { tone, message } = describeIniSave(
      report({
        applied: ["PVP"],
        ignored: ["Maxplayerz"],
        locked: ["Map"],
        live: { reloaded: true, verified: ["PVP"], unverified: [], stale: [] },
      })
    );
    expect(message).toContain("Saved 1 setting.");
    expect(message).toContain("Maxplayerz");
    expect(message).toContain("Map");
    // A partial result is not a clean success, whatever else the sentence says.
    expect(tone).toBe("warning");
  });

  it("says a change is live only when the game confirmed the new value", () => {
    // THE property. "live" / "applied" may appear only when `verified` is non-empty —
    // everything else in this module exists to make that statement checkable.
    const confirmed = describeIniSave(
      report({
        applied: ["MaxPlayers"],
        live: { reloaded: true, verified: ["MaxPlayers"], unverified: [], stale: [] },
      })
    );
    expect(confirmed.tone).toBe("success");
    expect(confirmed.message).toContain("live now");

    for (const live of [
      null,
      { reloaded: false, verified: [], unverified: ["MaxPlayers"], stale: [] },
      { reloaded: true, verified: [], unverified: ["MaxPlayers"], stale: [] },
      { reloaded: true, verified: [], unverified: [], stale: ["MaxPlayers"] },
    ]) {
      const { message } = describeIniSave(report({ applied: ["MaxPlayers"], live }));
      expect(message, JSON.stringify(live)).not.toMatch(/\blive\b/);
      expect(message, JSON.stringify(live)).toContain("Saved 1 setting.");
    }
  });

  it("asks for a restart only for the keys that need one", () => {
    const boot = describeIniSave(
      report({
        applied: ["ResetID", "PVP"],
        restartNeeded: ["ResetID"],
        live: { reloaded: true, verified: ["PVP"], unverified: [], stale: [] },
      })
    );
    expect(boot.message).toContain("ResetID needs a restart");

    const none = describeIniSave(
      report({
        applied: ["MaxPlayers"],
        live: { reloaded: true, verified: ["MaxPlayers"], unverified: [], stale: [] },
      })
    );
    expect(none.message).not.toMatch(/restart/i);
  });

  it("does not read 'nothing reloadable to do' as 'the server is down'", () => {
    // The route skips the RCON round trip when every key it wrote needs a boot anyway, so
    // `live` is null for a reason that says nothing about whether the world is running.
    // Reading it as "not running" would be a confident claim about something never
    // measured — the defect class, inverted.
    const { message } = describeIniSave(
      report({ applied: ["ResetID"], restartNeeded: ["ResetID"], live: null })
    );
    expect(message).toContain("ResetID needs a restart");
    expect(message).not.toMatch(/not running/);
  });

  it("says the file will be read on the next start when RCON did not answer", () => {
    const { tone, message } = describeIniSave(report({ applied: ["PVP"], live: null }));
    expect(tone).toBe("success");
    expect(message).toContain("not running");
    expect(message).toContain("next starts");
  });

  it("asks for a restart when the reload was not acknowledged", () => {
    const { tone, message } = describeIniSave(
      report({
        applied: ["PVP"],
        live: { reloaded: false, verified: [], unverified: ["PVP"], stale: [] },
      })
    );
    expect(tone).toBe("warning");
    expect(message).toMatch(/restart/i);
  });
});
