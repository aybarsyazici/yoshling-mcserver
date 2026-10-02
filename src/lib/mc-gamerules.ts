/**
 * Minecraft game rules: what they are, and how to read the game's answers about them.
 *
 * ## Why this exists
 *
 * `server.properties` lost four settings to game rules on 26.x and the dashboard noticed:
 * `/api/server/properties` refuses to write `pvp`, `spawn-monsters`,
 * `enable-command-block` and `allow-nether` and names the rule that replaced each one (see
 * `MC_GAME_RULE_REPLACEMENTS` in `mc-properties.ts`, measured 2026-10-01 against 26.1.2).
 * It then told the operator to go type `gamerule <x> false` into the console, because there
 * was no control. So the dashboard could *detect* a setting it could not change, for the 58
 * rules the deployed build has, none of which it listed. Production proves someone did it by
 * hand anyway: `server.properties` says `enable-command-block=false` while the world says
 * `command_blocks_work = true`, and `mob_griefing` is reported false on the live server
 * with nothing in this app having set it.
 *
 * ## The ids are discovered, not hardcoded — and that is the whole design
 *
 * **26.1 renamed the game rules.** `mc-properties.ts` records the measurement:
 * `keepInventory` and `doDaylightCycle` both answer `Incorrect argument` on 26.1.2, while
 * `pvp`, `spawn_monsters`, `command_blocks_work` and
 * `allow_entering_nether_using_portals` answer. The rename is also **not mechanical** —
 * `enable-command-block` did not become `enableCommandBlock`, it became
 * `command_blocks_work`.
 *
 * A hardcoded id list would therefore be the project's defect class in a new costume: on
 * the live build, 58 queries for rules that do not exist, every one answered `Incorrect
 * argument`, and a panel that renders empty while looking like it merely has nothing to
 * say. And 1.21.4 is still on the volume and still selectable in the version dropdown, so
 * there is no single correct spelling to hardcode either.
 *
 * So the route asks the server: `help gamerule` prints one usage line per rule, which is
 * the same recipe `mc-properties.ts` already names as the answer to "what game rules
 * exist?". Every id this module hands out came from the running build, which means the
 * panel is correct on 1.21.4 and on 26.1.2 without this file knowing which is booted.
 *
 * ## What the table below is for, then
 *
 * The server supplies ids and values and **no descriptions and no defaults**. Those are
 * the two things the table adds, and it is joined to a discovered id by a canonical form
 * (case- and separator-insensitive, plus the vanilla `do` prefix) rather than by equality,
 * so `mobGriefing`, `mob_griefing` and a hypothetical `MobGriefing` all find the same
 * entry. A rule the table has never heard of is still listed, with its live value and no
 * help — annotation is additive here, never a filter. That is deliberate: a table that
 * decided what gets rendered would silently shrink the panel on the next version bump.
 *
 * ## Provenance of the defaults, stated rather than implied
 *
 * **The `default` column is published vanilla behaviour for 1.21.x. It was NOT read off
 * this deployment.** It drives one soft hint ("not the vanilla default", which is how a
 * hand-edited rule like `mob_griefing` becomes visible) and nothing else: no write, no
 * refusal and no ordering depends on it, so a wrong entry misleads a label and cannot
 * misapply a setting. The types are not in that category — `type` is taken from the **live
 * value** by `inferGameRuleType`, so the control rendered for a rule is decided by what the
 * game said, not by this file.
 *
 * **The column is optional, and five entries deliberately leave it empty**: the four rules
 * 26.x created out of `server.properties` keys (`pvp`, `spawn_monsters`,
 * `command_blocks_work`, `allow_entering_nether_using_portals`) have no 1.21.x behaviour to
 * publish, because they were not game rules in 1.21.x — claiming one for them was a label
 * asserting a fact nobody had checked. And `playersNetherPortalCreativeDelay` was written
 * here as `1` while the deployed registry reports `0`. A rule with no default renders no
 * hint, which is the honest outcome: "unknown" and "matches" have to stay distinguishable.
 * The rule for adding one is therefore the rule for every claim in this repo — **verify a
 * default or state none.**
 *
 * To re-measure defaults against a build, on a world nobody has edited:
 *   docker exec yoshling-mc rcon-cli "help gamerule"      # the ids this build has
 *   docker exec yoshling-mc rcon-cli "gamerule <id>"      # query form, writes nothing
 */

export type McGameRuleType = "boolean" | "int";

export interface McGameRuleMeta {
  /**
   * The spelling this entry is written under: the 1.x camelCase id for a rule that has
   * one, or the measured 26.x id for a rule that only exists there. Matching is canonical
   * (see `gameRuleMeta`), so this is a label rather than a key and either spelling works.
   */
  id: string;
  type: McGameRuleType;
  /**
   * Published vanilla default for 1.21.x — see the provenance note above.
   *
   * **Optional, and absent means "no default is claimed for this rule".** It is not a
   * convenience: the four rules 26.x created out of `server.properties` keys did not exist in
   * 1.21.x, so the column's own provenance sentence cannot be true of them, and
   * `playersNetherPortalCreativeDelay` was written here as `1` against a deployed registry
   * that reports `0`. Stating a default for those was the project's defect class with the
   * sign flipped — a confident claim with nothing behind it — so they state none and the
   * panel renders no hint for them.
   */
  default?: string;
  group: string;
  /** One line, plain, in the imperative-free "what this does" voice the rest of the app uses. */
  help: string;
}

/**
 * Group order for the panel. 58 rules in one flat grid is the thing the properties editor
 * was just fixed for ("a flat alphabetical grid of ~58 bare labels"), so this ships grouped
 * from the start.
 */
export const MC_GAME_RULE_GROUPS = [
  "Mobs & spawning",
  "Damage & death",
  "World & blocks",
  "Players",
  "Commands & admin",
  "Limits",
] as const;

export const MC_GAME_RULE_OTHER_GROUP = "Other";

/**
 * The rules this module can describe. Not a list of what exists — see the header.
 *
 * The four at the end carry no 1.x ancestor: they are the rules 26.x created when it moved
 * those `server.properties` keys, and their ids are the ones measured over RCON on
 * 2026-10-01 and recorded in `MC_GAME_RULE_REPLACEMENTS`. `spawn_monsters` is kept separate
 * from `doMobSpawning` rather than aliased onto it because they are not the same switch:
 * `spawn-monsters` only ever gated hostile mobs, `doMobSpawning` gates all natural
 * spawning, and collapsing them would attach the wrong sentence to whichever one the build
 * has.
 */
export const MC_GAME_RULES: McGameRuleMeta[] = [
  // ── Mobs & spawning ───────────────────────────────────────────────────────
  { id: "doMobSpawning", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Mobs spawn naturally." },
  { id: "doMobLoot", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Mobs drop items and experience when they die." },
  { id: "mobGriefing", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Mobs can change blocks — creeper craters, endermen taking blocks, zombies breaking doors." },
  { id: "doInsomnia", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Phantoms spawn for players who have not slept in a while." },
  { id: "doPatrolSpawning", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Pillager patrols spawn in the world." },
  { id: "doTraderSpawning", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Wandering traders turn up." },
  { id: "doWardenSpawning", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Wardens spawn in the deep dark." },
  { id: "disableRaids", type: "boolean", default: "false", group: "Mobs & spawning",
    help: "Stops pillager raids from starting at all." },
  { id: "universalAnger", type: "boolean", default: "false", group: "Mobs & spawning",
    help: "An angered neutral mob attacks every nearby player, not only the one who angered it." },
  { id: "forgiveDeadPlayers", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Angered neutral mobs calm down once the player who angered them dies." },

  // ── Damage & death ────────────────────────────────────────────────────────
  { id: "keepInventory", type: "boolean", default: "false", group: "Damage & death",
    help: "Players keep their items and experience when they die." },
  { id: "doImmediateRespawn", type: "boolean", default: "false", group: "Damage & death",
    help: "Skip the death screen and respawn straight away." },
  { id: "fallDamage", type: "boolean", default: "true", group: "Damage & death",
    help: "Players take damage from falling." },
  { id: "fireDamage", type: "boolean", default: "true", group: "Damage & death",
    help: "Players take damage from fire and lava." },
  { id: "drowningDamage", type: "boolean", default: "true", group: "Damage & death",
    help: "Players take damage when they run out of air underwater." },
  { id: "freezeDamage", type: "boolean", default: "true", group: "Damage & death",
    help: "Players take damage from powder snow." },
  { id: "naturalRegeneration", type: "boolean", default: "true", group: "Damage & death",
    help: "Health regenerates on its own while the hunger bar is high enough." },
  { id: "enderPearlsVanishOnDeath", type: "boolean", default: "true", group: "Damage & death",
    help: "A thrown ender pearl disappears if the player who threw it dies first." },

  // ── World & blocks ────────────────────────────────────────────────────────
  { id: "doDaylightCycle", type: "boolean", default: "true", group: "World & blocks",
    help: "Time of day advances. Off freezes the sun where it is." },
  { id: "doWeatherCycle", type: "boolean", default: "true", group: "World & blocks",
    help: "Weather changes on its own." },
  { id: "doFireTick", type: "boolean", default: "true", group: "World & blocks",
    help: "Fire spreads to nearby blocks and burns out." },
  { id: "doTileDrops", type: "boolean", default: "true", group: "World & blocks",
    help: "Broken blocks drop items." },
  { id: "doEntityDrops", type: "boolean", default: "true", group: "World & blocks",
    help: "Minecarts, boats and item frames drop their contents when destroyed." },
  { id: "doVinesSpread", type: "boolean", default: "true", group: "World & blocks",
    help: "Vines grow onto neighbouring blocks." },
  { id: "blockExplosionDropDecay", type: "boolean", default: "true", group: "World & blocks",
    help: "Some blocks destroyed by a block explosion (a bed in the Nether) drop nothing." },
  { id: "mobExplosionDropDecay", type: "boolean", default: "true", group: "World & blocks",
    help: "Some blocks destroyed by a mob explosion (a creeper) drop nothing." },
  { id: "tntExplosionDropDecay", type: "boolean", default: "false", group: "World & blocks",
    help: "Some blocks destroyed by TNT drop nothing." },
  { id: "projectilesCanBreakBlocks", type: "boolean", default: "true", group: "World & blocks",
    help: "Projectiles can break the blocks they are able to break." },
  { id: "waterSourceConversion", type: "boolean", default: "true", group: "World & blocks",
    help: "Water forms new source blocks, which is what makes infinite water work." },
  { id: "lavaSourceConversion", type: "boolean", default: "false", group: "World & blocks",
    help: "Lava forms new source blocks, giving infinite lava." },
  { id: "globalSoundEvents", type: "boolean", default: "true", group: "World & blocks",
    help: "Events like a boss spawning or the dragon dying are heard everywhere." },
  { id: "randomTickSpeed", type: "int", default: "3", group: "World & blocks",
    help: "How often blocks get a random tick — crop growth, leaf decay, fire spread. 0 stops them." },
  { id: "snowAccumulationHeight", type: "int", default: "1", group: "World & blocks",
    help: "How many layers of snow may build up while it is snowing." },
  { id: "playersNetherPortalDefaultDelay", type: "int", default: "80", group: "World & blocks",
    help: "Ticks a player stands in a Nether portal before travelling." },
  // No default: this was written here as "1" and the deployed registry reports 0. Nothing in
  // this repo has measured which is right for which build, so it claims neither.
  { id: "playersNetherPortalCreativeDelay", type: "int", group: "World & blocks",
    help: "The same delay, for a player in creative mode." },

  // ── Players ───────────────────────────────────────────────────────────────
  { id: "showDeathMessages", type: "boolean", default: "true", group: "Players",
    help: "Death messages appear in chat." },
  { id: "announceAdvancements", type: "boolean", default: "true", group: "Players",
    help: "Advancements are announced in chat." },
  { id: "doLimitedCrafting", type: "boolean", default: "false", group: "Players",
    help: "Players can only craft recipes they have unlocked." },
  { id: "reducedDebugInfo", type: "boolean", default: "false", group: "Players",
    help: "Hides coordinates and other detail from the F3 screen." },
  { id: "disableElytraMovementCheck", type: "boolean", default: "false", group: "Players",
    help: "Skips the server-side elytra speed check. Turning it on makes some flight exploits possible." },
  { id: "playersSleepingPercentage", type: "int", default: "100", group: "Players",
    help: "What share of online players has to be asleep to skip the night. 0 lets one player skip it." },
  { id: "spawnRadius", type: "int", default: "10", group: "Players",
    help: "How far from the world spawn point a player can appear when they join or respawn." },

  // ── Commands & admin ──────────────────────────────────────────────────────
  { id: "sendCommandFeedback", type: "boolean", default: "true", group: "Commands & admin",
    help: "Players see the output of commands they run." },
  { id: "commandBlockOutput", type: "boolean", default: "true", group: "Commands & admin",
    help: "Command blocks report what they did in chat." },
  { id: "logAdminCommands", type: "boolean", default: "true", group: "Commands & admin",
    help: "Admin commands are written to the server log." },
  { id: "commandModificationBlockLimit", type: "int", default: "32768", group: "Commands & admin",
    help: "How many blocks one /fill, /clone or /fillbiome may change." },
  { id: "maxCommandChainLength", type: "int", default: "65536", group: "Commands & admin",
    help: "How many commands one chain — a function, or a line of command blocks — may run." },

  // ── Limits ────────────────────────────────────────────────────────────────
  { id: "maxEntityCramming", type: "int", default: "24", group: "Limits",
    help: "How many entities may share one block before they take cramming damage. 0 turns it off." },
  { id: "spawnChunkRadius", type: "int", default: "2", group: "Limits",
    help: "How large the always-loaded area around world spawn is. Bigger costs memory and tick time." },
  { id: "spectatorsGenerateChunks", type: "boolean", default: "true", group: "Limits",
    help: "Spectators can generate new terrain by flying into it." },

  // ── Rules 26.x created out of server.properties keys ──────────────────────
  // Ids measured over RCON on 2026-10-01 against 26.1.2; see MC_GAME_RULE_REPLACEMENTS.
  //
  // **None of these four states a default, and that is the point.** They did not exist as
  // game rules in 1.21.x, so "published vanilla default for 1.21.x" — the only provenance
  // this column has — cannot be true of them. The previous version claimed `true` for all
  // four on exactly that basis. What their 26.x defaults are is a measurement nobody here
  // has made, and the `server.properties` key each replaced is not the same thing (that
  // file's default is what the *file* ships with, not what the rule initialises to in a
  // world created without it).
  { id: "pvp", type: "boolean", group: "Damage & death",
    help: "Players can hurt each other. On 26.x this took over from the server.properties key of the same name." },
  { id: "spawn_monsters", type: "boolean", group: "Mobs & spawning",
    help: "Hostile mobs spawn. On 26.x this took over from server.properties spawn-monsters." },
  { id: "command_blocks_work", type: "boolean", group: "Commands & admin",
    help: "Command blocks run at all. On 26.x this took over from server.properties enable-command-block." },
  { id: "allow_entering_nether_using_portals", type: "boolean", group: "World & blocks",
    help: "Nether portals take players to the Nether. On 26.x this took over from server.properties allow-nether." },
];

/**
 * Case- and separator-insensitive form, so one entry covers every spelling of a rename.
 *
 * `mobGriefing` and `mob_griefing` both reduce to `mobgriefing`, which is the whole reason
 * the 26.1 snake_case rename does not cost this table 40 entries.
 */
export function canonicalGameRuleId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The same form with the vanilla `do` prefix removed, or null for an id that does not carry
 * one.
 *
 * Needed because the 26.1 rename's handling of that prefix is **not known here**: if
 * `doDaylightCycle` became `do_daylight_cycle` the plain canonical form already matches,
 * and if it became `daylight_cycle` only this one does. Registering both for every
 * `do`-prefixed entry costs nothing and covers either answer, and `gameRuleMeta` can only
 * ever return help text — a wrong match would mislabel a row, never write anything. The
 * guard against a wrong match is the uniqueness assertion in the tests.
 *
 * Gated on `do` + uppercase (or `do_`) rather than a bare `do` prefix so a future rule
 * actually named `double…` is not shortened into `uble…`.
 */
export function doStrippedGameRuleId(id: string): string | null {
  if (!/^do[A-Z]/.test(id) && !/^do_/.test(id)) return null;
  return canonicalGameRuleId(id.replace(/^do_?/, ""));
}

const META_BY_CANON = new Map<string, McGameRuleMeta>();
for (const rule of MC_GAME_RULES) {
  META_BY_CANON.set(canonicalGameRuleId(rule.id), rule);
  const stripped = doStrippedGameRuleId(rule.id);
  if (stripped) META_BY_CANON.set(stripped, rule);
}

/** What this module knows about a rule the server named, or null if it has never heard of it. */
export function gameRuleMeta(id: string): McGameRuleMeta | null {
  return META_BY_CANON.get(canonicalGameRuleId(id)) ?? null;
}

/**
 * One `gamerule <id>` mention anywhere in a reply, with the `minecraft:` namespace optional.
 *
 * `(?:^|[^A-Za-z0-9_])` so `gamerules notACommand` cannot match (the word has to end where
 * `gamerule` ends) without requiring the `/` that a line pasted without it would lack.
 * `(?=\s|$)` is the boundary that makes a malformed id a skip instead of a truncation.
 */
const GAME_RULE_MENTION =
  /(?:^|[^A-Za-z0-9_])gamerule\s+(?:minecraft:)?([A-Za-z][A-Za-z0-9_]*)(?=\s|$)/g;

/**
 * The rule ids in a `help gamerule` reply.
 *
 * ## There are no newlines in that reply. Measured.
 *
 * This parser split on `\n` first, and that was wrong in the most expensive available way:
 * it returned **one** id from a reply listing 58 rules, the route answered 200 with that one
 * rule, and the panel rendered as if the build had one game rule.
 * `src/lib/__tests__/fixtures/mc-help-gamerule.txt` is the real reply, captured from the
 * deployed 26.1.2 server on 2026-10-01: **5,082 bytes, zero newline characters.**
 * `RconConsoleSource.sendSystemMessage` appends every feedback message to one buffer with no
 * separator, so brigadier's 116 usage lines arrive as one run-together string:
 *
 *   /gamerule immediate_respawn [<value>]/gamerule minecraft:immediate_respawn [<value>]…
 *
 * So the delimiter is the literal `/gamerule ` that `HelpCommand` prints in front of each
 * usage, not a line break. A newline-separated reply (if some build or some transport ever
 * produces one) still parses — whitespace around a mention is irrelevant to the scan.
 *
 * ## Both spellings of every rule, once
 *
 * Brigadier lists each rule twice, bare and namespaced (`fall_damage` and
 * `minecraft:fall_damage`), so 58 rules produce 116 mentions. The `minecraft:` prefix is
 * stripped and the result de-duplicated, which is what turns 116 into 58. Order is the
 * server's, first mention wins.
 *
 * ## Anything that does not look like a rule id is skipped, never guessed at
 *
 * The id must start with a letter, contain only `[A-Za-z0-9_]`, and be **followed by
 * whitespace or the end of the reply** — that last clause is what rejects `bad-id` and
 * `evil; op mallory` rather than silently truncating them to `bad` and `evil`. A
 * placeholder (`/gamerule <rule>`), an `Unknown or incomplete command` refusal and a
 * foreign-namespace id (`mypack:custom`, which would need a `:` this charset forbids) all
 * produce no entry. That is both correctness — a fabricated id gets queried and reported as
 * unreadable, noise this parser invented — and safety: the token is pasted straight into an
 * RCON command, and a token that cannot hold a space or a semicolon cannot turn one command
 * into two.
 */
export function parseGameRuleList(reply: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of reply.matchAll(GAME_RULE_MENTION)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * How many times a reply mentions a rule at all, parsed or not.
 *
 * The denominator for the shortfall check below: 116 mentions against 1 parsed id is the
 * signature of a parser that cannot read the reply, and it is a different fact from "this
 * build has one game rule". Counted with its own scan rather than derived from
 * `parseGameRuleList`, so a bug in the parser cannot hide itself in the number used to judge
 * the parser.
 */
export function countGameRuleMentions(reply: string): number {
  return (reply.match(/(?:^|[^A-Za-z0-9_])gamerule\s+\S/g) ?? []).length;
}

/**
 * The floor a `help gamerule` reply has to clear before the panel will render it.
 *
 * Every Minecraft build that has game rules has dozens: 58 on the deployed 26.1.2 (measured,
 * see the fixture) and ~48 on 1.21.4. Ten is well under either, so it refuses a misread
 * reply without refusing a build nobody here has seen. It is a floor on *plausibility*, not
 * an expected count — asserting 58 would make the next version bump look like a fault.
 */
export const MIN_PLAUSIBLE_GAME_RULES = 10;

/** The payload size of one Source-RCON packet, and so the size a truncated reply lands on. */
const RCON_PACKET_PAYLOAD = 4096;

export type GameRuleListVerdict =
  /** Enough to render. `warning` is non-null when the reply is readable but demonstrably short. */
  | { ok: true; warning: string | null }
  /** Too little to render, and the message says what was actually read. */
  | { ok: false; error: string };

/**
 * Judge a parsed rule list against the reply it came out of.
 *
 * This exists because the failure it catches was **HTTP 200 with one rule and no warning** —
 * this project's named defect class, "reports success after doing nothing or the wrong
 * thing". Two compounding bugs produced it: the newline split above, and `sendCommand`
 * truncating the reply at 4096 bytes. Either one alone still produces a short list, so the
 * check is on the evidence rather than on the cause:
 *
 * - **Fewer than `MIN_PLAUSIBLE_GAME_RULES` parsed** → refuse, naming the parsed count, the
 *   reply's size and how many times it says `gamerule`. "We read 1 rule out of a
 *   5,082-character reply that mentions gamerule 116 times" is checkable; "this build has no
 *   game rules" is a cause this code cannot establish and would be false.
 * - **A reply exactly `RCON_PACKET_PAYLOAD` long** → warn, because that is the single-packet
 *   cliff and not a number a server produces by coincidence. It matters on its own: a
 *   truncated `help gamerule` still yields ~46 ids, which clears the floor, so without this
 *   the panel would quietly be missing a dozen rules.
 */
export function assessGameRuleList(ids: string[], reply: string): GameRuleListVerdict {
  const mentions = countGameRuleMentions(reply);
  const size = `${reply.length}-character`;

  if (ids.length < MIN_PLAUSIBLE_GAME_RULES) {
    return {
      ok: false,
      error:
        `Read ${ids.length} game ${ids.length === 1 ? "rule" : "rules"} out of the server's ` +
        `${size} reply to "${MC_GAME_RULE_LIST_COMMAND}", which mentions "gamerule" ` +
        `${mentions} ${mentions === 1 ? "time" : "times"}. Every Minecraft build has dozens, ` +
        `so this is the dashboard failing to read the reply rather than a build without game ` +
        `rules. Run "${MC_GAME_RULE_LIST_COMMAND}" in the console to see it raw.`,
    };
  }

  if (reply.length === RCON_PACKET_PAYLOAD) {
    return {
      ok: true,
      warning:
        `The server's reply is exactly ${RCON_PACKET_PAYLOAD} characters, the most one RCON ` +
        `packet carries, so it was almost certainly cut off — rules past the cut are missing ` +
        `from this list. ${ids.length} were read.`,
    };
  }

  return { ok: true, warning: null };
}

/**
 * The name and value out of a `gamerule` reply, or null when the line is not one.
 *
 * Minecraft answers the query form with the vanilla string `commands.gamerule.query` —
 * "Gamerule %s is currently set to: %s" — and a write with `commands.gamerule.set`, "Gamerule
 * %s is now set to: %s". `mc-properties.ts` records the query form measured over RCON on
 * 26.1.2: `Gamerule pvp is currently set to: true`.
 *
 * Both forms are accepted because the write path reads the set reply **and** re-queries, and
 * a parser that only knew one of them would make half of that evidence unreadable.
 *
 * Returning null for everything else is load-bearing, not politeness: a rule this build does
 * not have answers `Incorrect argument for command`, and anything that coerced that into a
 * value would invent a setting. The caller reports such a rule as unread.
 *
 * **This one does split on newlines, and that is not an inconsistency with
 * `parseGameRuleList` above.** Minecraft concatenates feedback messages with no separator, so
 * a reply carrying many of them has no line breaks — which is why the list parser cannot use
 * them. A `gamerule <id>` query produces exactly **one** feedback message, so there is nothing
 * to separate here; the line split only tolerates stray `\r\n` off the socket. If a caller
 * ever batches several `gamerule` queries into one RCON command, this needs the same
 * delimiter-scanning treatment the list parser got.
 */
export function parseGameRuleReply(reply: string): { id: string; value: string } | null {
  for (const raw of reply.split(/\r?\n/)) {
    const m = /^Gamerule\s+([A-Za-z][A-Za-z0-9_]*)\s+is\s+(?:currently|now)\s+set\s+to:\s*(.*)$/.exec(
      raw.trim()
    );
    if (m) return { id: m[1], value: m[2].trim() };
  }
  return null;
}

/**
 * Which control to render, decided by **what the game said** rather than by the table.
 *
 * So a rule the table has never heard of still gets the right control, and a rule whose
 * type changed between builds follows the build rather than this file.
 *
 * `"boolean"` requires the value to be exactly `true` or `false`; everything else gets the
 * number field. Vanilla has only these two kinds of rule, so the remaining case is a modded
 * rule holding something else — which renders in the number field and is then refused by
 * `checkGameRuleValue` instead of being written. That degrades visibly; the alternative
 * (defaulting to a switch) would show a control unable to represent its own value, which is
 * the empty-dropdown bug `mc-properties.ts` was just fixed for, one layer along.
 */
export function inferGameRuleType(value: string): McGameRuleType {
  return value === "true" || value === "false" ? "boolean" : "int";
}

/**
 * Which **input** to render — a finer question than `inferGameRuleType`, and the two are
 * deliberately separate.
 *
 * `inferGameRuleType` answers "which of the two things brigadier can parse is this", and the
 * route needs exactly that to validate a submitted value. This answers "can the control show
 * the value the game reported", and the two disagree in one case that was a dead end:
 *
 * A modded rule holding something that is neither `true`/`false` nor an integer got
 * `type: "int"` and therefore `<input type="number">`, and **React renders a number input
 * with a non-numeric value as empty**. So the row showed a blank box, and because the Set
 * button only appears when the draft differs from the live value — and the draft *was* the
 * live value — there was no way to submit anything either. A rule you could neither read nor
 * write, rendered as if it were blank.
 *
 * `"text"` shows the real value and lets it be edited. A non-integer typed into it is still
 * refused by `checkGameRuleValue` with a message naming the problem, which is the visible
 * degradation that case always deserved.
 */
export function gameRuleInputMode(value: string): "switch" | "number" | "text" {
  if (value === "true" || value === "false") return "switch";
  return /^-?\d+$/.test(value.trim()) ? "number" : "text";
}

/**
 * Is this value the published vanilla default? `null` means **no default is known** for this
 * rule, which is different from "yes" and must stay different — it has to render without the
 * hint, not with a wrong one.
 *
 * Two ways to get `null`, and both are real: a rule the table has never heard of, and a rule
 * the table lists with no `default` because none has been verified (the four 26.x rules and
 * `playersNetherPortalCreativeDelay` — see the provenance note at the top).
 *
 * This is what makes a hand-edited rule visible. `mob_griefing` is reported false on
 * production with nothing in this app having set it; that is a row the panel can point at
 * only because the default is written down.
 */
export function isDefaultGameRuleValue(id: string, value: string): boolean | null {
  const expected = gameRuleMeta(id)?.default;
  if (expected === undefined) return null;
  return expected === value.trim();
}

export type GameRuleValueCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Normalise and check a value for a rule of this type, before anything is sent.
 *
 * Minecraft would refuse a bad value itself, but it refuses by replying with an error that
 * this route would then have to tell apart from a successful write — and the re-read would
 * report the unchanged value as "didn't apply", which reads like a server fault rather than
 * a typo. Checking first turns that into a 400 that names the problem.
 *
 * Booleans accept `true`/`false` in any case and the JSON primitives, and are sent
 * lowercase because that is the only form `BoolArgumentType` parses.
 *
 * Ints are deliberately strict: `+5`, `5.0`, `1e3`, `0x10` and `007` are all things a
 * number field or a JSON body can produce and none of them is what brigadier's
 * `IntegerArgumentType` reads, so they are refused here rather than sent and lost. The
 * range is int32 because that is what the argument type is. **No per-rule minimum is
 * enforced** — several int rules have one (`randomTickSpeed` and `maxEntityCramming` are
 * documented as clamped at 0) but this change measured none of them, and a guessed bound
 * would refuse a legal value while claiming the game would have. The read-back is what
 * catches a value the game rejects.
 */
export function checkGameRuleValue(value: unknown, type: McGameRuleType): GameRuleValueCheck {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ok: false, error: "A game rule value must be a string, a number or a boolean." };
  }
  const raw = String(value).trim();

  if (type === "boolean") {
    const lower = raw.toLowerCase();
    if (lower !== "true" && lower !== "false") {
      return { ok: false, error: `"${raw}" is not a value for a true/false rule.` };
    }
    return { ok: true, value: lower };
  }

  if (!/^-?\d+$/.test(raw)) {
    return { ok: false, error: `"${raw}" is not a whole number.` };
  }
  // `-0` and a leading-zero form both parse as integers but are not what the game echoes
  // back, so the re-read would report a mismatch for a write that worked. Normalising here
  // keeps the comparison honest.
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) {
    return { ok: false, error: `${raw} is outside the range Minecraft accepts (-2147483648 to 2147483647).` };
  }
  return { ok: true, value: String(n) };
}

/** Only ever these characters, so an id can never carry a second command into RCON. */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The RCON command for a query (no value) or a write.
 *
 * It throws on an unsafe id rather than returning something sendable. The route already
 * refuses any rule that is not in the set the server itself listed, so reaching this is a
 * bug — and a bug here concatenates attacker-controlled text into a console command, which
 * is the one failure mode that must not degrade quietly. Same reasoning as the MC backup
 * route's shell-injection fix.
 */
export function gameRuleCommand(id: string, value?: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe game rule id: ${JSON.stringify(id)}`);
  if (value === undefined) return `gamerule ${id}`;
  if (!/^(true|false|-?\d+)$/.test(value)) {
    throw new Error(`Unsafe game rule value: ${JSON.stringify(value)}`);
  }
  return `gamerule ${id} ${value}`;
}

/**
 * The command that enumerates the rules this build has.
 *
 * **It must be sent with `sendCommandLong`, not `sendCommand`.** Its reply is 5,082 bytes on
 * 26.1.2 and one RCON packet carries 4096, and `rcon-client` keeps the first packet and
 * discards the rest — measured through the live dashboard, which saw the reply cut at exactly
 * 4096 and lost a dozen rules with nothing saying so.
 */
export const MC_GAME_RULE_LIST_COMMAND = "help gamerule";

/**
 * Where to go to set a game rule, in one sentence used by **both** the properties route's
 * refusal and the properties editor's per-field note.
 *
 * Those two used to say "Set it from the console, e.g. `gamerule pvp false`" and "Set it in
 * the console: gamerule pvp false" — two hand-written variants of the same instruction,
 * which is how they would have drifted apart the moment the control they now point at moves.
 * The refusal itself is unchanged: 26.x genuinely does not read those four keys from
 * `server.properties`, so writing them would still be a green toast over nothing.
 */
export function gameRuleControlHint(rules: string[]): string {
  if (rules.length === 0) return "";
  return `Set ${rules.join(", ")} under Game rules on this page.`;
}

/**
 * Group the panel's rows, in declared order, with unknown rules last.
 *
 * Lossless by construction — every id in, every id out exactly once — because a grouped
 * renderer that drops an id it has not heard of is strictly worse than one flat list: the
 * rule is simply absent and nothing says so. Same property `groupMcProperties` is pinned on.
 */
export function groupGameRules(ids: string[]): { title: string; ids: string[] }[] {
  const byGroup = new Map<string, string[]>();
  for (const id of ids) {
    const title = gameRuleMeta(id)?.group ?? MC_GAME_RULE_OTHER_GROUP;
    const list = byGroup.get(title);
    if (list) list.push(id);
    else byGroup.set(title, [id]);
  }
  const out: { title: string; ids: string[] }[] = [];
  for (const title of MC_GAME_RULE_GROUPS) {
    const list = byGroup.get(title);
    if (list && list.length > 0) out.push({ title, ids: list });
  }
  const other = byGroup.get(MC_GAME_RULE_OTHER_GROUP);
  if (other && other.length > 0) out.push({ title: MC_GAME_RULE_OTHER_GROUP, ids: other });
  return out;
}

/**
 * A label for a rule id, for a panel that has to render both spellings legibly.
 *
 * `mobGriefing` and `mob_griefing` both become "Mob griefing", so the live build's
 * spelling does not change how the row reads. The raw id is shown next to it in the UI —
 * it is what you would type in the console, so hiding it would make the panel harder to
 * cross-check, not easier.
 */
export function gameRuleLabel(id: string): string {
  const words = id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
