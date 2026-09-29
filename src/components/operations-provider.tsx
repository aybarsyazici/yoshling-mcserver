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
  const alive = useRef(true);
  /**
   * `serverNow - receivedAt`. Elapsed time is computed against the server's clock,
   * because `Date.now() - startedAt` mixes a browser clock with a server epoch and a
   * machine that is a few minutes out then shows nonsense (or negative) durations.
   */
  const skew = useRef(0);

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
      skew.current = data.serverNow - receivedAt;
      setPayload(data);
    } catch {
      /* keep the last known state; a dropped poll is not news */
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  const running = payload?.operations.length ?? 0;

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
    (op: { startedAt: number }) => Math.max(0, Date.now() + skew.current - op.startedAt),
    []
  );

  const value = useMemo<OperationsState>(
    () => ({
      operations: payload?.operations ?? [],
      finished: (payload?.finished ?? []).filter((f) => !dismissed.includes(f.id)),
      dismiss,
      elapsedMs,
      loading,
      refresh,
    }),
    [payload, dismissed, dismiss, elapsedMs, loading, refresh]
  );

  return (
    <Ctx.Provider value={value}>
      <CompletionToasts operations={value.operations} finished={value.finished} />
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
 * ledger's settled row already says it three rows up; today's banner toasts "is
 * ready" while the banner says the same thing, which is the noise worth removing.
 *
 * Because the text IS `op.summary`, and `summary` is derived server-side from
 * recorded steps and facts, the toast cannot claim a success the operation did not
 * evidence. That is the whole point.
 */
function CompletionToasts({
  operations,
  finished,
}: {
  operations: OperationView[];
  finished: OperationView[];
}) {
  const seen = useRef<Set<string>>(new Set());
  const everHidden = useRef<Map<string, boolean>>(new Map());
  const primed = useRef(false);

  // Track which live operations we watched while the tab was hidden at any point.
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
    // The first payload is server-seeded history: toasting all of it on mount would
    // replay up to twenty old operations at once.
    if (!primed.current) {
      primed.current = true;
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
  }, [finished]);

  return null;
}

/** True when this record has stopped proving it is alive. Re-exported for the UI. */
export { isStale };
