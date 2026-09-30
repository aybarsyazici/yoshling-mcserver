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
import { pluralNoun } from "@/lib/format";
import {
  OPERATION_STALE_MS,
  formatElapsed,
  lowerFirst,
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
 * The power slot AND every world's files — total exclusivity.
 *
 * This used to be the default for every power-adjacent kind, with the reasoning
 * that a power operation may save and stop any world and therefore may be writing
 * any world's files, so declaring them all "reproduces today's total exclusivity in
 * one line rather than reasoning at runtime about which world happens to be running".
 *
 * **That was too broad for the common case and it destroyed real backups.** On a
 * one-world box the *stopped* worlds are precisely the ones whose files nothing is
 * touching, so their backups are the only clean ones — and they were the ones being
 * thrown away. Measured on production 2026-09-29: two 7 Days to Die archives (~600 MB)
 * were invalidated and deleted by power operations on Minecraft and on Project Zomboid
 * while 7DTD had been `Exited (0)` for two minutes and nothing had opened its files.
 *
 * So `power` and `settings` now declare the lanes they can actually touch (see
 * `DEFAULT_RESOURCES`, and `powerOn`, which names the worlds it is about to evict).
 * This full set stays for the rare, long, genuinely box-wide operations —
 * `mods.update`, `world.reset`, `game.update`, `backup.restore` — and is still
 * imported by `/api/7dtd/update`, `/api/7dtd/reset` and `zomboid-updates.ts`.
 */
export const POWER_RESOURCES: OperationResource[] = [
  "power",
  ...GAME_LIST.map((g) => `files:${g.id}` as OperationResource),
];

const DEFAULT_RESOURCES: Record<OperationKind, (g: GameId | null) => OperationResource[]> = {
  // Power holds `power` — which every world-starting path claims, so admission is what
  // serialises them — plus only its *own* world's files. A hand-off has more than one
  // world's files to claim, and `powerOn` passes them explicitly because only it knows
  // which worlds it found running.
  power: (g) => (g ? ["power", `files:${g}`] : POWER_RESOURCES),
  settings: (g) => (g ? ["power", `files:${g}`] : POWER_RESOURCES),
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

/**
 * The registry is pinned to `globalThis`, the same way `src/lib/db.ts` pins Prisma.
 *
 * Module-level `const LIVE = new Map()` is NOT one instance here. Next builds route
 * handlers, server components and `instrumentation.ts` into separate module graphs,
 * so each layer gets its own copy of this file's module scope — measured in this tree
 * against `next dev`: a route handler's `listOperations()` returned the running
 * backup while a server component's `operationsPayload()` on the same process
 * returned `[]`, and an operation entered from `instrumentation.ts` was invisible to
 * both. `globalThis` *is* shared across the layers, so hoisting the three mutable
 * roots onto it collapses them back into one registry.
 *
 * Consequences of getting this wrong, for the record: the Project Zomboid Workshop
 * apply runs on the instrumentation timer, so its six minutes produced no ledger row
 * and no `busy` — the exact 2026-09-15 silence — and `DashShell`'s server-rendered
 * seed was permanently empty, which both removed the refresh-survival property and
 * made `CompletionToasts` prime from nothing and replay history on the first poll.
 *
 * NOT gated on NODE_ENV: this is not an HMR workaround, it is how the layers share
 * state in production too.
 */
interface Registry {
  live: Map<string, Entry>;
  finished: Entry[];
  seq: number;
}
const g = globalThis as unknown as { __yoshlingOperations?: Registry };
const REGISTRY: Registry = (g.__yoshlingOperations ??= {
  live: new Map<string, Entry>(),
  finished: [],
  seq: 0,
});

const LIVE = REGISTRY.live;

/** Terminal records, newest last. Bounded so it cannot grow. */
const FINISHED = REGISTRY.finished;
const FINISHED_MAX = 20;
/**
 * A clean record ages out in ten minutes. Anything that did NOT end cleanly is kept
 * for hours, because the design rule is that a non-`ok` record never clears itself
 * and ten minutes broke it: a restore that threw left Project Zomboid powered off
 * (`restartOnFailure: false`, and `restart: "no"` revives nothing), and someone back
 * at their desk fifteen minutes later found an empty strip, no toast and nothing in
 * `/activity` — the only remaining signal being that the world was off.
 */
const FINISHED_TTL_MS = 10 * 60 * 1000;
const FINISHED_TTL_BAD_MS = 6 * 60 * 60 * 1000;

/**
 * Clean means `ok` **or** `nothing`, and `nothing` used to be on the six-hour side.
 *
 * That was wrong in both directions. A no-op has nothing to preserve — there is no
 * failure to diagnose and no side effect to remember — and it is the single most
 * common outcome here, because clicking the running world's card, or Stop on a world
 * that is already down, produces one. Measured on production 2026-09-29: of the twenty
 * slots in a full ring, **eight were held by `nothing` records**, each for six hours,
 * which is what starved the ring of room for the successes people were watching.
 */
function isCleanOutcome(outcome: Outcome | undefined): boolean {
  return outcome === "ok" || outcome === "nothing";
}

function finishedTtl(e: { outcome?: Outcome }): number {
  return isCleanOutcome(e.outcome) ? FINISHED_TTL_MS : FINISHED_TTL_BAD_MS;
}

const HEARTBEAT_MS = 20_000;

function nextId(kind: OperationKind): string {
  REGISTRY.seq += 1;
  return `${kind.replace(/\./g, "-")}-${Date.now().toString(36)}-${REGISTRY.seq}`;
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
  /**
   * True once a power operation has been admitted *over* this one.
   *
   * A file operation is not cancelled — nothing here can interrupt an in-flight
   * `cp -r` — but it can be asked, and a route that produces an artefact should ask
   * before publishing it. The three backup-create routes throw on this, which both
   * deletes the half-written archive (their existing `catch` does the `rm`) and makes
   * the confirm dialog's "the archive will be incomplete and is deleted" true.
   */
  readonly preempted: boolean;
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
    // Pre-emption is EVIDENCE, not just bookkeeping.
    //
    // `admit()` used to set this flag and nothing anywhere read it, so a backup that a
    // Power off ran straight through still concluded `ok` and published "Backup created
    // — 198 MB, world map included." as a restore point, for an archive taken across a
    // save-and-SIGKILL boundary. Recording it as a fact is what makes that impossible:
    // `bad` for an artefact (it is not restorable), `warn` for everything else.
    if (entry.preempted) {
      entry.facts.push({
        label: "Interrupted",
        value: "a power operation ran while this was working",
        verdict: entry.kind === "backup.create" ? "bad" : "warn",
      });
    }
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
    get preempted() {
      return entry.preempted === true;
    },
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
      // A route may refuse before it has opened its first step — `/api/7dtd/reset`
      // validates `GameWorld` before touching anything. With no step to settle this
      // used to record nothing at all, which `concludeOperation` read as "finished and
      // checked nothing" → `unverified`, so a *rejected* request got a summary telling
      // the user to go and inspect a world list. Record the refusal as its own failed
      // step instead.
      if (!current(entry)) {
        entry.steps.push({
          id: `${entry.id}:${entry.steps.length}`,
          label,
          kind: "failed",
          game: entry.game ?? undefined,
          at: Date.now(),
          endedAt: Date.now(),
        });
      } else {
        settleCurrent(entry, label, "failed");
      }
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

/**
 * Refuse to publish an artefact a power operation ran through.
 *
 * Throwing is what makes the confirm dialog's "the archive will be incomplete and is
 * deleted" TRUE: the three backup-create routes already `rm(target)` in their `catch`,
 * so this both deletes the half-written file and makes the operation conclude `failed`
 * with a sentence naming why. Nothing here can abort an in-flight `cp -r`/`tar`; what
 * it can do is decline to hand back a torn archive the backups list would then offer
 * as a restore point.
 */
export function refuseIfPreempted(op: OpHandle, what: string): void {
  if (!op.preempted) return;
  throw new Error(
    `A power operation ran while ${what} was being written, so it was taken across a ` +
      `save-and-shutdown boundary and cannot be trusted. It has been deleted.`
  );
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

/**
 * Refuse a short write that would land on files an operation is already holding.
 *
 * For the config/settings writers, which are sub-second and legitimately have no
 * record of their own — entering one would toast twice for a 17 ms write. What they do
 * need is the *lane*: measured on production, `PUT /api/7dtd/config` returned 200 in
 * 17 ms and rewrote `sdtdserver.xml` while a backup held `files:7dtd` and was
 * mid-"Compressing the archive", and `PUT /api/zomboid/config` did the same through a
 * "Copying the world". A second *backup* fired in the same window was correctly
 * refused with a 409, so the lane works — only these callers never asked it.
 *
 * The dangerous direction is the one this covers: a restore holds the lane for minutes
 * and would overwrite the config saved through it, while the page toasted "Saved".
 */
export function assertResourceFree(resource: OperationResource): void {
  const now = Date.now();
  const holder = [...LIVE.values()].find(
    (o) => notStale(o, now) && o.resources.includes(resource)
  );
  if (!holder) return;
  const conflict = trimForConflict(view(holder, false));
  const message = conflictMessage(holder, now);
  throw holder.action
    ? new ControlBusyError(conflict, resource, message)
    : new OperationConflictError(conflict, resource, message);
}

function conflictMessage(other: Entry, now: number): string {
  const name = other.game ? GAMES[other.game].name : "The server";
  const ago = formatElapsed(now - other.startedAt);
  if (other.action) {
    const verb =
      other.action === "start" ? "starting" : other.action === "stop" ? "stopping" : "restarting";
    return `${name} is already ${verb} (${ago}). Try again when it finishes.`;
  }
  return `${name} is busy — ${lowerFirst(other.title)} (${ago}). Try again when it finishes.`;
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
  // `!madeProgress` guards BOTH clauses, not just `allNoop`. Without it on this one, a
  // modpack apply whose "Removed the current mods" step settled 0 of 3 (a mods-dir
  // permission error) and then installed all 166 concluded `nothing`, and the summary
  // read "finished in 4m 12s, but nothing changed. 166 of 166 mods were installed." —
  // self-contradictory in eight words, while 166 new jars were on disk.
  const madeProgress = steps.some((s) => (s.count?.done ?? 0) > 0);
  const allNoop = steps.length > 0 && steps.every((s) => s.kind === "noop") && !madeProgress;
  const zeroOfSomething =
    !madeProgress &&
    steps.some((s) => s.kind === "noop" && s.count && s.count.done === 0 && (s.count.total ?? 0) > 0);
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

/** The value of a fact only if it actually carries a `warn`. */
function warnValue(entry: Entry, label: string): string | undefined {
  return warnFact(entry, label)?.value;
}

/** The whole fact, so a template can read the world it is about as well as its value. */
function warnFact(entry: Entry, label: string): OperationFact | undefined {
  const f = entry.facts.find((x) => x.label === label);
  return f?.verdict === "warn" ? f : undefined;
}

/**
 * The world this operation handed the box over FROM, if it did.
 *
 * Read off the recorded steps, which have always been tagged per world and have always
 * been right — a hand-off's steps name the outgoing world for the save and the stop and
 * the incoming one for the start. Only the derived sentence got it wrong.
 */
function handedOffFrom(entry: Entry): GameId | undefined {
  return entry.steps.find((s) => s.game && s.game !== entry.game)?.game;
}

function nameOf(game: GameId | null | undefined): string {
  return game ? GAMES[game].name : "The server";
}

/**
 * Drop a trailing `.`/`!`/`?` before a template appends its own sentence.
 *
 * `entry.error` is an error message and ends in a period of its own, so the failure
 * template produced "…Use Restart if it stays that way.. Project Zomboid is still
 * running." — observed twice on the live box, and that string is also the toast.
 */
function trimSentence(s: string): string {
  return s.replace(/[\s.!?]+$/, "");
}

/**
 * Grammar for a warn fact the *template* did not select on.
 *
 * A fact's `value` is terse so the facts row stays scannable ("killed after 300s"),
 * which means splicing it in after "but " produces nonsense — and worse, it lets an
 * unrelated warn drive a sentence that makes a specific factual claim.
 *
 * That was not hypothetical. **Every** Project Zomboid stop ends in SIGKILL (measured,
 * documented), so `narratedStop` always adds `Shutdown: killed after 300s` as a warn,
 * so `concludeOperation` always returned `partial` for anything that stops PZ. The
 * `partial` branches then fired for a reason that had nothing to do with them:
 *
 *   - a restore that WAS restarting the world said "Project Zomboid stayed powered off
 *     — Power on when you're ready", one line below the code that computed `restarted`
 *     specifically to answer that question;
 *   - a successful memory change said "The configured and running values disagree"
 *     while quoting two identical values — inverting the one read-back the docs call
 *     never-wrong, next to a green toast from the same request saying the opposite;
 *   - a fully successful 89-mod Workshop apply — the flagship operation — summarised
 *     as the bare fragment "killed after 300s. The container is up…", losing the count
 *     and reading as a failure.
 *
 * So each branch below selects on the evidence it understands, and everything else
 * comes through here as its own trailing clause with template-supplied grammar.
 */
const WARN_CLAUSE: Record<string, (v: string) => string> = {
  Shutdown: (v) => `it had to be ${v}`,
  // Already a whole clause: "the world was not saved — the server did not answer".
  Save: (v) => v,
  Interrupted: (v) => v,
  Replaced: (v) => `it replaced ${v}`,
  "Rollback point": (v) => v,
  "New game name": (v) => `the new game name ${v}`,
  "World map": (v) => `the world map is ${v}`,
  Container: (v) => `the container reports ${v}`,
  Build: (v) => `the build is ${v}`,
};

function sideNote(entry: Entry, understood: string[]): string {
  const rest = warnFacts(entry).filter((f) => !understood.includes(f.label));
  if (rest.length === 0) return "";
  const parts = rest.map((f) =>
    (WARN_CLAUSE[f.label] ?? ((v: string) => `${f.label.toLowerCase()}: ${v}`))(f.value)
  );
  return ` Also, ${parts.join("; ")}.`;
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
    // pointing at the wrong page. And a reason that ALREADY names the power state does
    // not get it appended a second time: "…is already running — it just isn't responding
    // yet. Use Restart if it stays that way. Project Zomboid is still running." says the
    // same thing twice and reads as a contradiction.
    const touchesPower = entry.resources.includes("power");
    const statesPower = /\b(already running|still running|powered off|already stopped)\b/i.test(why);
    const where = statesPower
      ? ""
      : power
      ? ` ${name} is ${power}.`
      : touchesPower
      ? ` Check ${name}'s power state on its page before trying again.`
      : ` Check ${describeTarget(entry)} before trying again.`;
    // "after 0 steps" is internal bookkeeping about an operation that was refused
    // before it did anything, so it is dropped rather than printed.
    const after =
      entry.steps.length > 0
        ? ` after ${entry.steps.length} step${entry.steps.length === 1 ? "" : "s"}`
        : "";
    return `${verbFor(entry)} failed${after}: ${trimSentence(why)}.${where}`;
  }

  if (outcome === "unverified") {
    return `${verbFor(entry)} finished in ${took}, but nothing could be read back to confirm it. Check ${describeTarget(entry)} before relying on it.`;
  }

  if (outcome === "nothing") {
    // A power request against a world that is already in the state you asked for. It
    // is not a failure and it is certainly not a success: nothing on the box moved, and
    // saying so is the entire point. (Before the guard in `powerOff`, this case
    // fabricated a save, a stop and a `Shutdown` verdict read off the PREVIOUS run's
    // exit code — a 135 ms operation claiming "killed after 300s".)
    if (entry.kind === "power") {
      const state = factValue(entry, "Power");
      return `Nothing to do — ${name} was already ${state ?? "in that state"}.`;
    }
    // `count.total` is optional, so it has to be checked — "0 of undefined files" is
    // the kind of sentence that makes a reader distrust everything else on the row.
    const what =
      count && count.total != null
        ? ` ${count.done} of ${count.total} ${count.noun} ${
            count.total === 1 ? "was" : "were"
          } ${pastNoun(entry)}.`
        : "";
    return `${name} — finished in ${took}, but nothing changed.${what}`;
  }

  switch (entry.kind) {
    case "power": {
      const past =
        entry.action === "stop" ? "stopped" : entry.action === "restart" ? "restarted" : "started";
      // `warnValue`/`warnFact`, not `factValue`: a CLEAN stop also records a `Shutdown`
      // fact ("exited cleanly (code 0)"), so reading it unconditionally produced "but it
      // had to be exited cleanly (code 0)" whenever the partial came from somewhere else.
      const shutdown = warnFact(entry, "Shutdown");
      /**
       * The world the kill is about, which on a hand-off is NOT `entry.game`.
       *
       * `entry.game` is the world coming up. Attributing the outgoing world's SIGKILL to
       * it produced, verbatim on production, "Minecraft — started in 5m 04s, but it had
       * to be killed after 300s" for a Minecraft that `docker events` shows was only ever
       * started, and booted in 450 ms. It also handed Minecraft the five minutes Project
       * Zomboid spent refusing to exit. Both halves are fixed by naming the world the
       * fact is about and hanging the duration on the *switch* rather than on the start.
       */
      const outgoing = handedOffFrom(entry);
      if (shutdown) {
        const killedWorld = shutdown.game ?? outgoing ?? entry.game;
        if (killedWorld && killedWorld !== entry.game) {
          return `Switched to ${name} in ${took} — ${nameOf(killedWorld)} had to be ${
            shutdown.value
          }. ${powerSentence(entry)}${sideNote(entry, ["Shutdown", "Power"])}`;
        }
        return `${name} — ${past} in ${took}, but it had to be ${shutdown.value}. ${powerSentence(
          entry
        )}${sideNote(entry, ["Shutdown", "Power"])}`;
      }
      if (outcome === "partial") {
        return `${name} — ${past} in ${took}, but ${
          warnText.toLowerCase() || "it did not go cleanly"
        }. ${powerSentence(entry)}`;
      }
      // A clean hand-off is two worlds' work, so the duration belongs to the switch and
      // not to the incoming world's `docker start`.
      if (outgoing) {
        return `Switched to ${name} in ${took} — ${nameOf(outgoing)} stopped first. ${powerSentence(
          entry
        )}`;
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
      // Selected on the `Container` fact's OWN verdict, never on the operation-wide
      // outcome: `recordEnvApplied` marks that one fact `warn` when and only when the
      // compose value and the container disagree, which is the exact claim this
      // sentence makes.
      if (warnValue(entry, "Container") !== undefined) {
        return `Saved ${conf}, but the container reports ${live}. The configured and running values disagree.${sideNote(
          entry,
          ["Container"]
        )}`;
      }
      return `${what ?? "The setting"} is now ${conf}. The container reports ${live}.${sideNote(
        entry,
        ["Container", "Power"]
      )}`;
    }
    case "backup.create": {
      const size = factValue(entry, "Size") ?? "unknown size";
      // Selected on the `World map` fact, which is the only thing that makes an
      // archive unusable as a restore point.
      const noMap = warnValue(entry, "World map");
      if (noMap) {
        // Said plainly, because a 4 MB config-only archive looks entirely plausible in
        // the backups list and is the one thing you cannot restore a world from.
        return `Backup created — ${size}, but the world map isn't in it. This is not a restore point.${sideNote(
          entry,
          ["World map"]
        )}`;
      }
      // Evidence required, and `warnText` IS the evidence. The fallback string used to be
      // `"part of it is missing"`, which fired whenever `warnText` was empty — and a
      // `partial` with no warn fact at all is the commonest way to get here: any `noop`
      // step makes the whole operation `partial`. So a flawless archive of a STOPPED
      // world, whose flush step legitimately had nothing to do, was published as
      // "Backup created — 217 MB, but part of it is missing. This is not a restore point."
      // in amber, on the everyday path — Minecraft and 7 Days to Die are both normally
      // stopped. The routes were fixed to settle that step `done`, but leaving the
      // fallback here means the next route author's `noop` re-creates the same lie, which
      // is exactly the rule in `docs/OPERATIONS.md`: never branch on
      // `outcome === "partial"` to make a claim the facts do not support.
      if (outcome === "partial" && warnText) {
        return `Backup created — ${size}, but ${warnText.toLowerCase()}. This is not a restore point.`;
      }
      // Still `partial`, so the row and toast stay amber — but the sentence names the step
      // that did nothing instead of inventing a missing part.
      const skipped = outcome === "partial" ? entry.steps.find((s) => s.kind === "noop") : undefined;
      return `Backup created — ${size}${
        factValue(entry, "World map") === "included" ? ", world map included" : ""
      }.${skipped ? ` ${trimSentence(skipped.label)}.` : ""}`;
    }
    case "backup.restore": {
      const from = factValue(entry, "Archive");
      // `withGameStopped` records this specifically to answer "is the world coming
      // back?", and it is the ONLY thing that may decide this sentence. The old code
      // computed it and then let the operation-wide `partial` pick the branch, so every
      // restore of a running Project Zomboid claimed it had stayed powered off.
      const restarted = factValue(entry, "Server") === "starting again";
      return `${name} restored${from ? ` from ${from}` : ""}. ${
        restarted
          ? "The server is starting again."
          : `${name} stayed powered off — Power on when you're ready.`
      }${sideNote(entry, ["Server", "Power"])}`;
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
        // "Open the report for which ones" pointed at nothing for the runs that need it:
        // the report is built in the browser from `install-modpack`'s response body, and
        // a 166-mod apply routinely outlives the ~100s origin timeout, after which
        // `modpacks.tsx`'s catch substitutes `{installed: 0, total: 0}`. The names are a
        // recorded `Failed` fact now, so the record itself is the report.
        return `Installed ${count.done} of ${count.total} ${count.noun}; ${missing} failed. Expand this record to see which ones.`;
      }
      return `Installed ${count.done} of ${count.total} ${count.noun}. Restart ${name} to load them.`;
    }
    case "mods.update": {
      // Selected on the DOWNLOAD's own count — Steam's number, recorded by the route —
      // not on the operation-wide outcome. A Project Zomboid apply always stops PZ and
      // a PZ stop always ends in SIGKILL, so `outcome === "partial"` was unavoidable and
      // the `ok` sentence (with the count in it) was unreachable for the one world this
      // feature was built for. Every successful 89-mod apply reported "killed after
      // 300s." and nothing else.
      const short = count && count.total != null && count.done < count.total;
      if (short) {
        const missing = (count.total ?? 0) - count.done;
        return `Downloaded ${count.done} of ${count.total} ${count.noun} — ${missing} failed. ${powerSentence(
          entry
        )}${sideNote(entry, ["Shutdown", "Power"])}`;
      }
      const dlWarns = warnFacts(entry).filter((f) => f.label !== "Shutdown" && f.label !== "Power");
      if (!count && dlWarns.length > 0) {
        return `${dlWarns.map((f) => f.value).join("; ")}. ${powerSentence(entry)}`;
      }
      return `Finished in ${took}. ${
        count ? `${count.done} ${pluralNoun(count.done, count.noun)} updated` : "Mods updated"
      }, ${
        power === "running" ? "the server is back up" : "the server is powered off"
      }.${sideNote(entry, ["Power"])}`;
    }
    case "world.upload": {
      const placed = factValue(entry, "Installed as");
      // The ok sentence always renders; a warn becomes its own clause. "Upload
      // finished, but an existing copy of the same name." was both ungrammatical and
      // threw away the thing that actually happened.
      return `Uploaded and placed ${placed ?? "the world"}${
        count ? ` — ${count.done} ${count.noun}` : ""
      }.${sideNote(entry, [])}`;
    }
    case "world.reset": {
      const to = warnValue(entry, "New game name") ? undefined : factValue(entry, "New game name");
      return `World reset. ${name} is generating ${to ?? "a fresh save"}.${sideNote(entry, [
        "Power",
      ])}`;
    }
    case "game.update":
      // The route can only ever prove it *requested* the update — the build id does
      // not change until the ~17 GB download finishes inside the container. So the
      // `Build` fact is amber by construction, which is what this branch is about, and
      // the synthetic boot carries the next 20 minutes.
      return warnValue(entry, "Build") !== undefined
        ? `Update requested — ${name} is downloading the new build. Watch the strip at the top of the page.${sideNote(
            entry,
            ["Build", "Power", "Shutdown"]
          )}`
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

/**
 * Two stages, and the order is the whole point.
 *
 * The old version was one head-only loop, so it stopped at the first unexpired entry
 * and evicted strictly oldest-first when over `FINISHED_MAX`. Both halves failed on the
 * live box, measured 2026-09-29: ordinary clean traffic (31 operations in 2.5 h) pushed
 * the ring to 21 and deleted three `partial` records at 43m, 2h00m and 2h19m — all far
 * inside their six hours — while **six of the twenty slots were held by `ok` records
 * whose own TTL had already expired** and which therefore no reader could see. The head
 * loop could not reclaim those, because `FINISHED[0]` was not yet expired.
 *
 * So: drop everything past its own TTL wherever it sits, which reclaims the invisible
 * slots first; only then, if still over the cap, evict the oldest **clean** record and
 * fall back to non-clean ones only when no clean one is left. A failure record is the
 * one thing here with no other home — nothing writes an Activity row on the failure
 * path — so it must be the last thing thrown away, not the first.
 */
function pruneFinished(): void {
  const now = Date.now();
  for (let i = FINISHED.length - 1; i >= 0; i--) {
    if (now - (FINISHED[i].endedAt ?? 0) > finishedTtl(FINISHED[i])) FINISHED.splice(i, 1);
  }
  while (FINISHED.length > FINISHED_MAX) {
    const newest = FINISHED[FINISHED.length - 1];
    const victim = evictionIndex(FINISHED, newest.endedAt ?? now);
    if (victim < 0) break;
    FINISHED.splice(victim, 1);
  }
}

/**
 * Which slot the over-cap loop gives up, given the record that just arrived.
 *
 * Exported and pure so it can be asserted on; the ring itself needs a live registry
 * and 21 real operations to reproduce.
 *
 * ## The bug this shape exists to stop
 *
 * The previous rule was `FINISHED.findIndex(e => e.outcome === "ok")` — the oldest
 * clean record, whatever its age. With twenty non-clean records in the ring, the
 * newly-pushed success is the *only* clean one, so its own `push` selected it and
 * spliced it out synchronously. Measured on production 2026-09-29: a memory change
 * that really recreated a container (env 5G → 4G, new `Created` timestamp) and a
 * restart that really cycled one left **no record at all** — `finished` read twenty
 * entries, none of them `ok`, before and after. Proven by contrast: restarting the web
 * container emptied the ring, and the very next clean operations were retained. So the
 * dashboard could not report the operation the user had just watched succeed, which is
 * the exact class of defect this module was written to prevent.
 *
 * So the clean candidate must also be **older than the incoming record**. That leaves
 * the design rule intact — a failure still outlives a success, because nothing else
 * records a failure — while making the newest success un-evictable by its own arrival.
 * If no such candidate exists (a ring of nothing but failures), give up the oldest slot
 * by `endedAt`; ties resolve to the lowest index, and the incoming record is always the
 * highest, so it still cannot be the victim.
 */
export function evictionIndex(
  entries: { outcome?: Outcome; endedAt?: number }[],
  incomingEndedAt: number
): number {
  for (let i = 0; i < entries.length; i++) {
    if (isCleanOutcome(entries[i].outcome) && (entries[i].endedAt ?? 0) < incomingEndedAt) return i;
  }
  let oldest = -1;
  for (let i = 0; i < entries.length; i++) {
    if (oldest < 0 || (entries[i].endedAt ?? 0) < (entries[oldest].endedAt ?? 0)) oldest = i;
  }
  return oldest;
}

/** Exported for the retention test: the TTL rule is half of what starved the ring. */
export function finishedTtlFor(outcome: Outcome | undefined): number {
  return finishedTtl({ outcome });
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
  return FINISHED.filter((e) => Date.now() - (e.endedAt ?? 0) < finishedTtl(e))
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

// `powerBlockedBy` / `fileOperationsFor` used to live here as a second, subtly
// different copy of `operation-ui.ts`'s `powerBlocker` / `liveFileOperations` — they
// omitted the `!o.endedAt` guard, so a future server-side caller reaching for the
// name a reader would expect would silently match finished records too. Deleted
// rather than kept in sync; `operation-ui.ts` is the one definition of "blocked".

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
 * FINISHED, and **suppressed while a real operation holding `"power"` names the same
 * world** — that operation's own steps already narrate the boot, and two rows for one
 * boot is the drift to avoid.
 *
 * **Bounded at `BOOT_STALL_MS`, the same 12 minutes `game-controls.tsx` uses.** The
 * drivers set `status: "starting"` purely from `containerRunning && !reachable`, with
 * no upper bound, so a wedged Project Zomboid game loop (documented, 2026-09-22) or a
 * rotated 7DTD `TelnetPassword` projected "7 Days to Die is starting … +3h 41m" onto
 * every page for every user, forever and undismissibly — re-conflating the two states
 * commit a7d76b8 split on purpose, and contradicting the controls on the same screen,
 * which correctly said "Not responding". Past the threshold the projection says what is
 * actually known (the container is up and not answering; Restart is the way out) and
 * becomes dismissible.
 */
const BOOT_STALL_MS = 12 * 60 * 1000;
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
    const stalled = now - startedAt > BOOT_STALL_MS;
    const v: OperationView = {
      id: `boot:${g.id}`,
      kind: "boot",
      game: g.id,
      title: stalled ? `${g.name} is not answering` : `${g.name} is starting`,
      startedAt,
      heartbeatAt: now,
      facts: [],
      steps: [
        {
          id: `boot:${g.id}:0`,
          label: stalled
            ? `The container is up but the game has not answered for ${Math.round(
                (now - startedAt) / 60000
              )} minutes`
            : snap.boot?.stage ?? "Starting up",
          kind: "running",
          game: g.id,
          at: startedAt,
          detail: stalled
            ? "Restart is the way out — Powering off and on again does the same thing more slowly"
            : tidyLine(snap.boot?.detail),
        },
      ],
      progress:
        !stalled && snap.boot?.percent != null
          ? { kind: "fraction", percent: snap.boot.percent }
          : { kind: "indeterminate" },
      resources: [],
      holdsPower: false,
      startedBy: null,
      synthetic: true,
      stalled,
    };
    out.push(
      access.includes(g.id)
        ? v
        : {
            ...redact(v),
            synthetic: true,
            stalled,
            title: stalled ? "A server is not answering" : "A server is starting",
          }
    );
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
  // The await happens FIRST, and every read of the registry happens after it in one
  // synchronous tick — including `syntheticBoots`, which consults the registry itself to
  // suppress a boot a power operation is already narrating.
  //
  // Reading either side of the await is what produced a payload listing the same id as
  // both live and finished (measured on production: `backup-create-mumq305i-32` appeared
  // in both lists of one response), which gave the ledger a duplicate React key and made
  // it pick the stale running copy as `primary`.
  let statuses: Awaited<ReturnType<typeof import("@/lib/game-manager").cachedAllStatus>> | null =
    null;
  try {
    const { cachedAllStatus } = await import("@/lib/game-manager");
    statuses = await cachedAllStatus();
  } catch {
    // A docker hiccup must not take the ledger down with it: the real operations
    // are in memory and are the more important half.
  }
  const operations = listOperations(access);
  const finished = listFinished(access);
  const boots = statuses ? syntheticBoots(statuses, access) : [];
  const now = Date.now();
  return {
    operations: [...operations, ...boots].sort((a, b) => orderKey(a, now) - orderKey(b, now)),
    finished,
    serverNow: now,
  };
}
