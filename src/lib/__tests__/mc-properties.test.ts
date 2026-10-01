import { describe, it, expect } from "vitest";
import {
  MC_GAME_RULE_REPLACEMENTS,
  MC_INERT_HERE,
  MC_LOCKED_KEYS,
  MC_OTHER_GROUP,
  MC_PROPERTIES_VERIFIED_FOR,
  MC_PROPERTY_GROUPS,
  MC_SELECTS,
  MC_TEXT_KEYS,
  escapeMcValue,
  gameRuleReplacing,
  groupMcProperties,
  isLockedMcProperty,
  mcCouplingNote,
  mcSelectOptions,
  movedToGameRules,
  unescapeMcValue,
} from "../mc-properties";

/**
 * The keys of the **live** `server.properties`, read off the box on 2026-10-01 with
 * `grep = /data/server.properties | cut -d= -f1 | sort` against the 26.1.2 server
 * (`rcon-cli version` → `id = 26.1.2  data = 4790`). 71 of them.
 *
 * It is here as the oracle for "does this table talk about keys that exist", which is the
 * one way a static annotation table rots silently: a mistyped key annotates nothing, looks
 * fine in review, and the setting it was supposed to warn about renders bare.
 *
 * Values are deliberately absent. The file holds `rcon.password` and a 40-character
 * `management-server-secret`, and a test fixture is the last place either should live.
 */
const LIVE_KEYS = [
  "accepts-transfers", "allow-flight", "allow-nether", "broadcast-console-to-ops",
  "broadcast-rcon-to-ops", "bug-report-link", "difficulty", "enable-code-of-conduct",
  "enable-command-block", "enable-jmx-monitoring", "enable-query", "enable-rcon",
  "enable-status", "enforce-secure-profile", "enforce-whitelist",
  "entity-broadcast-range-percentage", "force-gamemode", "function-permission-level",
  "gamemode", "generate-structures", "generator-settings", "hardcore",
  "hide-online-players", "initial-disabled-packs", "initial-enabled-packs", "level-name",
  "level-seed", "level-type", "log-ips", "management-server-allowed-origins",
  "management-server-enabled", "management-server-host", "management-server-port",
  "management-server-secret", "management-server-tls-enabled",
  "management-server-tls-keystore", "management-server-tls-keystore-password",
  "max-chained-neighbor-updates", "max-players", "max-tick-time", "max-world-size", "motd",
  "network-compression-threshold", "online-mode", "op-permission-level",
  "pause-when-empty-seconds", "player-idle-timeout", "prevent-proxy-connections", "pvp",
  "query.port", "rate-limit", "rcon.password", "rcon.port", "region-file-compression",
  "require-resource-pack", "resource-pack", "resource-pack-id", "resource-pack-prompt",
  "resource-pack-sha1", "server-ip", "server-port", "simulation-distance",
  "spawn-monsters", "spawn-protection", "status-heartbeat-interval", "sync-chunk-writes",
  "text-filtering-config", "text-filtering-version", "use-native-transport",
  "view-distance", "white-list",
];

const visible = LIVE_KEYS.filter((k) => !isLockedMcProperty(k));

describe("what the properties editor withholds", () => {
  /**
   * The property: **nothing the dashboard needs in order to reach the game is editable
   * here, and nothing credential-shaped is readable here.**
   *
   * Spelled out per key rather than iterating `MC_LOCKED_KEYS`, because iterating the
   * table would assert only that the table equals itself. `server-ip` is the key this
   * test was written for: it was *not* locked, and the audit demonstrated destructively
   * that setting it to 127.0.0.1 takes down both the published game port and the
   * dashboard's own RCON — which is the recovery route. This assertion fails on the code
   * as it shipped.
   */
  it("withholds every key that decides how the dashboard reaches Minecraft", () => {
    for (const key of ["server-ip", "server-port", "rcon.port", "rcon.password", "enable-rcon"]) {
      expect(isLockedMcProperty(key), key).toBe(true);
    }
  });

  it("withholds Minecraft 26's management-server block, including by shape", () => {
    for (const key of LIVE_KEYS.filter((k) => k.startsWith("management-server-"))) {
      expect(isLockedMcProperty(key), key).toBe(true);
    }
    // The shape rule, not the name list: a credential key added by a future version is
    // hidden the day it appears rather than the day somebody notices it on screen.
    expect(isLockedMcProperty("some-future-api-token")).toBe(true);
  });

  it("leaves no credential-shaped key visible, and hides nothing else", () => {
    for (const key of visible) {
      expect(/password|secret|token/.test(key), key).toBe(false);
    }
    // The counter-property: over-hiding is also a failure. `enforce-secure-profile` is the
    // near-miss ("secure", not "secret") and an unknown key must stay visible, or the
    // editor silently shrinks every time Minecraft adds a setting.
    expect(isLockedMcProperty("enforce-secure-profile")).toBe(false);
    expect(isLockedMcProperty("some-new-26-2-setting")).toBe(false);
    // 71 keys on disk, 14 withheld (6 named + 8 management-server-*), 57 shown.
    expect(visible.length).toBe(57);
    expect(MC_LOCKED_KEYS.length).toBe(6);
  });
});

describe("java.util.Properties escaping", () => {
  /**
   * The bug: the file holds `level-type=minecraft\:normal` — written by the server, because
   * `Properties.store` escapes `:` — and the dropdown offered `minecraft:normal`, so the
   * select never matched its own value and rendered empty on every load.
   *
   * The property is the round trip, stated over the dropdown's own options: whatever the
   * file can hold must compare equal to an option after unescaping. Fails before the fix,
   * where the GET returned the raw escaped string.
   */
  it("makes every level-type option match the form the file holds", () => {
    for (const option of MC_SELECTS["level-type"]) {
      const onDisk = escapeMcValue(option); // what Properties.store would write
      expect(onDisk).toContain("\\:");
      expect(MC_SELECTS["level-type"]).toContain(unescapeMcValue(onDisk));
    }
    // The measured byte sequence from the live file, not a reconstruction.
    expect(unescapeMcValue("minecraft\\:normal")).toBe("minecraft:normal");
  });

  it("round-trips, and escapes idempotently", () => {
    // Idempotence is load-bearing: the page re-sends values it received from the GET, so a
    // second escape of an already-escaped value would write `minecraft\\:normal` and the
    // server would read a literal backslash.
    for (const v of ["minecraft:normal", "https://example.test/pack.zip", "plain", ""]) {
      expect(unescapeMcValue(escapeMcValue(v))).toBe(v);
      expect(escapeMcValue(escapeMcValue(v))).toBe(escapeMcValue(v));
    }
  });

  it("leaves values without a colon byte-identical", () => {
    // The deliberate limit of the implementation: only `:` is handled, so every other key
    // keeps exactly today's behaviour and no value can be mangled by a half-symmetric
    // unescape/escape pair.
    const motd = "A Minecraft Server";
    expect(escapeMcValue(motd)).toBe(motd);
    expect(unescapeMcValue("a\\uXXXX")).toBe("a\\uXXXX");
  });
});

describe("properties this Minecraft version does not read", () => {
  /**
   * The property: on a version that moved these four into game rules, the route must
   * refuse them and be able to name the rule — and on a version that still reads them it
   * must not. Measured against 26.1.2: the property-name literals are absent from every
   * class in the server jar while present in 1.21.4's, the four game rules answer over
   * RCON, and production already disagrees with itself
   * (`enable-command-block=false` in the file, `command_blocks_work = true` in the world).
   *
   * Before the fix there was no such concept: the PUT wrote all four and answered
   * `{success:true}`.
   */
  it("names the game rule that replaced each key on 26.x", () => {
    expect(gameRuleReplacing("pvp", "26.1.2")).toBe("pvp");
    expect(gameRuleReplacing("spawn-monsters", "26.1.2")).toBe("spawn_monsters");
    expect(gameRuleReplacing("enable-command-block", "26.1.2")).toBe("command_blocks_work");
    expect(gameRuleReplacing("allow-nether", "26.1.2")).toBe("allow_entering_nether_using_portals");
    // Not a blanket refusal — a key 26.1.2 does read is unaffected.
    expect(gameRuleReplacing("difficulty", "26.1.2")).toBe(null);
  });

  it("still writes them on 1.x, where the server does read them", () => {
    // 1.21.4 is still on the volume (`/data/versions/1.21.4/server-1.21.4.jar`) and still
    // selectable in the dropdown, and its DedicatedServerProperties holds all four
    // literals. Refusing them there would be the same lie with the sign flipped.
    expect(movedToGameRules("1.21.4")).toBe(false);
    for (const key of Object.keys(MC_GAME_RULE_REPLACEMENTS)) {
      expect(gameRuleReplacing(key, "1.21.4"), key).toBe(null);
    }
  });

  it("answers 'unknown' rather than guessing for a version it cannot parse", () => {
    // Three-state on purpose: null annotates nothing and writes the key, which is exactly
    // the old behaviour, so an unparseable version can never be the reason a save is
    // refused.
    expect(movedToGameRules(null)).toBe(null);
    expect(movedToGameRules("")).toBe(null);
    expect(movedToGameRules("snapshot-weird")).toBe(null);
    expect(gameRuleReplacing("pvp", "snapshot-weird")).toBe(null);
  });

  it("is stamped with the build it was measured against", () => {
    // The stamp is the anti-rot device for the whole table: it tells the next version bump
    // to re-measure instead of to trust. If this is still 26.1.2 when the server is not,
    // the table is a claim about a build nobody is running.
    expect(MC_PROPERTIES_VERIFIED_FOR).toBe("26.1.2");
    expect(movedToGameRules(MC_PROPERTIES_VERIFIED_FOR)).toBe(true);
  });
});

describe("couplings, evaluated against the file rather than asserted", () => {
  /**
   * The property: a switch that cannot do anything because its partner is off says so,
   * and stops saying so the moment the partner is set. A function rather than a sentence in
   * a table is what makes the second half true.
   */
  it("explains require-resource-pack only while no pack is set", () => {
    expect(mcCouplingNote("require-resource-pack", { "resource-pack": "" })).toMatch(/no resource pack/i);
    expect(mcCouplingNote("require-resource-pack", { "resource-pack": "   " })).not.toBe(null);
    expect(mcCouplingNote("require-resource-pack", { "resource-pack": "https://x.test/p.zip" })).toBe(null);
  });

  it("explains enforce-whitelist only while the whitelist is off", () => {
    expect(mcCouplingNote("enforce-whitelist", { "white-list": "false" })).toMatch(/whitelist is off/i);
    expect(mcCouplingNote("enforce-whitelist", { "white-list": "true" })).toBe(null);
  });

  it("says nothing about a key it has no opinion on", () => {
    expect(mcCouplingNote("difficulty", { difficulty: "hard" })).toBe(null);
  });
});

describe("the annotation tables talk about keys that exist", () => {
  /**
   * The property that keeps a static table honest: every key it annotates is a key the
   * editor actually renders. A typo here is invisible — the note simply never appears —
   * which is the quiet form of "reports success after doing nothing".
   */
  it("annotates only keys present in the live file", () => {
    const annotated = [
      ...Object.keys(MC_GAME_RULE_REPLACEMENTS),
      ...Object.keys(MC_INERT_HERE),
      ...Object.keys(MC_SELECTS),
      ...MC_TEXT_KEYS,
      ...MC_PROPERTY_GROUPS.flatMap((g) => g.keys),
    ];
    for (const key of annotated) {
      expect(LIVE_KEYS, key).toContain(key);
    }
  });

  it("annotates nothing the editor withholds", () => {
    // A note on a locked key is dead weight that reads as coverage.
    const annotated = [
      ...Object.keys(MC_GAME_RULE_REPLACEMENTS),
      ...Object.keys(MC_INERT_HERE),
      ...Object.keys(MC_SELECTS),
      ...MC_PROPERTY_GROUPS.flatMap((g) => g.keys),
    ];
    for (const key of annotated) {
      expect(isLockedMcProperty(key), key).toBe(false);
    }
  });

  it("files each key under exactly one group", () => {
    const seen = new Set<string>();
    for (const group of MC_PROPERTY_GROUPS) {
      for (const key of group.keys) {
        expect(seen.has(key), `${key} appears in two groups`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("grouping the editor's fields", () => {
  it("loses no key, and puts an unrecognised one in Other", () => {
    // The property is losslessness. A grouped renderer that drops a key it has not heard of
    // is strictly worse than the flat alphabetical grid it replaced: the setting is simply
    // not on the page, and nothing says so.
    const props = Object.fromEntries([...visible, "brand-new-26-2-key"].map((k) => [k, "x"]));
    const groups = groupMcProperties(props);
    const rendered = groups.flatMap((g) => g.keys);
    expect([...rendered].sort()).toEqual(Object.keys(props).sort());
    expect(groups.find((g) => g.title === MC_OTHER_GROUP)?.keys).toEqual(["brand-new-26-2-key"]);
  });

  it("emits no empty heading", () => {
    const groups = groupMcProperties({ difficulty: "hard" });
    expect(groups).toHaveLength(1);
    expect(groups[0].keys).toEqual(["difficulty"]);
  });

  it("has a home for every key of the file it was built against", () => {
    // Stamped to 26.1.2 along with the rest of the table. If a version bump adds keys they
    // land in "Other" and this goes red, which is the prompt to file them — it is not a
    // claim that the grouping is the only correct one.
    const groups = groupMcProperties(Object.fromEntries(visible.map((k) => [k, "x"])));
    expect(groups.find((g) => g.title === MC_OTHER_GROUP)).toBeUndefined();
  });
});

describe("field types", () => {
  it("offers only values 26.1.2 accepts for region-file-compression", () => {
    // Read out of 26.1.2's RegionFileVersion.class, which holds exactly these three option
    // names next to the message it logs for anything else ("Invalid
    // `region-file-compression` value `{}` … Please use one of: {}"). It was a free-text
    // box, where `delfate` is a typo the server rejects at load with nothing in the UI to
    // explain why.
    expect(MC_SELECTS["region-file-compression"].sort()).toEqual(["deflate", "lz4", "none"]);
  });

  it("never renders a dropdown that cannot show its own value", () => {
    /**
     * The same failure as the escaped colon, one level up: a value outside the option list
     * renders as an empty select, which reads as "unset" and is one click from silently
     * replacing a setting nobody chose. A mod or datapack can register its own level type,
     * so the list cannot be assumed complete.
     */
    expect(mcSelectOptions("level-type", "mymod:void")).toEqual([
      "mymod:void",
      ...MC_SELECTS["level-type"],
    ]);
    // A known value adds nothing, and an empty one is not offered as a choice.
    expect(mcSelectOptions("level-type", "minecraft:flat")).toEqual(MC_SELECTS["level-type"]);
    expect(mcSelectOptions("difficulty", "")).toEqual(MC_SELECTS["difficulty"]);
    // Every dropdown, for every value the live file could hold after unescaping, offers it.
    for (const [key, options] of Object.entries(MC_SELECTS)) {
      for (const option of options) {
        expect(mcSelectOptions(key, unescapeMcValue(escapeMcValue(option)))).toContain(option);
      }
    }
  });

  it("keeps level-seed free text", () => {
    // A seed may be negative or a word, and `type="number"` rejects both while offering a
    // spinner that can nudge a 19-digit seed by one.
    expect(MC_TEXT_KEYS.has("level-seed")).toBe(true);
  });
});
