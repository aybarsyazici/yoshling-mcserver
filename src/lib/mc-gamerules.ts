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
 * was no control. So the dashboard could *detect* a setting it could not change, for 48-odd
 * rules none of which it listed. Production proves someone did it by hand anyway:
 * `server.properties` says `enable-command-block=false` while the world says
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
 * the live build, 48 queries for rules that do not exist, every one answered `Incorrect
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
 * this deployment** — nothing in this change talked to the box. It drives one soft hint
 * ("not the vanilla default", which is how a hand-edited rule like `mob_griefing` becomes
 * visible) and nothing else: no write, no refusal and no ordering depends on it, so a
 * wrong entry misleads a label and cannot misapply a setting. The types are not in that
 * category — `type` is taken from the **live value** by `inferGameRuleType`, so the
 * control rendered for a rule is decided by what the game said, not by this file.
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
  /** Published vanilla default for 1.21.x — see the provenance note above. */
  default: string;
  group: string;
  /** One line, plain, in the imperative-free "what this does" voice the rest of the app uses. */
  help: string;
}

/**
 * Group order for the panel. 48 rules in one flat grid is the thing the properties editor
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
  { id: "playersNetherPortalCreativeDelay", type: "int", default: "1", group: "World & blocks",
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
  { id: "pvp", type: "boolean", default: "true", group: "Damage & death",
    help: "Players can hurt each other. On 26.x this took over from the server.properties key of the same name." },
  { id: "spawn_monsters", type: "boolean", default: "true", group: "Mobs & spawning",
    help: "Hostile mobs spawn. On 26.x this took over from server.properties spawn-monsters." },
  { id: "command_blocks_work", type: "boolean", default: "true", group: "Commands & admin",
    help: "Command blocks run at all. On 26.x this took over from server.properties enable-command-block." },
  { id: "allow_entering_nether_using_portals", type: "boolean", default: "true", group: "World & blocks",
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
 * The rule ids in a `help gamerule` reply.
 *
 * Brigadier's `getSmartUsage` returns one entry per child of the `gamerule` node — one per
 * rule — and `HelpCommand` prints each as `/gamerule <that usage>`, so the reply is a block
 * of lines shaped like:
 *
 *   /gamerule announceAdvancements [<value>]
 *   /gamerule mob_griefing [<value>]
 *
 * **Anything that does not match is skipped rather than guessed at**, which is the one rule
 * this parser follows. A placeholder (`/gamerule <rule>`), a wrapped line, a `Unknown or
 * incomplete command` refusal and a modded id with punctuation in it all produce no entry,
 * so the caller queries only ids it is sure of. The pattern is anchored to
 * letters-then-word-characters for the same reason the id is never interpolated from user
 * input: the token is pasted straight into an RCON command, and a token that cannot contain
 * a space or a semicolon cannot turn one command into two.
 *
 * Order is the server's and duplicates are dropped, so the panel lists rules in the order
 * the build declares them.
 */
export function parseGameRuleList(reply: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\//, "");
    const m = /^gamerule\s+([A-Za-z][A-Za-z0-9_]*)(\s|$)/.exec(line);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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
 * Is this value the published vanilla default? `null` means the table has no entry, which
 * is different from "yes" and must stay different — an unknown rule has to render without
 * the hint, not with a wrong one.
 *
 * This is what makes a hand-edited rule visible. `mob_griefing` is reported false on
 * production with nothing in this app having set it; that is a row the panel can point at
 * only because the default is written down.
 */
export function isDefaultGameRuleValue(id: string, value: string): boolean | null {
  const meta = gameRuleMeta(id);
  if (!meta) return null;
  return meta.default === value.trim();
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

/** The command that enumerates the rules this build has. */
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
