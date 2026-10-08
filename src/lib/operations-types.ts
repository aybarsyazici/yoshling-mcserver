// Client-safe shapes for the operation registry. No node imports — this file is
// pulled into the browser bundle by `useOperations` and the ledger, exactly the
// way `games.ts` is, so keep it free of `fs`, `child_process` and `@/lib/db`.

import type { GameId } from "@/lib/games";

export type OperationKind =
  | "power"
  | "settings"
  | "backup.create"
  | "backup.restore"
  | "backup.delete"
  | "mods.apply"
  | "mods.install"
  | "mods.update"
  | "world.upload"
  | "world.reset"
  | "game.update"
  | "profile.prepare"
  | "profile.adopt"
  | "profile.switch"
  | "profile.delete"
  | "profile.overview"
  /**
   * Synthetic, derived from the boot probe — never entered by a route and never
   * admissible. A game container booting is work that outlives this Node process,
   * so it has its own authority (`docker logs`) and is projected in on read.
   */
  | "boot";

/**
 * What an operation holds. Two operations whose sets intersect cannot run at the
 * same time.
 *
 * `"power"` is the box's single power slot. A power operation also declares every
 * `files:` lane, because saving and stopping a world writes that world's files —
 * declaring them all reproduces today's total exclusivity in one line instead of
 * reasoning about which world happens to be running.
 */
export type OperationResource = "power" | `files:${GameId}` | "auth:whitelist" | "render:minecraft-overview";

export type StepKind = "running" | "done" | "noop" | "failed";

export interface OpStepView {
  id: string;
  /** Present tense while running, past tense once settled. */
  label: string;
  kind: StepKind;
  /**
   * Which world this step acts on. Drives the row's tint, which is how a hand-off
   * reads as ONE object whose colour changes at the transfer point rather than as
   * two banners with two names to reconcile.
   */
  game?: GameId;
  /** Server epoch ms. */
  at: number;
  endedAt?: number;
  /** Real counts only — never a predicted total. */
  count?: { done: number; total?: number; noun: string };
  /** Newest concrete line: a mod name, a byte figure. Tidied server-side. */
  detail?: string;
}

export type Verdict = "ok" | "warn" | "bad";

/** A specific thing that was read back AFTER the work. Drives the outcome. */
export interface OperationFact {
  label: string;
  value: string;
  verdict?: Verdict;
  /**
   * Which world this fact is about, when that is not the operation's own world.
   *
   * A hand-off is ONE operation whose `game` is the world coming **up**, and it
   * records a `Shutdown` fact about the world going **down**. Without this the
   * summary took the name from `entry.game` and said "Minecraft — started in 5m 04s,
   * but it had to be killed after 300s" — measured on production 2026-09-29, while
   * `docker events` showed Minecraft had only ever been *started* and it was Project
   * Zomboid that was SIGKILLed. The step list had it right all along; only the derived
   * sentence (which is also the toast, and the toast shows nothing else) was wrong.
   */
  game?: GameId;
}

/**
 * How an operation ended.
 *
 * `unverified` exists because this codebase's recurring defect is "reports success
 * after doing nothing". An operation that finished without reading anything back
 * has not earned "ok", and saying so out loud is cheaper than a green toast that
 * turns out to be wrong.
 */
export type Outcome = "ok" | "partial" | "nothing" | "failed" | "unverified";

export type OperationProgress =
  | { kind: "indeterminate" }
  | { kind: "count"; done: number; total: number; noun: string }
  /** Renders as TEXT in the live step's detail line. Never as a bar. */
  | { kind: "fraction"; percent: number };

export interface OperationView {
  id: string;
  kind: OperationKind;
  game: GameId | null;
  /** Present tense, plain. Rendered verbatim. */
  title: string;
  /** Power ops only, so `busy` can be projected without inventing a verb. */
  action?: "start" | "stop" | "restart";
  startedAt: number;
  heartbeatAt: number;
  endedAt?: number;
  /** Non-null only once ended. */
  outcome?: Outcome;
  /** Server-derived from the recorded steps and facts. The UI never writes this. */
  summary?: string;
  facts: OperationFact[];
  steps: OpStepView[];
  progress: OperationProgress;
  resources: OperationResource[];
  holdsPower: boolean;
  /** null = automatic (the Workshop watcher), not "unknown". */
  startedBy: { name: string } | null;
  /** Set when a power operation was admitted over this file operation. */
  preempted?: boolean;
  /** Viewer lacks this world: labels, details, facts and summary stripped. */
  redacted?: boolean;
  /** True for `kind: "boot"` — derived, not tracked. No history. */
  synthetic?: boolean;
  /**
   * A projected boot that has outlived a plausible boot (12 minutes — the same
   * threshold `game-controls.tsx` uses for "Not responding"). The container is up and
   * the game is not answering, which is its own state and not "starting": it stops
   * claiming progress, drops out of the fast poll, and becomes dismissible.
   */
  stalled?: boolean;
}

export interface OperationsPayload {
  /** Live, non-stale, plus the synthetic boots. */
  operations: OperationView[];
  /** Terminal records: at most 20, at most 10 minutes past `endedAt`. */
  finished: OperationView[];
  /**
   * The server's clock. Elapsed time is computed against this, never against the
   * browser's — `Date.now() - startedAt` mixes two clocks and a skewed machine
   * then shows nonsense (or negative) elapsed times.
   */
  serverNow: number;
}

/** How long without a heartbeat before a record is treated as abandoned. */
export const OPERATION_STALE_MS = 90_000;

/**
 * How long the pip may sit still before the row admits it has heard nothing.
 * 1.5x the heartbeat interval, so one missed beat is not yet an accusation.
 */
export const OPERATION_QUIET_MS = 30_000;

/** True when this record has stopped proving it is alive. */
export function isStale(op: { heartbeatAt: number; endedAt?: number }, now: number): boolean {
  return !op.endedAt && now - op.heartbeatAt > OPERATION_STALE_MS;
}

/** The step currently running, if any. */
export function liveStep(op: OperationView): OpStepView | undefined {
  return op.steps.find((s) => s.kind === "running");
}

/**
 * How tall the gap under a settled step should be, in px, for a step that took
 * `seconds`.
 *
 * Duration lives in the GAP and never in the text line, so text is never crushed
 * and an instant step stacks flush against its neighbour — which correctly reads
 * as "these happened at once". Log-scaled because the steps on this box span
 * 433 ms (a Project Zomboid save) to 20 minutes (a SteamCMD download), and a
 * linear scale renders the first 30 of them as a single line.
 *
 * Checked: 0.4s→0, 5s→9, 30s→25, 60s→31, 300s→47, ≥20min→56.
 */
export function gapPx(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(56, Math.max(0, Math.round(22 * Math.log10(1 + seconds)) - 8));
}

/**
 * Lowercase the FIRST letter only, for splicing a title into mid-sentence.
 *
 * `title.toLowerCase()` mangled the two titles that embed a proper noun: "7 Days to
 * Die is busy — updating 7 days to die", and "changing project zomboid's memory
 * setting". The generic titles ("Creating a backup") lowercase fine either way.
 */
export function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** "4m 58s" / "26s" / "1h 04m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "4 minutes 58 seconds" — spoken form, for the sr-only duration on each row. */
export function spellDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return "under a second";
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  const mins = `${m} minute${m === 1 ? "" : "s"}`;
  return rest ? `${mins} ${rest} second${rest === 1 ? "" : "s"}` : mins;
}
