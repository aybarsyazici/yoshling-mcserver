/**
 * What the generic Project Zomboid settings editor is allowed to write, and what
 * it is allowed to *claim* afterwards.
 *
 * The .ini parser in `lib/zomboid.ts` is fine. What was missing was the contract
 * around it, and every gap was the same gap: the route reported success for work it
 * had not done.
 *
 *   - An unmatched key was **appended** to the file and listed in `applied`, so
 *     `PUT {"Maxplayerz":"99"}` answered `{"applied":["Maxplayerz"]}` and put a line
 *     the game ignores into the config. 7DTD's equivalent route already answered
 *     with an `ignored` array and `config-panel.tsx` already renders one; PZ simply
 *     never sent it.
 *   - The lock list was compared case-sensitively, so `rconpassword` slipped past it
 *     and was appended as a second, game-ignored copy of the control channel's
 *     password.
 *   - The toast said "Restart Project Zomboid to apply" for every key. Measured
 *     against the live server (2026-10-01): the .ini holds 144 keys, and only eight
 *     of them actually need a boot. The other ~136 are picked up by `reloadoptions`
 *     over RCON, so the restart the UI demanded for a `MaxPlayers` change kicked
 *     everyone off for nothing.
 *
 * Everything in this module is pure so it can be tested without a server: the key
 * policy, the `showoptions` reader, and the sentence the UI says.
 */

/**
 * Keys another page owns. The generic editor must not show or write them, because
 * two editors for one setting means one of them silently loses.
 *
 * `Map` is the one that was missing and it was the worst of the three, because
 * editing it there did not merely clobber another view — it could not work at all.
 * `pz/search_folder.sh` regenerates `Map=` on every boot from the maps actually
 * installed under the workshop mount, keeping the saved order but dropping any name
 * it cannot find. So a stock or mistyped name typed into "All settings" was written,
 * reported saved, told to restart, and deleted by that restart; and a name *removed*
 * there came straight back. The Maps card is the owner: it is the only view that
 * knows which names survive.
 *
 * The value is where the user is sent instead, so the refusal names the owner rather
 * than being a bare "not editable".
 */
export const CARD_OWNED_KEYS: Readonly<Record<string, string>> = {
  Map: "the Maps card on the Mods page",
  Mods: "the Mods page",
  WorkshopItems: "the Mods page",
};

/**
 * The only .ini keys a running server cannot pick up from `reloadoptions`.
 *
 * - `Mods`, `WorkshopItems`, `Map` — read once while the world loads.
 * - `DefaultPort`, `UDPPort`, `RCONPort` — sockets are bound at startup.
 * - `ResetID`, `ServerPlayerID` — the soft-reset handshake, compared at connect.
 *
 * The first three are also in `CARD_OWNED_KEYS`, so this editor can never receive
 * them. They stay listed anyway: this answers "does this key need a boot", not "what
 * can that one route be sent", and the Mods and Maps cards ask the same question.
 */
export const RESTART_KEYS: readonly string[] = [
  "Mods",
  "WorkshopItems",
  "Map",
  "DefaultPort",
  "UDPPort",
  "RCONPort",
  "ResetID",
  "ServerPlayerID",
];

const RESTART_SET = new Set(RESTART_KEYS.map((k) => k.toLowerCase()));

/** Of these keys, the ones a reload cannot apply. Case-insensitive, like the locks. */
export function restartKeysIn(names: Iterable<string>): string[] {
  return Array.from(names).filter((n) => RESTART_SET.has(n.toLowerCase()));
}

/**
 * Lowercased key → the spelling the file actually uses.
 *
 * The .ini's keys have fixed capitalisation and the game matches them exactly, so a
 * request saying `mods` means `Mods` — and treating it as a different key is how
 * `rconpassword` got past a lock list keyed on `RCONPassword` and was appended as a
 * new line. Resolving to the file's own spelling first makes every check downstream
 * (locks included) a plain exact-case comparison.
 *
 * A key whose lowercase form appears twice is left out rather than guessed at: the
 * live file has no such pair (checked 2026-10-01 across all 144 keys), but picking
 * one of two arbitrarily would write to whichever happened to sort first.
 */
export function canonicalKeyIndex(fileKeys: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const key of fileKeys) {
    const lower = key.toLowerCase();
    if (index.has(lower) && index.get(lower) !== key) ambiguous.add(lower);
    else index.set(lower, key);
  }
  for (const lower of ambiguous) index.delete(lower);
  return index;
}

/**
 * The file's spelling of a requested name, or `undefined` if the file has no such key.
 *
 * A one-line wrapper so no caller has to remember that the index is keyed on the
 * lowercase form — forgetting that lookup is the same off-by-one-case mistake the index
 * exists to fix, and it would fail *open* at the call site: `index.get("rconpassword")`
 * returning undefined reads as "not a setting", which is exactly the wrong verdict.
 */
export function canonicalKey(
  index: Map<string, string>,
  name: string
): string | undefined {
  return index.get(name.toLowerCase());
}

/**
 * `showoptions` over RCON answers with a header line and then `* Key=Value` per
 * option — measured against the live server 2026-10-01. It is the only way to ask the
 * *game* what it believes, rather than re-reading the file we just wrote, which is
 * what makes "applied" something this app can show instead of assume (the same move
 * the memory card makes with its configured-vs-live comparison).
 *
 * Two measured facts shape the readers below. The game reported all 137 of the keys
 * it lists byte-for-byte identically to the .ini on disk, so a mismatch is a real
 * signal and not formatting noise. And it withholds seven of the file's 144 keys
 * entirely — `Password`, `RCONPassword`, `RCONPort`, `DiscordToken` and the three
 * `Discord*Channel` keys — so "absent from `showoptions`" has to mean *unverifiable*,
 * never *rejected*.
 */
export function parseShowOptions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\*\s*([A-Za-z0-9_]+)\s*=(.*)$/.exec(raw);
    if (!m) continue;
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** The game masks one value it does list (`BadWordReplacement=[HIDDEN]`). */
const MASKED = "[HIDDEN]";

/**
 * Whether the game's reported value is the one we asked for.
 *
 * Deliberately tolerant about *form*, because reporting a false failure is the same
 * defect as reporting a false success wearing the other hat. A number field hands up
 * `70` where the game answers `70.0` (it reports `SpeedLimit`, `FastForwardMultiplier`
 * and the PVP damage modifiers with a decimal), and PZ writes its `;`-separated lists
 * with a trailing separator that a user retyping the value will not.
 */
export function sameOptionValue(want: string, got: string): boolean {
  const norm = (v: string) => v.trim().replace(/;$/, "").trim();
  const a = norm(want);
  const b = norm(got);
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase() && /^(true|false)$/i.test(a)) return true;
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return false;
}

/** How a saved key fared once the game had been asked to reload its options. */
export interface PzLiveReload {
  /** The server answered `reloadoptions`. Measured reply: `Options reloaded`. */
  reloaded: boolean;
  /** `showoptions` now reports these at the value we wrote. Proven live. */
  verified: string[];
  /** Reloaded, but the game does not report these back at all, so unprovable. */
  unverified: string[];
  /** The game still reports a different value — the reload did not take these. */
  stale: string[];
}

/** Bucket the keys we wrote against what the game says it is now using. */
export function classifyLiveOptions(
  expect: Record<string, string>,
  live: Map<string, string>
): Pick<PzLiveReload, "verified" | "unverified" | "stale"> {
  const verified: string[] = [];
  const unverified: string[] = [];
  const stale: string[] = [];
  for (const [name, want] of Object.entries(expect)) {
    const got = live.get(name);
    if (got === undefined || got === MASKED) unverified.push(name);
    else if (sameOptionValue(want, got)) verified.push(name);
    else stale.push(name);
  }
  return { verified, unverified, stale };
}

/** Exactly what `PUT /api/zomboid/config` answers with. */
export interface PzIniSaveReport {
  /** Keys the file had, and which were rewritten in place. */
  applied: string[];
  /** Keys this server's .ini does not have. Nothing was written for them. */
  ignored: string[];
  /** Keys another page owns, or this deployment's own. Nothing was written. */
  locked: string[];
  /** Of `applied`, the ones only a boot can pick up. */
  restartNeeded: string[];
  /** `null` when RCON did not answer — the world is down, so there is nothing live. */
  live: PzLiveReload | null;
}

/**
 * The sentence the UI says, built from what the route actually did.
 *
 * Pure and tested rather than assembled inline, for the reason `docs/OPERATIONS.md`
 * gives for `concludeOperation`: this project's recurring defect is a success message
 * nobody checked against the facts. The rule this encodes is one assertion wide — **the
 * word "live" may appear only when `live.verified` is non-empty, and "Saved N" only when
 * N keys were really rewritten** — and the suite breaks both on purpose to prove they bite.
 */
export function describeIniSave(report: PzIniSaveReport): {
  tone: "success" | "warning" | "error";
  message: string;
} {
  const { applied, ignored, locked, restartNeeded, live } = report;

  const refusals: string[] = [];
  if (ignored.length > 0) {
    refusals.push(
      `${ignored.join(", ")} ${ignored.length === 1 ? "is not a setting" : "are not settings"} this server has`
    );
  }
  if (locked.length > 0) {
    refusals.push(`${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} managed elsewhere`);
  }
  const refusal = refusals.length > 0 ? ` ${refusals.join("; ")}, so nothing was written for ${refusals.length === 1 ? "it" : "them"}.` : "";

  if (applied.length === 0) {
    return {
      tone: refusal ? "warning" : "error",
      message: `Nothing was saved.${refusal || " The server applied none of those settings."}`,
    };
  }

  const count = `Saved ${applied.length} setting${applied.length === 1 ? "" : "s"}.`;

  // The restart list first: it is the one case where the user has to do something.
  const boot =
    restartNeeded.length > 0
      ? ` ${restartNeeded.join(", ")} ${restartNeeded.length === 1 ? "needs" : "need"} a restart to take effect.`
      : "";

  // Every key saved needs a boot anyway, so there is no live state to talk about and
  // `live` being null here says nothing about whether the server is up. Checked before
  // the `live === null` branch for exactly that reason: the route skips the RCON round
  // trip when nothing it wrote is reloadable, and reading that as "the server is not
  // running" would be a confident claim about something never measured.
  if (restartNeeded.length === applied.length) {
    return { tone: refusal ? "warning" : "success", message: `${count}${boot}${refusal}` };
  }

  if (live === null) {
    // No RCON, so the world is down or wedged. Nothing to reload and nothing to prove —
    // and saying "restart to apply" here would be wrong in the other direction, since
    // the file is read on the way up either way.
    return {
      tone: "success",
      message: `${count} The server is not running, so it will read them when it next starts.${refusal}`,
    };
  }

  if (!live.reloaded) {
    return {
      tone: "warning",
      message: `${count} The server did not confirm a reload, so restart Project Zomboid to be sure they are in effect.${refusal}`,
    };
  }

  const liveBits: string[] = [];
  if (live.verified.length > 0) {
    liveBits.push(
      `${live.verified.length === applied.length && live.stale.length === 0 && live.unverified.length === 0 ? "They are" : `${live.verified.join(", ")} ${live.verified.length === 1 ? "is" : "are"}`} live now — the server reports the new value.`
    );
  }
  if (live.stale.length > 0) {
    liveBits.push(
      `${live.stale.join(", ")} ${live.stale.length === 1 ? "is" : "are"} still reported at the old value, so ${live.stale.length === 1 ? "it needs" : "they need"} a restart.`
    );
  }
  if (live.unverified.length > 0) {
    liveBits.push(
      `The server does not report ${live.unverified.join(", ")} back, so ${live.unverified.length === 1 ? "that one" : "those"} could not be confirmed.`
    );
  }

  const tone: "success" | "warning" =
    live.stale.length > 0 || refusal || live.verified.length === 0 ? "warning" : "success";

  return { tone, message: `${count}${boot} ${liveBits.join(" ")}${refusal}`.replace(/\s+/g, " ").trim() };
}
