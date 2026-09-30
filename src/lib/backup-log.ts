// The durable record of what has happened to this box's backups.
//
// Two stores, because they answer two different questions and only one of them can
// answer both honestly.
//
// ## `Activity` — "who did what in this app"
//
// Already exists, already rendered at `/activity`, and every neighbouring feature writes
// one. `logBackupActivity` is the same write the three routes each had a private copy of.
// Its constraint is that `Activity.userId` is a **required** column with a foreign key to
// `User`, so every row must name a person.
//
// ## The journal — "what happened to the archives on this box"
//
// A scheduled backup has no person. The three ways to give it one are all dishonest:
// attribute it to an admin (a name on work they did not do — this project's exact
// defect class), invent a `User` row called "Scheduler" (a fake account that then shows
// up on the Crew page and can be granted worlds), or make `userId` nullable (a schema
// change, and production has **no automatic migrations** — it would have to be applied by
// hand before the code could run at all, which is not something this change can verify).
//
// So scheduled work, prunes and **failures** go into an append-only JSONL file next to
// the archives themselves, where `actor: null` means "nobody asked for this, the timer
// did" rather than "unknown".
//
// ### Why a file is safe here, given `applyingSince`
//
// The recorded trap is `pz-updates.json`'s `applyingSince`: a marker written *before* the
// long part and not cleared on every exit path, which left the UI reading "Updating now —
// started 3 days ago" permanently, with the only control that could have cleared it
// disabled by that same state. This file is **append-only and carries no state**. There
// is no field here that anything reads as "in flight", so there is nothing to get stuck
// and nothing to reconcile. Anything in-flight is in the operation registry, which cannot
// outlive the frame awaiting it.
//
// ## What never gets written
//
// An operation the registry **refused to admit** writes nothing at all, to either store.
// Nothing was attempted, no file changed, and "a log of things that did not happen is
// worse than no log" is the rule the success-only `logBackup` was built on. What changes
// here is that a backup which *started* and then failed is now recorded — a failed
// restore is exactly what someone needs to find an hour later, and the in-memory
// registry has dropped it after six.

import { appendFile, readFile, writeFile } from "fs/promises";
import { db } from "@/lib/db";
import type { GameId } from "@/lib/games";

export type BackupActivityAction =
  | "backup_create"
  | "backup_restore"
  | "backup_delete"
  | "backup_download"
  /** A retention pass that deleted something. Destructive, so it gets its own row. */
  | "backup_prune"
  /** A create or restore that started and did not finish. */
  | "backup_failed";

/**
 * The `/activity` row. One copy, previously three.
 *
 * `game` has to be inside `details`: `/api/activity` picks each world's rows with
 * `contains "<game>"`, and an untagged row is shown to everyone.
 *
 * Logged rather than swallowed, following `mc-whitelist`'s precedent — "who restored the
 * world" is precisely the question this row exists to answer, so a row that failed to
 * write is worth a line in the container log.
 */
export async function logBackupActivity(
  userId: string,
  game: GameId,
  action: BackupActivityAction,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.activity.create({
      data: { userId, action, details: JSON.stringify({ game, ...details }) },
    });
  } catch (e) {
    console.error(`[backups] could not write the ${action} activity row for ${game}:`, e);
  }
}

export type BackupEvent = "create" | "restore" | "delete" | "download" | "prune";

export interface JournalEntry {
  /** ISO8601, so a human reading the raw file gets a date without a converter. */
  at: string;
  game: GameId;
  event: BackupEvent;
  outcome: "ok" | "failed";
  /** Display name, or `null` for the scheduler — absence of an actor, not of knowledge. */
  actor: string | null;
  /** The archive this is about, when there is exactly one. */
  name?: string;
  sizeBytes?: number;
  /** The archives a prune removed. */
  names?: string[];
  /** Collapsed thrown message, for a `failed` entry. */
  error?: string;
  /** Anything else worth keeping — the world name, the checksum state. */
  detail?: string;
}

const JOURNAL_FILE = process.env.BACKUP_JOURNAL_FILE || "/app/data/backup-journal.jsonl";
/**
 * Bound. One line is ~150 bytes, so this is roughly the last two thousand events —
 * years of a daily schedule. Trimmed on write rather than on read so the file cannot
 * grow without limit on a box nobody is watching.
 */
const JOURNAL_MAX_LINES = 2000;
const JOURNAL_TRIM_AT_BYTES = 512 * 1024;

/**
 * Append one event. Never throws, and never fatal to the work it describes.
 *
 * A backup that succeeded and failed to write its journal line is still a backup; making
 * the archive's existence depend on a log write would be the wrong way round.
 */
export async function journalBackup(entry: Omit<JournalEntry, "at">): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  try {
    await appendFile(JOURNAL_FILE, line, "utf-8");
    await trimJournal();
  } catch (e) {
    console.error("[backups] could not append to the journal:", e);
  }
}

async function trimJournal(): Promise<void> {
  try {
    const text = await readFile(JOURNAL_FILE, "utf-8");
    if (text.length <= JOURNAL_TRIM_AT_BYTES) return;
    const lines = text.split("\n").filter(Boolean).slice(-JOURNAL_MAX_LINES);
    await writeFile(JOURNAL_FILE, lines.join("\n") + "\n", "utf-8");
  } catch {
    /* best effort — a journal that could not be trimmed is still a journal */
  }
}

/**
 * Newest first, optionally for one world.
 *
 * Unparseable lines are dropped rather than throwing: a torn last line (a container
 * killed mid-append) must not take the whole history down with it.
 */
export async function readJournal(game: GameId | null, limit = 20): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(JOURNAL_FILE, "utf-8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as JournalEntry;
      if (game && entry.game !== game) continue;
      out.push(entry);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/**
 * Both stores at once, for a user-initiated event.
 *
 * `actor.userId` is what makes the `Activity` row possible; a scheduled event calls
 * `journalBackup` directly with `actor: null` and writes no row.
 */
export async function recordBackupEvent(
  game: GameId,
  event: BackupEvent,
  actor: { userId: string; name: string } | null,
  entry: Omit<JournalEntry, "at" | "game" | "event" | "actor">,
  activity?: { action: BackupActivityAction; details: Record<string, unknown> }
): Promise<void> {
  // `||`, not `??`. A Discord account with no display name gives `{name: ""}` — the
  // routes build the actor as `{userId, name: session.user.name ?? ""}` — and `??` only
  // collapses null/undefined, so an empty name journalled `actor: ""`, which the backups
  // page renders as **"the scheduler"** because "" is falsy. That is a false attribution on
  // a prune, a delete and a restore, and `createBackup` already handles the same case
  // correctly one file away (`startedBy: actor?.name ? {name: actor.name} : null`, "an
  // empty attribution renders worse than none") — so the two records of one backup
  // disagreed about who took it.
  await journalBackup({ game, event, actor: actor?.name || null, ...entry });
  if (actor && activity) {
    await logBackupActivity(actor.userId, game, activity.action, activity.details);
  }
}
