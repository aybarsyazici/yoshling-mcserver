import { isValidMcName, isValidUuid } from "@/lib/mc-identity";

/**
 * Minecraft ban lists: the two json files, the RCON replies, and — the part that
 * decides whether a ban is real — *which of the two paths a change has to take*.
 *
 * ## Why there are two paths at all, and why picking wrong is silent
 *
 * The game keeps both ban lists **in memory** and rewrites `banned-players.json` /
 * `banned-ips.json` from that memory whenever a ban changes. That the file is written
 * from memory is not a guess: it is the only way `/ban` survives a restart at all, and
 * the only way the file ends up holding the `created` / `source` / `expires` fields no
 * dashboard ever typed. The consequence is the whole reason this module exists:
 *
 *   - **Server up → the file is downstream.** Editing it changes nothing now, and the
 *     next time the server rewrites its list our edit is gone. A green toast over that
 *     is exactly the defect class `CLAUDE.md` names ("reports success after doing
 *     nothing"), in its most expensive form, because the person being banned keeps
 *     playing.
 *   - **Server down → the file is the only store.** There is no RCON socket to talk to,
 *     and the list the game loads at boot is what is on disk.
 *
 * So: running → RCON, stopped → file, and **never a fall-back from one to the other**.
 * `routeBanChange` is that decision, in one tested place.
 *
 * ## What is measured here and what is not
 *
 * Nothing in this file has been exercised against the live 26.1.2 server — this was
 * written offline, and the honest consequence is that **every reply-string match below
 * is advisory and the read-back is what decides an outcome**. The reply formats come
 * from vanilla's command feedback (`commands.banlist.list` → "There are %s ban(s):",
 * `commands.banlist.entry` → "%s was banned by %s: %s", `commands.ban.success` →
 * "Banned %s: %s"), which are translation strings and therefore version- and
 * locale-dependent. A parser built on them *will* eventually stop matching, so the
 * design makes that case say "could not confirm" rather than "done".
 *
 * That cuts both ways and is the second thing to know about the read-back: **`reason` and
 * `source` are free text the server echoes straight back into the `banlist` reply.** So the
 * reply is not a trusted document — part of it is operator input, and anything that reads it
 * has to read *structure* rather than search text. `banlistLists` does, `banlistUsable` says
 * when the structure is recoverable at all, and nothing matches on the raw buffer.
 *
 * ## Deliberately not supported
 *
 * **Temporary bans.** `banned-players.json` has an `expires` field, but vanilla's
 * `/ban` has no duration argument — so a timed ban would only be settable while the
 * server is *stopped*, and the same control would silently become permanent-only once
 * it was running. A control that means two different things depending on power state is
 * worse than one that does less. Every entry written here is `expires: "forever"`.
 */

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * A single octet: no leading zeros, 1-3 digits.
 *
 * Leading zeros are rejected rather than tolerated because `010` is octal to
 * `inet_aton` and decimal to a naive parser, so `127.000.000.001` is an entry whose
 * meaning depends on who reads it. An address that may or may not match the peer it
 * was meant to block is the silent-nothing failure with extra steps.
 */
const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;

export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => IPV4_OCTET.test(p) && Number(p) <= 255);
}

/**
 * A syntactically valid IPv6 address, with `::` compression and an optional trailing
 * dotted-quad (`::ffff:127.0.0.1`).
 *
 * This exists to make the *refusal* precise, not to admit v6 — see `checkBanTarget`.
 * Telling "that is an IPv6 address, which this does not handle" apart from "that is
 * not an address" is the difference between a user fixing a typo and a user retyping
 * a correct value five times.
 *
 * A zone id (`fe80::1%eth0`) is refused outright: it is scoped to one interface and
 * is never the thing a remote peer is identified by.
 */
export function isValidIpv6(value: string): boolean {
  if (value.length === 0 || value.includes("%")) return false;

  const halves = value.split("::");
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;

  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = compressed ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const groups = [...head, ...tail];

  // A dotted-quad tail stands in for the last two 16-bit groups.
  let need = 8;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes(".")) {
    if (!isValidIpv4(last)) return false;
    groups.pop();
    need = 6;
  }

  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  // `::` stands for at least one group, so a compressed address must be short of the
  // full count; an uncompressed one must hit it exactly.
  return compressed ? groups.length <= need - 1 : groups.length === need;
}

/** Trim and case-fold, so `banned-ips.json` can be compared by string equality. */
export function normalizeIp(value: string): string {
  return value.trim().toLowerCase();
}

// ── Reasons ─────────────────────────────────────────────────────────────────

/** What vanilla itself puts in `reason` when a ban is issued without one. */
export const DEFAULT_BAN_REASON = "Banned by an operator.";

/** Longer than this and the banlist line it produces is unreadable in the reply. */
const MAX_REASON_LENGTH = 150;

/** What goes in `source` when the dashboard cannot name the user who issued the ban. */
export const DEFAULT_BAN_SOURCE = "Dashboard";

const MAX_SOURCE_LENGTH = 40;

/** One line of printable text, collapsed and capped. Shared by `reason` and `source`. */
function flatten(raw: string, max: number): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Flatten a reason to one line of printable text.
 *
 * **The risk being managed here is not shell injection and not RCON injection.**
 * Minecraft's RCON carries one command per packet with no separator to escape, and
 * `ban <targets> [<reason>]` takes the reason as a greedy trailing string — so there is
 * nothing after it for a crafted value to become. Two real hazards remain:
 *
 *   1. A newline in the reason produces an extra line in the `banlist` reply, which is
 *      indistinguishable from a second ban entry. That corrupts this module's own
 *      read-back — i.e. it breaks the thing that decides whether we claim success.
 *   2. The reason is persisted into json the game parses at boot. Control characters
 *      there are a liability for no benefit.
 */
export function sanitizeBanReason(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_BAN_REASON;
  const flat = flatten(raw, MAX_REASON_LENGTH);
  return flat.length === 0 ? DEFAULT_BAN_REASON : flat;
}

/**
 * The `source` field — who issued the ban. Same flattening as a reason and for the same
 * two reasons (it is persisted into json the game parses, and it is echoed back inside
 * the `banlist` line this module has to read), but a different fallback: a blank display
 * name must not become "Banned by an operator." in the column that is supposed to say
 * *which* operator.
 */
export function sanitizeBanSource(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_BAN_SOURCE;
  const flat = flatten(raw, MAX_SOURCE_LENGTH);
  return flat.length === 0 ? DEFAULT_BAN_SOURCE : flat;
}

// ── Targets ─────────────────────────────────────────────────────────────────

export type BanKind = "player" | "ip";

export type BanTargetCheck =
  | { ok: true; kind: BanKind; target: string }
  | { ok: false; error: string };

/**
 * The one gate every ban and pardon passes through: validate the kind, validate and
 * normalise the target, or say precisely what is wrong with it.
 *
 * IPv6 is **refused**, and the reason is worth stating plainly rather than hiding in a
 * generic "invalid address": whether the running server matches a v6 peer against
 * `banned-ips.json` has not been verified on this box, and an entry we cannot show is
 * enforced is a ban that silently does nothing. Refusing it with a sentence that names
 * the alternative (ban the account instead) is the honest version of not knowing.
 */
export function checkBanTarget(kind: unknown, target: unknown): BanTargetCheck {
  if (kind !== "player" && kind !== "ip") {
    return { ok: false, error: 'Expected kind to be "player" or "ip".' };
  }
  if (typeof target !== "string") {
    return { ok: false, error: "Expected a name or an IP address." };
  }

  if (kind === "player") {
    const name = target.trim();
    // Same `/^\w{1,16}$/` the ops and whitelist routes use, via `mc-identity`, so the
    // three cannot disagree about what a username is.
    if (!isValidMcName(name)) {
      return { ok: false, error: `"${name}" is not a valid Minecraft username.` };
    }
    return { ok: true, kind, target: name };
  }

  const ip = normalizeIp(target);
  if (isValidIpv4(ip)) return { ok: true, kind, target: ip };
  if (isValidIpv6(ip)) {
    return {
      ok: false,
      error:
        `${ip} is an IPv6 address. Only IPv4 addresses can be banned here, because ` +
        `whether the server enforces an IPv6 entry hasn't been confirmed — ban the ` +
        `account by name instead.`,
    };
  }
  return { ok: false, error: `"${target}" is not an IPv4 address.` };
}

// ── The json files ──────────────────────────────────────────────────────────

export interface BannedPlayerEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

export interface BannedIpEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

/**
 * The literal vanilla writes into `expires` for a permanent ban, and therefore the one
 * value we know the game reads back as "no expiry".
 */
export const BAN_FOREVER = "forever";

/**
 * `yyyy-MM-dd HH:mm:ss Z` — the `SimpleDateFormat` both ban files use.
 *
 * Always emitted in UTC (`+0000`). The game writes its own container-local offset, but
 * the format carries the offset explicitly, so the two forms are the same instant and
 * no conversion is implied. Pinning UTC means this function has no dependence on the
 * web container's `TZ`, which is one fewer thing that differs between a laptop test and
 * the box.
 */
export function mcBanDate(when: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getUTCFullYear()}-${p(when.getUTCMonth() + 1)}-${p(when.getUTCDate())} ` +
    `${p(when.getUTCHours())}:${p(when.getUTCMinutes())}:${p(when.getUTCSeconds())} +0000`
  );
}

/**
 * The inverse, for sorting and display. Returns `null` for anything that is not that
 * format — including `"forever"`, which is the point: a caller that treats a failed
 * parse as "expired" would un-ban everyone.
 */
export function parseMcBanDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
    value.trim()
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const when = new Date(utc - offsetMinutes * 60_000);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * Attach an ISO `created` for the browser to render.
 *
 * The parsing stays here rather than in the settings page because `mc-bans` reaches
 * `mc-identity` for its username and UUID checks, and that module pulls in `crypto` and
 * `fs/promises` — importing any of it from a `"use client"` component puts node builtins
 * in the browser bundle. A client needs a date it can format, not a Java
 * `SimpleDateFormat` parser, so the conversion belongs on this side of the wire and the
 * page imports only types.
 *
 * `null` rather than a guess for anything unparseable: the files on the box were written
 * by an unknown chain of versions, and a fabricated date in an audit column is worse than
 * a blank one.
 */
export function withCreatedIso<T extends { created: string }>(
  entries: T[]
): (T & { createdIso: string | null })[] {
  return entries.map((e) => ({ ...e, createdIso: parseMcBanDate(e.created)?.toISOString() ?? null }));
}

/**
 * Build the entry for a player ban. `uuid` is deliberately left blank here and filled
 * in by `resolveEntryUuids` before anything is written — see `serializePlayerBans`,
 * which refuses a blank one so the path cannot be skipped.
 */
export function buildPlayerBan(opts: {
  name: string;
  source: string;
  reason?: unknown;
  now?: Date;
}): BannedPlayerEntry {
  return {
    uuid: "",
    name: opts.name,
    created: mcBanDate(opts.now ?? new Date()),
    source: opts.source,
    expires: BAN_FOREVER,
    reason: sanitizeBanReason(opts.reason),
  };
}

export function buildIpBan(opts: {
  ip: string;
  source: string;
  reason?: unknown;
  now?: Date;
}): BannedIpEntry {
  return {
    ip: normalizeIp(opts.ip),
    created: mcBanDate(opts.now ?? new Date()),
    source: opts.source,
    expires: BAN_FOREVER,
    reason: sanitizeBanReason(opts.reason),
  };
}

/**
 * Read either ban file tolerantly, and **count what was unreadable** instead of
 * quietly dropping it.
 *
 * The count is the whole reason this returns a pair. A file with one malformed entry
 * would otherwise render as a shorter list with no indication, and "the ban I added is
 * missing from the page" would look like the page losing it rather than the file having
 * a problem. The route reports the number.
 */
export interface ParsedBanFile<T> {
  entries: T[];
  /** Entries that were present but unreadable, and so are missing from `entries`. */
  skipped: number;
  /**
   * The file was not a JSON array at all, so `entries` being empty says nothing about
   * what is banned.
   *
   * **A writer must refuse on this, not proceed.** Building a new list from an empty
   * array and saving it would replace a file full of bans with a file holding one — the
   * destructive version of this project's defect class, since the page would then
   * truthfully show the one ban that is left.
   */
  malformed: boolean;
}

function parseArray(raw: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

export function parseBannedPlayersFile(raw: string): ParsedBanFile<BannedPlayerEntry> {
  // An empty or whitespace-only file is what the game leaves when nothing is banned in
  // some versions, and `JSON.parse("")` throws — so it is "zero entries", not a fault.
  if (raw.trim() === "") return { entries: [], skipped: 0, malformed: false };
  const list = parseArray(raw);
  if (!list) return { entries: [], skipped: 0, malformed: true };

  const entries: BannedPlayerEntry[] = [];
  let skipped = 0;
  for (const item of list) {
    const e = item as Record<string, unknown>;
    if (typeof item !== "object" || item === null || typeof e.name !== "string" || e.name.trim() === "") {
      skipped += 1;
      continue;
    }
    entries.push({
      uuid: typeof e.uuid === "string" ? e.uuid : "",
      name: e.name.trim(),
      created: str(e.created, ""),
      source: str(e.source, ""),
      expires: str(e.expires, BAN_FOREVER),
      reason: str(e.reason, DEFAULT_BAN_REASON),
    });
  }
  return { entries, skipped, malformed: false };
}

export function parseBannedIpsFile(raw: string): ParsedBanFile<BannedIpEntry> {
  if (raw.trim() === "") return { entries: [], skipped: 0, malformed: false };
  const list = parseArray(raw);
  if (!list) return { entries: [], skipped: 0, malformed: true };

  const entries: BannedIpEntry[] = [];
  let skipped = 0;
  for (const item of list) {
    const e = item as Record<string, unknown>;
    if (typeof item !== "object" || item === null || typeof e.ip !== "string" || e.ip.trim() === "") {
      skipped += 1;
      continue;
    }
    entries.push({
      ip: normalizeIp(e.ip),
      created: str(e.created, ""),
      source: str(e.source, ""),
      expires: str(e.expires, BAN_FOREVER),
      reason: str(e.reason, DEFAULT_BAN_REASON),
    });
  }
  return { entries, skipped, malformed: false };
}

/**
 * Why this entry must not be written, or `null` if it may be. One sentence naming the entry
 * it is about, so no caller has to guess which of a list it refers to.
 */
export function banEntryRefusal(e: BannedPlayerEntry): string | null {
  if (!isValidMcName(e.name)) {
    return `Refusing to write a ban entry with the name "${e.name}".`;
  }
  if (!isValidUuid(e.uuid)) {
    return (
      `Refusing to write a ban for "${e.name}" with no UUID — Minecraft matches bans ` +
      `by UUID and would ignore it.`
    );
  }
  return null;
}

/**
 * Serialize for disk, or refuse.
 *
 * **This is where the blank-UUID bug is made impossible rather than merely avoided.**
 * `whitelist.json` and `ops.json` were written with `uuid: ""` for months; Minecraft
 * resolves the UUID first and discards any entry it cannot, so enabling the whitelist
 * after using the dashboard locked everyone out under a green toast. A ban entry has
 * the same shape and the same failure — with the sign flipped, which is worse: the
 * entry looks present on the page and the banned player keeps connecting.
 *
 * `resolveEntryUuids` in `mc-identity` is what fills the id in. This function is the
 * backstop that makes forgetting to call it a refusal instead of a silent nothing, and
 * it is a `Result` rather than a `throw` so the route answers 500 with a sentence
 * instead of a stack trace.
 *
 * ## `require` — whose entries this write is answerable for
 *
 * Only the entries named in `require` are checked. The rest of the list is carried through
 * **unchanged**, and that is deliberate rather than lax.
 *
 * Validating all of them turned one pre-existing entry the dashboard dislikes — a ban added
 * by an older version, or by hand, with a blank `uuid` — into a refusal of *every* file-path
 * edit, including the pardon that would have removed it. A list that cannot be edited is
 * not a protected list. Worse, the sentence that came back named whichever entry the loop
 * reached first, so a 500 about "Herobrine" was returned to someone banning "Notch": the
 * error pointed at the wrong player and at a write they had not asked for.
 *
 * Carrying a bad entry through does not make it worse. It is already on disk, the game
 * already ignores it, and `banDrift` is what surfaces it while the server is running. What
 * must never happen is *this* route creating one, and `require` is exactly the set that
 * could: the entry being added. A pardon adds nothing, so it requires nothing — it passes
 * `[]` and can always proceed.
 *
 * The default is every entry, so a caller that forgets the argument gets the strict
 * behaviour rather than the permissive one.
 */
export function serializePlayerBans(
  entries: BannedPlayerEntry[],
  require: BannedPlayerEntry[] = entries
): { ok: true; json: string } | { ok: false; error: string } {
  for (const e of require) {
    const refusal = banEntryRefusal(e);
    if (refusal) return { ok: false, error: refusal };
  }
  return { ok: true, json: JSON.stringify(entries, null, 2) };
}

/** `require` means the same thing here as in `serializePlayerBans` — see its comment. */
export function serializeIpBans(
  entries: BannedIpEntry[],
  require: BannedIpEntry[] = entries
): { ok: true; json: string } | { ok: false; error: string } {
  for (const e of require) {
    // IPs are matched as strings, so there is no identity to resolve — but an
    // unvalidated value still lands in a file the game parses, which is the other half
    // of the same lesson.
    if (!isValidIpv4(e.ip)) {
      return { ok: false, error: `Refusing to write "${e.ip}" to banned-ips.json — not an IPv4 address.` };
    }
  }
  return { ok: true, json: JSON.stringify(entries, null, 2) };
}

// ── Pure list edits ─────────────────────────────────────────────────────────
//
// Separated from the file I/O so "removing a name that is not in the list" has a
// tested answer. The route needs that answer: it is the difference between telling the
// operator "unbanned" and telling them "that name was not banned, nothing changed".

/** Minecraft usernames are unique case-insensitively, so matching has to be too. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function addPlayerBan(
  list: BannedPlayerEntry[],
  entry: BannedPlayerEntry
): { list: BannedPlayerEntry[]; added: boolean } {
  if (list.some((e) => sameName(e.name, entry.name))) return { list, added: false };
  return { list: [...list, entry], added: true };
}

export function removePlayerBan(
  list: BannedPlayerEntry[],
  name: string
): { list: BannedPlayerEntry[]; removed: number } {
  const kept = list.filter((e) => !sameName(e.name, name));
  return { list: kept, removed: list.length - kept.length };
}

export function addIpBan(
  list: BannedIpEntry[],
  entry: BannedIpEntry
): { list: BannedIpEntry[]; added: boolean } {
  if (list.some((e) => e.ip === entry.ip)) return { list, added: false };
  return { list: [...list, entry], added: true };
}

export function removeIpBan(
  list: BannedIpEntry[],
  ip: string
): { list: BannedIpEntry[]; removed: number } {
  const target = normalizeIp(ip);
  const kept = list.filter((e) => e.ip !== target);
  return { list: kept, removed: list.length - kept.length };
}

// ── RCON ────────────────────────────────────────────────────────────────────

export const BANLIST_PLAYERS = "banlist players";
export const BANLIST_IPS = "banlist ips";

/**
 * `ban <name> <reason>` / `ban-ip <ip> <reason>`.
 *
 * The reason is sanitized *here* rather than trusted from the caller, so there is no
 * ordering a caller can get wrong that puts a newline into a command whose reply this
 * module then has to parse.
 *
 * Throws on an invalid target as a **backstop**, not as the gate — `checkBanTarget` is
 * the gate and answers 400. Reaching the throw means a caller skipped it, which is a
 * bug worth a stack trace rather than a command sent to the server.
 */
export function banCommand(kind: BanKind, target: string, reason?: unknown): string {
  const checked = checkBanTarget(kind, target);
  if (!checked.ok) throw new Error(`banCommand: ${checked.error}`);
  return `${kind === "player" ? "ban" : "ban-ip"} ${checked.target} ${sanitizeBanReason(reason)}`;
}

export function pardonCommand(kind: BanKind, target: string): string {
  const checked = checkBanTarget(kind, target);
  if (!checked.ok) throw new Error(`pardonCommand: ${checked.error}`);
  return `${kind === "player" ? "pardon" : "pardon-ip"} ${checked.target}`;
}

export type BanReplyVerdict =
  /** The server says it did it. */
  | "applied"
  /** Already in that state, so nothing changed — not a failure. */
  | "already"
  /** Pardoning something that was not banned. Also not a failure. */
  | "notBanned"
  | "invalidAddress"
  | "noSuchPlayer"
  /** The reply did not look like any of the above. Says nothing about the outcome. */
  | "unrecognised";

/**
 * Classify a `ban` / `pardon` reply. **Advisory only.**
 *
 * Every pattern here is a vanilla translation string (`commands.ban.success`,
 * `commands.pardon.failed`, …), which means a locale change or a version bump can make
 * all of them stop matching at once. Nothing is reported to the operator on the
 * strength of this function alone: it chooses the *wording*, and the `banlist`
 * read-back chooses the *outcome*. Keeping those two jobs apart is what stops a
 * renamed string from turning into a confident lie.
 */
export function classifyBanReply(reply: string): BanReplyVerdict {
  const text = reply.trim();
  if (text === "") return "unrecognised";
  // The specific "Nothing changed. …" variants first — the generic prefix is shared.
  if (/already banned/i.test(text)) return "already";
  if (/(isn't|is not) banned/i.test(text)) return "notBanned";
  if (/IP address you entered is invalid/i.test(text)) return "invalidAddress";
  if (/No player was found|Unknown player|that player does not exist/i.test(text)) {
    return "noSuchPlayer";
  }
  if (/^(Banned|Unbanned) /i.test(text)) return "applied";
  return "unrecognised";
}

export interface BanlistReply {
  /** The N from "There are N ban(s):", or 0 for "There are no bans". `null` if absent. */
  count: number | null;
  /**
   * Per-entry parse — **only populated when it agrees with `count`**. See `separated`.
   */
  entries: BanlistLine[];
  /**
   * True when the entry lines could be told apart, so `entries` is complete.
   *
   * This matters because Minecraft's RCON console source appends each feedback message
   * to one buffer, and multi-message replies are widely reported to come back run
   * together with no separator. If that is what arrives, entry boundaries are genuinely
   * unrecoverable: the end of one reason abuts the start of the next name with nothing
   * between them, so `"...GriefingNotch was banned by..."` has no reading that
   * distinguishes the reason from the name. Rather than guess, the header count is
   * cross-checked against the number of lines that parsed; a mismatch drops `entries`
   * and sets this false.
   *
   * **A reply that is not `separated` answers nothing about any single target**, which is
   * why `banlistUsable` requires it. A previous version searched the raw buffer for
   * `"<name> was banned by "` on the grounds that the phrase is unambiguous wherever it
   * appears — it is not: `reason` and `source` are free text the server echoes back into
   * this same reply, so one ban carrying the reason `"Bob was banned by me: spam"` makes
   * every later read-back answer "Bob is banned" whether he is or not. The read-back is
   * the only thing that decides whether this feature claims success, so that search was a
   * way for a crafted reason to buy a green toast.
   */
  separated: boolean;
  /** True when this looked like a banlist answer at all. */
  recognised: boolean;
}

export interface BanlistLine {
  target: string;
  source: string;
  reason: string;
}

/**
 * **A `banlist` reply with two or more bans cannot be parsed, and that is a fact about the
 * server, not a gap here.** Measured on the live 26.1.2 container 2026-10-02 by banning three
 * throwaway names and hexdumping the reply — 151 bytes, **zero newlines**:
 *
 *   `There are 3 ban(s):zz_fix_a was banned by Rcon: fixture capturezz_fix_c was banned by …`
 *
 * `RconConsoleSource.sendSystemMessage` appends every feedback message to one buffer with no
 * separator (the same thing that makes `help gamerule` arrive as one 5 KB line). So one
 * entry's reason runs straight into the next entry's name: `fixture capture` followed by
 * `zz_fix_c` is the eight characters `capturezz_fix_c`, and **nothing in the reply says where
 * the boundary was**. One ban parses, because one entry needs no separator.
 *
 * **Do not "fix" this by walking the reply globally.** That was tried: matching every
 * `(\S+) was banned by ` occurrence yields three entries for the reply above — enough to
 * satisfy the `entries.length === count` cross-check — named `zz_fix_a`, `capturezz_fix_c` and
 * `capturezz_fix_b`. It turns an honest refusal into a confidently wrong answer, which is
 * strictly worse and is this project's named defect class. The committed fixture
 * `__tests__/fixtures/mc-banlist-players.txt` is the real reply, kept so the next person can
 * see why before trying it.
 *
 * What this costs, and why it is acceptable: the live cross-check degrades to "cannot
 * confirm" (`liveReadState` → `unreadable`, `banDrift` → `null`) whenever more than one ban
 * exists. The ban *files* remain authoritative and are read directly, so the list shown is
 * correct; what is lost is the second opinion. Refusing to answer is the right failure for a
 * read-back whose whole job is to decide whether a ban is really in effect.
 *
 * Line-anchored on purpose: where the reply *is* newline-separated, the line boundary says
 * where an entry ends, so a reason may safely contain the literal " was banned by " and a
 * crafted reason cannot forge a second entry.
 */
const BANLIST_ENTRY = /^(\S+) was banned by (.+?): ([\s\S]*)$/;

export function parseBanlist(raw: string): BanlistReply {
  const text = raw.replace(/\r\n/g, "\n");
  const none = { count: 0, entries: [], separated: true, recognised: true };

  if (/There are no bans/i.test(text)) return none;

  const header = /There are (\d+) ban\(s\):/i.exec(text);
  if (!header) return { count: null, entries: [], separated: false, recognised: false };

  const count = Number(header[1]);
  const rest = text.slice(header.index + header[0].length);
  const lines = rest
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const entries: BanlistLine[] = [];
  for (const line of lines) {
    const m = BANLIST_ENTRY.exec(line);
    if (m) entries.push({ target: m[1], source: m[2], reason: m[3] });
  }

  // The cross-check. One run-together line still parses — greedily and wrongly — so
  // "it parsed" is not evidence. "It parsed into as many entries as the server said
  // there are" is.
  const separated = entries.length === count;
  return { count, entries: separated ? entries : [], separated, recognised: true };
}

/**
 * Can this reply be read as a list of entries at all?
 *
 * The gate on every question asked of a `banlist` reply. Both halves are needed:
 * `recognised` says it looked like a banlist answer, `separated` says the entries could be
 * told apart. "There are no bans" satisfies both — it is a complete, readable list that
 * happens to be empty, and a pardon read back against it is genuinely proved.
 */
export function banlistUsable(reply: BanlistReply): boolean {
  return reply.recognised && reply.separated;
}

/**
 * Does this ban list hold `target`? **`null` means the reply could not be read**, which is
 * not the same as "no" and must never be collapsed into it.
 *
 * Matched against the **parsed** `target` of each entry, not against a substring of the
 * reply buffer. That distinction is the whole point: `reason` and `source` are free text
 * the server echoes back into this reply, so a ban stored with the reason
 * `"Bob was banned by me: spam"` makes a raw-buffer search answer "Bob is banned" for a
 * Bob who is not — and since this function is what proves a ban or pardon took effect,
 * that bought a green toast for a ban that did not happen. A per-entry match cannot be
 * poisoned that way: the reason always lands in the entry's own `reason` capture, never in
 * its `target`. Replies whose entry boundaries are unrecoverable are refused rather than
 * guessed at, which is what the `null` is.
 *
 * Case-insensitive: the operator may type `notch` while the server prints the profile's
 * canonical `Notch`. For an IPv4 target case is irrelevant, so the same comparison is safe
 * for both kinds.
 */
export function banlistLists(reply: BanlistReply, target: string): boolean | null {
  if (!banlistUsable(reply)) return null;
  const wanted = target.trim().toLowerCase();
  return reply.entries.some((e) => e.target.trim().toLowerCase() === wanted);
}

/**
 * Did the read-back **prove** the state the caller asked for? `null` means the reply said
 * nothing either way.
 *
 * This exists because of an asymmetry that is easy to get wrong at a call site and was
 * wrong at one: *presence* is evidence a ban landed, but *absence* is only evidence a
 * pardon landed **if the reply was readable in the first place**. Written inline as
 * `action === "ban" ? present : !present`, an unreadable reply makes `present` false and
 * therefore confirms the pardon — a green toast for a player who is still banned, which
 * is this project's defect class exactly. Here the unreadable case is `null` for both
 * directions and the caller has to decide what to say about not knowing.
 */
export function banlistProves(
  action: "ban" | "pardon",
  reply: BanlistReply,
  target: string
): boolean | null {
  const present = banlistLists(reply, target);
  if (present === null) return null;
  return action === "ban" ? present : !present;
}

/** How much a `banlist` read is worth, as three distinguishable states. */
export type LiveRead =
  /** No reply at all — the command threw, so the server was not asked successfully. */
  | "unreachable"
  /** A reply arrived and could not be read as a list of entries. */
  | "unreadable"
  /** A reply arrived and parsed. Comparisons against it mean something. */
  | "read";

/**
 * Which of the three a reply is. `null` in means the RCON call failed.
 *
 * The three have to stay apart in the response body because the page says a different
 * thing about each, and the first version collapsed the middle one: an unrecognised reply
 * still produced a non-null parse, so "could not read the server's list" was reported as
 * "the server is enforcing nothing" and every ban on disk was flagged as not enforced. The
 * `recognised` flag existed and nothing read it, which is how that got through.
 */
export function liveReadState(reply: BanlistReply | null): LiveRead {
  if (!reply) return "unreachable";
  return banlistUsable(reply) ? "read" : "unreadable";
}

// ── Which path, and what to say about it ────────────────────────────────────

export interface BanRouting {
  path: "rcon" | "file" | "refuse";
  /** One clause naming why, for the response the UI shows. */
  why: string;
  /**
   * Set only when `path` is `"refuse"`. Carried here rather than written at the call
   * site so the policy and its explanation cannot drift apart: the reason a file write
   * is *not* an acceptable fall-back is the same reason this routing exists.
   */
  error: string;
}

/**
 * Where a ban change has to go, from **two** signals rather than one.
 *
 * | container (docker) | RCON answering | path |
 * |---|---|---|
 * | running | yes | `rcon` |
 * | running | no   | `refuse` — the "Not responding" state |
 * | stopped | yes | `rcon` — see below |
 * | stopped | no   | `file` |
 *
 * **Why `rconAnswering` and not just `containerRunning`.** `containerState` in
 * `game-manager` answers `"missing"` for *any* `docker inspect` failure — a broken
 * socket, a renamed container, docker itself being down — so `containerRunning === false`
 * is not evidence that the game is stopped. Taking the file path on that evidence is the
 * one mistake with a silent, lasting consequence: the running game rewrites both json
 * files from its in-memory list, so the write disappears and the banned player keeps
 * connecting. **A live RCON socket is proof the game is up; docker's answer is a report.**
 * So a socket that answers wins, whatever docker said.
 *
 * The reverse pair is the third reachability state `a7d76b8` named for the power controls:
 * the container is up and the game is not answering. There is nothing useful to do with a
 * ban in that state, and the one tempting thing — write the file — is the trap above. So
 * it refuses and says why, rather than reporting a success that has a delete scheduled
 * behind it.
 */
export function routeBanChange(opts: {
  containerRunning: boolean;
  rconAnswering: boolean;
}): BanRouting {
  if (opts.rconAnswering) {
    return {
      path: "rcon",
      why: "the server is running, so it was applied over RCON and is in effect now",
      error: "",
    };
  }
  if (opts.containerRunning) {
    return {
      path: "refuse",
      why: "the container is up but the server isn't answering RCON",
      error:
        "The Minecraft container is running but isn't answering RCON, so the ban can't be " +
        "applied right now. Nothing was written: the server rewrites banned-players.json " +
        "and banned-ips.json from its own list, so an edit made now would be discarded. " +
        "Restart the server, then try again.",
    };
  }
  return {
    path: "file",
    why: "the server is stopped, so it was written to the ban file and applies at the next start",
    error: "",
  };
}

export interface BanOutcome {
  action: "ban" | "pardon";
  kind: BanKind;
  target: string;
  path: "rcon" | "file";
  /** The read-back proved the new state. */
  verified: boolean;
  /** The read-back ran and showed the opposite — distinct from "could not read back". */
  contradicted?: boolean;
  /** It was already in the requested state, so nothing changed. */
  noop?: boolean;
}

/**
 * The sentence the UI shows, derived from what was actually observed.
 *
 * A pure function because the wording *is* the feature: every axis below has a
 * combination that this project has historically got wrong by reporting the optimistic
 * one. In particular `verified: false` must never produce a sentence that claims the
 * ban is in effect, and the `file` path must never claim it is in effect *now* — the
 * server is stopped, so there is nothing for it to be in effect on.
 */
export function banMessage(o: BanOutcome): string {
  const what = o.kind === "player" ? o.target : `IP ${o.target}`;
  const file = o.kind === "player" ? "banned-players.json" : "banned-ips.json";

  if (o.noop) {
    return o.action === "ban"
      ? `${what} was already banned. Nothing changed.`
      : `${what} wasn't banned. Nothing changed.`;
  }

  const verb = o.action === "ban" ? "Banned" : "Unbanned";

  if (!o.verified) {
    const sent = o.path === "rcon" ? `Sent the ${o.action} for ${what}` : `Wrote ${what} to ${file}`;
    return o.contradicted
      ? `${sent}, but reading it back shows it did not take effect. Nothing is confirmed — ` +
          `check the console.`
      : `${sent}, but it couldn't be read back, so it is not confirmed.`;
  }

  return o.path === "rcon"
    ? `${verb} ${what}. The running server applied it, and reading its ban list back confirms it.`
    : `${verb} ${what} in ${file}. The server is stopped, so this applies the next time it starts.`;
}

// ── Drift between the file and the running server ───────────────────────────

export interface BanDrift {
  /**
   * Targets the file lists that the running server's own list does not.
   *
   * **The cause is not single**, and saying so was a false claim worth deleting rather than
   * softening. The common one is a file edit made while the server was up, which it then
   * rewrites away. But a file entry whose `uuid` the game could not use is also listed here
   * and never enforced; so is an entry naming an account the server resolves to a different
   * canonical name. What every member of this list has in common is only what it is called:
   * on disk, not in the running server's list. The page says that and stops.
   */
  notEnforced: string[];
  /** How many live bans the file does not account for. */
  extraLive: number;
}

/**
 * Compare `banned-*.json` against what the running server reports. **`null` when the reply
 * could not be read**, because there is no comparison to report in that case.
 *
 * The same shape as the memory card's configured-vs-live comparison, and for the same
 * reason: it makes "applied" something the page can show rather than something the reader
 * has to assume.
 *
 * The `null` is the fix for a straightforward inversion. An unrecognised reply used to
 * reach this function as "zero bans live", so every ban on disk came out as `notEnforced` —
 * a wall of false warnings produced by not being able to read, which is the opposite of
 * what the comparison is for. `banlistUsable` is the gate, and `liveReadState` is what the
 * route sends so the page can say which of the two happened.
 */
export function banDrift(fileTargets: string[], reply: BanlistReply): BanDrift | null {
  if (!banlistUsable(reply)) return null;

  const notEnforced = fileTargets.filter((t) => banlistLists(reply, t) === false);
  const enforced = fileTargets.length - notEnforced.length;
  /**
   * Clamped, and the clamp is reachable: a hand-edited file may hold the same target twice
   * (`removePlayerBan` deletes every copy for exactly that reason), so two file entries can
   * match one live entry and `enforced` can exceed `count`. "−1 extra bans" is not a
   * sentence.
   *
   * One guard rather than two. `count === null` only happens on an unrecognised reply, and
   * `banlistUsable` has already returned above for those — so `?? 0` is unreachable
   * defensive spelling rather than a branch, and a separate null arm would be a line no
   * input can reach and no test can pin. (Mutation-checked: an earlier version had both,
   * and deleting either left the suite green.)
   */
  const extraLive = Math.max(0, (reply.count ?? 0) - enforced);
  return { notEnforced, extraLive };
}
