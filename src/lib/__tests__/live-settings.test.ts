import { parseShowOptions } from "@/lib/zomboid-ini-contract";
import { describe, expect, it } from "vitest";
import {
  NEXT_WORLD_LABEL,
  compareSetting,
  compareSettings,
  gameFromConfigEndpoint,
  isCreationOnly,
  liveSummaryLine,
  parseGamePrefs,
  parseMcDifficulty,
  parseMcMaxPlayers,
  parsePzOptions,
  redactSecretKeys,
  valuesAgree,
  type LiveSettings,
} from "@/lib/live-settings";
import type { GameId } from "@/lib/games";

/**
 * Configured-versus-live, as properties rather than as rendered markup.
 *
 * The feature's whole risk is in one direction: an amber "this isn't what the server is
 * running" chip on a world that is merely **stopped** would be a new false claim, and two
 * of the three worlds are stopped at any moment. So the bulk of what is pinned here is
 * what the comparison must *refuse* to say — a failed probe is `unknown`, a key the game
 * does not report is `unknown`, and a creation-only key is never a disagreement even when
 * a live value for it is sitting right there.
 *
 * Every sample below is real output captured from production on 2026-10-01 (all three
 * containers were up): PZ `showoptions` over RCON, 7DTD `getgamepref` over telnet, and
 * Minecraft `difficulty` / `list` over RCON.
 */

function live(values: Record<string, string>, over: Partial<LiveSettings> = {}): LiveSettings {
  return { game: "zomboid", available: true, values, readAt: 1_700_000_000_000, ...over };
}

const STOPPED: LiveSettings = {
  game: "zomboid",
  available: false,
  reason: "Project Zomboid is stopped, so there is nothing to compare these against.",
  values: {},
  readAt: 1_700_000_000_000,
};

describe("valuesAgree — the coercions, each one measured", () => {
  /**
   * The measured reason this coercion exists. On production 2026-10-01, of the 61 keys
   * present in BOTH `sdtdserver.xml` and `getgamepref`, exactly 11 differed as raw strings
   * and all 11 were this: the XML stores `false`, the game prints `False`. Without the
   * fold, a healthy 7 Days to Die server's settings page opens with eleven amber chips.
   */
  it("folds boolean words case-insensitively, in both directions", () => {
    expect(valuesAgree("false", "False")).toBe(true);
    expect(valuesAgree("true", "True")).toBe(true);
    expect(valuesAgree("True", "true")).toBe(true);
    expect(valuesAgree("false", "True")).toBe(false);
    expect(valuesAgree("true", "False")).toBe(false);
  });

  /**
   * `1` must NOT be a boolean. 7 Days to Die really does ship `GameDifficulty = 1`
   * (captured), and a coercion that read `1` as true would call a numeric setting equal to
   * a boolean one. False agreement is this project's defect class, so an "only usually
   * right" coercion is worse than none.
   */
  it("does not treat 1/0 as booleans", () => {
    expect(valuesAgree("1", "True")).toBe(false);
    expect(valuesAgree("0", "False")).toBe(false);
    expect(valuesAgree("true", "1")).toBe(false);
  });

  it("compares numbers numerically, so 20 == '20' and 40 == '40.0'", () => {
    expect(valuesAgree("20", " 20 ")).toBe(true);
    expect(valuesAgree("40", "40.0")).toBe(true);
    expect(valuesAgree("0.50", "0.5")).toBe(true);
    // Leading zeros agreeing is correct: the live side is the game's own re-serialisation
    // of the value it parsed, so 007 and 7 are the same setting.
    expect(valuesAgree("007", "7")).toBe(true);
    expect(valuesAgree("20", "21")).toBe(false);
  });

  it("keeps strings exact — including case, which only the readers may fold", () => {
    expect(valuesAgree("Yoshling 7DTD", "Yoshling 7DTD")).toBe(true);
    // A renamed server is a real difference; folding case here would hide it.
    expect(valuesAgree("yoshling", "Yoshling")).toBe(false);
    // Not a number by the strict pattern, so compared as text rather than as 26.1.
    expect(valuesAgree("26.1.2", "26.1.20")).toBe(false);
    expect(valuesAgree("", "")).toBe(true);
    expect(valuesAgree("", "s,r,a")).toBe(false);
  });
});

describe("a probe that failed reads as unknown, never as a disagreement", () => {
  it("answers unknown for every key when the game could not be asked", () => {
    for (const name of ["MaxPlayers", "PVP", "SafetySystem"]) {
      const v = compareSetting("zomboid", name, "32", STOPPED);
      expect(v.kind).toBe("unknown");
      if (v.kind === "unknown") {
        expect(v.why).toBe("unreadable");
        // The sentence the server sent, so the page can say *why* rather than "unknown".
        expect(v.reason).toContain("stopped");
      }
    }
  });

  /**
   * The adversarial case, and the reason `available` is a separate field from `values`:
   * an unavailable payload may still carry values (a future caller merging a stale read,
   * a half-parsed reply). Availability wins. Deleting the `!live.available` guard turns
   * this red — verified.
   */
  it("ignores values carried by an unavailable payload", () => {
    const stale = live({ MaxPlayers: "16" }, { available: false, reason: "Couldn't read it." });
    const v = compareSetting("zomboid", "MaxPlayers", "32", stale);
    expect(v.kind).toBe("unknown");
  });

  it("answers unknown when nothing has been read at all", () => {
    const v = compareSetting("minecraft", "difficulty", "hard", null);
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") expect(v.why).toBe("not-read");
  });

  /**
   * Measured absences, per game: `showoptions` returns 137 of the `.ini`'s 144 keys (the 7
   * it omits are `Password`, `RCONPassword`, `RCONPort`, `DiscordToken` and the three
   * Discord channels), and `getgamepref` reports none of `sdtdserver.xml`'s 8 deployment
   * keys. A key the game does not mention cannot be a mismatch.
   */
  it("answers unknown for a key the game does not report", () => {
    const v = compareSetting("zomboid", "DiscordToken", "abc", live({ MaxPlayers: "32" }));
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") expect(v.why).toBe("not-reported");
  });

  it("still says agrees/disagrees when the game did answer", () => {
    const snapshot = live({ MaxPlayers: "32", PVP: "true" });
    expect(compareSetting("zomboid", "MaxPlayers", "32", snapshot).kind).toBe("agrees");
    expect(compareSetting("zomboid", "MaxPlayers", "16", snapshot).kind).toBe("disagrees");
  });
});

describe("creation-only settings are never reported as disagreeing", () => {
  /**
   * These are read when a world is made, so the live value answers a different question
   * from the configured one. `GameWorld`, `GameName` and `ResetID` are all genuinely
   * reported by their games (captured: `GamePref.GameWorld = Reveo Valley`,
   * `GamePref.GameName = Fresh2`, `* ResetID=4389967`) — so the suppression has to be
   * deliberate, not a side effect of the value being unreadable.
   */
  const cases: [GameId, string, string, string][] = [
    ["minecraft", "level-seed", "12345", "98765"],
    ["minecraft", "level-type", "minecraft:flat", "minecraft:normal"],
    ["minecraft", "initial-enabled-packs", "vanilla,bundle", "vanilla"],
    ["minecraft", "initial-disabled-packs", "", "trade_rebalance"],
    ["7dtd", "GameWorld", "Navezgane", "Reveo Valley"],
    ["7dtd", "GameName", "Fresh3", "Fresh2"],
    ["zomboid", "ResetID", "1", "4389967"],
  ];

  for (const [game, key, configured, liveValue] of cases) {
    it(`${game} ${key} — next-world, not disagrees`, () => {
      const v = compareSetting(game, key, configured, live({ [key]: liveValue }, { game }));
      expect(v.kind).toBe("next-world");
    });
  }

  it("matches the key whatever case it is written in", () => {
    expect(isCreationOnly("7dtd", "gameworld")).toBe(true);
    expect(isCreationOnly("7dtd", "GameWorld")).toBe(true);
    // And does not suppress a key that merely starts the same way.
    expect(isCreationOnly("7dtd", "GameWorldLocationType")).toBe(false);
    expect(isCreationOnly("zomboid", "ResetID")).toBe(true);
    expect(isCreationOnly("minecraft", "difficulty")).toBe(false);
  });
});

describe("the summary line states what was NOT compared", () => {
  const props = [
    { name: "MaxPlayers", value: "32" },
    { name: "PVP", value: "true" },
    { name: "DiscordToken", value: "x" }, // not reported by the game
    { name: "ResetID", value: "7" }, // creation-only
  ];

  it("counts agreements, non-reports and next-world keys separately", () => {
    const cmp = compareSettings("zomboid", props, live({ MaxPlayers: "32", PVP: "True" }));
    expect(cmp).toEqual({ disagreeing: [], agreeing: 2, notReported: 1, nextWorld: 1 });
  });

  it("is amber only when something genuinely differs, and names the keys", () => {
    const cmp = compareSettings("zomboid", props, live({ MaxPlayers: "16", PVP: "true" }));
    const line = liveSummaryLine(cmp, live({ MaxPlayers: "16" }));
    expect(line?.tone).toBe("warn");
    expect(line?.text).toContain("MaxPlayers");
  });

  it("is muted — never amber — when the server could not be asked", () => {
    const cmp = compareSettings("zomboid", props, STOPPED);
    expect(cmp.disagreeing).toEqual([]);
    const line = liveSummaryLine(cmp, STOPPED);
    expect(line?.tone).toBe("muted");
    expect(line?.text).toContain("stopped");
  });

  it("says out loud how many settings it could not cover", () => {
    const cmp = compareSettings("zomboid", props, live({ MaxPlayers: "32", PVP: "true" }));
    const line = liveSummaryLine(cmp, live({ MaxPlayers: "32" }));
    // Silence about the gaps is how someone concludes the comparison covers everything.
    expect(line?.text).toContain("doesn't report");
    expect(line?.text).toContain(NEXT_WORLD_LABEL);
  });

  it("shows nothing at all before anything has been read", () => {
    expect(liveSummaryLine(compareSettings("zomboid", props, null), null)).toBeNull();
  });
});

// ── parsers, against real captured output ───────────────────────────────────

/** First six lines of a real `getgamepref` session, echo line included verbatim. */
const SDTD_SAMPLE = [
  "2026-10-01T12:44:47 730.576 INF Executing command 'getgamepref' by Telnet from 172.18.0.1:40616",
  "GamePref.AirDropFrequency = 3",
  "GamePref.AirDropMarker = True",
  "GamePref.GameDifficulty = 1",
  "GamePref.GameWorld = Reveo Valley",
  "GamePref.FavoriteServersList = ",
  "",
].join("\r\n");

describe("parseGamePrefs — 7 Days to Die getgamepref", () => {
  it("takes only GamePref lines, so the telnet echo cannot become a setting", () => {
    const v = parseGamePrefs(SDTD_SAMPLE);
    expect(Object.keys(v).sort()).toEqual([
      "AirDropFrequency",
      "AirDropMarker",
      "FavoriteServersList",
      "GameDifficulty",
      "GameWorld",
    ]);
  });

  it("keeps a value with spaces whole, and keeps an empty value as empty", () => {
    const v = parseGamePrefs(SDTD_SAMPLE);
    expect(v.GameWorld).toBe("Reveo Valley");
    // `GamePref.FavoriteServersList = ` is a real, empty setting. Dropping it would turn
    // "the server runs this empty" into "can't be compared".
    expect(v.FavoriteServersList).toBe("");
  });

  /**
   * The prefix is load-bearing, and this is the measured reason. 7 Days to Die has a
   * second namespace with overlapping names: `getgamestat` answers `GameStat.<Name> =
   * <Value>`, and `GameStat.AirDropFrequency` exists alongside `GamePref.AirDropFrequency`
   * (both captured from production 2026-10-01). A parser that accepted any `X = Y` line
   * would let one telnet session's stats be published as the server's *settings* — the
   * same answer-shaped-like-the-question mistake the RCON off-by-one made.
   */
  it("does not read GameStat lines as settings", () => {
    const mixed = [
      "GamePref.AirDropFrequency = 3",
      "GameStat.AirDropFrequency = 9",
      "GameStat.AnimalCount = 0",
    ].join("\n");
    expect(parseGamePrefs(mixed)).toEqual({ AirDropFrequency: "3" });
  });

  it("reads nothing out of the error 7DTD gives before its world is up", () => {
    const booting =
      "*** ERROR: Command 'getgamepref' can only be executed when a game is started.\r\n";
    expect(parseGamePrefs(booting)).toEqual({});
  });
});

/** A real `showoptions` reply, trimmed to the shapes that matter. */
const PZ_SAMPLE = [
  "List of Server Options:",
  "* AdminSafehouse=false",
  "* AntiCheatHit=4",
  "* FastForwardMultiplier=40.0",
  "* MaxPlayers=32",
  "* SafehouseAllowTrepass=true",
  "* SpawnItems=",
  "* ChatStreams=s,r,a,w,y,sh,f,all",
].join("\n");

describe("parsePzOptions — Project Zomboid showoptions", () => {
  // Pins the single-parser property. `parsePzOptions` used to carry its own copy of the
  // regex that did NOT tolerate a space before the `=`, so one wire format was parsed two
  // ways and the two views could disagree about whether a key existed at all. Mutation-
  // checked: re-inlining the old regex turns this red.
  it("agrees with the contract parser, including the forms only it tolerated", () => {
    const text = [
      "List of Server Options:",
      "* PVP=true",
      "* SpeedLimit =70.0",
      "* ServerWelcomeMessage=hello = world",
      "not a starred line",
    ].join("\n");
    expect(parsePzOptions(text)).toEqual(Object.fromEntries(parseShowOptions(text)));
    // and the space-before-= form is actually read, not merely "read the same way twice"
    expect(parsePzOptions(text).SpeedLimit).toBe("70.0");
  });

  it("skips the header and reads every starred line", () => {
    const v = parsePzOptions(PZ_SAMPLE);
    expect(Object.keys(v)).toHaveLength(7);
    expect(v.MaxPlayers).toBe("32");
    expect(v.SpawnItems).toBe("");
    expect(v.ChatStreams).toBe("s,r,a,w,y,sh,f,all");
  });

  it("splits on the FIRST = so a value may contain one", () => {
    // No production value contains `=` today, so this is a guard rather than a
    // measurement — but `ServerWelcomeMessage` is free text and the ini parser this is
    // compared against (`parseIni`) already splits on the first `=`. The two must agree or
    // one key would silently never match.
    const v = parsePzOptions("* ServerWelcomeMessage=hello a=b <LINE> bye");
    expect(v.ServerWelcomeMessage).toBe("hello a=b <LINE> bye");
  });

  it("reads nothing out of an unrelated RCON reply", () => {
    expect(parsePzOptions("Players connected (0):")).toEqual({});
  });
});

describe("parseMcDifficulty / parseMcMaxPlayers — Minecraft RCON", () => {
  it("lowercases the difficulty the way server.properties spells it", () => {
    // Captured: the file says `difficulty=hard`, the server answers `The difficulty is Hard`.
    expect(parseMcDifficulty("The difficulty is Hard")).toBe("hard");
    expect(valuesAgree("hard", parseMcDifficulty("The difficulty is Hard")!)).toBe(true);
  });

  it("reads the live player cap out of the list reply", () => {
    expect(parseMcMaxPlayers("There are 0 of a max of 20 players online: ")).toBe("20");
    expect(parseMcMaxPlayers("There are 2 of a max of 20 players online: a, b")).toBe("20");
  });

  it("answers null rather than a guess when the reply is not what it expects", () => {
    // null becomes an absent key, which becomes `unknown` — the whole point. A parser that
    // returned "" here would publish "the server runs an empty difficulty".
    expect(parseMcDifficulty("Unknown or incomplete command")).toBeNull();
    expect(parseMcMaxPlayers("Unknown or incomplete command")).toBeNull();
  });
});

describe("redactSecretKeys", () => {
  it("drops secret-named keys", () => {
    const v = redactSecretKeys({ ServerPassword: "hunter2", DiscordToken: "t", MaxPlayers: "32" });
    expect(v).toEqual({ MaxPlayers: "32" });
  });

  /**
   * The trap this regex is written around. `SafehouseAllowTrepass` is a real PZ setting;
   * a `/pass/i` filter would delete it from the comparison and the field would show a
   * permanent "not reported" about a key the server reports fine.
   */
  it("keeps SafehouseAllowTrepass", () => {
    expect(redactSecretKeys({ SafehouseAllowTrepass: "true" })).toEqual({
      SafehouseAllowTrepass: "true",
    });
  });
});

describe("gameFromConfigEndpoint", () => {
  it("maps each game's settings endpoint to its game", () => {
    expect(gameFromConfigEndpoint("/api/7dtd/config/all")).toBe("7dtd");
    expect(gameFromConfigEndpoint("/api/zomboid/config")).toBe("zomboid");
    expect(gameFromConfigEndpoint("/api/server/properties")).toBe("minecraft");
  });

  /**
   * Null, not a default. A verdict computed against the wrong game's live values would be
   * a confident wrong answer — the exact failure this feature exists to remove — so an
   * unrecognised endpoint turns the comparison off instead.
   */
  it("answers null for anything it does not recognise", () => {
    expect(gameFromConfigEndpoint("/api/games/status")).toBeNull();
    expect(gameFromConfigEndpoint("")).toBeNull();
  });
});

describe("end to end against the measured production state", () => {
  /**
   * The 11 real boolean-case differences, and the agreement that follows from them. These
   * are verbatim pairs from 2026-10-01: `sdtdserver.xml` on the left, `getgamepref` on the
   * right. All 61 comparable keys agreed once case was folded, so the resting state of the
   * 7DTD panel must be "nothing differs".
   */
  const SDTD_PAIRS: [string, string, string][] = [
    ["WebDashboardEnabled", "false", "False"],
    ["EnableMapRendering", "false", "False"],
    ["TerminalWindowEnabled", "true", "True"],
    ["ServerAllowCrossplay", "false", "False"],
    ["EACEnabled", "true", "True"],
    ["IgnoreEOSSanctions", "false", "False"],
    ["PersistentPlayerProfiles", "false", "False"],
    ["BuildCreate", "false", "False"],
    ["DynamicMeshEnabled", "true", "True"],
    ["DynamicMeshLandClaimOnly", "true", "True"],
    ["TwitchBloodMoonAllowed", "false", "False"],
    ["ServerMaxPlayerCount", "8", "8"],
    ["GameDifficulty", "1", "1"],
    ["ServerName", "Yoshling 7DTD", "Yoshling 7DTD"],
  ];

  it("reports zero disagreements for the config that was on the box", () => {
    const props = SDTD_PAIRS.map(([name, configured]) => ({ name, value: configured }));
    const snapshot = live(
      Object.fromEntries(SDTD_PAIRS.map(([name, , liveValue]) => [name, liveValue])),
      { game: "7dtd" }
    );
    const cmp = compareSettings("7dtd", props, snapshot);
    expect(cmp.disagreeing).toEqual([]);
    expect(cmp.agreeing).toBe(SDTD_PAIRS.length);
  });

  it("reports exactly the one key that drifts, when one does", () => {
    const props = SDTD_PAIRS.map(([name, configured]) => ({ name, value: configured }));
    const values = Object.fromEntries(SDTD_PAIRS.map(([name, , l]) => [name, l]));
    // The case the feature exists for: the file was edited, the server never restarted.
    values.ServerMaxPlayerCount = "8";
    props.find((p) => p.name === "ServerMaxPlayerCount")!.value = "16";
    const cmp = compareSettings("7dtd", props, live(values, { game: "7dtd" }));
    expect(cmp.disagreeing).toEqual(["ServerMaxPlayerCount"]);
  });
});

describe("the PZ sandbox is never compared against the .ini", () => {
  // The blocker found in integration: two correct branches merged cleanly and wired the
  // configured-vs-live comparison onto Project Zomboid's sandbox panels, which compared
  // `SandboxVars.lua` against the `.ini`'s `showoptions`. 737 of 742 options rendered a
  // false "not reported" chip, and `BloodSplatLifespanDays` — present in both files — showed
  // a permanent amber disagreement nothing could clear.
  it("returns null for the sandbox endpoint, at every scope", () => {
    expect(gameFromConfigEndpoint("/api/zomboid/sandbox")).toBeNull();
    expect(gameFromConfigEndpoint("/api/zomboid/sandbox?scope=world")).toBeNull();
    expect(gameFromConfigEndpoint("/api/zomboid/sandbox?scope=mods")).toBeNull();
  });

  it("still infers zomboid for the .ini endpoints it should compare", () => {
    // The opt-out must be narrow: the `.ini` really is reported by `showoptions`.
    expect(gameFromConfigEndpoint("/api/zomboid/config")).toBe("zomboid");
    expect(gameFromConfigEndpoint("/api/zomboid/config/import")).toBe("zomboid");
  });
});
