// Client-safe helpers the power UIs share, so `game-controls` and `mission-control`
// cannot drift on what "blocked" means or on what to say about it.

import { GAMES, type GameId } from "@/lib/games";
import { formatElapsed, liveStep, lowerFirst, type OperationView } from "@/lib/operations-types";

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

/** Live file operations on this world — the ones a power action would cut short. */
export function fileOperations(ops: OperationView[], game: GameId): OperationView[] {
  return ops.filter(
    (o) => !o.synthetic && !o.endedAt && !o.holdsPower && o.resources.includes(`files:${game}`)
  );
}

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
