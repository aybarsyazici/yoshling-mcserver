/**
 * Project Zomboid's `Server/<name>_SandboxVars.lua` — parser, validator and writer.
 *
 * This is the file that holds every setting players actually argue about: zombie
 * count and speed, loot rarity, XP rate, day length, when the water and the
 * electricity shut off. 742 options on production (counted 2026-10-01), against
 * the ~138 the dashboard exposed from the `.ini`. Until now the only way to change
 * one was to edit ~1,800 lines of raw Lua in the file browser.
 *
 * ## Everything here is pure text
 *
 * No `fs`, no Lua interpreter, no round-trip through a data model. The file is
 * rewritten **line by line**, in place, and nothing but the one value on the one
 * line changes. That is deliberate: a corrupt SandboxVars.lua is worse than a
 * corrupt `.ini`, because the `.ini` has `.bak-*` copies on the box and this file
 * has none, and because the game reacts to a malformed one by refusing to load
 * the world rather than by complaining about a single setting.
 *
 * ## What was measured on the box, because it decides what the UI may claim
 *
 * All of this is from production on 2026-10-01 (read-only), not from a comment:
 *
 * - **The game writes this file exactly once per run, during startup, and never at
 *   shutdown.** Two consecutive runs, from the server's own DebugLog:
 *   container start 09:57 UTC → `writing …/yoshling_SandboxVars.lua.` at 09:58:37,
 *   then nothing until `Shutdown handling finished.` at 10:54:27; next run start
 *   10:55:37 → write at 10:57:28, and nothing in the 48 minutes after. So an edit
 *   made while the world is up is **not** clobbered by that run — but it is also
 *   not read until the next start. Sandbox options never apply live.
 * - **There is no second copy.** The save directory holds no `map_sand.bin` and no
 *   `<name>_sandbox.ini` (`find`ed, 2026-10-01), so this file is the only source
 *   the server loads sandbox options from. `map_sand.bin` is the single-player path.
 * - **`VERSION` belongs to the game's serialiser.** `zombie/SandboxOptions` has
 *   `    VERSION = 6,` as a literal format string in its constant pool next to
 *   `SandboxVars = {` and `upgradeLuaTable`, i.e. it is the schema version the
 *   writer stamps and the loader migrates from. Writing it from here is how you
 *   tell the game to migrate a file that was never migrated.
 * - **The preset keys are inert.** `Zombies`, `ZombieRespawn` and `ZombieMigrate`
 *   appear in exactly one class in `projectzomboid.jar` — `zombie/SandboxOptions`
 *   itself — while `zombie/popman/ZombiePopulationManager` reads
 *   `PopulationMultiplier`, `PopulationStartMultiplier`, `PopulationPeakMultiplier`,
 *   `PopulationPeakDay`, `RespawnHours`, `RespawnUnseenHours`, `RespawnMultiplier`
 *   and `RedistributeHours` out of the advanced `ZombieConfig` block. And the game
 *   does not reconcile the two: production has `Zombies = 4` ("Normal", whose
 *   documented population multipliers are 0.65/1.0/1.0) sitting next to
 *   `PopulationPeakMultiplier = 1.5` ("High"), and that disagreement survived the
 *   startup rewrite untouched. Offering both as independent controls would be a
 *   control that looks like it works; see `PRESET_ONLY`.
 * - **The file must stay owned by uid 1000.** `docker top` shows the game running
 *   as uid 1000 (`su - steam`) while the web container is root, and the file is
 *   `1000:1000 664`. The startup rewrite above is a `FileWriter` truncate, so a
 *   root-owned 0644 file would make the game unable to persist its own options.
 *   That is why `zomboid-sandbox.ts` restores owner and mode after the rename.
 */

/** The four value shapes PZ's serialiser emits. Anything else is left alone. */
export type SandboxType = "boolean" | "integer" | "float" | "string";

export interface SandboxChoice {
  value: string;
  label: string;
}

export interface SandboxOption {
  /** `Key` at the top level, `Block.Key` inside a table. Unique across the file. */
  name: string;
  /** The value as text: `true`, `0.65`, `4`, or a string's contents unquoted. */
  value: string;
  /** PZ's own `--` comment block above the line, minus the `N = Label` lines. */
  help: string;
  /** The table this option lives in; `""` at the top level. */
  block: string;
  type: SandboxType;
  /** From the comment's own `Min: x Max: y`, when it declares one. */
  min?: number;
  max?: number;
  /** From the comment's own `-- N = Label` lines: PZ documents its enums inline. */
  choices?: SandboxChoice[];
  /** 0-based line index. Writes address this, never a pattern. */
  line: number;
  /** The line's leading whitespace, reproduced verbatim on rewrite. */
  indent: string;
  /** Whether the line ends in a comma. Every line PZ writes does; don't assume it. */
  comma: boolean;
}

const BLOCK_OPEN = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*$/;
const BLOCK_CLOSE = /^(\s*)\}\s*,?\s*$/;
const LEAF = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)(,?)\s*$/;
const COMMENT = /^\s*--\s?(.*)$/;
/** `-- 4 = Normal`. Anchored on a digit so `-- Default = 1 Hour, 30 Minutes` isn't one. */
const CHOICE = /^(\d+)\s*=\s*(.+?)\s*$/;
/** `Min: 0.00 Max: 4.00` — PZ writes both or neither. */
const MINMAX = /\bMin:\s*(-?\d+(?:\.\d+)?)\s+Max:\s*(-?\d+(?:\.\d+)?)/;

/**
 * The game's schema version, stamped by its own serialiser and migrated by
 * `upgradeLuaTable`. Never exposed, never writable — see the header.
 */
export const VERSION_KEY = "VERSION";

/**
 * Character-creation presets with no reader in the game. Hidden rather than shown
 * beside the advanced values they appear to duplicate: the forensics are in the
 * header, and the short version is that the simulation reads `ZombieConfig.*` and
 * nothing reads these, so a dashboard that offered them would be offering a
 * control that saves successfully and changes nothing — this project's defect class.
 */
export const PRESET_ONLY = ["Zombies", "ZombieRespawn", "ZombieMigrate"] as const;

/**
 * Options that describe a world's starting conditions and cannot change one that
 * already exists.
 *
 * Deliberately only the four that were *proved*: `zombie/GameTime` is the only
 * class in `projectzomboid.jar` that reads `getStartYear`/`getStartMonth`/
 * `getStartDay`/`getStartTimeOfDay`, and `GameTime` is also what saves and loads
 * `map_t.bin`, which this save has. So an existing world restores its own clock and
 * these four are inert for it.
 *
 * Nothing else is listed, because nothing else was measured. Guessing a longer list
 * would be the same mistake in the other direction: a caption nobody can trust.
 */
export const CREATION_ONLY = ["StartYear", "StartMonth", "StartDay", "StartTime"] as const;

const PRESET_SET: ReadonlySet<string> = new Set(PRESET_ONLY);
const CREATION_SET: ReadonlySet<string> = new Set(CREATION_ONLY);

export function isPresetOnly(name: string): boolean {
  return PRESET_SET.has(name);
}

export function isCreationOnly(name: string): boolean {
  return CREATION_SET.has(name);
}

/** The sentence appended to a creation-only option's help, so the form says so. */
export const CREATION_ONLY_NOTE =
  "Only applies to a world that does not exist yet: an existing save restores its own " +
  "clock from map_t.bin, so changing this does nothing to the current world.";

function classify(literal: string): { type: SandboxType; value: string } | null {
  if (literal === "true" || literal === "false") return { type: "boolean", value: literal };
  if (/^"[^"\\]*"$/.test(literal)) return { type: "string", value: literal.slice(1, -1) };
  if (/^-?\d+$/.test(literal)) return { type: "integer", value: literal };
  if (/^-?(?:\d+\.\d*|\.\d+)$/.test(literal)) return { type: "float", value: literal };
  // Anything else — a table reference, a quoted string with an escape, a number in
  // exponent form — is not a shape this writer can reproduce, so the option is not
  // exposed at all. Exposing it would offer an edit whose rewrite we cannot predict.
  return null;
}

/**
 * Every option in the file, in file order.
 *
 * Unparseable lines are skipped rather than guessed at, and the structure is tracked
 * by indentation so that `Strength` inside `ZombieLore` and `Strength` inside
 * `MultiplierConfig` are two different options. On production those are
 * `ZombieLore.Strength = 2` (a zombie-damage enum) and `MultiplierConfig.Strength = 1.0`
 * (an XP rate), and `Farming` collides the same way at the top level (`Farming = 3`,
 * a plant-growth enum) with `MultiplierConfig.Farming = 1.0`. A loose
 * `/^\s*Strength = /` would write the wrong option AND change its type.
 */
export function parseSandboxLua(text: string): SandboxOption[] {
  const lines = text.split(/\r?\n/);
  const out: SandboxOption[] = [];
  /** Open tables, innermost last. The root `SandboxVars` is pushed but not named. */
  const stack: { name: string; indent: number }[] = [];
  let root = false;
  let help: string[] = [];
  let choices: SandboxChoice[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const comment = COMMENT.exec(line);
    if (comment) {
      const body = comment[1].trim();
      const choice = CHOICE.exec(body);
      if (choice) choices.push({ value: choice[1], label: choice[2] });
      else if (body) help.push(body);
      continue;
    }

    const open = BLOCK_OPEN.exec(line);
    if (open) {
      const indent = open[1].length;
      if (!root && indent === 0) {
        // `SandboxVars = {`. The root is not part of any option's name.
        root = true;
      } else {
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
        stack.push({ name: open[2], indent });
      }
      help = [];
      choices = [];
      continue;
    }

    const close = BLOCK_CLOSE.exec(line);
    if (close) {
      const indent = close[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      help = [];
      choices = [];
      continue;
    }

    const leaf = LEAF.exec(line);
    if (leaf) {
      const [, indent, key, literal, comma] = leaf;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent.length) stack.pop();
      const shape = classify(literal.trim());
      if (shape) {
        const block = stack.map((s) => s.name).join(".");
        const helpText = help.join(" ").replace(/\s+/g, " ").trim();
        const mm = MINMAX.exec(helpText);
        out.push({
          name: block ? `${block}.${key}` : key,
          value: shape.value,
          help: helpText,
          block,
          type: shape.type,
          ...(mm ? { min: Number(mm[1]), max: Number(mm[2]) } : {}),
          ...(choices.length > 0 ? { choices: [...choices] } : {}),
          line: i,
          indent,
          comma: comma === ",",
        });
      }
      help = [];
      choices = [];
      continue;
    }

    // A blank line or anything unrecognised ends the comment block, so help is never
    // carried across to an option it does not describe.
    help = [];
    choices = [];
  }

  return out;
}

/** Why one value was refused. `name` is the option, `error` is shown to the user. */
export interface SandboxRejection {
  name: string;
  error: string;
}

/**
 * The Lua literal for a new value, or why it is refused.
 *
 * Refusals are the point of this function. The game *clamps* an out-of-range value
 * and *re-serialises* whatever it loaded, so writing `ZombiesCountBeforeDelete = 99999`
 * (Max: 5000) would be accepted by the file, silently clamped by the loader, and
 * read back as 5000 on the next GET — a setting that reports success and does
 * something else. Likewise a type change: `MuscleStrainFactor = true` is valid Lua
 * and gives the world a boolean where it wants a double.
 */
export function formatSandboxValue(
  option: SandboxOption,
  raw: string
): { ok: true; literal: string; value: string } | { ok: false; error: string } {
  const input = String(raw).trim();
  const label = option.name;

  if (option.type === "boolean") {
    if (input !== "true" && input !== "false") {
      return { ok: false, error: `${label} is a true/false option, so "${input}" is not a value it can take.` };
    }
    return { ok: true, literal: input, value: input };
  }

  if (option.type === "string") {
    // A quote or a backslash would need escaping to survive the round trip, and a
    // newline would split the option across two lines — which is how the file stops
    // being loadable at all rather than stops being right.
    if (/["\\]/.test(input) || /[\u0000-\u001f]/.test(input)) {
      return {
        ok: false,
        error: `${label} can't contain a quote, a backslash or a line break.`,
      };
    }
    return { ok: true, literal: `"${input}"`, value: input };
  }

  if (!/^-?(?:\d+|\d+\.\d*|\.\d+)$/.test(input)) {
    return { ok: false, error: `${label} is a number, so "${input}" is not a value it can take.` };
  }
  const n = Number(input);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${label} is a number, so "${input}" is not a value it can take.` };
  }

  if (option.type === "integer" && !Number.isInteger(n)) {
    return { ok: false, error: `${label} is a whole number, so ${input} is not a value it can take.` };
  }

  if (option.choices) {
    // An enum's permitted values are the ones PZ itself listed in the comment above
    // the line. Anything else is clamped or ignored by the loader.
    if (!option.choices.some((c) => Number(c.value) === n)) {
      return {
        ok: false,
        error: `${label} only accepts ${option.choices.map((c) => c.value).join(", ")} — ${input} is not one of them.`,
      };
    }
  } else if (option.min !== undefined && option.max !== undefined) {
    if (n < option.min || n > option.max) {
      return {
        ok: false,
        error: `${label} must be between ${option.min} and ${option.max}; ${input} is outside that, and the game would silently clamp it.`,
      };
    }
  }

  // Keep the game's own shape: a double is written with a decimal point even when the
  // value is whole (`1.0`, not `1`), which is what its serialiser emits.
  const literal =
    option.type === "float" && Number.isInteger(n) ? `${n}.0` : stripLeadingZeroless(input, n);
  return { ok: true, literal, value: literal };
}

/** `.5` → `0.5`, `+`-free, and `-0.60` kept as typed otherwise. */
function stripLeadingZeroless(input: string, n: number): string {
  return /^-?\./.test(input) ? String(n) : input;
}

export interface SandboxWriteResult {
  /** The new file text — identical to the input when `rejected` is non-empty. */
  text: string;
  /** Option names whose line was rewritten. */
  applied: string[];
  /** Option names refused, with the reason. Nothing is written if this is non-empty. */
  rejected: SandboxRejection[];
  /**
   * What each applied option should read back as, i.e. the value `parseSandboxLua`
   * will report once the file is on disk — not the Lua literal, because a string's
   * literal carries quotes the parser strips. The read-back check in
   * `zomboid-sandbox.ts` compares against this.
   */
  written: Record<string, string>;
}

/**
 * Rewrite the given options in place.
 *
 * **All or nothing.** One bad value rejects the whole request and the text comes back
 * byte-identical. A partial write would leave the operator with a file that is half
 * what they asked for and a toast that cannot honestly describe either half — and the
 * panel's "saved N of M" copy says the refused ones "aren't settings this server has",
 * which for an out-of-range value would be a lie.
 */
export function setSandboxValues(
  text: string,
  updates: Record<string, string>
): SandboxWriteResult {
  const options = parseSandboxLua(text);
  const byName = new Map(options.map((o) => [o.name, o]));
  const rejected: SandboxRejection[] = [];
  const edits: { option: SandboxOption; literal: string }[] = [];
  const written: Record<string, string> = {};

  for (const [name, raw] of Object.entries(updates)) {
    if (name === VERSION_KEY) {
      rejected.push({
        name,
        error: "VERSION is the game's own format version, not a setting — it is never written from here.",
      });
      continue;
    }
    if (isPresetOnly(name)) {
      rejected.push({
        name,
        error: `${name} is a character-creation preset that nothing in the game reads; set the advanced ZombieConfig values instead.`,
      });
      continue;
    }
    const option = byName.get(name);
    if (!option) {
      rejected.push({ name, error: `${name} is not an option in this world's sandbox file.` });
      continue;
    }
    const formatted = formatSandboxValue(option, raw);
    if (!formatted.ok) {
      rejected.push({ name, error: formatted.error });
      continue;
    }
    edits.push({ option, literal: formatted.literal });
    written[name] = formatted.value;
  }

  if (rejected.length > 0) return { text, applied: [], rejected, written: {} };

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const applied: string[] = [];
  for (const { option, literal } of edits) {
    const key = option.name.includes(".") ? option.name.slice(option.name.lastIndexOf(".") + 1) : option.name;
    lines[option.line] = `${option.indent}${key} = ${literal}${option.comma ? "," : ""}`;
    applied.push(option.name);
  }

  return { text: lines.join(eol), applied, rejected, written };
}

// ── grouping ────────────────────────────────────────────────────────────────
//
// Which panel an option lands in, and which heading inside it. Same approach as
// `zomboid-all-settings.tsx` takes for the .ini — a short ordered regex table with a
// catch-all — rather than per-setting metadata: the file documents each option itself,
// and a hand-written table of 742 descriptions would be a second source of truth that
// rots. This only decides where a control is drawn.

/**
 * Tables the base game ships. Everything else at table level was added by a mod, and
 * mods are the bulk: measured on production, 742 options total — 253 at the top level
 * plus 86 in these five tables, against 403 across 21 mod tables (`BurdJournals` alone
 * has 182). Splitting them is what keeps the vanilla panel readable, and it is also
 * what keeps it from rendering 742 inputs at once.
 */
export const VANILLA_BLOCKS = [
  "Map",
  "Basement",
  "ZombieLore",
  "ZombieConfig",
  "MultiplierConfig",
] as const;

const VANILLA_BLOCK_SET: ReadonlySet<string> = new Set(VANILLA_BLOCKS);

export type SandboxScope = "world" | "mods";

/**
 * Which panel an option belongs to. Partitioned on the **table** alone, never on the
 * key's spelling: mods do add top-level keys (production has 68, e.g. the
 * `lgd_antibodies_194_*` family), and guessing from an underscore would sort vanilla
 * keys into the mod panel and back again whenever the heuristic met a new name.
 */
export function scopeOf(option: Pick<SandboxOption, "block">): SandboxScope {
  if (option.block === "") return "world";
  return VANILLA_BLOCK_SET.has(option.block.split(".")[0]) ? "world" : "mods";
}

const WORLD_GROUPS: [RegExp, string][] = [
  [/^ZombieConfig\./, "Zombie population"],
  [/^ZombieLore\./, "Zombie behaviour"],
  [/^MultiplierConfig\./, "Skills & XP"],
  [/^(Map|Basement)\./, "Map & buildings"],
  [/^(Zombie|Distribution|Sprinter|MultiHit)/, "Zombie population"],
  [
    /^(DayLength|Start(Year|Month|Day|Time)|DayNightCycle|ClimateCycle|FogCycle|Temperature|Rain|Snow|Storm|Weather|Thunder|Night|MaxFog|MaxRain|TimeSinceApo)/,
    "Time & weather",
  ],
  // Before the utilities rule, which would otherwise claim `Firearm*` on `^Fire`.
  [/^(Firearm|Weapon|AttackBlock|Blood|Wound|Infection)/, "Weapons & combat"],
  [/^(Animal|Farming|Plant|Compost|Grass|Fish|Nature|Clay|KillInsideCrops|PlaceDirt)/, "Farming & animals"],
  [
    /^(WaterShut|ElecShut|AlarmDecay|Erosion|Generator|AllowExteriorGenerator|LightBulb|Fire|MaximumFire)/,
    "Utilities & erosion",
  ],
  [/(Loot|Removal|Container|Rolls|Fridge)/, "Loot"],
  [/^(Multiplier|Xp|XP|Stats|Level(For)?|Construction)/, "Skills & XP"],
  [
    /^(Nutrition|Hunger|Thirst|Fatigue|Endurance|Injury|Bone|Health|Medical|MuscleStrain|Starter|Char|Trait|Food|Cook|Clothing|NoBlack|AllClothes|Discomfort|Sleeping|EndRegen|Poison|EasyClimbing|Maggot)/,
    "Character & survival",
  ],
  [/^(Vehicle|Car|Fuel|Traffic|Gas|Siren|InitialGas|LockedCar|Recently|Rear|DamageToPlayerFromHitByACar|PlayerDamageFromCrash)/, "Vehicles"],
  [/^(Helicopter|Meta|Alarm|Survivor|Zone|Event|Noise|Annotated|Locked|Rat|Maximum)/, "World events"],
];

/**
 * The group heading for an option. **Total by construction**, and that matters more
 * than the grouping does: `config-panel.tsx` renders only the groups named in its
 * `groupOrder` prop, so an option whose group is missing from it is drawn nowhere, with
 * no error and no gap in the page. A silent disappearance is the failure this project
 * keeps paying for, so the fallbacks here are real groups and `groupOrder` lists them.
 */
export function sandboxGroupOf(name: string): string {
  if (!name.includes(".")) {
    for (const [re, group] of WORLD_GROUPS) if (re.test(name)) return group;
    return "Other world options";
  }
  const block = name.slice(0, name.indexOf("."));
  if (VANILLA_BLOCK_SET.has(block)) {
    for (const [re, group] of WORLD_GROUPS) if (re.test(name)) return group;
    return "Other world options";
  }
  // One heading for every mod-added table. The alternative is a heading per mod, which
  // `groupOrder` cannot list because the set is only knowable from the file — and an
  // unlisted heading renders nothing at all.
  return "Mod options";
}

export const WORLD_GROUP_ORDER = [
  "Zombie population",
  "Zombie behaviour",
  "Loot",
  "Time & weather",
  "Utilities & erosion",
  "Character & survival",
  "Weapons & combat",
  "Farming & animals",
  "Skills & XP",
  "Vehicles",
  "World events",
  "Map & buildings",
  "Other world options",
];

export const MOD_GROUP_ORDER = ["Mod options"];

/** The group list a panel must pass, so every option it is given has a heading. */
export function groupOrderFor(scope: SandboxScope): string[] {
  return scope === "mods" ? MOD_GROUP_ORDER : WORLD_GROUP_ORDER;
}
