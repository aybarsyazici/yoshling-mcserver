// Automatic backups.
//
// Backups were manual-only: the only one that ever existed was one somebody remembered
// to click. So the interesting part of this file is not "run a backup on a timer", it is
// the list of things it must never do.
//
// ## The four hard constraints
//
// 1. **Never while a world is being played.** Player count, not container state — a
//    running server with nobody on it is the *best* time to take one, and a running
//    server with somebody on it is the worst. And when the container is up but the game is
//    not answering (a documented state on this box: PZ's game loop wedged on 2026-09-22),
//    the player count is unknowable, so that counts as "possibly being played" and is
//    skipped too.
// 2. **Through `runOperation`**, so it appears in the ledger, so it cannot collide, and so
//    it cannot state its own outcome. It is the operation nobody clicks — the same
//    category as the Workshop watcher, whose six silent minutes are the reason the
//    registry exists.
// 3. **It respects the resource lanes and holds no power.** `backup.create` declares
//    `files:<game>` and nothing else, so a scheduled backup can be pre-empted by a Power
//    on (correctly: recovery must never be blocked) and can never evict a world.
// 4. **No state that can get stuck.** The recorded failure here is `applyingSince` in
//    `pz-updates.json`: written before the long part, not cleared on every exit path, and
//    the card then read "Updating now — started 3 days ago" permanently with the only
//    control that could have cleared it disabled *by that same state*. So this keeps no
//    "last run" file at all.
//
// ## Where "when did we last back up" comes from
//
// The newest archive's mtime on disk. That is evidence rather than bookkeeping: it cannot
// drift from reality, it cannot be left set by a crash, and it survives a redeploy — which
// an in-memory timestamp would not, so every deploy would reset the clock.
//
// It counts exactly what `listArchives` lists, which is the top level of the backups
// directory and nothing below it. **This paragraph first claimed it also counted
// `/api/7dtd/reset`'s pre-reset snapshot "which really is a backup of that world", and
// that was wrong on both halves.** That route writes to a *subdirectory*,
// `/app/data/backups-7dtd/presreset/`, and its own comment says why: the tar has no
// manifest and its members are rooted at `<world>/`, so restoring it would wipe `Saves/`
// and then find no `Saves/` in the archive to put back. It is a recovery artefact, not a
// restore point, and it is correct that it neither resets this clock nor is ever pruned.
//
// The one piece of memory kept is a failure cooldown, and it is **in memory on purpose**:
// a stuck cooldown clears itself on the next restart, where a stuck file would not.

import { GAME_LIST, type GameId } from "@/lib/games";
import { BACKUP_DIRS, listArchives } from "@/lib/backup-store";
import { minecraftActiveContext, assertMinecraftProfileCurrent, MinecraftActiveProfileError, type MinecraftActiveContext } from "./minecraft-active-profile";
import { minecraftBackupDirectory } from "./minecraft-profile-backups";

/** Default cadence. One a day per world, which with `keep: 5` is five days of history. */
const DEFAULT_INTERVAL_HOURS = 24;

/**
 * How long to wait after a failed automatic backup before trying again.
 *
 * Same reasoning as `zomboid-updates.ts`'s `SEED_RETRY_COOLDOWN_MS`: a failure that is
 * permanent (a full disk, a `Saves/` that does not exist) has no reason to go differently
 * on the next tick, and retrying it every five minutes turns one problem into a log nobody
 * can read. A flat cooldown rather than a backoff, because nothing about the next attempt
 * is different — only time can fix it.
 */
export const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `BACKUP_SCHEDULE=off` disables it entirely; anything else leaves it on. */
export function scheduleEnabled(): boolean {
  return (process.env.BACKUP_SCHEDULE ?? "on").toLowerCase() !== "off";
}

/**
 * Cadence per world. `BACKUP_SCHEDULE_HOURS_ZOMBOID` overrides
 * `BACKUP_SCHEDULE_HOURS`; a value of 0 or a non-number falls back rather than
 * producing an interval of zero, which would back up on every tick.
 */
export function intervalMsFor(game: GameId): number {
  const suffix = game.toUpperCase();
  const hours = envNumber(
    `BACKUP_SCHEDULE_HOURS_${suffix}`,
    envNumber("BACKUP_SCHEDULE_HOURS", DEFAULT_INTERVAL_HOURS)
  );
  return hours * 60 * 60 * 1000;
}

/**
 * What the decision needs to know about the world, or `null` when it has not been asked
 * yet.
 *
 * `status` is `GameStatus.status` verbatim: `"online" | "offline" | "starting" |
 * "stopping" | "installing"`. Typed as a string rather than importing `RunStatus`, because
 * that type lives in `game-manager`, which reaches Docker — and this module is deliberately
 * importable without it so the predicate can be tested without a container.
 */
export interface WorldSnapshot {
  status: string;
  playersOnline: number;
}

export interface ScheduleInput {
  now: number;
  enabled: boolean;
  intervalMs: number;
  /** mtime of the newest archive, or `null` when this world has never been backed up. */
  lastArchiveAtMs: number | null;
  /** When an automatic backup last failed, from memory. 0 = never. */
  lastFailedAtMs: number;
  failureCooldownMs: number;
  /** `null` = not probed yet. The decision then asks for a probe rather than guessing. */
  world: WorldSnapshot | null;
}

export type ScheduleVerdict =
  /** Take one now. */
  | { verdict: "run"; reason: string }
  /** Do nothing this tick. */
  | { verdict: "skip"; reason: string }
  /**
   * Due by the clock — ask the game how many players are on, then decide again.
   *
   * This exists so the timer does not probe three game servers over telnet and RCON every
   * five minutes just to discover that nothing is due. The cheap half of the decision
   * (a `readdir`) gates the expensive half.
   */
  | { verdict: "probe"; reason: string };

/**
 * Should an automatic backup of this world start right now?
 *
 * One function for the whole decision, deliberately: a "cheap pre-check" and a "real
 * check" as two predicates is two places for the rules to drift, and the rule that must
 * never drift is the player one. The tri-state is what lets one function be both.
 *
 * Order matters — the earliest `skip` wins, so the cheapest and most absolute refusals
 * come first.
 */
export function shouldRunScheduledBackup(i: ScheduleInput): ScheduleVerdict {
  if (!i.enabled) return { verdict: "skip", reason: "automatic backups are switched off" };

  if (i.lastFailedAtMs > 0 && i.now - i.lastFailedAtMs < i.failureCooldownMs) {
    const mins = Math.ceil((i.failureCooldownMs - (i.now - i.lastFailedAtMs)) / 60000);
    return {
      verdict: "skip",
      reason: `the last automatic backup failed; not retrying for ~${mins} min`,
    };
  }

  if (i.lastArchiveAtMs !== null) {
    const age = i.now - i.lastArchiveAtMs;
    if (age < i.intervalMs) {
      const hours = (age / 3_600_000).toFixed(1);
      return { verdict: "skip", reason: `the newest archive is ${hours}h old` };
    }
  }

  const due =
    i.lastArchiveAtMs === null
      ? "there is no archive for this world yet"
      : `the newest archive is ${((i.now - i.lastArchiveAtMs) / 3_600_000).toFixed(1)}h old`;

  if (i.world === null) return { verdict: "probe", reason: due };

  // Mid-boot, mid-shutdown, or a SteamCMD install: the files are moving and the player
  // count is not trustworthy. `"starting"` is also what the drivers report for a container
  // that is up and not answering, which is exactly the state where somebody could be
  // connected and we cannot tell — so it is a refusal, not a green light.
  if (i.world.status !== "online" && i.world.status !== "offline") {
    return { verdict: "skip", reason: `the server is ${i.world.status}` };
  }

  if (i.world.playersOnline > 0) {
    return {
      verdict: "skip",
      reason: `${i.world.playersOnline} player${i.world.playersOnline === 1 ? " is" : "s are"} connected`,
    };
  }

  return { verdict: "run", reason: due };
}

// ── the runner ───────────────────────────────────────────────────────────────

/**
 * Failure cooldowns, pinned to `globalThis` for the reason `operations.ts` documents at
 * length: Next compiles route handlers, server components and `instrumentation.ts` into
 * separate module graphs, so a module-level `Map` here is not one instance across them.
 * Only the timer writes it today, but "this is a general trap in this codebase" is the
 * note that module leaves, and the cost of honouring it is one line.
 */
interface ScheduleMemory {
  failedAt: Record<string, number>;
}
const g = globalThis as unknown as { __yoshlingBackupSchedule?: ScheduleMemory };
const MEMORY: ScheduleMemory = (g.__yoshlingBackupSchedule ??= { failedAt: {} });

/** Whether an automatic backup is currently on cooldown, and until when. */
export function scheduleState(game: GameId): { lastFailedAtMs: number } {
  return { lastFailedAtMs: MEMORY.failedAt[game] ?? 0 };
}

type ScheduleDecision = ScheduleVerdict & { minecraftContext?: MinecraftActiveContext };
async function decideFor(game: GameId, now: number): Promise<ScheduleDecision> {
  const minecraftContext = game === "minecraft" ? await minecraftActiveContext() : undefined;
  const dir = minecraftContext ? await minecraftBackupDirectory(minecraftContext) : BACKUP_DIRS[game];
  const archives = await listArchives(dir);
  const base: Omit<ScheduleInput, "world"> = {
    now,
    enabled: scheduleEnabled(),
    intervalMs: intervalMsFor(game),
    lastArchiveAtMs: archives.length > 0 ? archives[0].createdAtMs : null,
    lastFailedAtMs: MEMORY.failedAt[game] ?? 0,
    failureCooldownMs: FAILURE_COOLDOWN_MS,
  };

  const cheap = shouldRunScheduledBackup({ ...base, world: null });
  if (cheap.verdict !== "probe") return { ...cheap, minecraftContext };

  // Only now is a live probe worth its telnet/RCON round trip.
  const { getGameStatus } = await import("@/lib/game-manager");
  const snap = await getGameStatus(game);
  if (minecraftContext) await assertMinecraftProfileCurrent(minecraftContext);
  return { ...shouldRunScheduledBackup({
    ...base,
    world: { status: snap.status, playersOnline: snap.players.online },
  }), minecraftContext };
}

/**
 * One tick. Safe to call on a timer; safe to call while anything else is running.
 *
 * Logs one line per world on **every** tick, including "nothing due". A watcher that only
 * speaks up when it acts is indistinguishable from one that silently died, which cost real
 * time to diagnose the first time round with the Workshop watcher.
 *
 * Errors are per world: a 7 Days to Die backup that throws must not stop Project Zomboid's
 * from being considered.
 */
export async function runScheduledBackups(now = Date.now()): Promise<void> {
  if (!scheduleEnabled()) return;

  for (const meta of GAME_LIST) {
    const game = meta.id;
    let decision: ScheduleDecision;
    try {
      decision = await decideFor(game, now);
    } catch (e) {
      if (e instanceof MinecraftActiveProfileError) { console.log(`[backups] ${game}: skipped — Minecraft profile changed or is unverified`); continue; }
      console.error(`[backups] could not decide whether to back up ${game}:`, e);
      continue;
    }

    if (decision.verdict !== "run") {
      console.log(`[backups] ${game}: skipped — ${decision.reason}`);
      continue;
    }

    console.log(`[backups] ${game}: taking an automatic backup — ${decision.reason}`);
    try {
      const { createBackup } = await import("@/lib/backup-create");
      const result = await createBackup(game, null, decision.minecraftContext);
      // Cleared explicitly rather than left: a world that failed an hour ago and succeeds
      // now must not keep serving its old cooldown.
      delete MEMORY.failedAt[game];
      console.log(
        `[backups] ${game}: wrote ${result.backup.name}` +
          (result.pruned.length > 0 ? `, pruned ${result.pruned.length}` : "")
      );
    } catch (e) {
      const { OperationConflictError } = await import("@/lib/operations");
      if (e instanceof OperationConflictError || e instanceof MinecraftActiveProfileError) {
        // Not a failure: something else holds this world's files, which is precisely what
        // the lane is for. No cooldown — the next tick must be free to try, and nothing was
        // attempted so nothing is recorded anywhere.
        console.log(`[backups] ${game}: skipped — ${(e as Error).message}`);
        continue;
      }
      MEMORY.failedAt[game] = Date.now();
      // `createBackup` has already written the durable failure record; this is the
      // container-log copy, which is where a stack trace belongs.
      console.error(`[backups] ${game}: automatic backup failed:`, e);
    }
  }
}
