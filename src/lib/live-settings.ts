import type { GameId } from "@/lib/games";
import { parseShowOptions } from "@/lib/zomboid-ini-contract";

/**
 * Configured-versus-live, generalised.
 *
 * `MemoryCard` already does this for one value: it shows the heap the compose file asks
 * for next to the heap the container was actually created with, and warns when they
 * disagree — so "applied" is something you can see rather than assume. CLAUDE.md names
 * that as the pattern to copy, because **this project's recurring defect is "reports
 * success after doing nothing or the wrong thing"**, not crashes. Three paid instances:
 * two 7 Days to Die quick settings wrote XML properties that do not exist and said
 * "Settings saved." for months; Project Zomboid's map-order card wrote the `.ini` and the
 * restart put it back; Minecraft's whitelist wrote `uuid: ""`, which matches nobody,
 * behind a green toast. In every case the file on disk said one thing and the running
 * game another, and nothing in the dashboard ever asked the game.
 *
 * Everything here is pure: parsers for what each game answers, and the comparison. The
 * transport lives in `game-manager.ts` (`liveSettings()`), so it can be tested without
 * Docker, a network or a running server — the constraint the whole suite is built on.
 *
 * **The hard part is honesty about what cannot be compared.** An amber "configured does
 * not match live" chip for a server that is simply stopped would be a *new* false claim,
 * and two of the three worlds are stopped at any moment. So the verdict type has four
 * cases, not two, and `unknown` is the default everywhere evidence is missing.
 */

/** What one game answered when asked what it is running. */
export interface LiveSettings {
  game: GameId;
  /** True only when the game answered and `values` is trustworthy. */
  available: boolean;
  /** Why not, in words a user can act on. Set whenever `available` is false. */
  reason?: string;
  /** Live setting name → value, as the game printed it. */
  values: Record<string, string>;
  /** Server clock when the probe ran, so a UI can say how fresh this is. */
  readAt: number;
}

export type LiveVerdict =
  /** The game is running this value. */
  | { kind: "agrees"; live: string }
  /** The game is running something else — the file has not reached it. */
  | { kind: "disagrees"; live: string }
  /**
   * No evidence either way. Never rendered as a mismatch.
   *
   * `why` is a code and `reason` the sentence, because the three unknowns are not
   * interchangeable: "the game does not report this key" belongs on the field, while
   * "the server is stopped" belongs once at the top of the page rather than on all 137
   * rows. A UI that had to tell them apart by matching on the sentence would re-break the
   * moment the wording improved.
   */
  | { kind: "unknown"; why: "not-read" | "unreadable" | "not-reported"; reason: string }
  /** Read only when a world is created, so the live value answers a different question. */
  | { kind: "next-world" };

/**
 * Settings the game reads only when it creates a world.
 *
 * Comparing these is meaningless even when the game *does* report a value, because the
 * live one belongs to the world that already exists and the configured one to the next
 * world. Reporting that as a disagreement would be exactly the kind of confident false
 * statement this feature exists to remove — so they get their own verdict and are
 * labelled, rather than silently omitted: **silence is how someone concludes the
 * comparison covers everything.**
 *
 * Matched case-insensitively because the three games disagree about case
 * (`level-seed` vs `ResetID` vs `GameWorld`).
 *
 * Deliberately only the keys this round could justify. 7DTD's `WorldGenSeed` and
 * `WorldGenSize` are plausible members — the XML's own comment says they apply "If RWG …
 * If a world with the resulting name already exists it will simply load it" — but nothing
 * here measured that, and marking a key next-world *suppresses* a real disagreement. An
 * unproven suppression is worse than an unproven chip.
 */
const CREATION_ONLY: Record<GameId, readonly string[]> = {
  // server.properties: the seed and generator are baked into the world on first run, and
  // the datapack lists are "initial-" by name.
  minecraft: ["level-seed", "level-type", "initial-enabled-packs", "initial-disabled-packs"],
  // GameWorld/GameName name the save. Both ARE reported by `getgamepref` (measured on
  // production 2026-10-01: `GamePref.GameWorld = Reveo Valley`, `GamePref.GameName =
  // Fresh2`), which is precisely why they need this case: the live value is readable and
  // comparing it still answers the wrong question.
  "7dtd": ["GameWorld", "GameName"],
  // Also reported live (`* ResetID=4389967`): it is the token clients check against the
  // world they already have, so a new value only means anything to the next world.
  zomboid: ["ResetID"],
};

export function isCreationOnly(game: GameId, name: string): boolean {
  const lower = name.toLowerCase();
  return CREATION_ONLY[game].some((k) => k.toLowerCase() === lower);
}

/** The words a UI puts on a `next-world` verdict, in one place for all three games. */
export const NEXT_WORLD_LABEL = "applies to the next world";

/**
 * Key names whose value never goes on the wire, however the probe behaves.
 *
 * Measured 2026-10-01: neither probe returns one today — `getgamepref` omits all eight of
 * `sdtdserver.xml`'s deployment keys (`ServerPassword`, `TelnetPassword`, `TelnetPort`,
 * `TelnetEnabled`, `TelnetFailedLoginLimit`, `TelnetFailedLoginsBlocktime`,
 * `AdminFileName`, `UserDataFolder`), and PZ's `showoptions` returns 137 of the `.ini`'s
 * 144 keys, the 7 missing ones being exactly `Password`, `RCONPassword`, `RCONPort`,
 * `DiscordToken` and the three Discord channel names. So this is defence against a future
 * game build widening its own output, not a leak being plugged.
 *
 * **`password`, not `pass`.** `SafehouseAllowTrepass` is a real Project Zomboid setting
 * and a naive `/pass/i` would delete it from the comparison, which would show as a
 * permanent "the server doesn't report this one" on a key the server reports fine.
 */
const SECRET_KEY_RE = /password|passwd|token|secret/i;

export function redactSecretKeys(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (!SECRET_KEY_RE.test(k)) out[k] = v;
  return out;
}

const BOOLEAN_WORDS: Record<string, boolean> = { true: true, false: false };

/** Strict decimal, so `26.1.2` and `1e3` stay strings and are compared as text. */
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Whether the configured value and the live value are the same value.
 *
 * Three coercions, each one measured rather than imagined:
 *
 * - **Boolean words, case-insensitively.** `getgamepref` prints `True`/`False` while
 *   `sdtdserver.xml` stores `true`/`false`. Measured on production 2026-10-01: of the 61
 *   keys both sides report, **11 differed as raw strings and all 11 were exactly this** —
 *   so without the coercion the panel's first impression of a healthy server would be
 *   eleven amber chips.
 * - **Numbers numerically**, so `"20"` from `server.properties` equals the `20` the live
 *   reader parsed out of `list`, and `40.0` equals `40`. Leading zeros agreeing is
 *   correct here, not a bug: the live side is the game's own re-serialisation of the value
 *   it parsed, so `007` and `7` really are the same setting.
 * - **Nothing else.** `1`/`0` are deliberately NOT booleans: 7 Days to Die has
 *   `GameDifficulty = 1`, and a coercion that read `1` as `true` would call that equal to
 *   a live `True` from some other key's shape. The project's defect class is false
 *   agreement; a coercion that is only usually right manufactures exactly that.
 *
 * Strings otherwise compare exactly (after trimming). Case-folding strings would make
 * `ServerName=yoshling` agree with a live `Yoshling`, which is a genuine difference — the
 * one place case had to be folded (Minecraft prints `Hard` for `difficulty=hard`) is
 * folded in the *reader*, where the enum is known, instead of here where it is not.
 */
export function valuesAgree(configured: string, live: string): boolean {
  const a = configured.trim();
  const b = live.trim();
  if (a === b) return true;

  const ab = BOOLEAN_WORDS[a.toLowerCase()];
  const bb = BOOLEAN_WORDS[b.toLowerCase()];
  if (ab !== undefined || bb !== undefined) return ab !== undefined && ab === bb;

  if (NUMERIC_RE.test(a) && NUMERIC_RE.test(b)) return Number(a) === Number(b);

  return false;
}

/** Reasons a single key has no verdict, as sentences rather than codes. */
export const NOT_REPORTED_REASON =
  "The server doesn't report this setting, so it can't be compared with what it is running.";
const NOT_READ_REASON = "The live settings haven't been read yet.";

/**
 * One key's verdict. The order of the guards is the honesty contract:
 *
 * 1. a creation-only key is never a disagreement, even with a live value in hand;
 * 2. **no probe, or a failed probe, is `unknown`** — never `disagrees`. Two of the three
 *    worlds are stopped at any moment, so getting this backwards would put an amber
 *    "configured does not match live" chip on every row of a stopped server's settings
 *    page and make the feature worse than not having it;
 * 3. a key the game does not report is `unknown` too, and says so — measured, that is 8
 *    keys for 7DTD and 7 for PZ, all of them deployment/secret keys.
 */
export function compareSetting(
  game: GameId,
  name: string,
  configured: string,
  live: LiveSettings | null
): LiveVerdict {
  if (isCreationOnly(game, name)) return { kind: "next-world" };
  if (!live) return { kind: "unknown", why: "not-read", reason: NOT_READ_REASON };
  if (!live.available) {
    return {
      kind: "unknown",
      why: "unreadable",
      reason: live.reason || "The live settings couldn't be read.",
    };
  }
  const liveValue = live.values[name];
  if (liveValue === undefined) {
    return { kind: "unknown", why: "not-reported", reason: NOT_REPORTED_REASON };
  }
  return valuesAgree(configured, liveValue)
    ? { kind: "agrees", live: liveValue }
    : { kind: "disagrees", live: liveValue };
}

export interface LiveComparison {
  /** Keys where the file and the game genuinely differ. */
  disagreeing: string[];
  /** Keys compared and matching. */
  agreeing: number;
  /** Keys the game does not report, so nothing can be said about them. */
  notReported: number;
  /** Keys that only take effect on a new world. */
  nextWorld: number;
}

/** Every verdict for a panel's worth of settings, for the one-line summary. */
export function compareSettings(
  game: GameId,
  props: readonly { name: string; value: string }[],
  live: LiveSettings | null
): LiveComparison {
  const out: LiveComparison = { disagreeing: [], agreeing: 0, notReported: 0, nextWorld: 0 };
  for (const p of props) {
    const v = compareSetting(game, p.name, p.value, live);
    if (v.kind === "disagrees") out.disagreeing.push(p.name);
    else if (v.kind === "agrees") out.agreeing += 1;
    else if (v.kind === "next-world") out.nextWorld += 1;
    else if (v.why === "not-reported") out.notReported += 1;
  }
  return out;
}

/**
 * The sentence the settings panel shows above the fields.
 *
 * One function so the three states cannot be worded three ways on three pages — the
 * three-copies drift `docs/OPERATIONS.md` records for the power control. Returns the tone
 * with the text, because the amber wash must only ever appear on a real disagreement.
 */
export function liveSummaryLine(
  cmp: LiveComparison,
  live: LiveSettings | null
): { tone: "warn" | "muted"; text: string } | null {
  if (!live) return null;
  if (!live.available) {
    return { tone: "muted", text: live.reason || "The live settings couldn't be read." };
  }
  const tail =
    (cmp.notReported > 0
      ? ` ${cmp.notReported} the server doesn't report, so ${
          cmp.notReported === 1 ? "it isn't" : "they aren't"
        } compared.`
      : "") +
    (cmp.nextWorld > 0 ? ` ${cmp.nextWorld} ${NEXT_WORLD_LABEL}.` : "");

  if (cmp.disagreeing.length > 0) {
    const n = cmp.disagreeing.length;
    return {
      tone: "warn",
      text:
        `${n} setting${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} saved here but not ` +
        `running on the server: ${cmp.disagreeing.join(", ")}.` +
        tail,
    };
  }
  return {
    tone: "muted",
    text: `${cmp.agreeing} setting${cmp.agreeing === 1 ? "" : "s"} match what the server is running.${tail}`,
  };
}

// ── what each game answers ──────────────────────────────────────────────────

/**
 * 7 Days to Die `getgamepref`, over one telnet session.
 *
 * Captured from production 2026-10-01: 155 lines — one `INF Executing command
 * 'getgamepref' by Telnet from …` echo, **153** `GamePref.<Name> = <Value>` lines and a
 * trailing blank. Anything that is not a `GamePref.` line is skipped rather than guessed
 * at, so the echo line and telnet's own banner cannot become settings.
 *
 * An empty value is kept (`GamePref.ServerDescription = ` is a real, empty setting);
 * dropping it would turn "the server runs this as empty" into "can't be compared".
 */
export function parseGamePrefs(out: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*GamePref\.([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim();
  }
  return values;
}

/**
 * Project Zomboid `showoptions`, over RCON.
 *
 * Captured from production 2026-10-01: a `List of Server Options:` header then 137 lines
 * of `* Key=Value`, 6,774 bytes. The split is on the FIRST `=` — `ServerWelcomeMessage`
 * and `ClientCommandFilter` both carry further characters that must stay in the value.
 *
 * **Delegates rather than re-parsing.** This file briefly had its own copy of the regex,
 * and the two were not the same: `parseShowOptions` tolerates `* Key =Value` and this one
 * did not. One wire format parsed two ways means the save report and the live-settings
 * chip could disagree about whether a key *exists*, which is worse than either being
 * wrong — a missing key reads as "not reported" in one view and as a value in the other.
 * `zomboid-ini-contract.ts` owns the format (it has the measurements and the 137/144
 * accounting); this is the `Record` shape the generic live-settings layer wants.
 */
export function parsePzOptions(out: string): Record<string, string> {
  return Object.fromEntries(parseShowOptions(out));
}

/**
 * Minecraft `difficulty` → the live difficulty, as `server.properties` spells it.
 *
 * Measured 2026-10-01: the reply is `The difficulty is Hard` (22 bytes) while the file
 * says `difficulty=hard`. The lowercasing happens HERE, where the value is known to be an
 * enum, rather than in `valuesAgree` — a case-insensitive string compare for everything
 * would also make a renamed server agree with its old name.
 */
export function parseMcDifficulty(out: string): string | null {
  const m = /difficulty is (\w+)/i.exec(out);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Minecraft `list` → the live player cap.
 *
 * Measured 2026-10-01: `There are 0 of a max of 20 players online: `. The cap is the one
 * `max-players` fact the running server will admit to, and it is the value a stale
 * `server.properties` edit silently fails to change.
 */
export function parseMcMaxPlayers(out: string): string | null {
  const m = /max of (\d+) players/i.exec(out);
  return m ? m[1] : null;
}

/**
 * Which game a settings endpoint belongs to.
 *
 * `ConfigPanel` is shared by 7 Days to Die and Project Zomboid and is handed an endpoint,
 * not a game — and the two wrapper components that could pass one belong to other
 * workstreams. Inference keeps this to one file; an explicit `game` prop still wins when
 * a caller passes it. Returning `null` turns the comparison OFF rather than guessing a
 * game, because a verdict computed against the wrong game's live values would be the
 * confident-wrong-answer failure again.
 */
export function gameFromConfigEndpoint(endpoint: string): GameId | null {
  // Project Zomboid's SANDBOX is a different config surface from its `.ini`, and there is
  // nothing live to compare it against — so it must not be compared at all.
  //
  // Caught in integration, as a clean merge of two correct branches. `ZomboidSandbox` passes
  // no `game`, so this function inferred `zomboid` from the path and ConfigPanel compared
  // `SandboxVars.lua` option names against PZ's RCON `showoptions`, which reports the `.ini`.
  // Measured over the real production files: of 742 sandbox options, 737 rendered a false
  // "the server doesn't report this" chip, the summary asserted a sandbox option was
  // "running", and `BloodSplatLifespanDays` — the one name that exists in BOTH files — got a
  // permanent amber "saved here but not running on the server" that no restart could clear.
  // All of it under the card's own correct heading that nothing there applies while the
  // server is running.
  //
  // A brand-new honesty feature making a false claim about 742 settings is the exact defect
  // class this run set out to close, so the opt-out is explicit rather than a `game` prop
  // someone has to remember to omit.
  if (endpoint.startsWith("/api/zomboid/sandbox")) return null;
  if (endpoint.startsWith("/api/7dtd/")) return "7dtd";
  if (endpoint.startsWith("/api/zomboid/")) return "zomboid";
  // The Minecraft routes predate the per-game namespace and are still `/api/server/*`.
  if (endpoint.startsWith("/api/server/")) return "minecraft";
  return null;
}
