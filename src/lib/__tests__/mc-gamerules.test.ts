import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  MC_GAME_RULES,
  MC_GAME_RULE_GROUPS,
  MC_GAME_RULE_LIST_COMMAND,
  MC_GAME_RULE_OTHER_GROUP,
  MIN_PLAUSIBLE_GAME_RULES,
  assessGameRuleList,
  canonicalGameRuleId,
  checkGameRuleValue,
  countGameRuleMentions,
  doStrippedGameRuleId,
  gameRuleCommand,
  gameRuleControlHint,
  gameRuleInputMode,
  gameRuleLabel,
  gameRuleMeta,
  groupGameRules,
  inferGameRuleType,
  isDefaultGameRuleValue,
  parseGameRuleList,
  parseGameRuleReply,
} from "../mc-gamerules";
import { MC_GAME_RULE_REPLACEMENTS, MC_PROPERTIES_VERIFIED_FOR } from "../mc-properties";

/**
 * Small hand-written replies, for the per-case assertions that would be unreadable against
 * 5 KB of real output.
 *
 * **These are newline-separated and the real reply is not.** That sentence used to read "one
 * line per child of the `gamerule` node", stated as fact, and it is the false claim that cost
 * the most in this feature: the parser was written to split on `\n`, these fixtures agreed
 * with it, and it returned **one** id from the deployed server's 58-rule reply while a
 * 580-line suite stayed green. The real thing is in
 * `describe("the help gamerule reply this server actually sends")` below — read that first,
 * and treat these as what they are, convenient shapes the parser also has to tolerate.
 *
 * Written in **26.1 snake_case**, because that is what the deployed build answers — the
 * measurement is in `mc-properties.ts`: `keepInventory` and `doDaylightCycle` both reply
 * `Incorrect argument` on 26.1.2, while `pvp`, `spawn_monsters`, `command_blocks_work` and
 * `allow_entering_nether_using_portals` answer. The camelCase fixture below is the 1.21.4
 * build that is still on the volume and still selectable in the version dropdown, so both
 * spellings have to work and neither is "the" format.
 */
const HELP_26 = [
  "/gamerule allow_entering_nether_using_portals [<value>]",
  "/gamerule command_blocks_work [<value>]",
  "/gamerule keep_inventory [<value>]",
  "/gamerule mob_griefing [<value>]",
  "/gamerule pvp [<value>]",
  "/gamerule random_tick_speed [<value>]",
  "/gamerule spawn_monsters [<value>]",
].join("\n");

const HELP_1_21 = [
  "/gamerule announceAdvancements [<value>]",
  "/gamerule doFireTick [<value>]",
  "/gamerule keepInventory [<value>]",
  "/gamerule mobGriefing [<value>]",
  "/gamerule randomTickSpeed [<value>]",
].join("\n");

describe("discovering which rules this build has", () => {
  /**
   * The property: the ids come from the server, so the panel is correct on a build nobody
   * anticipated.
   *
   * This is the reason the module has no hardcoded id list. 26.1 renamed every game rule and
   * the rename is not mechanical — `enable-command-block` became `command_blocks_work` — so
   * a hardcoded list would be right for at most one of the two builds installed on this box
   * and would fail by querying rules that do not exist, rendering an empty panel that looks
   * like "nothing to show".
   */
  it("reads the ids out of a 26.1 help reply, in the server's order", () => {
    expect(parseGameRuleList(HELP_26)).toEqual([
      "allow_entering_nether_using_portals",
      "command_blocks_work",
      "keep_inventory",
      "mob_griefing",
      "pvp",
      "random_tick_speed",
      "spawn_monsters",
    ]);
  });

  it("reads camelCase ids the same way, so 1.21.4 still works", () => {
    expect(parseGameRuleList(HELP_1_21)).toEqual([
      "announceAdvancements",
      "doFireTick",
      "keepInventory",
      "mobGriefing",
      "randomTickSpeed",
    ]);
  });

  it("skips anything that is not a rule rather than guessing at it", () => {
    /**
     * The one rule this parser follows, and the reason it matters twice over. Correctness: a
     * fabricated id would be queried, answered `Incorrect argument`, and reported as a rule
     * that could not be read — noise invented by the parser. Safety: the token is pasted
     * straight into an RCON command, so a pattern that admitted spaces or semicolons would
     * let one command become two.
     */
    const noise = [
      "Unknown or incomplete command, see below for error",
      "/gamerule <rule>", // a placeholder, not a rule
      "/gamerule [<value>]",
      "/gamerule 9lives [<value>]", // must start with a letter
      "/gamerule bad-id [<value>]", // punctuation is not in the charset
      "/gamerule evil; op mallory", // the injection shape
      "/gamerules notACommand",
      "gamerule", // no id at all
      "",
    ].join("\n");
    expect(parseGameRuleList(noise)).toEqual([]);
  });

  it("accepts a line with or without the leading slash, and drops duplicates", () => {
    expect(parseGameRuleList("gamerule pvp [<value>]\n/gamerule pvp [<value>]")).toEqual(["pvp"]);
    // Trailing whitespace and \r\n, because the reply arrives off a socket.
    expect(parseGameRuleList("  /gamerule pvp [<value>]  \r\n/gamerule mob_griefing\r\n")).toEqual([
      "pvp",
      "mob_griefing",
    ]);
  });

  it("names the command it parses, so the route and this test cannot disagree", () => {
    expect(MC_GAME_RULE_LIST_COMMAND).toBe("help gamerule");
  });

  it("strips the minecraft: namespace and collapses the two spellings into one rule", () => {
    // Brigadier lists every rule twice, bare and namespaced. Without stripping, the panel
    // shows 116 rows for 58 rules and queries each one twice.
    expect(
      parseGameRuleList("/gamerule fall_damage [<value>]/gamerule minecraft:fall_damage [<value>]")
    ).toEqual(["fall_damage"]);
    // The namespaced form alone still yields the writable id.
    expect(parseGameRuleList("/gamerule minecraft:pvp [<value>]")).toEqual(["pvp"]);
  });

  it("skips a foreign namespace rather than inventing a bare id for it", () => {
    // `mypack:custom` needs a `:` that `gameRuleCommand`'s charset forbids, and whether
    // brigadier would answer the bare `custom` is not something this repo has measured. The
    // parser's one rule applies: skip, do not guess. It must NOT yield "mypack".
    expect(parseGameRuleList("/gamerule mypack:custom_rule [<value>]")).toEqual([]);
  });
});

/**
 * ## The real reply, from the deployed server
 *
 * `fixtures/mc-help-gamerule.txt` is `help gamerule` as 26.1.2 actually answered it, captured
 * from production on 2026-10-01. It is the strongest test available here and it exists because
 * the hand-written fixtures above — plausible, newline-separated, and wrong about the one
 * property that mattered — let a parser that returned **one** id from a 58-rule reply pass a
 * 580-line suite.
 *
 * Two facts about it that no invented fixture had:
 *
 * - **zero newline characters.** `RconConsoleSource.sendSystemMessage` appends each feedback
 *   message to one buffer with no separator, so the whole thing is one run-together string.
 *   The parser split on `\n`, found one "line", and matched the first mention on it.
 * - **5,082 bytes**, which is past the 4096 one RCON packet carries, so the discovery read
 *   has to go through `sendCommandLong`. Through `sendCommand` the reply arrived cut at
 *   exactly 4096 — two compounding bugs, each sufficient on its own to make the panel lie.
 */
describe("the help gamerule reply this server actually sends", () => {
  const FIXTURE = readFileSync(
    path.join(__dirname, "fixtures", "mc-help-gamerule.txt"),
    "utf-8"
  );

  it("is one run-together string with no newlines, and bigger than one RCON packet", () => {
    // The two properties the parser and the transport each have to survive. Asserted on the
    // fixture itself so a future edit to it cannot quietly remove the thing it is here for.
    expect(FIXTURE).not.toContain("\n");
    expect(FIXTURE.length).toBe(5082);
    expect(FIXTURE.length).toBeGreaterThan(4096);
  });

  it("yields 58 rules", () => {
    const ids = parseGameRuleList(FIXTURE);
    expect(ids).toHaveLength(58);
    // Not just the count: a parser that returned 58 of the wrong thing would pass that alone.
    expect(new Set(ids).size).toBe(58);
    expect(ids[0]).toBe("immediate_respawn");
    expect(ids).toContain("fall_damage");
    expect(ids).toContain("allow_entering_nether_using_portals");
    expect(ids).toContain("universal_anger");
    expect(ids).toContain("water_source_conversion");
    expect(ids).toContain("advance_time");
    // snake_case on this build, and no namespaced duplicate survived the de-dup.
    expect(ids.some((id) => id.includes(":"))).toBe(false);
    expect(ids.filter((id) => id === "fall_damage")).toHaveLength(1);
  });

  it("every id it yields is safe to interpolate into an RCON command", () => {
    // The whole write path's injection guard is "the id came from the server's own list", so
    // the list had better not contain anything `gameRuleCommand` would refuse.
    for (const id of parseGameRuleList(FIXTURE)) {
      expect(() => gameRuleCommand(id), id).not.toThrow();
      expect(gameRuleCommand(id, "true"), id).toBe(`gamerule ${id} true`);
    }
  });

  /**
   * How much of the live build the help table can actually describe — a **measurement**, not
   * a target.
   *
   * The 26.1 rename was not mechanical, so a third of the live ids have no entry:
   * `advance_time` is not reachable from `doDaylightCycle` by any canonical form, nor
   * `spawn_mobs` from `doMobSpawning`, nor `raids` from `disableRaids` (which is also
   * inverted). Those rows still render — grouped under "Other", with their live value and no
   * help, because annotation here is additive and never a filter.
   *
   * Pinned so the number is visible rather than silent, and so a change that breaks canonical
   * matching shows up as "described dropped below 34" instead of as a quietly emptier panel. The
   * bound is one-sided on purpose: adding entries should not fail a test.
   */
  it("describes 34 of the 58, and the rest still render under Other", () => {
    const ids = parseGameRuleList(FIXTURE);
    const described = ids.filter((id) => gameRuleMeta(id) !== null);
    expect(described.length).toBeGreaterThanOrEqual(34);
    // Nothing is lost: every live id lands in exactly one group.
    const grouped = groupGameRules(ids).flatMap((g) => g.ids);
    expect(grouped.sort()).toEqual([...ids].sort());
    const other = groupGameRules(ids).find((g) => g.title === MC_GAME_RULE_OTHER_GROUP);
    expect(other?.ids.length).toBe(ids.length - described.length);
  });

  it("counts the 116 mentions behind those 58 rules", () => {
    // Each rule twice, bare and namespaced. This is the denominator the shortfall check uses,
    // and it is what makes "we read 1 of these" demonstrably a parser failure.
    expect(countGameRuleMentions(FIXTURE)).toBe(116);
  });

  it("passes the plausibility floor with no warning", () => {
    expect(assessGameRuleList(parseGameRuleList(FIXTURE), FIXTURE)).toEqual({
      ok: true,
      warning: null,
    });
  });

  /**
   * What the broken parser did, pinned.
   *
   * Splitting on newlines over a reply with none leaves one "line" and matches its first
   * mention: exactly one id. The route then answered 200 with it. This asserts the shortfall
   * check catches that, which is the half of the fix that stops a future regression being
   * silent rather than merely wrong.
   */
  it("refuses the one-rule read the newline split produced, naming what it read", () => {
    const verdict = assessGameRuleList(["immediate_respawn"], FIXTURE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toContain("Read 1 game rule");
    expect(verdict.error).toContain("5082-character");
    expect(verdict.error).toContain("116 times");
    // It must not name a cause it has not established.
    expect(verdict.error).not.toMatch(/no game rules|renamed/i);
  });

  it("warns rather than passing silently when the reply landed on exactly one packet", () => {
    // A `help gamerule` truncated at 4096 still parses to ~46 ids, which clears the floor —
    // so without this the panel would be quietly missing a dozen rules. 4096 is not a length
    // a server produces by coincidence.
    const cut = FIXTURE.slice(0, 4096);
    const verdict = assessGameRuleList(parseGameRuleList(cut), cut);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.warning).toContain("4096");
    expect(verdict.warning).toMatch(/cut off/);
  });
});

describe("the floor a rule list has to clear", () => {
  /** A plausible list, so the floor can be tested without the fixture's own length. */
  const plausible = (n: number) =>
    Array.from({ length: n }, (_, i) => `/gamerule rule_${i} [<value>]`).join("");

  it("refuses a list shorter than any real build's", () => {
    for (const n of [0, 1, 5, MIN_PLAUSIBLE_GAME_RULES - 1]) {
      const reply = plausible(n);
      expect(assessGameRuleList(parseGameRuleList(reply), reply).ok, `${n} rules`).toBe(false);
    }
  });

  it("accepts a list at the floor, so an unseen build is not refused for being small", () => {
    const reply = plausible(MIN_PLAUSIBLE_GAME_RULES);
    expect(assessGameRuleList(parseGameRuleList(reply), reply)).toEqual({
      ok: true,
      warning: null,
    });
  });

  it("stays well under both builds this box has, so neither trips it", () => {
    // 58 on 26.1.2 (measured) and ~48 on 1.21.4. A floor anywhere near those would make the
    // next version bump look like a fault.
    expect(MIN_PLAUSIBLE_GAME_RULES).toBeLessThan(40);
  });

  it("says nothing about a cause when the reply is empty", () => {
    const verdict = assessGameRuleList([], "");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error).toContain("Read 0 game rules");
    expect(verdict.error).not.toMatch(/powered off|renamed|no game rules on/i);
  });
});

describe("reading the game's answer about one rule", () => {
  /**
   * The property: a value is only ever reported when the game said it in so many words.
   *
   * Both vanilla forms are accepted — `commands.gamerule.query` ("is currently set to") and
   * `commands.gamerule.set` ("is now set to") — because the write path reads the set reply
   * *and* re-queries, and a parser that knew only one of them would make half of that
   * evidence unreadable. The measured query string is in `mc-properties.ts`:
   * `Gamerule pvp is currently set to: true`.
   */
  it("parses the query form measured on 26.1.2", () => {
    expect(parseGameRuleReply("Gamerule pvp is currently set to: true")).toEqual({
      id: "pvp",
      value: "true",
    });
  });

  it("parses the write form", () => {
    expect(parseGameRuleReply("Gamerule mob_griefing is now set to: false")).toEqual({
      id: "mob_griefing",
      value: "false",
    });
  });

  it("parses an int value and a camelCase id", () => {
    expect(parseGameRuleReply("Gamerule randomTickSpeed is currently set to: 3")).toEqual({
      id: "randomTickSpeed",
      value: "3",
    });
  });

  it("returns null for every reply that is not an answer", () => {
    /**
     * Load-bearing, not politeness. A rule this build does not have answers `Incorrect
     * argument for command`; anything that coerced that into a value would invent a setting
     * and render a switch in a position the world is not in. The route reports such a rule as
     * unread instead.
     */
    for (const reply of [
      "Incorrect argument for command at position 9: gamerule <--[HERE]",
      "Unknown or incomplete command, see below for error",
      "",
      "Gamerule pvp is set to: true", // neither "currently" nor "now"
      "gamerule pvp is currently set to: true", // the game capitalises it
      "Gamerule pvp currently set to: true",
    ]) {
      expect(parseGameRuleReply(reply), JSON.stringify(reply)).toBe(null);
    }
  });

  it("finds the answer among other lines, and trims the value", () => {
    // RCON concatenates the command's feedback messages with newlines, so the answer is not
    // guaranteed to be the only line.
    expect(
      parseGameRuleReply("Some other broadcast\nGamerule pvp is currently set to: false  ")
    ).toEqual({ id: "pvp", value: "false" });
  });
});

describe("joining a discovered id to what this module knows about it", () => {
  /**
   * The property this whole module turns on: **one table entry covers both spellings of the
   * 26.1 rename**, so the panel keeps its help text on either build without the table
   * guessing which one is booted.
   */
  it("finds the same entry for the camelCase and the snake_case spelling", () => {
    const camel = gameRuleMeta("mobGriefing");
    const snake = gameRuleMeta("mob_griefing");
    expect(camel).not.toBe(null);
    expect(snake).toBe(camel);
    // And is not case-sensitive, since the only guarantee about a renamed id is that it
    // describes the same rule.
    expect(gameRuleMeta("MOB_GRIEFING")).toBe(camel);
  });

  it("covers both answers to the `do` prefix question, which was not measured", () => {
    /**
     * 26.1's handling of the vanilla `do` prefix is genuinely unknown here: `doDaylightCycle`
     * could have become `do_daylight_cycle` or `daylight_cycle`, and nothing in this change
     * talked to the box. Registering both forms costs nothing and covers either answer, and
     * the only thing a match can produce is help text — never a write.
     */
    const entry = gameRuleMeta("doDaylightCycle");
    expect(entry).not.toBe(null);
    expect(gameRuleMeta("do_daylight_cycle")).toBe(entry);
    expect(gameRuleMeta("daylight_cycle")).toBe(entry);
  });

  it("strips the prefix only where it is really the vanilla `do`", () => {
    // `do` + uppercase, or `do_`. A future rule actually named `double…` must not be
    // shortened into `uble…`, which would be a silent wrong match.
    expect(doStrippedGameRuleId("doFireTick")).toBe("firetick");
    expect(doStrippedGameRuleId("do_fire_tick")).toBe("firetick");
    expect(doStrippedGameRuleId("doubleTapSpeedLimit")).toBe(null);
    expect(doStrippedGameRuleId("mobGriefing")).toBe(null);
  });

  it("no two entries claim the same canonical name", () => {
    /**
     * The guard that makes the `do`-stripping safe. Two entries resolving to one key would
     * attach one rule's sentence to another rule's row — a wrong label, which is worse than
     * no label, and completely invisible in review.
     */
    const seen = new Map<string, string>();
    for (const rule of MC_GAME_RULES) {
      for (const key of [canonicalGameRuleId(rule.id), doStrippedGameRuleId(rule.id)]) {
        if (!key) continue;
        expect(seen.has(key), `${rule.id} collides with ${seen.get(key)} on "${key}"`).toBe(false);
        seen.set(key, rule.id);
      }
    }
  });

  it("knows the four rules 26.x made out of server.properties keys", () => {
    /**
     * The join to the route that started this: `/api/server/properties` refuses those four
     * keys and names the rule that replaced each one. If this table cannot describe the rule
     * it points at, the refusal sends the operator to a row with no explanation on it.
     *
     * Read out of `MC_GAME_RULE_REPLACEMENTS` rather than retyped, so the two cannot drift.
     */
    for (const rule of Object.values(MC_GAME_RULE_REPLACEMENTS)) {
      const meta = gameRuleMeta(rule);
      expect(meta, rule).not.toBe(null);
      expect(meta!.help, rule).not.toBe("");
    }
    // And the pairing is not accidental: each names the property it took over from.
    expect(gameRuleMeta("command_blocks_work")!.help).toContain("enable-command-block");
    expect(gameRuleMeta("allow_entering_nether_using_portals")!.help).toContain("allow-nether");
  });

  it("keeps spawn_monsters distinct from doMobSpawning", () => {
    // They are not the same switch — `spawn-monsters` only ever gated hostile mobs, while
    // `doMobSpawning` gates all natural spawning — so aliasing them would attach the wrong
    // sentence to whichever one the build has.
    expect(gameRuleMeta("spawn_monsters")).not.toBe(gameRuleMeta("doMobSpawning"));
    expect(gameRuleMeta("spawn_monsters")!.help).toContain("Hostile");
  });

  it("says nothing at all about a rule it has never heard of", () => {
    // Annotation is additive. An unknown rule still gets listed by the route with its live
    // value; what it must not get is an invented description.
    expect(gameRuleMeta("someModdedRule")).toBe(null);
    expect(isDefaultGameRuleValue("someModdedRule", "true")).toBe(null);
  });
});

describe("the table's internal consistency", () => {
  it("declares a default that matches its own declared type, where it declares one", () => {
    // A `default` of "yes" on a boolean, or "lots" on an int, renders a "not the vanilla
    // default" hint on every single row forever — a wrong label on the one annotation whose
    // whole job is spotting a hand-edit.
    for (const rule of MC_GAME_RULES) {
      if (rule.default === undefined) continue;
      if (rule.type === "boolean") {
        expect(["true", "false"], rule.id).toContain(rule.default);
      } else {
        expect(rule.default, rule.id).toMatch(/^-?\d+$/);
      }
    }
  });

  it("agrees with what the live value would make of it", () => {
    // `type` on the table is documentation; `inferGameRuleType` on the live value is what
    // actually picks the control. They have to agree on the default, or the table is
    // describing a different rule than the one the panel renders.
    for (const rule of MC_GAME_RULES) {
      if (rule.default === undefined) continue;
      expect(inferGameRuleType(rule.default), rule.id).toBe(rule.type);
    }
  });

  /**
   * The provenance rule, enforced instead of described.
   *
   * The `default` column's only stated provenance is "published vanilla behaviour for
   * 1.21.x". Four entries claimed `true` under that sentence for rules that **did not exist**
   * in 1.21.x — `pvp`, `spawn_monsters`, `command_blocks_work` and
   * `allow_entering_nether_using_portals` are what 26.x created when it moved those
   * `server.properties` keys — and a fifth claimed `1` for
   * `playersNetherPortalCreativeDelay` where the deployed registry reports `0`. Five labels
   * asserting facts nobody had checked, in a panel whose purpose is telling an operator what
   * their world is actually set to.
   *
   * So: state a default or state none, and this is the assertion that makes re-adding one of
   * these five a red test rather than a plausible-looking line in a table.
   */
  it("claims no default for the rules whose default has never been verified", () => {
    const unverified = [
      "pvp",
      "spawn_monsters",
      "command_blocks_work",
      "allow_entering_nether_using_portals",
      "playersNetherPortalCreativeDelay",
    ];
    for (const id of unverified) {
      const meta = gameRuleMeta(id);
      expect(meta, id).not.toBe(null);
      expect(meta?.default, id).toBeUndefined();
    }
  });

  it("renders no 'not the vanilla default' hint for a rule with no default", () => {
    // `null`, not `false`. `false` is what drives the hint, so returning it for an unverified
    // rule would put "Not the vanilla default (undefined)" under four rows on the live build.
    expect(isDefaultGameRuleValue("pvp", "true")).toBe(null);
    expect(isDefaultGameRuleValue("pvp", "false")).toBe(null);
    expect(isDefaultGameRuleValue("playersNetherPortalCreativeDelay", "0")).toBe(null);
    // And still answers for a rule that does declare one, so the hint has not been disabled
    // wholesale.
    expect(isDefaultGameRuleValue("mob_griefing", "false")).toBe(false);
    expect(isDefaultGameRuleValue("mob_griefing", "true")).toBe(true);
  });

  it("files every rule under a declared group", () => {
    // An unknown group string would send the row to "Other" and the heading it was meant for
    // would never render — a typo that looks exactly like a deliberate grouping choice.
    for (const rule of MC_GAME_RULES) {
      expect(MC_GAME_RULE_GROUPS as readonly string[], rule.id).toContain(rule.group);
    }
  });

  it("gives every rule a help line, since that is the only thing the table adds", () => {
    // The server supplies ids and values and no descriptions. An entry with an empty `help`
    // is an entry that does nothing but occupy a name.
    for (const rule of MC_GAME_RULES) {
      expect(rule.help.trim().length, rule.id).toBeGreaterThan(10);
    }
  });

  it("is written against the build mc-properties was measured on", () => {
    // The ids for the four 26.x rules come from that measurement. If the stamp moves, they
    // are claims about a build nobody is running.
    expect(MC_PROPERTIES_VERIFIED_FOR).toBe("26.1.2");
  });
});

describe("which control a rule gets", () => {
  it("takes the type from the game's answer, not from the table", () => {
    // So a rule the table has never heard of still gets the right control, and a rule whose
    // type changed between builds follows the build.
    expect(inferGameRuleType("true")).toBe("boolean");
    expect(inferGameRuleType("false")).toBe("boolean");
    expect(inferGameRuleType("3")).toBe("int");
    expect(inferGameRuleType("-1")).toBe("int");
  });

  it("does not render a switch for a value a switch cannot represent", () => {
    // The empty-dropdown bug from `mc-properties.ts`, one layer along: a control that cannot
    // show its own value reads as "unset" and is one click from replacing a setting nobody
    // chose. Anything that is not exactly true/false gets the number field, where the write
    // is then refused rather than silently coerced.
    expect(inferGameRuleType("True")).toBe("int");
    expect(inferGameRuleType("")).toBe("int");
    expect(inferGameRuleType("sometimes")).toBe("int");
  });

  /**
   * `gameRuleInputMode` is a finer question than `inferGameRuleType`, and the dead end it
   * removes was a row you could neither read nor write.
   *
   * A modded rule holding something that is neither `true`/`false` nor an integer got
   * `type: "int"` and therefore `<input type="number">` — and React renders a number input
   * whose value is non-numeric as **empty**. The draft then equalled the live value, so the
   * Set button (which only appears when they differ) never appeared either. A blank box with
   * no way to submit, indistinguishable from a rule with no value.
   */
  it("keeps a value a number field cannot show out of a number field", () => {
    expect(gameRuleInputMode("sometimes")).toBe("text");
    expect(gameRuleInputMode("")).toBe("text");
    expect(gameRuleInputMode("True")).toBe("text");
    expect(gameRuleInputMode("1.5")).toBe("text");
    expect(gameRuleInputMode("1e3")).toBe("text");
  });

  it("still uses a switch and a number field for the two kinds vanilla has", () => {
    expect(gameRuleInputMode("true")).toBe("switch");
    expect(gameRuleInputMode("false")).toBe("switch");
    expect(gameRuleInputMode("3")).toBe("number");
    expect(gameRuleInputMode("-1")).toBe("number");
    expect(gameRuleInputMode("65536")).toBe("number");
  });

  it("agrees with inferGameRuleType on everything brigadier can actually parse", () => {
    // The two must not drift: whatever the UI offers has to be a value the route's own check
    // accepts, or the control is a trap. They only differ on values neither accepts.
    for (const v of ["true", "false", "0", "-7", "2147483647"]) {
      const mode = gameRuleInputMode(v);
      expect(mode === "switch" ? "boolean" : "int", v).toBe(inferGameRuleType(v));
      expect(checkGameRuleValue(v, inferGameRuleType(v)).ok, v).toBe(true);
    }
  });
});

describe("checking a value before anything is sent", () => {
  it("normalises a boolean to the only form the game parses", () => {
    // `BoolArgumentType` reads lowercase `true`/`false` and nothing else, and a JSON body or
    // a toggle can produce either case or the primitive.
    for (const input of ["true", "TRUE", " True ", true]) {
      expect(checkGameRuleValue(input, "boolean"), String(input)).toEqual({
        ok: true,
        value: "true",
      });
    }
    expect(checkGameRuleValue(false, "boolean")).toEqual({ ok: true, value: "false" });
  });

  it("refuses a non-boolean for a true/false rule", () => {
    for (const input of ["1", "yes", "on", "", "maybe"]) {
      expect(checkGameRuleValue(input, "boolean").ok, String(input)).toBe(false);
    }
  });

  it("refuses the number forms brigadier does not read", () => {
    /**
     * The failure this prevents is subtle: the game would reject these itself, the re-read
     * would report the unchanged value, and the panel would say "the server did not take 5.0"
     * — which reads as a server fault rather than a typo. Each of these is something a
     * `type="number"` field or a JSON body really produces.
     */
    for (const input of ["+5", "5.0", "1e3", "0x10", "5 ", "", "three", "٣"]) {
      const result = checkGameRuleValue(input, "int");
      expect(result.ok, JSON.stringify(input)).toBe(String(input).trim() === "5");
    }
    // `"5 "` trims to a legal 5, which is the one member of that list that should pass.
    expect(checkGameRuleValue("5 ", "int")).toEqual({ ok: true, value: "5" });
  });

  it("normalises an int so the read-back comparison stays honest", () => {
    // `007` and `-0` are integers that the game echoes back as `7` and `0`. Left alone, the
    // write would work and the read-back would report a mismatch — the route would call a
    // successful change a failure.
    expect(checkGameRuleValue("007", "int")).toEqual({ ok: true, value: "7" });
    expect(checkGameRuleValue("-0", "int")).toEqual({ ok: true, value: "0" });
    expect(checkGameRuleValue(3, "int")).toEqual({ ok: true, value: "3" });
  });

  it("refuses what will not fit in the int argument", () => {
    expect(checkGameRuleValue("2147483647", "int").ok).toBe(true);
    expect(checkGameRuleValue("-2147483648", "int").ok).toBe(true);
    expect(checkGameRuleValue("2147483648", "int").ok).toBe(false);
    expect(checkGameRuleValue("-2147483649", "int").ok).toBe(false);
    expect(checkGameRuleValue("99999999999999999999", "int").ok).toBe(false);
  });

  it("refuses a value that is not a scalar at all", () => {
    // `String({})` is "[object Object]" and `String(["1"])` is "1" — the second is the
    // dangerous one, because it would silently succeed.
    for (const input of [{}, ["1"], null, undefined, () => 1]) {
      expect(checkGameRuleValue(input, "int").ok, JSON.stringify(input) ?? "fn").toBe(false);
    }
  });
});

describe("building the RCON command", () => {
  it("builds the query form and the write form", () => {
    expect(gameRuleCommand("mob_griefing")).toBe("gamerule mob_griefing");
    expect(gameRuleCommand("mob_griefing", "false")).toBe("gamerule mob_griefing false");
    expect(gameRuleCommand("randomTickSpeed", "3")).toBe("gamerule randomTickSpeed 3");
  });

  it("throws rather than emitting a command carrying a second command", () => {
    /**
     * The route already refuses any rule the server did not itself list, so reaching this is
     * a bug — but a bug here concatenates caller-controlled text into a console command, and
     * that is the one failure mode that must not degrade quietly. Same call the Minecraft
     * backup route's shell-injection fix made.
     */
    for (const id of ["pvp; op mallory", "pvp false", "", "9lives", "pvp\nop mallory", "../pvp"]) {
      expect(() => gameRuleCommand(id), JSON.stringify(id)).toThrow(/Unsafe game rule id/);
    }
    for (const value of ["false; op mallory", "1 2", "true\nstop", "abc", ""]) {
      expect(() => gameRuleCommand("pvp", value), JSON.stringify(value)).toThrow(
        /Unsafe game rule value/
      );
    }
  });

  it("accepts exactly what checkGameRuleValue produces", () => {
    // The two have to agree or a legal value throws on its way out. Checked over every
    // declared default, which is the set of values the table itself claims are legal — five
    // entries declare none (see "claims no default…" above) and have no value to check.
    for (const rule of MC_GAME_RULES) {
      if (rule.default === undefined) continue;
      const checked = checkGameRuleValue(rule.default, rule.type);
      expect(checked.ok, rule.id).toBe(true);
      expect(() => gameRuleCommand(rule.id, (checked as { value: string }).value)).not.toThrow();
    }
  });
});

describe("spotting a rule somebody set by hand", () => {
  /**
   * The motivating case: `mob_griefing` is false on the live server and nothing in this app
   * set it. A panel that lists 48 values and does not say which are unusual hides that in
   * plain sight.
   */
  it("flags a value that is not the published vanilla default", () => {
    expect(isDefaultGameRuleValue("mob_griefing", "true")).toBe(true);
    expect(isDefaultGameRuleValue("mob_griefing", "false")).toBe(false);
    expect(isDefaultGameRuleValue("keepInventory", "false")).toBe(true);
    expect(isDefaultGameRuleValue("keepInventory", "true")).toBe(false);
  });

  it("answers unknown rather than 'yes' for a rule it cannot speak about", () => {
    // Three-state for the same reason `movedToGameRules` is: "no opinion" has to be
    // distinguishable from "it is the default", or an unknown rule renders with a hint the
    // table cannot support.
    expect(isDefaultGameRuleValue("someModdedRule", "17")).toBe(null);
  });
});

describe("grouping the panel's rows", () => {
  it("loses no rule, and puts an unrecognised one in Other", () => {
    // Losslessness, the same property `groupMcProperties` is pinned on: a grouped renderer
    // that drops an id it has not heard of is strictly worse than a flat list, because the
    // rule is simply absent from the page and nothing says so.
    const ids = [...MC_GAME_RULES.map((r) => r.id), "someModdedRule", "another_mod_rule"];
    const groups = groupGameRules(ids);
    const rendered = groups.flatMap((g) => g.ids);
    expect([...rendered].sort()).toEqual([...ids].sort());
    expect(groups.find((g) => g.title === MC_GAME_RULE_OTHER_GROUP)?.ids).toEqual([
      "someModdedRule",
      "another_mod_rule",
    ]);
  });

  it("groups the snake_case spellings exactly as the camelCase ones", () => {
    // Otherwise the whole panel reorganises itself on a version bump — every row sliding
    // into "Other" the day the server renames its rules.
    const camel = groupGameRules(["mobGriefing", "keepInventory", "randomTickSpeed"]);
    const snake = groupGameRules(["mob_griefing", "keep_inventory", "random_tick_speed"]);
    expect(snake.map((g) => g.title)).toEqual(camel.map((g) => g.title));
    expect(snake.find((g) => g.title === MC_GAME_RULE_OTHER_GROUP)).toBeUndefined();
  });

  it("emits no empty heading and keeps the declared order", () => {
    const groups = groupGameRules(["keepInventory", "mobGriefing"]);
    expect(groups.map((g) => g.title)).toEqual(["Mobs & spawning", "Damage & death"]);
    expect(groupGameRules([])).toEqual([]);
  });
});

describe("labelling a row", () => {
  it("reads the same whichever spelling the build uses", () => {
    // The id is rendered next to the label, so the label's job is only to be legible — but it
    // has to be legible identically on both builds, or the panel looks like a different panel
    // after a version change.
    expect(gameRuleLabel("mobGriefing")).toBe("Mob griefing");
    expect(gameRuleLabel("mob_griefing")).toBe("Mob griefing");
    expect(gameRuleLabel("doFireTick")).toBe("Do fire tick");
    expect(gameRuleLabel("allow_entering_nether_using_portals")).toBe(
      "Allow entering nether using portals"
    );
    expect(gameRuleLabel("pvp")).toBe("Pvp");
  });
});

describe("the sentence that points at this panel", () => {
  /**
   * Item four of the brief: where `/api/server/properties` used to say "run `gamerule X
   * false` yourself", it points at the control instead — and its refusal stays.
   *
   * One function used by both the route's refusal and the editor's per-field note, because
   * those were two hand-written variants of the same instruction and would have drifted the
   * moment either moved.
   */
  it("names the panel instead of a command to type", () => {
    const hint = gameRuleControlHint(["pvp"]);
    expect(hint).toBe("Set pvp under Game rules on this page.");
    // The specific regression: no console instruction anywhere in it.
    expect(hint).not.toMatch(/console/i);
    expect(hint).not.toMatch(/gamerule \w+ (true|false)/);
  });

  it("names every rule it is talking about", () => {
    // Each rule by name, not "set them": the properties route refuses up to four keys at
    // once, and "set them under Game rules" leaves the reader to work out which four rows to
    // look for among forty-eight.
    const rules = Object.values(MC_GAME_RULE_REPLACEMENTS);
    const hint = gameRuleControlHint(rules);
    for (const rule of rules) expect(hint, rule).toContain(rule);
    expect(hint).toMatch(/^Set .* under Game rules on this page\.$/);
    expect(hint).not.toMatch(/console/i);
  });

  it("says nothing when there is nothing to point at", () => {
    // The properties route builds this only when a key was refused; an empty string keeps the
    // caller from stitching a dangling "Set  under Game rules" onto a clean save.
    expect(gameRuleControlHint([])).toBe("");
  });
});

describe("the two routes that now share this module", () => {
  /**
   * A grep rather than an execution of the handlers, for the reason `permissions.test.ts`
   * gives: a route handler needs `auth()`, Prisma and a `NextRequest`, which is the
   * Docker-and-network line this suite does not cross. What it buys is that the console
   * instruction cannot come back, and that the id interpolated into an RCON command still
   * comes from the server.
   */
  it("leaves no hand-written 'type it in the console' instruction behind", async () => {
    const { readFile } = await import("fs/promises");
    const path = await import("path");
    const root = path.resolve(__dirname, "..", "..");
    for (const rel of ["app/api/server/properties/route.ts", "app/minecraft/settings/page.tsx"]) {
      const text = await readFile(path.join(root, rel), "utf-8");
      // The literal both files used to build: a `gamerule <x> <bool>` command inside a
      // template string handed to the user.
      const body = text.replace(/^\s*(\*|\/\/).*$/gm, ""); // comments may still describe the old text
      expect(body, rel).not.toMatch(/gamerule \$\{/);
      expect(body, rel).toContain("gameRuleControlHint");
    }
  });

  it("keeps the properties route's refusal of the four moved keys", () => {
    // "Keep its refusal" is half the brief. Pointing somewhere better must not become
    // writing the key anyway — 26.x does not read it, so that would be a green toast over
    // nothing, which is the defect the refusal exists for.
    expect(Object.keys(MC_GAME_RULE_REPLACEMENTS).sort()).toEqual([
      "allow-nether",
      "enable-command-block",
      "pvp",
      "spawn-monsters",
    ]);
  });

  it("maps the kebab-case property name to the camelCase-or-snake_case rule name", () => {
    /**
     * The one place the two naming schemes meet. `server.properties` keys are kebab-case and
     * game rules are not, and the mapping is **not** a transformation of the string:
     * `enable-command-block` became `command_blocks_work`. Anything that tried to derive one
     * from the other would produce `enableCommandBlock`, query a rule that does not exist,
     * and report it as unreadable.
     */
    for (const [key, rule] of Object.entries(MC_GAME_RULE_REPLACEMENTS)) {
      expect(key, key).toMatch(/^[a-z][a-z-]*$/); // kebab-case on the properties side
      expect(rule, rule).not.toMatch(/-/); // never kebab-case on the rule side
      expect(gameRuleCommand(rule), rule).toBe(`gamerule ${rule}`);
    }
    expect(MC_GAME_RULE_REPLACEMENTS["enable-command-block"]).toBe("command_blocks_work");
  });
});
