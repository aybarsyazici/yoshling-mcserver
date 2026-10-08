// Retention: what gets kept, what gets deleted, and saying so out loud.
//
// ## The measured problem
//
// Nothing ever removed a backup. Read off the box on 2026-09-30, inside
// `yoshling-web-1`:
//
//     /app/data/backups          818.8M   5 archives
//     /app/data/backups-7dtd       1.7G   6 archives
//     /app/data/backups-zomboid    1.0G   4 archives
//
// 15 archives, ~3.5 GB — and **five of the six 7 Days to Die archives were written
// between 13:33 and 13:41 on 2026-09-29**, eight minutes apart, 304 MB each. Nothing
// prevented that pile-up and nothing would ever have cleared it. The disk has 208 GB
// free so it was not urgent, but "not urgent" is how it reached 15 with no policy at
// all, and an automatic schedule turns the same shape into unbounded growth.
//
// ## Why the rule is OR and not AND
//
// A retention policy is usually written "keep the newest N **and** at most D days",
// i.e. delete only what is both beyond N and older than D. That rule would not have
// touched those five 7DTD archives — they were minutes old — so it would not have
// fixed the one pile-up that actually happened here.
//
// So an archive is a deletion candidate if it is beyond the newest `keep` **or** older
// than `maxAgeDays`. `keep` alone bounds a burst; the age rule is the one that trims a
// long tail, and it is **off by default** (`maxAgeDays: 0`) because on its own it would
// happily delete the entire history of a world nobody has backed up in a while.
//
// ## The newest archive is never a candidate
//
// Stronger than "never delete the only archive", and it is the property that matters:
// after any prune there is always at least one restore point, whatever the numbers are
// set to — including `keep: 0`, a zero-length `maxAgeDays`, or a directory where every
// file is older than the age limit.
//
// ## The oldest archive survives the COUNT rule
//
// Because `keep: N` only bounds a burst when the burst is bigger than N, and on this box
// it is not. Measured set on 2026-09-30: 7 Days to Die had 6 archives, one from
// 2026-07-23 and **five written between 13:34 and 13:41 on 2026-09-29**. Running the
// count rule at the default `keep: 5` over exactly that set selected
// `7dtd-Reveo_Valley-2026-07-23T…` for deletion — the only restore point older than a
// day — and kept four near-identical copies of one seven-minute window. Minecraft was
// the same shape: 3 of its 5 are from one afternoon, and the 2026-05-29 archive was
// selected. Repeat daily and what `keep` trims is the history, not the burst.
//
// So the oldest archive is exempt from the count rule, which means a prune can never
// collapse the whole history into one moment; the cost is exactly one stale archive per
// world. It is **not** exempt from `maxAgeDays`, because that rule is an operator saying
// "delete anything past this date" and an unannounced "…except one" would make it a lie.
// The two exemptions coincide when a world has a single archive.

import { rm } from "fs/promises";
import path from "path";
import type { GameId } from "@/lib/games";
import { removeManifestSidecar } from "@/lib/backup-archive";
import { BACKUP_DIRS, listArchives, type ArchiveFile } from "@/lib/backup-store";
import type { OpHandle } from "@/lib/operations";

export interface BackupPolicy {
  /** How many of the newest archives to keep unconditionally. Never allowed below 1. */
  keep: number;
  /** Delete anything older than this many days. `0` = no age limit. */
  maxAgeDays: number;
}

export const DEFAULT_POLICY: BackupPolicy = { keep: 5, maxAgeDays: 0 };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * The policy in force for a world.
 *
 * Env, not the database, deliberately: there is no automatic migration in production
 * (see CLAUDE.md), so a new table means a hand-applied `CREATE TABLE` before this can
 * work at all, and the value is one an operator sets once. `BACKUP_KEEP_7DTD` overrides
 * `BACKUP_KEEP` for that world; the game id is upper-cased, so the keys are
 * `BACKUP_KEEP_MINECRAFT`, `BACKUP_KEEP_7DTD`, `BACKUP_KEEP_ZOMBOID`.
 *
 * `keep` is clamped to at least 1 whatever is configured. A `keep: 0` that actually
 * deleted everything is the accident this whole module has to be incapable of.
 */
export function policyFor(game: GameId): BackupPolicy {
  const suffix = game.toUpperCase();
  return {
    keep: Math.max(1, envInt(`BACKUP_KEEP_${suffix}`, envInt("BACKUP_KEEP", DEFAULT_POLICY.keep))),
    maxAgeDays: envInt(
      `BACKUP_MAX_AGE_DAYS_${suffix}`,
      envInt("BACKUP_MAX_AGE_DAYS", DEFAULT_POLICY.maxAgeDays)
    ),
  };
}

export interface PruneSelection {
  /** Names to delete, **oldest first**, so a partial failure loses the oldest ones. */
  delete: string[];
  /** How many survive. Always ≥ 1 when the directory was not empty. */
  keep: number;
  /** Names excluded by `protect` that the policy would otherwise have deleted. */
  protected: string[];
}

/**
 * Which archives the policy gives up. Pure — this is the function the tests pin.
 *
 * `protect` is for names something is reading right now. In practice the resource lane
 * already covers the dangerous case (a `backup.restore` declares every `files:` lane, so
 * a `backup.create` — the only thing that prunes — cannot be admitted while one runs),
 * but the *reason* an archive is safe should not be an argument about admission order
 * three files away. The caller names what it must not lose and this honours it.
 */
export function selectForPruning(
  archives: Pick<ArchiveFile, "name" | "createdAtMs">[],
  policy: BackupPolicy,
  opts: { now: number; protect?: string[] } = { now: Date.now() }
): PruneSelection {
  const protect = new Set(opts.protect ?? []);
  // Newest first. `name` descending as the tie-break, because archive names carry a
  // second-resolution timestamp and two written in the same second must still order
  // deterministically — otherwise which one gets deleted depends on readdir order.
  const sorted = [...archives].sort(
    (a, b) => b.createdAtMs - a.createdAtMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
  );

  const keep = Math.max(1, Math.floor(policy.keep));
  const ageCutoff =
    policy.maxAgeDays > 0 ? opts.now - policy.maxAgeDays * 24 * 60 * 60 * 1000 : null;

  const doomed: typeof sorted = [];
  const blocked: string[] = [];
  const oldest = sorted.length - 1;
  for (let i = 0; i < sorted.length; i++) {
    // Index 0 is the newest and is never a candidate: this is what guarantees a restore
    // point survives every possible setting of `keep` and `maxAgeDays`.
    if (i === 0) continue;
    const a = sorted[i];
    // The oldest archive is exempt from the COUNT rule — see "The oldest archive
    // survives the count rule" above. Not exempt from the age rule, which is an explicit
    // instruction to delete things past a date.
    const beyondKeep = i >= keep && i !== oldest;
    const tooOld = ageCutoff !== null && a.createdAtMs < ageCutoff;
    if (!beyondKeep && !tooOld) continue;
    if (protect.has(a.name)) {
      blocked.push(a.name);
      continue;
    }
    doomed.push(a);
  }

  return {
    // Oldest first: if the loop dies partway the surviving set is still the newest ones.
    delete: doomed.map((a) => a.name).reverse(),
    keep: sorted.length - doomed.length,
    protected: blocked,
  };
}

/** Human form of a policy, for a step label and for the UI. */
export function describePolicy(policy: BackupPolicy): string {
  const age = policy.maxAgeDays > 0 ? `, and anything older than ${policy.maxAgeDays} days` : "";
  // "keep the 1 newest" is the one value that reads badly, and it is also the value a
  // clamped `keep: 0` lands on — i.e. exactly the setting somebody is most likely to be
  // surprised by, so it is worth spelling out rather than printing awkwardly.
  const keep = policy.keep === 1 ? "keep only the newest" : `keep the ${policy.keep} newest`;
  return `${keep}${age}`;
}

export interface PruneResult {
  deleted: string[];
  failed: string[];
  kept: number;
  policy: BackupPolicy;
}

/**
 * Apply the policy, as a recorded step of whatever operation is running.
 *
 * Pruning deletes files a user asked this app to keep, so it is never silent: it is a
 * step in the operation's own record, a fact on it, and a line in the durable journal
 * (written by the caller, which has the actor). The step also runs when there is
 * nothing to delete — "3 archives kept, nothing to delete" is information, and a
 * retention pass that only appears when it destroys something is one you cannot audit.
 *
 * **The step always settles `done`, never `noop`, and a failed delete records no `warn`
 * fact.** Both of those are load-bearing and both were regressions this project has
 * already shipped once:
 *
 *   - any `noop` step makes `concludeOperation` return `partial`, and a `partial`
 *     backup.create used to publish "…but part of it is missing. This is not a restore
 *     point." in amber for a flawless archive. That is the bug the test suite was
 *     written for; a retention step that settles `noop` on the everyday
 *     nothing-to-delete path re-creates it exactly.
 *   - a `warn` fact does the same via a different door: `summarize()`'s `backup.create`
 *     branch renders `partial` + any warn as "Backup created — 304 MiB, but <warn>.
 *     **This is not a restore point.**" An old archive that could not be deleted says
 *     nothing at all about the archive just written, so that sentence would be false.
 *     The failure goes in the step label, the journal and the container log instead.
 */
export async function applyRetention(
  op: OpHandle,
  game: GameId,
  opts: { protect?: string[]; now?: number; directory?: string } = {}
): Promise<PruneResult> {
  const dir = opts.directory ?? BACKUP_DIRS[game];
  const policy = policyFor(game);
  op.step("Applying the retention policy");

  const archives = await listArchives(dir);
  const selection = selectForPruning(archives, policy, {
    now: opts.now ?? Date.now(),
    protect: opts.protect,
  });

  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of selection.delete) {
    const target = path.join(dir, name);
    try {
      await rm(target);
      await removeManifestSidecar(target);
      deleted.push(name);
    } catch (e) {
      failed.push(name);
      // Logged, not swallowed: "why is this directory still growing" needs an answer,
      // and the operation record cannot carry it as a warn (see the note above).
      console.error(`[backups] could not prune ${target}:`, e);
    }
  }

  const kept = archives.length - deleted.length;
  const label =
    deleted.length === 0
      ? failed.length === 0
        ? `Kept all ${kept} ${kept === 1 ? "archive" : "archives"} — nothing to delete`
        : `Kept ${kept} archives — ${failed.length} could not be deleted`
      : `Deleted ${deleted.length} old ${deleted.length === 1 ? "archive" : "archives"}, kept ${kept}`;
  // `count` only when something was actually deleted. A `{done: 0, total: 0}` count is
  // noise, and `{done: 0, total: n}` on a `noop` step is the exact shape
  // `concludeOperation` reads as "it ran and changed nothing" for the whole operation.
  op.settle(
    label,
    deleted.length > 0
      ? { count: { done: deleted.length, total: selection.delete.length, noun: "archives" } }
      : undefined
  );
  op.fact({
    label: "Retention",
    value:
      `${describePolicy(policy)} — ${kept} kept` +
      (deleted.length > 0 ? `, ${deleted.length} deleted` : "") +
      (failed.length > 0 ? `, ${failed.length} could not be deleted` : "") +
      (selection.protected.length > 0 ? `, ${selection.protected.length} in use` : ""),
  });

  return { deleted, failed, kept, policy };
}
