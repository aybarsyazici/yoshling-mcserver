"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  isStale,
  type OperationView,
  type OperationsPayload,
} from "@/lib/operations-types";

/**
 * One poller for `/api/operations`, shared by the ledger, the sidebar pip and the
 * power controls.
 *
 * Polling rather than SSE, and the reasoning is worth keeping: the registry has no
 * push source, so an SSE endpoint would still have to poll docker to learn anything
 * had changed — it would move the cost, not remove it. And a long-lived connection
 * through Cloudflare and Caddy gets buffered and idle-timed, where a silently
 * dropped stream freezes the UI at the last stage it saw. That is indistinguishable
 * from the hung-operation bug this whole feature exists to fix. Polling's failure
 * mode is a number that is six seconds stale and then heals itself.
 */
interface OperationsState {
  operations: OperationView[];
  /** Terminal records this viewer hasn't dismissed. */
  finished: OperationView[];
  dismiss(id: string): void;
  /** Skew-corrected, so it can never be negative or wild. */
  elapsedMs(op: { startedAt: number }): number;
  /**
   * `serverNow - Date.now()`, from the last poll.
   *
   * Exported because `elapsedMs` was not enough: the ledger also compares the browser
   * clock against `heartbeatAt`, `endedAt` and `step.at` to decide whether an operation
   * is lost, whether a settled row should auto-clear, and how long a live step has been
   * running — and only the elapsed counters were corrected. On a laptop three minutes
   * fast, every healthy live operation read "lost contact 3m 0s ago. Check the console."
   * with a Dismiss button, on the same line as a corrected "+2s". Add this to
   * `Date.now()` anywhere a server epoch is on the other side of the comparison.
   */
  skewMs: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<OperationsState | null>(null);

const FAST_MS = 1500;
const IDLE_MS = 6000;
const DISMISS_KEY = "yoshling.ops.dismissed";

function readDismissed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function OperationsProvider({
  initial,
  children,
}: {
  /**
   * Server-rendered snapshot. Without it a reload during the operation you are
   * anxious about shows a blank header for up to a poll interval — which is the
   * exact silence the ledger exists to remove.
   */
  initial?: OperationsPayload;
  children: React.ReactNode;
}) {
  const [payload, setPayload] = useState<OperationsPayload | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [dismissed, setDismissed] = useState<string[]>([]);
  /** True once a payload has arrived over the network, as opposed to from the seed. */
  const [fetched, setFetched] = useState(false);
  const alive = useRef(true);
  /**
   * `serverNow - receivedAt`. Every comparison against a server epoch is corrected
   * with this, because `Date.now() - startedAt` mixes a browser clock with a server
   * epoch and a machine that is a few minutes out then shows nonsense (or negative)
   * durations — or, worse, declares a healthy operation dead.
   *
   * State, not a ref: the ledger re-renders on its own 1s tick, but a ref would leave
   * the first render after a skew change using the stale value with no re-render to fix
   * it, and skew is read during render.
   */
  const [skewMs, setSkewMs] = useState(0);

  // sessionStorage is read after mount: touching it during render would differ
  // between the server pass and the client one and break hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const receivedAt = Date.now();
      const res = await fetch("/api/operations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as OperationsPayload;
      if (!alive.current) return;
      // Only replace the skew when it moved by more than a second: a re-render per poll
      // for 40ms of network jitter is pure churn, and the ledger ticks anyway.
      const next = data.serverNow - receivedAt;
      setSkewMs((prev) => (Math.abs(next - prev) > 1000 ? next : prev));
      setPayload(data);
      setFetched(true);
    } catch {
      /* keep the last known state; a dropped poll is not news */
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // A *stalled* projected boot is not progress to watch: the container has been up and
  // unreachable for over twelve minutes and nothing about it is going to change on a
  // 1.5s cadence, so it must not pin the poller to the fast interval indefinitely.
  const running = (payload?.operations ?? []).filter((o) => !o.stalled).length;

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(() => {
      // Paused entirely in a hidden tab. `useGames` polls hidden tabs forever today
      // and that is a measured cost on a box that is CPU-bound during a boot.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, running > 0 ? FAST_MS : IDLE_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, running]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id].slice(-60);
      try {
        window.sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next));
      } catch {
        /* private mode; dismissal just doesn't persist across reloads */
      }
      return next;
    });
  }, []);

  const elapsedMs = useCallback(
    (op: { startedAt: number }) => Math.max(0, Date.now() + skewMs - op.startedAt),
    [skewMs]
  );

  const value = useMemo<OperationsState>(
    () => ({
      operations: payload?.operations ?? [],
      finished: (payload?.finished ?? []).filter((f) => !dismissed.includes(f.id)),
      dismiss,
      elapsedMs,
      skewMs,
      loading,
      refresh,
    }),
    [payload, dismissed, dismiss, elapsedMs, skewMs, loading, refresh]
  );

  return (
    <Ctx.Provider value={value}>
      <CompletionToasts operations={value.operations} finished={value.finished} fetched={fetched} />
      {children}
    </Ctx.Provider>
  );
}

export function useOperations(): OperationsState {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  // Rendered outside a provider (a page that doesn't mount one). An empty, inert
  // state is better than a thrown error on the critical render path.
  return {
    operations: [],
    finished: [],
    dismiss: () => {},
    elapsedMs: () => 0,
    skewMs: 0,
    loading: false,
    refresh: async () => {},
  };
}

/**
 * Exactly one toast per operation, on the `endedAt` transition, with the server's
 * own summary as its text.
 *
 * Two rules do most of the work here. **No operation ever gets a "started" toast** —
 * the ledger appearing on every page is the announcement, and it is persistent. And
 * **nothing toasts if the tab was visible for the whole operation**, because the
 * ledger's settled row two lines up already says it. (This said "today's banner toasts
 * 'is ready' while the banner says the same thing" — present tense about the
 * predecessor of this file. `OperationBanner` is gone: `grep -rn "OperationBanner" src/`
 * returns nothing and no `"is ready"` string is toasted anywhere. The *rule* it
 * justified is still the right rule, which is why only the tense changed.)
 *
 * Because the text IS `op.summary`, and `summary` is derived server-side from
 * recorded steps and facts, the toast cannot claim a success the operation did not
 * evidence. That is the whole point.
 */
function CompletionToasts({
  operations,
  finished,
  fetched,
}: {
  operations: OperationView[];
  finished: OperationView[];
  /** True once a payload has come over the network, not just from the server seed. */
  fetched: boolean;
}) {
  const seen = useRef<Set<string>>(new Set());
  const everHidden = useRef<Map<string, boolean>>(new Map());
  const primedRender = useRef(false);
  const primedFetch = useRef(false);
  /** The live ids, for the `visibilitychange` listener to stamp. */
  const liveIds = useRef<string[]>([]);

  useEffect(() => {
    liveIds.current = operations.filter((o) => !o.synthetic).map((o) => o.id);
  }, [operations]);

  /**
   * Record hidden-ness from the event, not from a poll.
   *
   * This effect used to be keyed on `[operations]` and read `visibilityState` — but the
   * poller *declines to run while the tab is hidden*, so `operations` never changed
   * while hidden, so this never observed a hidden tab and `everHidden` stayed `false`
   * for practically every operation. Rule 4 then suppressed the completion toast for
   * exactly the users who had missed the completion: start a 5-minute PZ restart, switch
   * tabs, come back — no toast, and the ledger's 90s auto-clear had already taken the
   * settled row. Zero feedback, which is the 2026-09-15 silence for the background case.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      if (document.visibilityState !== "hidden") return;
      for (const id of liveIds.current) everHidden.current.set(id, true);
    };
    // Also stamp on mount if we are already hidden (a background tab restored by the
    // browser on startup).
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const hidden = document.visibilityState === "hidden";
    for (const op of operations) {
      if (op.synthetic) continue;
      const prev = everHidden.current.get(op.id) ?? false;
      everHidden.current.set(op.id, prev || hidden);
    }
  }, [operations]);

  useEffect(() => {
    // Prime twice, and both matter.
    //
    // The server-seeded first render is history: toasting it would replay up to twenty
    // old operations at once. But the seed can also be *empty* (a failed
    // `operationsPayload`, or — before the registry was hoisted onto `globalThis` —
    // always), and then priming on it alone left every already-finished record unseen,
    // so the first real poll replayed the lot as toasts, `toast.error`s included, on
    // every layout remount. So the first *fetched* payload primes as well, and never
    // toasts.
    if (!primedRender.current) {
      primedRender.current = true;
      for (const op of finished) seen.current.add(op.id);
      if (!fetched) return;
    }
    if (fetched && !primedFetch.current) {
      primedFetch.current = true;
      for (const op of finished) seen.current.add(op.id);
      return;
    }
    for (const op of finished) {
      if (seen.current.has(op.id)) continue;
      seen.current.add(op.id);
      if (op.redacted) continue;
      // Was the user looking the whole time? Then the ledger already told them.
      const missedSome = everHidden.current.get(op.id);
      if (missedSome === false && op.outcome === "ok") continue;
      const text = op.summary ?? `${op.title} finished.`;
      switch (op.outcome) {
        case "ok":
          toast.success(text, { duration: 4500 });
          break;
        case "partial":
        case "nothing":
          toast.warning(text, { duration: 8000 });
          break;
        case "failed":
          toast.error(text, { duration: 10000, closeButton: true });
          break;
        default:
          // `unverified` gets no severity colour at all — it is neither a success
          // nor a failure, and dressing it as either would be the invention.
          toast(text, { duration: 8000 });
      }
    }
  }, [finished, fetched]);

  return null;
}

/** True when this record has stopped proving it is alive. Re-exported for the UI. */
export { isStale };
