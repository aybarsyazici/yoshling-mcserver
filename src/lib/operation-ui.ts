// Client-safe helpers the power UIs share, so `game-controls`, `game-overview` and
// `mission-control` cannot drift on what "blocked" means, on what the buttons say, or
// on what to tell you when they're dead.

import { GAMES, otherGames, type GameId } from "@/lib/games";
import {
  formatElapsed,
  liveStep,
  lowerFirst,
  type OpStepView,
  type OperationView,
} from "@/lib/operations-types";
import type { ControlLock, GameSnapshot } from "@/lib/use-games";

/**
 * What is stopping this world's power buttons from working right now.
 *
 * One expression instead of two: either something holds the box's power slot, or a
 * *file* operation is writing this world's data. Because a power operation declares
 * every `files:` lane, `busy !== null` implies this too — so this subsumes the old
 * `serverBusy` check and adds the file lanes the old one could not see. Synthetic
 * boots are excluded: a booting container blocks nothing, and Restart is precisely
 * the action you need while one is wedged.
 */
export function powerBlocker(ops: OperationView[], game: GameId): OperationView | undefined {
  return ops.find(
    (o) => !o.synthetic && !o.endedAt && (o.holdsPower || o.resources.includes(`files:${game}`))
  );
}

// A per-world `fileOperations(ops, game)` used to sit here, exported and never called
// by anything. It is deleted rather than kept for symmetry, because that is exactly how
// `operations.ts` grew its second copy of this logic: a plausible name with no caller
// gets picked up by the next person and used for the *warning*, where per-world is the
// wrong scope — see `liveFileOperations` below for the measured consequence.

/**
 * EVERY live file operation, on every world.
 *
 * Pre-emption is global — a power operation declares every `files:` lane, so `admit()`
 * marks every held file operation `preempted` regardless of which world it belongs to.
 * The confirm dialogs, though, were built from `files:${game}` and so named only the
 * world whose button was pressed. Measured on production 2026-09-29 with three backups
 * live on three worlds: pressing Power on for 7 Days to Die warned about the 7DTD backup
 * alone, and the Project Zomboid and Minecraft ones were destroyed unmentioned (one had
 * already written 290 MB; it concluded `failed` and was deleted).
 *
 * `powerBlocker` stays per-world — that is the *disable* decision and it is correct. It
 * is only the warning that has to be as wide as the consequence.
 */
export function liveFileOperations(ops: OperationView[]): OperationView[] {
  return ops.filter((o) => !o.synthetic && !o.endedAt && !o.holdsPower);
}

/**
 * "a Project Zomboid backup (4m 08s) and a Minecraft backup (1m 12s)" — for the
 * consequence clause of a confirm dialog. Each one's world is named, because on this box
 * the whole point of the sentence is which world loses work.
 */
export function namedFileOperations(
  ops: OperationView[],
  elapsed: (op: OperationView) => number
): string {
  const parts = ops.map((o) => {
    const name = o.game ? GAMES[o.game].name : "a server";
    return `${name} — ${fileOperationLabel(o, elapsed(o))}`;
  });
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "creating a backup (3m 21s)" — for a disabled control's stated reason.
 *
 * `lowerFirst`, not `toLowerCase()`: two of these titles embed a proper noun, and the
 * whole-string version produced "updating 7 days to die" and "changing project
 * zomboid's memory setting".
 */
export function fileOperationLabel(op: OperationView, elapsedMs: number): string {
  return `${lowerFirst(op.title)} (${formatElapsed(elapsedMs)})`;
}

/**
 * The sentence a disabled power control shows.
 *
 * A disabled control that does not say why is the same failure as a silent
 * operation, so this always names the world, the work and how long it has been
 * going.
 *
 * The stage is a **separate sentence**, in its own case. It used to be spliced in
 * lowercased after an em dash, which was harmless while stages were generic strings
 * ("Saving and stopping the server") and stopped being harmless the moment they became
 * step labels that name worlds: "Project Zomboid is starting up — saving project
 * zomboid (12s)".
 */
export function blockedReason(op: OperationView, elapsedMs: number): string {
  const name = op.game ? GAMES[op.game].name : "The server";
  const stage = liveStep(op)?.label;
  if (op.holdsPower) {
    const verb =
      op.action === "start"
        ? "starting up"
        : op.action === "stop"
        ? "shutting down"
        : op.action === "restart"
        ? "restarting"
        : "busy";
    return `${name} is ${verb} (${formatElapsed(elapsedMs)}).${
      stage ? ` ${stage}.` : ""
    } Controls unlock when it finishes.`;
  }
  return `Locked while ${name} is being worked on — ${fileOperationLabel(op, elapsedMs)}.`;
}

// ── one derivation of "what state is this world in, and what may I press" ──────

/**
 * How long a container may be up without the game answering before we stop calling it
 * a boot. The same 12 minutes `operations.ts` uses to mark a synthetic boot `stalled`,
 * deliberately: two thresholds for "still starting" is two answers to one question.
 */
const STUCK_AFTER_MS = 12 * 60 * 1000;

export interface PowerSurfaceInput {
  game: GameId;
  /** Every world's snapshot — the hand-off sentence has to name the *other* ones. */
  games: Record<GameId, GameSnapshot> | null;
  /** From `/api/games/status`, so a control the viewer may not use is disabled rather than 403'd. */
  can: { start: boolean; stop: boolean; restart: boolean };
  /** This tab fired a request about THIS world and has not heard back. */
  localBusy: boolean;
  /**
   * This tab fired a request about ANY world. Defaults to `localBusy`, which is correct
   * for the two single-world surfaces.
   *
   * `/home` renders all three worlds from one component, so there the two differ and
   * conflating them breaks in both directions: pass the global flag as `localBusy` and
   * every card claims to be working, pass the per-card flag alone and the *other* cards'
   * buttons stay live for the ~1.5s before the registry poll names a holder.
   */
  tabBusy?: boolean;
  /** The projected control lock (any world). */
  serverBusy: ControlLock | null;
  /** The registry operation holding the box's single power slot, if any. */
  powerHeld?: OperationView;
  /** A live *file* operation on this world: cut short by a power action, never blocking it. */
  preemptable?: OperationView;
  elapsedMs: (op: OperationView) => number;
  /** Server clock minus browser clock — `startedAtMs` is the box's clock, not ours. */
  clockSkewMs: number;
}

export interface PowerSurface {
  /** The container is up, whether or not the game answers. */
  containerUp: boolean;
  /** Up but not answering: its own state, and NOT "stopped". */
  unreachable: boolean;
  /** Unreachable for longer than any boot takes — almost certainly wedged. */
  looksStuck: boolean;
  /** Whole minutes it has been unreachable, for the stuck sentence. */
  unreachableMinutes: number;
  /** The power holder's live step, when that step is about THIS world. */
  ownStep: OpStepView | undefined;
  /** Something is happening to *this* container (not merely somewhere on the box). */
  ownBusy: boolean;
  /** What is happening to THIS world — a hand-off away from us is a stop, not a start. */
  ownAction: "start" | "stop" | "restart" | undefined;
  ownStopping: boolean;
  /** Any power operation anywhere locks every power control: one world at a time. */
  busy: boolean;
  /** Whether the viewer may press the power button *in its current sense*. */
  canPower: boolean;
  canRestart: boolean;
  /** The power button's text. */
  label: string;
  /** The state heading: Running / Working… / Not responding / Starting… / Stopped. */
  heading: string;
  /** Why the control is dead, or what pressing it will do. Never empty. */
  reason: string;
  /** Worlds that would have to be saved and stopped for this one to start. */
  blocking: GameId[];
}

/**
 * The one derivation of a world's power state, shared by all three surfaces that
 * render it: `/{game}/server` (`game-controls`), `/{game}` (`game-overview`) and
 * `/home` (`mission-control`).
 *
 * It exists because those three had three different answers for one container, and the
 * two that were wrong were the two you meet first. `game-controls` was fixed in
 * `a7d76b8` to tell "stopped" apart from "up but not answering"; `game-overview` — the
 * page every world *opens on* — never was. So on a wedged server it offered **Power
 * on**, which runs `docker start` on an already-running container (a silent no-op that
 * toasts success), and hid Restart entirely behind `isOnline`, which is the one state a
 * wedged server is not in. Both the useful action and the honest label were missing at
 * once, on the more obvious of the two pages, for the whole of the fix's lifetime.
 * `mission-control`'s cards had the same inversion plus no `can` check at all, so a
 * MEMBER pressed Power on and got an unexplained 403.
 *
 * Consolidated **onto `game-controls`' logic**, never the reverse. The two properties
 * that carry the fix and must survive any future edit:
 *
 *  - `containerUp = containerRunning ?? isOnline`, and Restart is gated on
 *    `containerUp` — **not** on `isOnline`. That inversion is the entire recovery path.
 *  - the power button's sense and label branch on `containerUp` too, so a world that is
 *    up but mute offers Power **off** rather than a start that cannot do anything.
 *
 * Pure and hook-free on purpose: `mission-control` calls it once per card, inside a
 * `.map()`.
 */
export function powerState(input: PowerSurfaceInput): PowerSurface {
  const { game, games, can, localBusy, serverBusy, powerHeld, preemptable, clockSkewMs } = input;
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";

  const containerUp = snap?.containerRunning ?? isOnline;
  const unreachable = containerUp && !isOnline;
  /**
   * Skew-corrected: `startedAtMs` is docker's `StartedAt` on the box, so comparing it
   * against a browser clock a few minutes fast declared a healthy 30-second boot "Not
   * responding", and a slow one would never say it at all.
   */
  const startedFor = snap?.startedAtMs ? Date.now() + clockSkewMs - snap.startedAtMs : 0;
  const looksStuck = unreachable && startedFor > STUCK_AFTER_MS;
  const unreachableMinutes = Math.round(startedFor / 60000);

  /**
   * A hand-off is ONE operation whose `game` is the world coming up, and its steps are
   * tagged per world — so the world being saved and shut down appears only in the steps.
   * Keying ownership on `op.game` alone left the outgoing world's own page claiming
   * nothing was happening to it: measured 2m 35s into a Project Zomboid save+stop,
   * `/zomboid/server` read "Running / 0h 14m" with its uptime still counting up.
   */
  const step = powerHeld ? liveStep(powerHeld) : undefined;
  const ownStep = step?.game === game ? step : undefined;
  const busy = (input.tabBusy ?? localBusy) || serverBusy !== null || powerHeld !== undefined;
  const ownBusy =
    localBusy || serverBusy?.game === game || powerHeld?.game === game || ownStep !== undefined;
  /**
   * On a hand-off away from us the operation's action is `start` (of the *other* world)
   * while what is happening here is a stop — so nothing may say "Starting…" or animate
   * as though we were coming up.
   */
  const ownAction: "start" | "stop" | "restart" | undefined =
    powerHeld?.game === game ? powerHeld.action : ownStep ? "stop" : serverBusy?.action;
  const ownStopping = ownAction === "stop";

  // Power on cannot help when the container is already up, so the button's *sense*
  // flips — and with it which permission it needs.
  const canPower = containerUp ? can.stop : can.start;

  // Only one world can hold the box, but check every other one rather than assume
  // which: a stale container would otherwise be missed.
  const blocking = otherGames(game).filter((g) => {
    const s = games?.[g]?.status;
    return s === "online" || s === "starting";
  });

  return {
    containerUp,
    unreachable,
    looksStuck,
    unreachableMinutes,
    ownStep,
    ownBusy,
    ownAction,
    ownStopping,
    busy,
    canPower,
    canRestart: containerUp && can.restart,
    label: ownBusy ? busyLabel(ownAction) : containerUp ? "Power off" : "Power on",
    heading: isOnline
      ? "Running"
      : ownBusy
      ? "Working…"
      : looksStuck
      ? "Not responding"
      : unreachable
      ? "Starting…"
      : "Stopped",
    reason: powerReason({
      game,
      blocking,
      can,
      canPower,
      looksStuck,
      unreachable,
      unreachableMinutes,
      isOnline,
      powerHeld,
      preemptable,
      elapsedMs: input.elapsedMs,
    }),
    blocking,
  };
}

/**
 * The sentence under the controls. A plain string, like `blockedReason`, so the three
 * surfaces render one set of words rather than three.
 *
 * Order matters and is not arbitrary: a *blocked* control has to explain the block
 * before it explains anything else, and a wedged server has to be told about Restart
 * before it is told to wait.
 */
function powerReason(a: {
  game: GameId;
  blocking: GameId[];
  can: { start: boolean; stop: boolean; restart: boolean };
  canPower: boolean;
  looksStuck: boolean;
  unreachable: boolean;
  unreachableMinutes: number;
  isOnline: boolean;
  powerHeld?: OperationView;
  preemptable?: OperationView;
  elapsedMs: (op: OperationView) => number;
}): string {
  const meta = GAMES[a.game];
  if (a.powerHeld) return blockedReason(a.powerHeld, a.elapsedMs(a.powerHeld));
  if (a.preemptable) {
    // Deliberately NOT a blocked message: a file operation does not disable the power
    // buttons, because on this box a wedged server is a documented real event and Power
    // off is the recovery path. The confirm dialog is what "force" looks like here.
    return (
      `${meta.name} is being worked on — ` +
      `${fileOperationLabel(a.preemptable, a.elapsedMs(a.preemptable))}. Powering off or ` +
      `restarting now cuts it short; you'll be asked to confirm.`
    );
  }
  if (a.looksStuck) {
    return (
      `The container is up but the game has not answered for ${a.unreachableMinutes} minutes. ` +
      `It is most likely wedged — Restart is the way out. Powering off and on again does the ` +
      `same thing more slowly.`
    );
  }
  if (a.unreachable) {
    return (
      `Running but still loading, so it can't answer yet. Watch the strip at the top of the ` +
      `page for progress; Restart is available if it stops moving.`
    );
  }
  if (!a.canPower && !a.can.restart) {
    return "You can view this server but not power it. Ask an admin for Mod access.";
  }
  if (a.blocking.length > 0) {
    const names = a.blocking.map((g) => GAMES[g].name).join(" and ");
    const verb = a.blocking.length > 1 ? "are" : "is";
    const them = a.blocking.length > 1 ? "them" : "it";
    return `${names} ${verb} running. Starting this one stops ${them} first.`;
  }
  if (a.isOnline) return "Stopping saves the world first.";
  return "Only one server runs at a time.";
}

/**
 * The in-flight verb on a power button.
 *
 * It must be fed `ownAction`, never the operation's own `action`: during a hand-off
 * those differ, and the global one relabels the *outgoing* world's button with the
 * incoming world's verb.
 *
 * Module-local for that reason — `powerState` is the only thing that may call it, and
 * the label it produces is already on the returned surface. Exporting it would put a
 * function that takes "an action" back within reach of a caller holding the wrong one,
 * which is the bug this whole helper exists to close.
 */
function busyLabel(action?: "start" | "stop" | "restart"): string {
  switch (action) {
    case "restart":
      return "Restarting…";
    case "stop":
      return "Stopping…";
    case "start":
      return "Starting…";
    default:
      return "Working…";
  }
}

/**
 * How long stopping these worlds takes, worst case, in seconds.
 *
 * Exists so no surface writes "about a minute" again: that string was hardcoded in the
 * hand-off confirm and on the memory card, and Project Zomboid's stop is a measured
 * 5m 03s. See `GameMeta.stopSeconds`.
 */
export function slowestStopSeconds(games: GameId[]): number {
  return games.reduce((worst, g) => Math.max(worst, GAMES[g].stopSeconds), 0);
}

/** "five minutes" / "about a minute" — a duration in words, for prose. */
export function spellMinutes(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const mins = Math.round(seconds / 60);
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return `${WORDS[mins] ?? mins} minutes`;
}
