"use client";

import { useEffect, useRef, useState } from "react";
import { GAMES, type GameId } from "@/lib/games";
import { cn } from "@/lib/utils";
import {
  formatElapsed,
  gapPx,
  spellDuration,
  type OperationView,
  type OpStepView,
} from "@/lib/operations-types";

/**
 * The tape: one row per step, and **the height of the gap under a row is how long
 * that step took**.
 *
 * Duration lives in the gap and never in the text line, so text is never crushed
 * and two instant steps stack flush — which correctly reads as "these happened at
 * once". It is log-scaled because the steps on this box span 433 ms (a Project
 * Zomboid save) to twenty minutes (a SteamCMD download), and a linear scale renders
 * the first thirty of them as a single line.
 *
 * What is deliberately absent: there is no bar, no spinner, no shimmer, **no green
 * and no checkmark**. A bar animates identically whether the server is alive,
 * wedged or gone, and in a codebase whose documented recurring defect is "reports
 * success after doing nothing" that is the same defect at the animation layer. "It
 * worked" here is a past-tense sentence with a count. Colour is only ever used for
 * trouble.
 *
 * Also deliberately absent: a stagger on the rows. `/activity` staggers its list in,
 * and copying that would animate historical facts as though they were arriving now —
 * but the whole premise is that a settled step is a record. Worth the inconsistency.
 */
export function OperationTape({
  op,
  elapsedMs,
  now,
  mounted,
  reduced,
  quietMs,
  beatTick,
}: {
  op: OperationView;
  elapsedMs: number;
  now: number;
  /** Wall-clock times render only after mount — the box is Europe/Berlin and the
   *  viewer usually is not, so formatting them during SSR is a hydration mismatch. */
  mounted: boolean;
  reduced: boolean;
  /** How long the server has been silent about this operation. */
  quietMs: number;
  /** Increments on each observed heartbeat, which is what moves the pip. */
  beatTick: number;
}) {
  return (
    <div
      /* Focusable because it scrolls. Nine settled steps clip at 340px and every
         descendant is a `<p>`, `<span>` or `<time>`, so a keyboard-only user had no way
         to reach the earlier steps at all — the evidence the tape exists to show.
         (axe `scrollable-region-focusable`, WCAG 2.1.1.) `aria-live="off"` stays: this
         is a region you go and read, not one that should announce itself. */
      tabIndex={0}
      role="group"
      aria-label={`${op.title} — steps`}
      className="relative max-h-[min(50vh,340px)] overflow-y-auto pr-1 outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-h-[min(42vh,340px)]"
      style={{ overflowAnchor: "auto" }}
      aria-live="off"
    >
      {/* The rail. Same 15px inset and 1px weight as /activity's timeline, so the
          two surfaces read as the same system. */}
      <div
        className="pointer-events-none absolute bottom-2 left-[15px] top-2 w-px"
        style={{ background: "color-mix(in oklab, var(--foreground) 12%, transparent)" }}
        aria-hidden
      />
      <ol className="relative">
        {op.steps.map((step, i) => {
          const prev = i > 0 ? op.steps[i - 1] : undefined;
          const handoff =
            prev && step.game && prev.game && step.game !== prev.game ? prev.game : null;
          return (
            <li key={step.id}>
              {handoff && (
                <Handoff from={handoff} to={step.game as GameId} reduced={reduced} />
              )}
              <StepRow
                step={step}
                live={step.kind === "running"}
                elapsedMs={elapsedMs}
                now={now}
                mounted={mounted}
                reduced={reduced}
                quietMs={quietMs}
                beatTick={beatTick}
                progress={op.progress}
                synthetic={op.synthetic === true}
              />
            </li>
          );
        })}
      </ol>
      {op.steps.length === 0 && (
        <p className="py-2 pl-9 text-[13px] text-muted-foreground">
          {op.endedAt ? "No steps were recorded." : "Getting started…"}
        </p>
      )}
    </div>
  );
}

function StepRow({
  step,
  live,
  elapsedMs,
  now,
  mounted,
  reduced,
  quietMs,
  beatTick,
  progress,
  synthetic,
}: {
  step: OpStepView;
  live: boolean;
  elapsedMs: number;
  now: number;
  mounted: boolean;
  reduced: boolean;
  quietMs: number;
  beatTick: number;
  progress: OperationView["progress"];
  /** A projected boot: no heartbeat of its own, so "quiet" means something else. */
  synthetic: boolean;
}) {
  const tint = step.game ? GAMES[step.game].tint : "var(--primary)";
  const durationMs = live ? Math.max(0, now - step.at) : Math.max(0, (step.endedAt ?? step.at) - step.at);
  const gap = live ? gapPx(elapsedMs / 1000) : gapPx(durationMs / 1000);
  /**
   * 30s is 1.5x the server's heartbeat interval — one missed beat is not yet an
   * accusation. A **synthetic** boot has no heartbeat: its signal is the last log line,
   * and during a 17 GB SteamCMD fetch or a Minecraft world load that line legitimately
   * sits unchanged for minutes. Claiming "no response from the server" there is a claim
   * about something we never measured, so the threshold is longer and the sentence is
   * about the log, which is what was actually observed.
   */
  const quiet = live && quietMs > (synthetic ? 150_000 : 30_000);

  // Only trouble gets colour, and never colour alone — the `sr-only` words below carry
  // the same distinction, because `textClass` and the ✕/▲ marks are invisible to a
  // screen reader and to a red/green deficiency.
  const textClass =
    step.kind === "failed"
      ? "op-bad"
      : step.kind === "noop"
      ? "op-warn"
      : live
      ? "text-foreground"
      : "text-muted-foreground";
  const severity =
    step.kind === "failed" ? "failed" : step.kind === "noop" ? "no change" : undefined;

  const detail =
    live && progress.kind === "fraction" && !step.detail
      ? `${progress.percent}%`
      : step.detail;

  return (
    <div className="relative">
      <div className="flex items-start gap-3 pl-0">
        {/* The mark on the rail: a tick for a settled step, the pip for a live one. */}
        <span className="relative flex h-4 w-[31px] flex-shrink-0 items-center justify-center" aria-hidden>
          {live ? (
            <Pip tint={tint} beatTick={beatTick} quiet={quiet} reduced={reduced} />
          ) : (
            // A tick crossing the rail, not a round dot: /activity uses round dots
            // for things a *person* did, and merging the marks merges two kinds of fact.
            // 2px × 9px, not 1px × 7px at 55%: one device pixel of #9ac68e over a
            // #e8ebf0 wash does not perceptibly cross a rail that is itself only
            // `foreground 12%`, so the tape read as an unmarked indented list with a
            // stray hairline beside it. Trouble still steps up to 3px.
            <span
              style={{
                background:
                  step.kind === "failed"
                    ? "var(--destructive)"
                    : step.kind === "noop"
                    ? "var(--chart-5)"
                    : `color-mix(in oklab, ${tint} 80%, transparent)`,
                height: step.kind === "done" ? "2px" : "3px",
                width: step.kind === "done" ? "9px" : "11px",
              }}
            />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn("flex items-baseline gap-2 text-[13px] leading-4", textClass)}
            title={severity ? `${severity} — ${step.label}` : undefined}
          >
            <span className="min-w-0 flex-1 truncate">
              {step.kind === "noop" && <span aria-hidden>▲ </span>}
              {step.kind === "failed" && <span aria-hidden>✕ </span>}
              {/* The ✕/▲ marks and `textClass` are both invisible to a screen reader, so
                  a failed step and a successful one were textually identical — and a
                  failed step keeps its present-tense running label ("Stopping the
                  container"), which made it worse. */}
              {severity && <span className="sr-only">{severity} — </span>}
              {step.label}
              {step.count && (
                <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-80">
                  {step.count.done}
                  {step.count.total != null ? ` of ${step.count.total}` : ""} {step.count.noun}
                </span>
              )}
            </span>
            {live && (
              <span
                className="flex-shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                aria-hidden
              >
                +{formatElapsed(durationMs)}
              </span>
            )}
            {/* Row height is the ONLY visual carrier of duration, so it has to be
                available as words too or the central idea is inaccessible — which
                would be its own version of claiming something you can't evidence. */}
            {!live && <span className="sr-only">took {spellDuration(durationMs)}</span>}
          </p>
          {quiet ? (
            <p className="op-warn mt-0.5 truncate font-mono text-[11px]">
              {synthetic
                ? `The log hasn't moved for ${Math.round(quietMs / 1000)}s`
                : `No response from the server for ${Math.round(quietMs / 1000)}s`}
            </p>
          ) : detail ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{detail}</p>
          ) : null}
        </div>

        {/* Wall clock, not relative: the real task is lining this tape up against
            `docker logs`, and this project's own forensics are written in clock time. */}
        <time
          className="w-[62px] flex-shrink-0 pt-px text-right font-mono text-[11px] tabular-nums text-muted-foreground"
          dateTime={new Date(step.at).toISOString()}
          title={!live ? `took ${spellDuration(durationMs)}` : undefined}
        >
          {mounted ? clock(step.at) : ""}
        </time>
      </div>

      {/* The gap IS the duration. `height` transitions so a live row grows visibly;
          reduced motion keeps the height changes (they are data, not decoration)
          and drops only the easing, so it steps instead. */}
      <div
        className="relative"
        style={{
          height: gap,
          transition: reduced ? undefined : "height 900ms linear",
        }}
        aria-hidden
      >
        {live && <MinuteTicks ms={durationMs} />}
      </div>
    </div>
  );
}

/**
 * The liveness pip.
 *
 * It advances **only when the server's own heartbeat changes** — it is not on a
 * client timer. That matters: a spinner on a 1s interval claims liveness without
 * having it, which is this codebase's defect class dressed as an animation. When the
 * pip stops, something really has stopped.
 */
function Pip({
  tint,
  beatTick,
  quiet,
  reduced,
}: {
  tint: string;
  beatTick: number;
  quiet: boolean;
  reduced: boolean;
}) {
  const [nudge, setNudge] = useState(false);
  const last = useRef(beatTick);

  useEffect(() => {
    if (reduced || beatTick === last.current) return;
    last.current = beatTick;
    setNudge(true);
    const id = setTimeout(() => setNudge(false), 200);
    return () => clearTimeout(id);
  }, [beatTick, reduced]);

  return (
    <span
      className="h-1.5 w-1.5"
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
 * A hairline on the rail per elapsed minute, up to ten. A tick appearing is proof a
 * minute passed — which is a different claim from a bar moving, and a checkable one.
 */
function MinuteTicks({ ms }: { ms: number }) {
  const n = Math.min(10, Math.floor(ms / 60_000));
  if (n <= 0) return null;
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          className="absolute left-[11px] h-px w-[9px] bg-muted-foreground/40"
          style={{ top: `${(i + 1) * 4}px` }}
        />
      ))}
    </>
  );
}

/**
 * The transfer point of a switch: the rail's colour changes here, from the outgoing
 * world's tint to the incoming one's.
 *
 * This is why a switch is ONE object in the ledger rather than two banners. The tint
 * change at this row is the whole story — no legend, no second strip, no pair of
 * names for the reader to reconcile.
 */
function Handoff({ from, to, reduced }: { from: GameId; to: GameId; reduced: boolean }) {
  const a = GAMES[from].tint;
  const b = GAMES[to].tint;
  return (
    <div className="relative flex items-center gap-3 py-1">
      <span className="relative flex h-3 w-[31px] flex-shrink-0 items-center justify-center" aria-hidden>
        <span
          className="h-3 w-[3px]"
          style={{
            background: `linear-gradient(to bottom, ${a}, ${b})`,
            animation: reduced ? undefined : "op-handoff 600ms ease-out 1",
          }}
        />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        switching servers
      </span>
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
