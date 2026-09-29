// The operation registry: every piece of work on this box that can outlive its
// own HTTP response.
//
// ## Why this exists
//
// The control lock before it was a single nullable slot, so `/api/games/status`
// could name at most one operation and it always named the *locked* one. The
// 20-minute 7 Days to Die SteamCMD update took no lock at all, which means the
// operation that most needed a banner was structurally the one that could never
// have it. Measured 2026-09-15: a mod-update apply ran 18:30:25 → 18:36:23 with
// the power buttons correctly locked and nothing anywhere saying why, which reads
// as the feature having done nothing.
//
// So: one additive registry keyed by id, mutual exclusion expressed as declared
// *resources* rather than one global slot, and `currentControlLock()` reduced to a
// projection of whichever entry holds `"power"` — so `busy` keeps its exact wire
// shape and every existing consumer keeps working.
//
// ## State lives in module memory, on purpose
//
// One Node process (`CMD ["node","server.js"]`, no cluster — module state is
// already shared between route handlers and `instrumentation.ts` today). Every
// operation here is a promise awaited inside it. So:
//
//     the entry exists  ⟺  the awaiting frame exists.
//
// An in-memory entry cannot outlive its work, which is exactly what an on-disk
// marker can and did: `applyingSince` in `pz-updates.json` once read "Updating
// now — started 3 days ago" permanently, and `zomboid-updates.ts` had to grow a
// whole `PROCESS_STARTED_AT` reconciliation to undo its own persistence. Nothing
// to write means nothing to reconcile.
//
// What legitimately survives a restart is work a *game container* is doing, and
// that has its own authority — the boot probe, re-derived from `docker logs` on
// every read. §`syntheticBoots` projects it in as a read-only operation so the
// split is invisible to the UI and still honest about which half knows what.

import { GAME_LIST, GAMES, type GameId } from "@/lib/games";
import {
  OPERATION_STALE_MS,
  formatElapsed,
  type OperationFact,
  type OperationKind,
  type OperationProgress,
  type OperationResource,
  type OperationView,
  type OpStepView,
  type Outcome,
  type OperationsPayload,
  type StepKind,
} from "@/lib/operations-types";

export type {
  OperationFact,
  OperationKind,
  OperationProgress,
  OperationResource,
  OperationView,
  OperationsPayload,
  Outcome,
};

// ── the lock's public shape, unchanged ───────────────────────────────────────

export type ControlAction = "start" | "stop" | "restart";

/**
 * Projection of the entry holding `"power"`, in exactly the shape
 * `/api/games/status` has always emitted. Frozen: `use-games.ts` and
 * `game-controls.tsx` read it and must not need an edit.
 */
export interface ControlLock {
  game: GameId;
  action: ControlAction;
  /** When the operation began. Never moves — the UI shows elapsed time from it. */
  since: number;
  /**
   * Last proof-of-life from the holder. Expiry is judged on THIS, never on
   * `since`, so a slow operation keeps its lock while a crashed one still frees.
   */
  beat: number;
  /** What the holder is doing right now. */
  stage?: string;
}

// ── resources and admission ──────────────────────────────────────────────────

/**
 * What a power operation holds: the power slot AND every world's files.
 *
 * It takes the file lanes too because a power operation may save and stop any
 * world, and therefore may be writing any world's files. Declaring them all
 * reproduces today's total exclusivity in one line rather than reasoning at
 * runtime about which world happens to be running.
 */
export const POWER_RESOURCES: OperationResource[] = [
  "power",
  ...GAME_LIST.map((g) => `files:${g.id}` as OperationResource),
];

const DEFAULT_RESOURCES: Record<OperationKind, (g: GameId | null) => OperationResource[]> = {
  power: () => POWER_RESOURCES,
  settings: () => POWER_RESOURCES,
  "mods.update": () => POWER_RESOURCES,
  "world.reset": () => POWER_RESOURCES,
  "game.update": () => POWER_RESOURCES,
  "backup.restore": () => POWER_RESOURCES,
  "backup.create": (g) => (g ? [`files:${g}`] : []),
  "backup.delete": (g) => (g ? [`files:${g}`] : []),
  "mods.apply": (g) => (g ? [`files:${g}`] : []),
  "world.upload": (g) => (g ? [`files:${g}`] : []),
  // Derived from the boot probe. Never admitted, so it can never block anything.
  boot: () => [],
};

// ── errors ───────────────────────────────────────────────────────────────────

export class OperationConflictError extends Error {
  readonly conflict: OperationView;
  readonly resource: OperationResource;
  constructor(conflict: OperationView, resource: OperationResource, message: string) {
    super(message);
    this.name = "OperationConflictError";
    this.conflict = conflict;
    this.resource = resource;
  }
}

/**
 * Kept as a subclass so the nine existing `instanceof ControlBusyError` sites and
 * their `e.lock.game` / `e.lock.action` reads keep working untouched. Thrown only
 * when the *conflicting* operation is a power one, because that is the only case
 * where a `ControlLock` can be projected without inventing a verb.
 */
export class ControlBusyError extends OperationConflictError {
  get lock(): ControlLock {
    return projectLock(this.conflict) ?? {
      game: this.conflict.game ?? "minecraft",
      action: this.conflict.action ?? "restart",
      since: this.conflict.startedAt,
      beat: this.conflict.heartbeatAt,
      stage: this.conflict.steps.find((s) => s.kind === "running")?.label,
    };
  }
}

// ── the record ───────────────────────────────────────────────────────────────

interface Step {
  id: string;
  label: string;
  kind: StepKind;
  game?: GameId;
  at: number;
  endedAt?: number;
  count?: { done: number; total?: number; noun: string };
  detail?: string;
}

interface Entry {
  id: string;
  kind: OperationKind;
  game: GameId | null;
  title: string;
  action?: ControlAction;
  startedAt: number;
  heartbeatAt: number;
  endedAt?: number;
  outcome?: Outcome;
  summary?: string;
  facts: OperationFact[];
  steps: Step[];
  progress: OperationProgress;
  resources: OperationResource[];
  startedBy: { name: string } | null;
  preempted?: boolean;
  /** The thrown message, for the failure summary. Never shown raw as a fact. */
  error?: string;
}

const LIVE = new Map<string, Entry>();

/** Terminal records, newest last. Bounded so it cannot grow. */
const FINISHED: Entry[] = [];
const FINISHED_MAX = 20;
const FINISHED_TTL_MS = 10 * 60 * 1000;

const HEARTBEAT_MS = 20_000;

let seq = 0;
function nextId(kind: OperationKind): string {
  seq += 1;
  return `${kind.replace(/\./g, "-")}-${Date.now().toString(36)}-${seq}`;
}

function notStale(e: Entry, now = Date.now()): boolean {
  return !e.endedAt && now - e.heartbeatAt <= OPERATION_STALE_MS;
}

// ── the only entry point ─────────────────────────────────────────────────────

export interface OperationSpec {
  kind: OperationKind;
  game: GameId | null;
  /** Present tense, plain. Rendered verbatim: "Creating a backup". */
  title: string;
  action?: ControlAction;
  resources?: OperationResource[];
  startedBy?: { name: string } | null;
}

export interface OpHandle {
  readonly id: string;
  /** Settle the current step (keeping its label) and open a new one. Present tense. */
  step(label: string, opts?: { game?: GameId }): void;
  /** Settle the current step with its past-tense label and a real count. */
  settle(
    label: string,
    opts?: { kind?: "done" | "noop"; count?: { done: number; total?: number; noun: string } }
  ): void;
  /**
   * Settle the current step as a failure without throwing.
   *
   * For a route that refuses input and answers 4xx on its own terms — an unsafe zip,
   * a name it can't derive. The operation still concludes `failed`, because from the
   * user's point of view the thing they asked for did not happen; what differs is that
   * the route owns the HTTP status rather than falling through to a 500.
   */
  reject(label: string): void;
  /** Newest concrete line on the live step. */
  detail(line: string | undefined): void;
  /** Record evidence AS IT IS OBTAINED, so a crash still leaves a trail. */
  fact(f: OperationFact): void;
  /** Real counts only. Never a predicted total. */
  progress(p: OperationProgress): void;
}

/**
 * The only way to finish successfully.
 *
 * There is deliberately no `summary` field: a route cannot hand the UI a success
 * sentence. `concludeOperation` writes it, from what was actually recorded. That
 * closes the hole where `{ summary: "Done" }` with no evidence still rendered
 * green — the documented recurring defect of this codebase, at the API layer.
 */
export interface OpSuccess<T> {
  facts?: OperationFact[];
  value: T;
  /**
   * Structurally forbidden, not merely absent.
   *
   * Leaving them off the type is not enough: TypeScript's excess-property check does
   * not fire on an object literal returned from an arrow whose return type is being
   * *inferred*, so `async (op) => ({ summary: "Done", value })` compiled cleanly and
   * the field was silently dropped. Typed `never`, the same line is a hard error —
   * which is what makes "a route cannot write its own success sentence" a fact about
   * the compiler rather than a convention in a comment.
   */
  summary?: never;
  outcome?: never;
}

/**
 * Enter an operation, run it, and record what it proved.
 *
 * There is no `begin()` / `end()` pair and no exported handle to the map, so a
 * route cannot start an operation without also ending it — it never had the means.
 * Release is identity-checked and the heartbeat closes over `entry`, which are the
 * two bugs the old single-slot lock had: `finally { controlLock = null }` let a
 * late-finishing operation wipe a successor's lock, and
 * `if (controlLock) controlLock.beat = …` let a stale operation's interval keep an
 * unrelated lock alive. Same root cause — no identity check — and neither is
 * inherited here.
 */
export async function runOperation<T>(
  spec: OperationSpec,
  fn: (op: OpHandle) => Promise<OpSuccess<T>>
): Promise<T> {
  const entry = admit(spec);

  // Keep proving we are alive for as long as the work takes. Closes over `entry`,
  // never over "whatever is in the map", so it cannot refresh someone else's
  // record. There is NO cap on total duration: a Project Zomboid graceful stop is
  // 300s on its own and a SteamCMD seed has a 45-minute timeout, and a total-length
  // cap is exactly what once let an operation lose its own lock mid-flight while a
  // second SteamCMD run raced it to "updated 0 of 1 mods".
  const heart = setInterval(() => {
    entry.heartbeatAt = Date.now();
  }, HEARTBEAT_MS);

  const handle = makeHandle(entry);
  try {
    const { facts = [], value } = await fn(handle);
    for (const f of facts) entry.facts.push(f);
    settleCurrent(entry, undefined, "done");
    return value;
  } catch (err) {
    // Collapsed to one line: a `docker` failure is three lines of stderr, and the
    // summary it lands in is also a toast. The full text is still in the container log.
    const raw = err instanceof Error ? err.message : String(err);
    entry.error = raw.replace(/\s+/g, " ").trim().slice(0, 240);
    settleCurrent(entry, undefined, "failed");
    throw err;
  } finally {
    clearInterval(heart);
    entry.endedAt = Date.now();
    entry.outcome = concludeOperation(entry);
    entry.summary = summarize(entry, entry.outcome);
    // Identity-checked: only remove the record if it is still ours. An expired
    // record stays in the map until its own `finally` runs, so expiry can widen an
    // admission window but can never delete a successor.
    if (LIVE.get(entry.id) === entry) LIVE.delete(entry.id);
    FINISHED.push(entry);
    pruneFinished();
  }
}

function makeHandle(entry: Entry): OpHandle {
  return {
    id: entry.id,
    step(label, opts) {
      settleCurrent(entry, undefined, "done");
      entry.steps.push({
        id: `${entry.id}:${entry.steps.length}`,
        label,
        kind: "running",
        game: opts?.game ?? entry.game ?? undefined,
        at: Date.now(),
      });
      entry.heartbeatAt = Date.now();
    },
    settle(label, opts) {
      const s = current(entry);
      if (!s) return;
      if (opts?.count) s.count = opts.count;
      settleCurrent(entry, label, opts?.kind ?? "done");
      entry.heartbeatAt = Date.now();
    },
    reject(label) {
      settleCurrent(entry, label, "failed");
      entry.heartbeatAt = Date.now();
    },
    detail(line) {
      const s = current(entry);
      if (s) s.detail = tidyLine(line);
      entry.heartbeatAt = Date.now();
    },
    fact(f) {
      entry.facts.push(f);
      entry.heartbeatAt = Date.now();
    },
    progress(p) {
      entry.progress = p;
      entry.heartbeatAt = Date.now();
    },
  };
}

function current(entry: Entry): Step | undefined {
  return entry.steps.find((s) => s.kind === "running");
}

function settleCurrent(entry: Entry, label: string | undefined, kind: StepKind): void {
  const s = current(entry);
  if (!s) return;
  if (label) s.label = label;
  s.kind = kind;
  s.endedAt = Date.now();
}

/**
 * Turn a raw server log line into something worth reading.
 *
 * Project Zomboid writes `LOG : Mod f:0 st:5,252,142> loading Secretz42`; the part
 * after the last `>` is the only bit anyone cares about.
 */
export function tidyLine(line?: string): string | undefined {
  if (!line) return undefined;
  const after = line.includes(">") ? line.slice(line.lastIndexOf(">") + 1) : line;
  const clean = after.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 140) : undefined;
}

// ── admission ────────────────────────────────────────────────────────────────

/**
 * Check and insert in ONE synchronous tick — no `await` between "is it free" and
 * "it is mine", or two requests interleave and both win. The old lock had this
 * property and it has to be preserved.
 */
function admit(spec: OperationSpec): Entry {
  if (spec.kind === "boot") {
    throw new Error("boot operations are derived, not entered");
  }
  const resources = spec.resources ?? DEFAULT_RESOURCES[spec.kind](spec.game);
  const now = Date.now();
  const held = [...LIVE.values()].filter(
    (o) => notStale(o, now) && o.resources.some((r) => resources.includes(r))
  );

  if (held.length > 0) {
    const wantsPower = resources.includes("power");
    const powerHeld = held.find((o) => o.resources.includes("power"));

    // A power operation is admitted OVER a file operation, and the file operation
    // is marked `preempted`.
    //
    // The other ordering — 409 the power op — is the one to avoid: on this box a
    // wedged Project Zomboid is a documented real event and Power off / Restart is
    // the recovery path, so letting a four-minute backup hold recovery hostage
    // would be a regression in the one path that must never be blocked. The
    // consequence (a torn archive) is stated in a confirm dialog instead; the
    // dialog IS the force flag.
    if (wantsPower && !powerHeld) {
      for (const o of held) o.preempted = true;
    } else {
      const other = powerHeld ?? held[0];
      const resource = other.resources.find((r) => resources.includes(r))!;
      const message = conflictMessage(other, now);
      // The conflict object is trimmed rather than fully redacted: its *title* is
      // already generic ("Creating a backup") and the message beside it names the same
      // world that `/api/games/status` reports to everyone anyway. What must not travel
      // is the identifying content — the live detail line ("Downloading Secretz42") and
      // the facts. Blanking the title too would leave a 409 that says less than its own
      // error string.
      const conflict = trimForConflict(view(other, false));
      throw other.action
        ? new ControlBusyError(conflict, resource, message)
        : new OperationConflictError(conflict, resource, message);
    }
  }

  const entry: Entry = {
    id: nextId(spec.kind),
    kind: spec.kind,
    game: spec.game,
    title: spec.title,
    action: spec.action,
    startedAt: now,
    heartbeatAt: now,
    facts: [],
    steps: [],
    progress: { kind: "indeterminate" },
    resources,
    startedBy: spec.startedBy ?? null,
  };
  LIVE.set(entry.id, entry);
  return entry;
}

function conflictMessage(other: Entry, now: number): string {
  const name = other.game ? GAMES[other.game].name : "The server";
  const ago = formatElapsed(now - other.startedAt);
  if (other.action) {
    const verb =
      other.action === "start" ? "starting" : other.action === "stop" ? "stopping" : "restarting";
    return `${name} is already ${verb} (${ago}). Try again when it finishes.`;
  }
  return `${name} is busy — ${other.title.toLowerCase()} (${ago}). Try again when it finishes.`;
}

// ── conclusion: the honesty spine ────────────────────────────────────────────

/**
 * What actually happened, derived from the recorded steps and facts and nothing
 * else. First match wins.
 *
 * This is the whole point of the module. A route cannot assert an outcome, so
 * "installed 0 of 166 mods" cannot render green: the sentence no longer decides
 * the colour, the recorded count does.
 */
function concludeOperation(entry: Entry): Outcome {
  const { steps, facts } = entry;

  if (entry.error) return "failed";
  if (steps.some((s) => s.kind === "failed")) return "failed";
  if (facts.some((f) => f.verdict === "bad")) return "failed";

  // "It ran and changed nothing." A count of 0 out of a real total is the clearest
  // possible evidence of it, and it is the exact shape of the modpack apply that
  // installed 0 of 166 and toasted success.
  //
  // `allNoop` has to exclude any step that DID make progress. Without that, a
  // one-step operation settling "Installed 142 of 166 mods" as `noop` satisfies
  // "every step is a noop" and concluded `nothing` — reporting that 142 downloaded
  // mods had changed nothing, which is its own kind of lie. Verified against the
  // in-process probe, which is how this was caught.
  const madeProgress = steps.some((s) => (s.count?.done ?? 0) > 0);
  const allNoop = steps.length > 0 && steps.every((s) => s.kind === "noop") && !madeProgress;
  const zeroOfSomething = steps.some(
    (s) => s.kind === "noop" && s.count && s.count.done === 0 && (s.count.total ?? 0) > 0
  );
  if (allNoop || zeroOfSomething) return "nothing";

  if (steps.some((s) => s.kind === "noop")) return "partial";
  if (facts.some((f) => f.verdict === "warn")) return "partial";

  // Finished, and read nothing back. Not a success — this codebase's recurring
  // defect is reporting one without evidence, so not checking has a visible price.
  if (facts.length === 0) return "unverified";

  return "ok";
}

/** The count recorded by the most informative step, for the summary templates. */
function bestCount(entry: Entry): { done: number; total?: number; noun: string } | undefined {
  for (let i = entry.steps.length - 1; i >= 0; i--) {
    const c = entry.steps[i].count;
    if (c) return c;
  }
  return undefined;
}

function factValue(entry: Entry, label: string): string | undefined {
  return entry.facts.find((f) => f.label === label)?.value;
}

function warnFacts(entry: Entry): OperationFact[] {
  return entry.facts.filter((f) => f.verdict === "warn");
}

/**
 * The sentence the ledger and the completion toast both show.
 *
 * Generated here and nowhere else, which is what makes the toast incapable of
 * lying: its text IS this string. A **failed** summary always names the world's
 * resulting power state, because `restart: "no"` means nothing revives Project
 * Zomboid and nothing else on screen would say so.
 */
function summarize(entry: Entry, outcome: Outcome): string {
  const name = entry.game ? GAMES[entry.game].name : "The server";
  const took = formatElapsed((entry.endedAt ?? Date.now()) - entry.startedAt);
  const count = bestCount(entry);
  const warns = warnFacts(entry);
  // Values, not labels: "killed after 300s" reads as a sentence, "Shutdown: killed
  // after 300s" reads as a log line.
  const warnText = warns.map((f) => f.value).join("; ");
  const power = factValue(entry, "Power");

  if (outcome === "failed") {
    // Where the reason comes from, in order of how specific it is: a thrown error, a
    // step the route rejected (`op.reject`), or the `bad` fact that produced the
    // verdict. That last fallback matters — "the operation failed" was the whole
    // sentence when a read-back said `not found after the move`, which is the most
    // useful thing anyone could have been told.
    const rejected = [...entry.steps].reverse().find((s) => s.kind === "failed");
    const badFact = entry.facts.find((f) => f.verdict === "bad");
    const why =
      entry.error?.trim() ||
      rejected?.label ||
      (badFact && `${badFact.label.toLowerCase()} — ${badFact.value}`) ||
      "the operation failed";
    // Only an operation that could have changed the power state says where it left it.
    // A modpack install does not touch power, and telling someone to check it is noise
    // pointing at the wrong page.
    const touchesPower = entry.resources.includes("power");
    const where = power
      ? ` ${name} is ${power}.`
      : touchesPower
      ? ` Check ${name}'s power state on its page before trying again.`
      : ` Check ${describeTarget(entry)} before trying again.`;
    return `${verbFor(entry)} failed after ${entry.steps.length} step${
      entry.steps.length === 1 ? "" : "s"
    }: ${why}.${where}`;
  }

  if (outcome === "unverified") {
    return `${verbFor(entry)} finished in ${took}, but nothing could be read back to confirm it. Check ${describeTarget(entry)} before relying on it.`;
  }

  if (outcome === "nothing") {
    const what = count ? ` ${count.done} of ${count.total} ${count.noun} ${count.total === 1 ? "was" : "were"} ${pastNoun(entry)}.` : "";
    return `${name} — finished in ${took}, but nothing changed.${what}`;
  }

  switch (entry.kind) {
    case "power": {
      const past =
        entry.action === "stop" ? "stopped" : entry.action === "restart" ? "restarted" : "started";
      if (outcome === "partial") {
        // A fact's `value` is terse so the facts row stays scannable, which means the
        // template has to supply the grammar. "but killed after 300s" is not a
        // sentence; "but it had to be killed after 300s" is.
        const shutdown = factValue(entry, "Shutdown");
        const why = shutdown
          ? `it had to be ${shutdown}`
          : warnText.toLowerCase() || "it did not go cleanly";
        return `${name} — ${past} in ${took}, but ${why}. ${powerSentence(entry)}`;
      }
      return `${name} ${past} in ${took}. ${powerSentence(entry)}`;
    }
    case "settings": {
      // Mechanical on purpose: the route records what it *read back*, and whether
      // the two agree decides the verdict. No route gets to write "Saved."
      const what = factValue(entry, "Setting");
      const conf = factValue(entry, "Configured");
      const live = factValue(entry, "Container");
      if (!conf || !live) return `${name} settings applied in ${took}.`;
      if (outcome === "partial") {
        return `Saved ${conf}, but the container reports ${live}. The configured and running values disagree.`;
      }
      return `${what ?? "The setting"} is now ${conf}. The container reports ${live}.`;
    }
    case "backup.create": {
      const size = factValue(entry, "Size") ?? "unknown size";
      if (outcome === "partial") {
        const map = factValue(entry, "World map");
        const why = map?.startsWith("not included")
          ? "the world map isn't in it"
          : warnText.toLowerCase() || "part of it is missing";
        // Said plainly, because a 4 MB config-only archive looks entirely plausible in
        // the backups list and is the one thing you cannot restore a world from.
        return `Backup created — ${size}, but ${why}. This is not a restore point.`;
      }
      return `Backup created — ${size}${factValue(entry, "World map") === "included" ? ", world map included" : ""}.`;
    }
    case "backup.restore": {
      const from = factValue(entry, "Archive");
      const restarted = factValue(entry, "Server") === "starting again";
      if (outcome === "partial") {
        return `${name} restored${from ? ` from ${from}` : ""}. ${name} stayed powered off — Power on when you're ready.`;
      }
      return `${name} restored${from ? ` from ${from}` : ""}. ${restarted ? "The server is starting again." : "The server is powered off."}`;
    }
    case "backup.delete":
      return `Deleted ${factValue(entry, "Archive") ?? "the backup"}.`;
    case "mods.apply": {
      if (!count) return `Modpack applied in ${took}.`;
      const missing = (count.total ?? 0) - count.done;
      if (outcome === "partial") {
        // Every mod landed, so the `partial` came from somewhere else in the run — the
        // pre-install world backup, or a jar that refused to be removed. Saying
        // "0 failed" there would be nonsense.
        if (missing <= 0) {
          return `Installed ${count.done} of ${count.total} ${count.noun}, but ${
            warnText || "something else in the run did not go cleanly"
          }.`;
        }
        return `Installed ${count.done} of ${count.total} ${count.noun}; ${missing} failed. Open the report for which ones.`;
      }
      return `Installed ${count.done} of ${count.total} ${count.noun}. Restart ${name} to load them.`;
    }
    case "mods.update": {
      if (outcome === "partial") {
        return `${warnText || "Some mods failed to download"}. ${powerSentence(entry)}`;
      }
      return `Finished in ${took}. ${count ? `${count.done} ${count.noun} updated` : "Mods updated"}, ${
        factValue(entry, "Power") === "running" ? "the server is back up" : "the server is powered off"
      }.`;
    }
    case "world.upload": {
      const placed = factValue(entry, "Installed as");
      if (outcome === "partial") return `Upload finished, but ${warnText.toLowerCase()}.`;
      return `Uploaded and placed ${placed ?? "the world"}${count ? ` — ${count.done} ${count.noun}` : ""}.`;
    }
    case "world.reset": {
      const to = factValue(entry, "New game name");
      if (outcome === "partial") return `World reset, but ${warnText.toLowerCase()}.`;
      return `World reset. ${name} is generating ${to ?? "a fresh save"}.`;
    }
    case "game.update":
      // The route can only ever prove it *requested* the update — the build id does
      // not change until the ~17 GB download finishes inside the container. So this
      // is amber by construction, and the synthetic boot carries the next 20 minutes.
      return outcome === "partial"
        ? `Update requested — ${name} is downloading the new build. Watch the bar at the top of the page.`
        : `${name} update applied in ${took}.`;
    default:
      return `${name} — finished in ${took}.`;
  }
}

function verbFor(entry: Entry): string {
  switch (entry.kind) {
    case "power":
      return entry.action === "start" ? "Starting" : entry.action === "stop" ? "Stopping" : "Restarting";
    case "settings":
      return "Applying the setting";
    case "backup.create":
      return "Creating the backup";
    case "backup.restore":
      return "Restoring the backup";
    case "backup.delete":
      return "Deleting the backup";
    case "mods.apply":
      return "Installing the modpack";
    case "mods.update":
      return "Applying mod updates";
    case "world.upload":
      return "Uploading the world";
    case "world.reset":
      return "Resetting the world";
    case "game.update":
      return "Updating the game";
    default:
      return "The operation";
  }
}

/** The surface that would actually show whether this worked. */
function describeTarget(entry: Entry): string {
  switch (entry.kind) {
    case "backup.create":
    case "backup.delete":
      return "the backups list";
    case "mods.apply":
      return "the installed mods list";
    case "mods.update":
      return "the Workshop mods page";
    case "world.upload":
    case "world.reset":
      return "the worlds list";
    default:
      return entry.game ? `${GAMES[entry.game].name} on its own page` : "the server";
  }
}

function pastNoun(entry: Entry): string {
  return entry.kind === "mods.apply" ? "installed" : "changed";
}

/** Where the world was left. Always said out loud after a power operation. */
function powerSentence(entry: Entry): string {
  const name = entry.game ? GAMES[entry.game].name : "The server";
  const power = factValue(entry, "Power");
  if (power === "running") {
    return `The container is up; it may take a few minutes to answer.`;
  }
  if (power) return `${name} is ${power}.`;
  return `Check ${name}'s power state on its page.`;
}

function pruneFinished(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS;
  while (FINISHED.length && (FINISHED.length > FINISHED_MAX || (FINISHED[0].endedAt ?? 0) < cutoff)) {
    FINISHED.shift();
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

function view(e: Entry, redacted: boolean): OperationView {
  const base: OperationView = {
    id: e.id,
    kind: e.kind,
    game: e.game,
    title: e.title,
    action: e.action,
    startedAt: e.startedAt,
    heartbeatAt: e.heartbeatAt,
    endedAt: e.endedAt,
    outcome: e.outcome,
    summary: e.summary,
    facts: e.facts,
    steps: e.steps.map((s) => ({ ...s }) as OpStepView),
    progress: e.progress,
    resources: e.resources,
    holdsPower: e.resources.includes("power"),
    startedBy: e.startedBy,
    preempted: e.preempted,
  };
  return redacted ? redact(base) : base;
}

/**
 * Strip, do not omit — the same call the `/api/games/status` route makes.
 *
 * A viewer who lacks a world still gets the record, because it may be *why* their
 * power button is disabled and the confirm dialog has to be able to say something.
 * But a live step reads "Downloading Secretz42" and the facts name mods, so the
 * identifying content goes. Doing this client-side would ship it to the browser
 * anyway.
 */
function redact(v: OperationView): OperationView {
  return {
    ...v,
    title: "A server operation",
    summary: v.endedAt ? "A server operation finished." : undefined,
    facts: [],
    steps: v.steps.map((s) => ({ ...s, label: "Working", detail: undefined, count: undefined })),
    startedBy: null,
    redacted: true,
  };
}

/** Keep the shape and the phase names; drop the identifying content. */
function trimForConflict(v: OperationView): OperationView {
  return {
    ...v,
    facts: [],
    summary: undefined,
    steps: v.steps.map((s) => ({ ...s, detail: undefined })),
  };
}

function visible(e: Entry, access: GameId[]): boolean {
  return e.game === null || access.includes(e.game);
}

/** Live, non-stale records. Synthetic boots are added by `operationsPayload`. */
export function listOperations(access: GameId[] = GAME_LIST.map((g) => g.id)): OperationView[] {
  const now = Date.now();
  return [...LIVE.values()]
    .filter((e) => !e.endedAt)
    .map((e) => ({ ...view(e, !visible(e, access)), heartbeatAt: e.heartbeatAt }))
    .sort((a, b) => orderKey(a, now) - orderKey(b, now));
}

/**
 * Terminal records. Kept so someone who refreshed five seconds after a backup
 * finished still sees "Backup created — 198 MB" rather than nothing at all.
 */
export function listFinished(access: GameId[] = GAME_LIST.map((g) => g.id)): OperationView[] {
  pruneFinished();
  return FINISHED.filter((e) => Date.now() - (e.endedAt ?? 0) < FINISHED_TTL_MS)
    .map((e) => view(e, !visible(e, access)))
    .reverse();
}

/**
 * Power holder first — it is *why* the buttons are dead — then longest-running,
 * then the synthetic boots, which are the least actionable thing on screen.
 */
function orderKey(o: OperationView, now: number): number {
  if (o.holdsPower) return -1e12;
  if (o.synthetic) return 1e12 - (now - o.startedAt);
  return -(now - o.startedAt);
}

/**
 * The operation that blocks power for `game`: either something holding the power
 * slot, or a file operation on that world.
 */
export function powerBlockedBy(ops: OperationView[], game: GameId): OperationView | undefined {
  return ops.find(
    (o) => !o.synthetic && (o.holdsPower || o.resources.includes(`files:${game}`))
  );
}

/** Live, non-stale file operations on `game` — what a power op would pre-empt. */
export function fileOperationsFor(ops: OperationView[], game: GameId): OperationView[] {
  return ops.filter((o) => !o.synthetic && !o.holdsPower && o.resources.includes(`files:${game}`));
}

// ── back-compat: the control lock as a projection ─────────────────────────────

function projectLock(v: OperationView): ControlLock | null {
  // Only kinds carrying an action project into `busy`. A backup create must not:
  // `busy.action` is `"start" | "stop" | "restart"` and `game-controls.tsx` renders
  // a verb straight out of it, so admitting one would put a lie in the verb.
  if (!v.action || !v.game) return null;
  return {
    game: v.game,
    action: v.action,
    since: v.startedAt,
    beat: v.heartbeatAt,
    stage: v.steps.find((s) => s.kind === "running")?.label,
  };
}

/** The in-flight power operation, in the shape `/api/games/status` has always sent. */
export function currentControlLock(): ControlLock | null {
  const now = Date.now();
  for (const e of LIVE.values()) {
    if (!notStale(e, now)) continue;
    if (!e.resources.includes("power")) continue;
    const lock = projectLock(view(e, false));
    if (lock) return lock;
  }
  return null;
}

/**
 * Describe what the in-flight power operation is doing.
 *
 * Kept as a shim so the three backup-restore routes need no edit. New code should
 * take the `OpHandle` and call `op.step()` / `op.settle()`, which records a step
 * with a start time instead of overwriting one string.
 */
export function setControlStage(stage: string): void {
  const now = Date.now();
  for (const e of LIVE.values()) {
    if (!notStale(e, now) || !e.resources.includes("power") || !e.action) continue;
    const s = current(e);
    if (s) {
      s.label = stage;
    } else {
      e.steps.push({
        id: `${e.id}:${e.steps.length}`,
        label: stage,
        kind: "running",
        game: e.game ?? undefined,
        at: Date.now(),
      });
    }
    return;
  }
}

// ── synthetic boot operations ────────────────────────────────────────────────

/**
 * A booting game container, projected in as a read-only operation.
 *
 * Needed because the honest end of the 7 Days to Die update is "we asked SteamCMD
 * to fetch a new build" — about 30 seconds — after which 17 GB downloads *inside
 * the container* for twenty minutes. Without this the registry entry ends
 * truthfully and the ledger then goes blank for the exact twenty minutes it exists
 * to explain. The container's own log is the authority for that phase, so this
 * borrows it rather than inventing anything.
 *
 * Rules: never admissible (no resources, so it can never block), never in
 * FINISHED, never dismissible, and **suppressed while a real operation holding
 * `"power"` names the same world** — that operation's own steps already narrate
 * the boot, and two rows for one boot is the drift to avoid.
 */
export function syntheticBoots(
  statuses: Record<
    GameId,
    { status: string; startedAtMs?: number; boot?: { stage: string; percent: number | null; detail?: string } }
  >,
  access: GameId[]
): OperationView[] {
  const now = Date.now();
  const powerOwners = new Set(
    [...LIVE.values()]
      .filter((e) => notStale(e, now) && e.resources.includes("power") && e.game)
      .map((e) => e.game as GameId)
  );

  const out: OperationView[] = [];
  for (const g of GAME_LIST) {
    const snap = statuses[g.id];
    if (!snap || snap.status !== "starting") continue;
    if (powerOwners.has(g.id)) continue;

    const startedAt = snap.startedAtMs ?? now;
    const v: OperationView = {
      id: `boot:${g.id}`,
      kind: "boot",
      game: g.id,
      title: `${g.name} is starting`,
      startedAt,
      heartbeatAt: now,
      facts: [],
      steps: [
        {
          id: `boot:${g.id}:0`,
          label: snap.boot?.stage ?? "Starting up",
          kind: "running",
          game: g.id,
          at: startedAt,
          detail: tidyLine(snap.boot?.detail),
        },
      ],
      progress:
        snap.boot?.percent != null
          ? { kind: "fraction", percent: snap.boot.percent }
          : { kind: "indeterminate" },
      resources: [],
      holdsPower: false,
      startedBy: null,
      synthetic: true,
    };
    out.push(access.includes(g.id) ? v : { ...redact(v), synthetic: true, title: "A server is starting" });
  }
  return out;
}

/**
 * Everything the ledger needs, in one object.
 *
 * `game-manager` is imported lazily: it pulls in `child_process`, the drivers and
 * the compose helpers, and it imports *this* module for `runOperation`. A static
 * import both ways is a cycle; the repo already reaches for a dynamic import in
 * this situation (see `/api/7dtd/reset`).
 */
export async function operationsPayload(access: GameId[]): Promise<OperationsPayload> {
  const operations = listOperations(access);
  let boots: OperationView[] = [];
  try {
    const { cachedAllStatus } = await import("@/lib/game-manager");
    boots = syntheticBoots(await cachedAllStatus(), access);
  } catch {
    // A docker hiccup must not take the ledger down with it: the real operations
    // are in memory and are the more important half.
  }
  const now = Date.now();
  return {
    operations: [...operations, ...boots].sort((a, b) => orderKey(a, now) - orderKey(b, now)),
    finished: listFinished(access),
    serverNow: now,
  };
}
