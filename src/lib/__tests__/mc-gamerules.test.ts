import { describe, it, expect } from "vitest";
import {
  MC_GAME_RULES,
  MC_GAME_RULE_GROUPS,
  MC_GAME_RULE_LIST_COMMAND,
  MC_GAME_RULE_OTHER_GROUP,
  canonicalGameRuleId,
  checkGameRuleValue,
  doStrippedGameRuleId,
  gameRuleCommand,
  gameRuleControlHint,
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
 * A `help gamerule` reply in the form brigadier produces it: `HelpCommand` prints one line
 * per child of the `gamerule` node, each `/gamerule <usage>`.
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
  it("declares a default that matches its own declared type", () => {
    // A `default` of "yes" on a boolean, or "lots" on an int, renders a "not the vanilla
    // default" hint on every single row forever — a wrong label on the one annotation whose
    // whole job is spotting a hand-edit.
    for (const rule of MC_GAME_RULES) {
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
      expect(inferGameRuleType(rule.default), rule.id).toBe(rule.type);
    }
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
    // declared default, which is the set of values the table itself claims are legal.
    for (const rule of MC_GAME_RULES) {
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
