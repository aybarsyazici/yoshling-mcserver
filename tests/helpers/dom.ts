/**
 * The browser APIs jsdom does not implement, plus the builders the component suites
 * share.
 *
 * Only jsdom files import this. The 199 pure-logic tests run under `environment: "node"`
 * and must keep doing so — see the note in `vitest.config.mts`.
 */

import { runningWorlds } from "@/lib/coresidency";
import type { GameId } from "@/lib/games";
import type { OperationView, OpStepView } from "@/lib/operations-types";
import type { ControlLock, GameSnapshot, GamesState } from "@/lib/use-games";

/**
 * `window.matchMedia` does not exist in jsdom, and `usePrefersReducedMotion` calls it in
 * an effect — so without this every component that animates throws on mount rather than
 * failing an assertion, which is an unreadable failure mode. Same for the two observers:
 * `motion`'s in-view helpers reach for `IntersectionObserver`.
 *
 * `prefers-reduced-motion: reduce` answers **true**, deliberately. Under reduced motion
 * `motion` settles to its target values immediately instead of scheduling frames, so the
 * DOM a test reads is the DOM the animation is heading for rather than whichever frame
 * the timer happened to produce. It is also the branch a real user with the OS setting on
 * gets, and this app has several places where that branch is the only one carrying a
 * signal (the ledger's pip stops moving, so the words have to say it) — so it is the
 * branch worth testing by default.
 */
export function installBrowserStubs(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  for (const name of ["IntersectionObserver", "ResizeObserver"] as const) {
    if (!(name in window)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any)[name] = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      };
    }
  }
}

// ── builders ────────────────────────────────────────────────────────────────
// Deliberately the same shapes `tests/operation-ui.test.ts` builds, so a reader can
// move between the pure suite and the rendering one without re-learning the fixtures.

export function snap(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    game: "zomboid",
    status: "offline",
    players: { online: 0, max: 0, players: [] },
    ...over,
  };
}

export function worlds(
  over: Partial<Record<GameId, Partial<GameSnapshot>>> = {}
): Record<GameId, GameSnapshot> {
  const base: Record<GameId, GameSnapshot> = {
    minecraft: snap({ game: "minecraft" }),
    "7dtd": snap({ game: "7dtd" }),
    zomboid: snap({ game: "zomboid" }),
  };
  for (const [g, v] of Object.entries(over)) {
    base[g as GameId] = { ...base[g as GameId], ...v } as GameSnapshot;
  }
  return base;
}

export const ALL_POWERS = { start: true, stop: true, restart: true };
export const NO_POWERS = { start: false, stop: false, restart: false };

/**
 * A `useGames()` return value, complete enough that no surface reads `undefined`.
 *
 * `running` is **derived from the games actually returned** unless the caller overrides
 * it, rather than defaulting to `[]`. A fixture with `containerRunning: true` beside
 * `running: []` is a state the app cannot produce — `useGames` computes one from the
 * other — and an impossible fixture is how a later correct change gets made to look like
 * a break. Overriding it is still allowed, because the endpoint sends `running`
 * separately and a tab held across a deploy can legitimately see the two disagree.
 */
export function gamesState(over: Partial<GamesState> = {}): GamesState {
  const games = over.games === undefined ? worlds() : over.games;
  return {
    games,
    activeGame: null,
    running: runningWorlds(games),
    // ~13 GB: the 16 GB box minus HOST_RESERVE_GB, which is what `maxGameGb()` returns
    // on the real host. A number rather than `null` so the ceiling copy renders.
    maxGb: 13,
    busy: null,
    access: ["minecraft", "7dtd", "zomboid"],
    can: ALL_POWERS,
    memoryGb: { minecraft: 4, zomboid: 10 },
    hostGb: 16,
    clockSkewMs: 0,
    loading: false,
    refresh: async () => {},
    ...over,
  };
}

export function lock(over: Partial<ControlLock> = {}): ControlLock {
  return { game: "zomboid", action: "start", since: 0, beat: 0, ...over };
}

export function step(over: Partial<OpStepView> = {}): OpStepView {
  return { id: "s1", label: "Working", kind: "running", at: 0, ...over };
}

export function op(over: Partial<OperationView> = {}): OperationView {
  return {
    id: "op1",
    kind: "backup.create",
    game: "zomboid",
    title: "Creating a backup",
    startedAt: 0,
    heartbeatAt: 0,
    facts: [],
    steps: [],
    progress: { kind: "indeterminate" },
    resources: ["files:zomboid"],
    holdsPower: false,
    startedBy: null,
    ...over,
  };
}

/** A `useOperations()` return value. */
export function opsState(over: Partial<OperationsStub> = {}): OperationsStub {
  return {
    operations: [],
    finished: [],
    dismiss: () => {},
    /**
     * Elapsed is a FUNCTION of the record, not a constant: the real one is
     * `Date.now() + skew - op.startedAt`, and a constant would let a test pass while
     * the component read the wrong operation's clock. Default to "now minus
     * `startedAt`" with the epoch pinned by the caller's `startedAt`.
     */
    elapsedMs: (o: { startedAt: number }) => Math.max(0, 0 - o.startedAt),
    skewMs: 0,
    loading: false,
    refresh: async () => {},
    ...over,
  };
}

export interface OperationsStub {
  operations: OperationView[];
  finished: OperationView[];
  dismiss(id: string): void;
  elapsedMs(op: { startedAt: number }): number;
  skewMs: number;
  loading: boolean;
  refresh(): Promise<void>;
}

/** Long enough ago that `powerState` calls a silent container wedged, not booting. */
export const WEDGED_FOR_MS = 20 * 60_000;
