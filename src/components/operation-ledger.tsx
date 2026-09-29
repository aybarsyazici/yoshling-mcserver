"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { GAMES, type GameId } from "@/lib/games";
import { cn } from "@/lib/utils";
import { GameMark } from "@/components/glyphs";
import { usePrefersReducedMotion } from "@/components/motion";
import { useOperations } from "@/components/operations-provider";
import { OperationTape } from "@/components/operation-tape";
import {
  OPERATION_QUIET_MS,
  OPERATION_STALE_MS,
  formatElapsed,
  liveStep,
  type OperationView,
} from "@/lib/operations-types";

/**
 * The strip above `<main>` that says what the box is doing, on every page.
 *
 * It is a strip and not only a toast because of a measured failure: on 2026-09-15 a
 * mod-update apply ran 18:30:25 → 18:36:23 with the power buttons correctly locked
 * and **nothing anywhere saying why**, which reads as the feature having done
 * nothing. A toast is gone in four seconds; the operation it needs to explain runs
 * for twenty minutes, and you are by definition elsewhere for most of them.
 *
 * Three properties are load-bearing, in descending order of importance:
 *
 *  1. **It cannot claim a success it did not observe.** Every settled line is
 *     `op.summary`, generated server-side from recorded steps and read-back facts.
 *     No route can hand this component a sentence.
 *  2. **It survives a refresh**, because both layouts seed it from the server, so
 *     reloading twelve minutes into a download shows the twelve minutes.
 *  3. **Nothing in it spins.** A sweeping bar and a `Loader2` animate identically
 *     whether the server is alive, wedged or gone. The only thing that moves on its
 *     own is the pip, and it moves only on an observed server heartbeat — so its
 *     *stillness* carries information.
 *
 * Not dismissible while anything is running: the operation disables controls
 * app-wide, and a surface you can close while the buttons stay dead is the 2026-09-15
 * bug wearing a different hat.
 */
export function OperationLedger() {
  const { operations, finished, dismiss, elapsedMs } = useOperations();
  const reduced = usePrefersReducedMotion();
  const mounted = useMounted();

  const [dismissedLive, setDismissedLive] = useState<string[]>([]);

  /**
   * A live record the viewer has waved away. Only ever offered for a **stale** one —
   * we stopped hearing from it, so a strip that cannot be closed would be the
   * self-sealing state this whole design avoids (the `applyingSince` card said
   * "Updating now — started 3 days ago" for good, with its only control disabled
   * *because* an apply looked in flight).
   *
   * Client-side only, and deliberately so: it hides nothing on the server, frees no
   * resource and lets no second operation start. `/api/operations` has no mutating
   * verb for exactly that reason — a clear button that removed a live record would be
   * a worse bug than the banner it fixed.
   */
  const live = operations.filter((o) => !dismissedLive.includes(o.id));
  const settled = finished;
  const active = live.length > 0;
  // Keep ticking while a settled record is still on screen: the 90s auto-clear for a
  // clean finish is driven off this clock.
  const now = useSecondTick(active || settled.length > 0);

  const beats = useBeats(live);
  const [open, setOpen] = useState(false);

  // Auto-open once per operation id, so arriving mid-flight catches you up but
  // navigating between pages does not keep re-opening what you already read.
  useEffect(() => {
    if (live.length === 0) return;
    const key = "yoshling.ops.autoOpened";
    let seen: string[] = [];
    try {
      seen = JSON.parse(window.sessionStorage.getItem(key) || "[]");
    } catch {}
    const fresh = live.filter((o) => !o.synthetic && !seen.includes(o.id)).map((o) => o.id);
    if (fresh.length === 0) return;
    // Reacting to an id arriving from the poll, which is external state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(true);
    try {
      window.sessionStorage.setItem(key, JSON.stringify([...seen, ...fresh].slice(-40)));
    } catch {}
  }, [live]);

  /**
   * A clean finish clears itself after 90s. Everything else — partial, nothing,
   * failed, unverified, stale — never does, and that is deliberate: there is no
   * timeout long enough, because the operation this matters most for runs twenty
   * minutes and you are elsewhere for them.
   */
  useEffect(() => {
    const stale = settled.filter((o) => o.outcome === "ok" && Date.now() - (o.endedAt ?? 0) > 90_000);
    for (const o of stale) dismiss(o.id);
  }, [settled, now, dismiss]);

  if (!active && settled.length === 0) return null;

  /**
   * A finished operation stays on screen next to a live one **for the same world**.
   *
   * This is what makes the 7 Days to Die case legible. That update honestly ends after
   * ~30 seconds — all it proved is that it *asked* SteamCMD for a new build — and the
   * synthetic boot then carries the 17 GB download for the next twenty minutes. Drop
   * the ended record and the strip shows a download with no explanation of where it
   * came from, which is exactly the twelve minutes of silence this exists to fill.
   */
  const context = active
    ? settled.filter(
        (f) =>
          f.game &&
          live.some((l) => l.game === f.game) &&
          now - (f.endedAt ?? 0) < 5 * 60_000
      )
    : settled.slice(0, 1);

  // Real work first (it is why the buttons are dead), then the context it explains,
  // then the derived boots — the least actionable thing on screen.
  const shown = active
    ? [...live.filter((o) => !o.synthetic), ...context, ...live.filter((o) => o.synthetic)]
    : context;
  const primary = shown[0];
  if (!primary) return null;

  const tint = primary.game ? GAMES[primary.game].tint : "var(--primary)";
  const drained = !active;
  const railTint = drained ? "var(--border)" : tint;
  const primaryStale = isLost(primary, now);

  const runningCount = shown.filter((o) => !o.endedAt).length;
  // Collapsed, a second live operation gets one line of its own; a third becomes
  // "and N more". Finished context is only shown expanded — it is history, and the
  // collapsed strip is for what is happening now.
  const extras = shown.slice(1).filter((o) => !o.endedAt);
  const secondary = extras[0];
  const moreCount = Math.max(0, extras.length - 1);

  return (
    <div
      className="flex-shrink-0 backdrop-blur"
      style={{
        background: `color-mix(in oklab, color-mix(in oklab, ${railTint} 7%, var(--card)) 60%, transparent)`,
        borderBottom: `1px solid color-mix(in oklab, ${railTint} 22%, transparent)`,
        // The one settle animation: the tint drains out once, over 600ms.
        transition: reduced ? undefined : "background 600ms ease-out, border-color 600ms ease-out",
      }}
    >
      <div className="mx-auto max-w-6xl px-4 py-2 sm:px-6 lg:px-8">
        {/* Collapsed header. Only this line is inside the live region — expanding the
            tape must not dump nine rows into a screen reader. */}
        <div className="flex items-center gap-2.5">
          <GameMark
            game={(primary.game ?? "minecraft") as GameId}
            className="h-4 w-4 flex-shrink-0"
            style={{ color: railTint }}
          />
          <p
            className="min-w-0 flex-1 truncate text-[13px]"
            role="status"
            aria-live="polite"
            aria-atomic="false"
          >
            <span className="hidden font-semibold text-foreground sm:inline">
              {headline(primary)}
            </span>
            <span className="hidden sm:inline"> — </span>
            {/* Expanded, this line names the operation and the tape below says where it
                has got to; collapsed, it has to carry both. Showing the live step here
                *and* the title one row down said the same thing twice. */}
            {/* A lost operation says so whether or not the tape is open. It is the one
                thing on this line that outranks knowing which operation it is. */}
            {open && !primaryStale ? (
              <span className="text-foreground">
                {runningCount > 1 ? `${runningCount} operations running` : primary.title}
              </span>
            ) : (
              <span className={cn(primaryStale ? "text-chart-5" : statusToneClass(primary))}>
                {lede(primary, now)}
              </span>
            )}
          </p>

          {active && (
            <>
              <span className="flex-shrink-0" aria-hidden>
                <Pip tint={tint} beat={beats.get(primary.id)} reduced={reduced} now={now} />
              </span>
              <span
                className="flex-shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                aria-hidden
              >
                +{formatElapsed(elapsedMs(primary))}
              </span>
            </>
          )}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="operation-tapes"
            className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <span className="hidden sm:inline">
              {open ? "Hide" : `${primary.steps.length} step${primary.steps.length === 1 ? "" : "s"}`}
            </span>
            <span className="sm:hidden">{primary.steps.length}</span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </button>

          {/* Dismiss once nothing is locked — or once we have lost contact, because a
              surface you cannot close while the buttons stay dead is the 2026-09-15
              bug in a new hat, and a surface you cannot close AND cannot trust is worse. */}
          {((!active && !primary.synthetic) || primaryStale) && (
            <button
              type="button"
              onClick={() =>
                primary.endedAt
                  ? dismiss(primary.id)
                  : setDismissedLive((p) => [...p, primary.id])
              }
              className="flex-shrink-0 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>

        {/* A settled failure has to name a way forward, and the container log is it. */}
        {!active && primary.outcome === "failed" && primary.game && (
          <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
            <Link href={`${GAMES[primary.game].base}/server`} className="underline hover:text-foreground">
              Open the console
            </Link>{" "}
            to see what the server printed.
          </p>
        )}

        {!open && secondary && (
          <p className="mt-1 flex items-center gap-1.5 pl-6 text-xs text-muted-foreground">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em]">also</span>
            <GameMark
              game={(secondary.game ?? "minecraft") as GameId}
              className="h-3 w-3 flex-shrink-0"
              style={{ color: secondary.game ? GAMES[secondary.game].tint : "var(--primary)" }}
            />
            <span className="min-w-0 truncate">
              {headline(secondary)} — {lede(secondary, now)}
            </span>
            <span className="flex-shrink-0 font-mono tabular-nums" aria-hidden>
              +{formatElapsed(elapsedMs(secondary))}
            </span>
          </p>
        )}

        {!open && moreCount > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1 pl-6 text-xs text-muted-foreground underline hover:text-foreground"
          >
            and {moreCount} more
          </button>
        )}

        {open && (
          <div
            id="operation-tapes"
            className={cn(
              "mt-2 grid gap-4 border-t pt-2",
              shown.length > 1 && "lg:grid-cols-2"
            )}
            style={{ borderColor: `color-mix(in oklab, ${railTint} 15%, transparent)` }}
          >
            {/* Each operation gets its own tape, never interleaved. Merging two
                machines' event streams invents causality, and on a box where "two
                worlds running at once" is an open defect, blurring which world did
                what is worse than two tapes. */}
            {shown.map((op) => {
              const beat = beats.get(op.id);
              const quietMs = beat ? now - beat.at : 0;
              return (
                <section key={op.id} className="min-w-0">
                  {/* Only when there are several: with one operation the header line
                      above already names it, and repeating it is noise. */}
                  {shown.length > 1 && (
                    <div className="mb-1 flex items-baseline gap-2">
                      <GameMark
                        game={(op.game ?? "minecraft") as GameId}
                        className="h-3.5 w-3.5 flex-shrink-0 self-center"
                        style={{ color: op.game ? GAMES[op.game].tint : "var(--primary)" }}
                      />
                      <h2 className="min-w-0 truncate text-[13px] font-semibold">{op.title}</h2>
                    </div>
                  )}
                  <p
                    className={cn(
                      "mb-1.5 text-[11px] text-muted-foreground",
                      shown.length > 1 && "pl-[23px]"
                    )}
                  >
                    {chrome(op, now, elapsedMs(op))}
                  </p>
                  <OperationTape
                    op={op}
                    elapsedMs={elapsedMs(op)}
                    now={now}
                    mounted={mounted}
                    reduced={reduced}
                    quietMs={quietMs}
                    beatTick={beat?.tick ?? 0}
                  />
                  {op.summary && op.endedAt && (
                    <p className={cn("mt-1.5 pl-[23px] text-[12px]", statusToneClass(op))}>
                      {op.summary}
                    </p>
                  )}
                  {op.facts.length > 0 && op.endedAt && (
                    <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-[23px] font-mono text-[10px] text-muted-foreground">
                      {op.facts.map((f, i) => (
                        <div key={`${f.label}-${i}`} className="flex gap-1.5">
                          <dt className="uppercase tracking-[0.12em]">{f.label}</dt>
                          <dd
                            className={cn(
                              f.verdict === "bad"
                                ? "text-destructive"
                                : f.verdict === "warn"
                                ? "text-chart-5"
                                : "text-foreground"
                            )}
                          >
                            {f.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Project Zomboid", or the plain fallback for an operation with no world. */
function headline(op: OperationView): string {
  return op.game ? GAMES[op.game].name : "The server";
}

/** We stopped hearing from it. NOT the same claim as "it failed". */
function isLost(op: OperationView, now: number): boolean {
  return !op.endedAt && !op.synthetic && now - op.heartbeatAt > OPERATION_STALE_MS;
}

/** The one line the strip must get right: what is happening, or what happened. */
function lede(op: OperationView, now: number): string {
  if (op.endedAt) return op.summary ?? `${op.title} finished.`;
  if (isLost(op, now)) {
    // We do NOT claim a failure we have not observed. The operation may well have
    // succeeded; what we know is that we stopped hearing about it. Naming the console
    // matters because that is where the evidence actually is.
    return `${op.title} — lost contact ${formatElapsed(
      now - op.heartbeatAt
    )} ago. Check the console.`;
  }
  return liveStep(op)?.label ?? op.title;
}

/** The sub-line under an expanded operation. Always about THAT operation. */
function chrome(op: OperationView, now: number, elapsed: number): string {
  if (op.endedAt) {
    return `Finished after ${formatElapsed(op.endedAt - op.startedAt)}${
      op.startedBy ? ` — started by ${op.startedBy.name}` : ""
    }`;
  }
  const started = new Date(op.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const at = `${p(started.getHours())}:${p(started.getMinutes())}:${p(started.getSeconds())}`;
  const locked = op.holdsPower
    ? " — server controls are locked until this finishes"
    : op.synthetic
    ? " — the server is not answering yet"
    : "";
  if (now - op.heartbeatAt > OPERATION_STALE_MS && !op.synthetic) {
    return `Started ${at}, ${formatElapsed(elapsed)} ago — no heartbeat since`;
  }
  return `Started ${at}, ${formatElapsed(elapsed)} ago${locked}`;
}

function statusToneClass(op: OperationView): string {
  if (!op.endedAt) return "text-muted-foreground";
  switch (op.outcome) {
    case "failed":
      return "text-destructive";
    case "partial":
    case "nothing":
      return "text-chart-5";
    // `unverified` gets no colour at all. It is the state nobody designs, and
    // dressing it as either a success or a failure would be the invention.
    default:
      return "text-muted-foreground";
  }
}

function Pip({
  tint,
  beat,
  reduced,
  now,
}: {
  tint: string;
  beat?: { tick: number; at: number };
  reduced: boolean;
  now: number;
}) {
  const [nudge, setNudge] = useState(false);
  const last = useRef(beat?.tick ?? 0);
  const quiet = beat ? now - beat.at > OPERATION_QUIET_MS : false;

  useEffect(() => {
    const t = beat?.tick ?? 0;
    if (reduced || t === last.current) return;
    last.current = t;
    setNudge(true);
    const id = setTimeout(() => setNudge(false), 200);
    return () => clearTimeout(id);
  }, [beat?.tick, reduced]);

  return (
    <span
      className="block h-1.5 w-1.5"
      style={{
        background: tint,
        opacity: quiet ? 0.6 : 1,
        filter: `drop-shadow(0 0 4px ${tint})`,
        transform: nudge ? "translateX(4px)" : "translateX(0)",
        transition: reduced ? undefined : "transform 200ms cubic-bezier(.22,1,.36,1), opacity 300ms",
      }}
    />
  );
}

/**
 * When the server last said something new about each operation.
 *
 * Keyed off the *observed* heartbeat, not a timer — that is what makes the pip's
 * stillness mean something. A synthetic boot has no heartbeat of its own (it is
 * re-derived every read), so its signal is the boot percentage and the last log line.
 */
function useBeats(ops: OperationView[]): Map<string, { tick: number; at: number }> {
  const [beats, setBeats] = useState<Map<string, { sig: string; tick: number; at: number }>>(
    () => new Map()
  );

  useEffect(() => {
    // Syncing React to an external stream (the poll), which is what effects are for;
    // the same disable sits in `use-games.ts` for the same reason.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBeats((prev) => {
      const next = new Map(prev);
      let changed = false;
      const ids = new Set(ops.map((o) => o.id));
      for (const id of [...next.keys()]) {
        if (!ids.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      for (const op of ops) {
        const sig = beatSignal(op);
        const prevBeat = next.get(op.id);
        if (!prevBeat) {
          next.set(op.id, { sig, tick: 0, at: Date.now() });
          changed = true;
        } else if (prevBeat.sig !== sig) {
          next.set(op.id, { sig, tick: prevBeat.tick + 1, at: Date.now() });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [ops]);

  return beats;
}

function beatSignal(op: OperationView): string {
  if (op.synthetic) {
    const pct = op.progress.kind === "fraction" ? op.progress.percent : "";
    const s = op.steps[0];
    return `${pct}|${s?.label ?? ""}|${s?.detail ?? ""}`;
  }
  const s = liveStep(op);
  return `${op.heartbeatAt}|${s?.label ?? ""}|${s?.detail ?? ""}|${op.steps.length}`;
}

/** A 1s clock, only while something is running. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Wall-clock strings are formatted only after mount: the box runs Europe/Berlin and
 * the viewer usually does not, so doing it during the server pass is a guaranteed
 * hydration mismatch.
 */
function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setM(true);
  }, []);
  return m;
}
