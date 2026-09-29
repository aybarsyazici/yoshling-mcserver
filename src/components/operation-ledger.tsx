"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, OctagonX, Server } from "lucide-react";
import { GAMES } from "@/lib/games";
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
  lowerFirst,
  type OperationFact,
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
export function OperationLedger({
  /**
   * The inner container. Defaults to `DashShell`'s column; `/home` passes its own,
   * because `HomeChrome` and `/home`'s `<main>` are `max-w-5xl sm:px-6` and the strip
   * hung 56px outside the content column on the one page whose identity is axial
   * symmetry around the Power Core.
   */
  className = "mx-auto max-w-6xl px-4 sm:px-6 lg:px-8",
}: { className?: string } = {}) {
  const { operations, finished, dismiss, elapsedMs, skewMs } = useOperations();
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
  //
  // TWO clocks, deliberately. `browserNow` is the raw tick and is only ever compared
  // against other browser timestamps (the beat map, which this component writes). `now`
  // is skew-corrected and is the only one allowed near a server epoch —
  // `heartbeatAt`, `startedAt`, `endedAt`, `step.at`. Mixing them is what made a laptop
  // three minutes fast report every live operation as "lost contact 3m 0s ago" beside a
  // corrected "+2s", with a Dismiss button on a running operation.
  const browserNow = useSecondTick(active || settled.length > 0);
  const now = browserNow + skewMs;

  const beats = useBeats(live);
  /**
   * Collapsed is the live state, and expanding is always a deliberate click.
   *
   * It used to auto-open on every newly-seen operation id, which measured badly on the
   * live box: on a 375×667 phone the panel came up **683px tall — taller than the
   * viewport** — so the first screen of `/home` contained zero product content and the
   * Power buttons the operator had come for sat at y=1485/1856/2249. At 1440px it moved
   * the page's own `<h1>` from y=225 to y=602, pushing the power row below the fold on any
   * 900px-tall laptop, and it has no ceiling: it grows with the retained record count.
   *
   * The collapsed bar already carries world, live step, elapsed and a step count, which is
   * the whole point of it, so nothing is lost. `#operation-tapes` is also capped at 45vh
   * below, so a deliberate expansion can no longer exceed the viewport either.
   */
  const [open, setOpen] = useState(false);

  /**
   * A clean finish clears itself after 90s. Everything else — partial, nothing,
   * failed, unverified, stale — never does, and that is deliberate: there is no
   * timeout long enough, because the operation this matters most for runs twenty
   * minutes and you are elsewhere for them.
   */
  useEffect(() => {
    const stale = settled.filter(
      (o) => o.outcome === "ok" && Date.now() + skewMs - (o.endedAt ?? 0) > 90_000
    );
    for (const o of stale) dismiss(o.id);
  }, [settled, now, dismiss, skewMs]);

  /**
   * A finished operation stays on screen next to a live one **for the same world**.
   *
   * This is what makes the 7 Days to Die case legible. That update honestly ends after
   * ~30 seconds — all it proved is that it *asked* SteamCMD for a new build — and the
   * synthetic boot then carries the 17 GB download for the next twenty minutes. Drop
   * the ended record and the strip shows a download with no explanation of where it
   * came from, which is exactly the twelve minutes of silence this exists to fill.
   *
   * Idle, it shows the **worst** retained record rather than merely the newest. Non-`ok`
   * records are deliberately kept for six hours while clean ones clear in ten minutes, and
   * nothing writes an Activity row on a failure path — so a `failed` record losing the one
   * slot to a two-second memory change is the retention policy being defeated by the
   * display. (Clean records self-dismiss after 90s, which is why this only bites in the
   * first minute and a half — which is also exactly when someone is looking.)
   */
  const worstSettled = settled.find((o) => o.outcome && o.outcome !== "ok");
  const context = active
    ? settled.filter(
        (f) =>
          f.game &&
          live.some((l) => l.game === f.game) &&
          now - (f.endedAt ?? 0) < 5 * 60_000
      )
    : worstSettled
    ? [worstSettled]
    : settled.slice(0, 1);

  // Real work first (it is why the buttons are dead), then the context it explains,
  // then the derived boots — the least actionable thing on screen.
  const shown = active
    ? [...live.filter((o) => !o.synthetic), ...context, ...live.filter((o) => o.synthetic)]
    : context;
  const primary = shown[0];

  const tint = primary ? opTint(primary) : "var(--primary)";
  const primaryStale = primary ? isLost(primary, now) : false;
  /**
   * The bar keeps weight when the outcome was not clean.
   *
   * Draining to `var(--border)` for everything made the one sentence this feature
   * exists to deliver — "Finished, but nothing changed. 0 of 166 mods installed." —
   * render in Latte as `#df8e1d` on a `#e8ebf0` bar over a `#eff1f5` page: 2.15:1 at
   * 13px, below AA, in a bar you can barely see. Every other warning in this app pairs
   * `text-chart-5` with an `AlertTriangle` and a tinted panel; this was the one place
   * colour carried it alone.
   */
  const railTint = primary?.stalled
    ? "var(--chart-5)"
    : !active
    ? primary?.outcome === "failed"
      ? "var(--destructive)"
      : primary?.outcome === "partial" || primary?.outcome === "nothing"
      ? "var(--chart-5)"
      : "var(--border)"
    : tint;

  const runningCount = shown.filter((o) => !o.endedAt).length;
  // Collapsed, a second live operation gets one line of its own; a third becomes
  // "and N more". Finished context is only shown expanded — it is history, and the
  // collapsed strip is for what is happening now.
  const extras = shown.slice(1).filter((o) => !o.endedAt);
  const secondary = extras[0];
  const moreCount = Math.max(0, extras.length - 1);

  const primaryQuiet = primary ? isQuiet(beats.get(primary.id), browserNow) : false;

  /**
   * The world name is printed once, not twice.
   *
   * Every power summary opens with the world's name (it is also the toast text, which has
   * no prefix of its own), so prefixing it here produced "7 Days to Die — 7 Days to Die —
   * started in 5m 04s…" on screen *and* in the live region, which announced the
   * duplication verbatim. Backup summaries open "Backup created —", so they still need
   * the prefix; so does every live record, whose lede is a bare step label ("Copying the
   * world"). Hence: condition it on the text, not remove it.
   *
   * **`includes`, not `startsWith`** — and that was the whole bug for the LIVE case.
   * A settled summary does start with the name, so the guard worked there and the fix
   * above looked complete. But a live lede is a step *label*, and every power label
   * embeds the world mid-sentence: `Stopping Project Zomboid`, `Saving Minecraft`,
   * `Checking 7 Days to Die`. `startsWith` never fired on any of them, so the strip read
   * "Project Zomboid — Stopping Project Zomboid" and the live region announced it
   * verbatim, for the entire five minutes of a PZ stop. `includes` still keeps the
   * hand-off form, where the operation's world and the step's world genuinely differ
   * ("Minecraft — Stopping Project Zomboid" contains neither name twice). The labels
   * themselves must NOT lose the world name: naming it is what makes a hand-off legible.
   */
  const primaryLede = primary ? lede(primary, now) : "";
  const primaryName = primary ? headline(primary) : "";
  /** Several worlds at once must not be labelled with the first one's name. */
  const oneWorld = shown.filter((o) => !o.endedAt).every((o) => o.game === primary?.game);
  /** Expanded with more than one live operation, the line names the group, not a record. */
  const groupOpen = open && !primaryStale && runningCount > 1;
  const needsName = groupOpen ? oneWorld : !primaryLede.includes(primaryName);
  /** The two extra collapsed lines, computed once — both are read twice below. */
  const primaryDetail = primary && !primary.endedAt ? collapsedDetail(primary) : undefined;
  const primaryConcern = primary && !primary.endedAt ? newestConcern(primary) : undefined;

  return (
    <>
      {/*
        The live region is mounted UNCONDITIONALLY, and it is the only one.

        A region created at the same moment as its content is the documented unreliable
        case for `aria-live`: neither NVDA nor VoiceOver is required to announce it, and
        in practice neither does. This component returned `null` while idle, so pressing
        Power on inserted a brand-new `<p role="status">` already containing "Project
        Zomboid — Saving the world" — and since every start toast was deliberately
        removed in favour of "the strip appearing IS the announcement", a screen-reader
        user heard nothing at all until the next step label swapped in, which for a PZ
        stop is five minutes later.

        It also carries the world name unconditionally, because the visible name is
        `hidden sm:inline` and every `GameMark` glyph hard-codes `aria-hidden` — so below
        `sm` the region said "Downloading mods from Steam" with no way to tell which of
        three worlds it was on. And it never contains a per-second figure, so a stale
        operation cannot make a screen reader repeat the same sentence once a second
        forever with no way to stop it but finding the Dismiss button.
      */}
      <p role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {primary ? announceLine(primary, now) : ""}
      </p>

      {!primary ? null : (
    <aside
      /* A landmark, so a screen-reader user skimming by landmark can reach the one
         surface whose whole purpose is to say what the box is doing. axe flagged the
         strip's own nodes as outside every landmark (`region`, moderate) on every page:
         `<header>` came before it and `<main>` after it, with nothing around it. */
      aria-label="Server operations"
      className="flex-shrink-0 backdrop-blur"
      style={{
        background: `color-mix(in oklab, color-mix(in oklab, ${railTint} 7%, var(--card)) 60%, transparent)`,
        borderBottom: `1px solid color-mix(in oklab, ${railTint} 22%, transparent)`,
        // The one settle animation: the tint drains out once, over 600ms.
        transition: reduced ? undefined : "background 600ms ease-out, border-color 600ms ease-out",
      }}
    >
      <div className={cn("py-2", className)}>
        {/* Collapsed header. The announcement lives in the sr-only region above; this
            line is the visual half, so nothing here needs a role. */}
        <div className="flex items-center gap-3">
          {/* 31px wide, matching the tape's mark column, so the glyph sits exactly over
              the rail below it and every line in the strip shares one left edge. There
              used to be five different ones (26 / 0 / 43 / 23 / 24 px), which read as
              sloppiness rather than as a column. */}
          <span className="flex h-4 w-[31px] flex-shrink-0 items-center justify-center">
            {/* Severity is never colour alone: every other warning in this app pairs
                `text-chart-5` with an AlertTriangle, and this was the one place it
                didn't. A settled non-ok outcome replaces the world glyph with the mark,
                which is the strongest signal available at 14px. */}
            {!active && primary.outcome === "failed" ? (
              <OctagonX className="op-bad h-4 w-4" aria-hidden />
            ) : (!active && (primary.outcome === "partial" || primary.outcome === "nothing")) ||
              primary.stalled ? (
              <AlertTriangle className="op-warn h-4 w-4" aria-hidden />
            ) : (
              <OpMark op={primary} className="h-4 w-4" color={railTint} />
            )}
          </span>
          <p
            className="min-w-0 flex-1 truncate text-[13px]"
            /* It is truncated, so the tooltip only ever adds information. Without it a
               sighted reader saw "…so it wa…" while the sr-only region carried the whole
               failure sentence — the accessible version being better than the visual one
               is backwards. */
            title={primaryLede}
          >
            {needsName && (
              <>
                <span className="hidden font-semibold text-foreground sm:inline">
                  {primaryName}
                </span>
                <span className="hidden sm:inline"> — </span>
              </>
            )}
            {/* Expanded, this line names the operation and the tape below says where it
                has got to; collapsed, it has to carry both. Showing the live step here
                *and* the title one row down said the same thing twice. */}
            {/* A lost operation says so whether or not the tape is open. It is the one
                thing on this line that outranks knowing which operation it is. */}
            {open && !primaryStale ? (
              <span className="text-foreground">
                {runningCount > 1
                  ? // Three backups on three worlds were headed "Project Zomboid — 3
                    // operations running", which is the same name-borrowing 8760454 fixed
                    // in the controls.
                    `${runningCount} operations running${oneWorld ? "" : " across several worlds"}`
                  : primary.title}
              </span>
            ) : (
              <span
                className={cn(
                  primaryStale || primary.stalled ? "op-warn" : statusToneClass(primary)
                )}
              >
                {primaryLede}
              </span>
            )}
            {/* Under reduced motion the pip does not move, so its 1 → 0.6 opacity step
                on a 6px square is the ONLY signal that the server has gone quiet. Say
                it in words too. No seconds figure, so it changes at most once and is
                safe in the region above. */}
            {primaryQuiet && !primaryStale && (
              <span className="op-warn"> — no response from the server yet</span>
            )}
          </p>

          {active && (
            <>
              <span className="flex-shrink-0" aria-hidden>
                <Pip tint={tint} beat={beats.get(primary.id)} reduced={reduced} now={browserNow} />
              </span>
              {/* Rendered only after mount. It is computed from the current clock on both
                  the server pass and the first client pass, so whenever the elapsed second
                  ticked between them React threw an uncaught #418 text-content hydration
                  error — observed on two page loads in three while an operation was live,
                  and before `src/app/error.tsx` existed there was nothing for it to land
                  in. The boundary exists now (added in 4b1e794, the same commit as this
                  file), but the guard stays: landing in a boundary on two loads in three
                  is worse UX than not throwing. */}
              <span
                className="op-chrome flex-shrink-0 font-mono text-xs tabular-nums"
                aria-hidden
              >
                {mounted ? `+${formatElapsed(elapsedMs(primary))}` : ""}
              </span>
            </>
          )}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="operation-tapes"
            /* Below `sm` the visible label is a bare numeral beside a chevron, which a
               screen reader announced as "1, button". The name is stated here so it is
               right at every width. */
            aria-label={
              open
                ? "Hide the operation steps"
                : `Show the operation steps (${primary.steps.length})`
            }
            className="op-chrome flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] transition-colors hover:bg-foreground/5 hover:text-foreground"
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
              bug in a new hat, and a surface you cannot close AND cannot trust is worse.
              A *stalled* projected boot counts too: it is re-derived on every poll from
              a container that is up and not answering, so without this it was an
              undismissible strip on every page that climbed past "+4h 12m". */}
          {((!active && !primary.synthetic) || primaryStale || primary.stalled) && (
            <button
              type="button"
              onClick={() =>
                primary.endedAt
                  ? dismiss(primary.id)
                  : setDismissedLive((p) => [...p, primary.id])
              }
              className="op-chrome flex-shrink-0 rounded-md px-1.5 py-1 font-mono text-[11px] transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>

        {/*
          The collapsed strip carries the live step's DETAIL, not only its label.

          This is the founding complaint of this pass. On 2026-09-29 the owner pressed
          Restart on Project Zomboid and watched it sit for five minutes with no
          explanation — and the explanation was on the wire the entire time.
          `narratedStop` sets `op.detail("Asked the server to quit over RCON — waiting for it
          * to exit")` before it calls `docker stop`, but `lede()` returns only
          `liveStep(op)?.label` and the panel defaults collapsed, so the one sentence that
          would have made the wait a non-event was one un-hinted click away for 300
          seconds.

          A second line rather than an auto-expand: expanding on its own measured 683px
          on a 375×667 phone — taller than the viewport, with zero product content on the
          first screen. One truncated line costs 16px.

          `aria-hidden`, and deliberately: for a modpack apply this is the mod name, which
          changes every few seconds. `announce()` stays label-only so a screen reader is
          never talked over — see its docstring.
        */}
        {!open && primaryDetail && (
          <p className="op-chrome mt-1 truncate pl-[43px] font-mono text-[11px]" aria-hidden>
            {primaryDetail}
          </p>
        )}

        {/*
          A warn/bad fact is shown WHILE the operation runs, not only after it ends.

          `op.fact()` records evidence as it is obtained, and the facts list is only ever
          appended to — nothing in it is speculative or later rewritten — so there was
          never a correctness reason to withhold it. The cost of withholding was measured:
          when Project Zomboid does not answer the save RCON, `narratedStop` records
          "the world was not saved — the server did not answer" at about second 1 and then
          blocks in `docker stop` for 300 seconds. The operator learned the world had not
          been saved *after* the SIGKILL — i.e. after the only window in which a human
          could have done anything about it.

          It names the world when the fact is about a DIFFERENT one from the operation's
          own, which on this box is the common case rather than an edge case: a hand-off is
          one operation whose `game` is the world coming *up*, and the warnings it collects
          ("the world was not saved", "killed after 300s") are about the world going
          *down*. That is exactly what `OperationFact.game` exists to disambiguate — the
          derived summary once read "Minecraft — started in 5m 04s, but it had to be killed
          after 300s" when it was Project Zomboid that was SIGKILLed. Printing this fact
          bare under a "Starting Minecraft" heading would have reintroduced that mix-up in
          a new place.

          Not `aria-hidden`: a fact is appended once and does not churn, and this sits
          outside the `role="status"` region above, so it is read on navigation and never
          announced over the user.
        */}
        {!open && primaryConcern && (
          <p
            className={cn(
              "mt-1 truncate pl-[43px] text-[11px]",
              primaryConcern.verdict === "bad" ? "op-bad" : "op-warn"
            )}
          >
            {primaryConcern.game && primaryConcern.game !== primary.game
              ? `${GAMES[primaryConcern.game].name}: ${primaryConcern.value}`
              : primaryConcern.value}
          </p>
        )}

        {/* A settled failure has to name a way forward, and the container log is it. */}
        {!active && primary.outcome === "failed" && primary.game && (
          <p className="op-chrome mt-1 pl-[43px] text-[11px]">
            <Link href={`${GAMES[primary.game].base}/server`} className="underline hover:text-foreground">
              Open the console
            </Link>{" "}
            to see what the server printed.
          </p>
        )}

        {!open && secondary && (
          <p className="op-chrome mt-1 flex items-center gap-1.5 pl-[43px] text-xs">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em]">also</span>
            <OpMark op={secondary} className="h-3 w-3 flex-shrink-0" color={opTint(secondary)} />
            {/* Through the same guard as the primary line: this printed the name
                unconditionally, so a second live power operation read
                "Project Zomboid — Stopping Project Zomboid" here too. */}
            <span className="min-w-0 truncate">
              {withName(secondary, lede(secondary, now))}
            </span>
            <span className="flex-shrink-0 font-mono tabular-nums" aria-hidden>
              {mounted ? `+${formatElapsed(elapsedMs(secondary))}` : ""}
            </span>
          </p>
        )}

        {!open && moreCount > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="op-chrome mt-1 pl-[43px] text-xs underline hover:text-foreground"
          >
            and {moreCount} more
          </button>
        )}

        {/* Rendered always and hidden with `hidden`, so `aria-controls` above never
            points at an id that does not exist — which, collapsed, was the state the
            control actually matters in. */}
        <div
          id="operation-tapes"
          hidden={!open}
          /* Capped and scrollable: this panel has no natural ceiling — it grows with the
             retained record count, and on a 375×667 phone it measured 683px, i.e. taller
             than the viewport, with the page's own content entirely off screen. */
          className={cn(
            "mt-2 grid max-h-[45vh] gap-4 overflow-y-auto border-t pt-2",
            shown.length > 1 && "lg:grid-cols-2"
          )}
          style={{ borderColor: `color-mix(in oklab, ${railTint} 15%, transparent)` }}
        >
          {/* Each operation gets its own tape, never interleaved. Merging two
              machines' event streams invents causality, and on a box where "two
              worlds running at once" is an open defect, blurring which world did
              what is worse than two tapes. */}
          {open &&
            shown.map((op) => {
              const beat = beats.get(op.id);
              // Browser-vs-browser: `beat.at` is stamped by this component, so this one
              // comparison must NOT be skew-corrected.
              const quietMs = beat ? browserNow - beat.at : 0;
              return (
                <section key={op.id} className="min-w-0">
                  {/* Only when there are several: with one operation the header line
                      above already names it, and repeating it is noise. */}
                  {shown.length > 1 && (
                    <div className="mb-1 flex items-center gap-3">
                      <span className="flex h-4 w-[31px] flex-shrink-0 items-center justify-center">
                        <OpMark op={op} className="h-3.5 w-3.5" color={opTint(op)} />
                      </span>
                      <h2 className="min-w-0 truncate text-[13px] font-semibold">{op.title}</h2>
                    </div>
                  )}
                  {/* One indent for every line in the strip — 43px, the tape's own mark
                      column plus its gap — and unconditional, so opening a second
                      operation no longer shifts the first one's text sideways. */}
                  <p className="op-chrome mb-1.5 pl-[43px] text-[11px]">
                    {chrome(op, now, elapsedMs(op), mounted)}
                  </p>
                  {/* Pre-emption was recorded and shipped on the wire from the moment a
                      power operation was admitted over this one, and nothing rendered it:
                      a backup already guaranteed to be discarded went on settling "Wrote
                      the archive — 291 MiB" for a further eleven minutes before concluding
                      `failed`. The refusal machinery is right; only the silence was wrong. */}
                  {op.preempted && !op.endedAt && (
                    <p className="op-warn mb-1.5 pl-[43px] text-[11px]">
                      {op.kind === "backup.create"
                        ? "A power operation ran through this — the archive will be deleted rather than offered as a restore point."
                        : "A power operation ran through this — its result cannot be trusted."}
                    </p>
                  )}
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
                    <p className={cn("mt-1.5 pl-[43px] text-[12px]", statusToneClass(op))}>
                      {op.summary}
                    </p>
                  )}
                  {/* Not gated on `op.endedAt` any more. `op.fact()` appends evidence as
                      it is obtained and never rewrites it, so every fact already present
                      is already true — withholding them until the end only meant the
                      "world was not saved" warning arrived 300s after the moment it
                      mattered. Checked every `verdict: "warn"` / `"bad"` site in the repo
                      before making the change: each is recorded immediately after its own
                      step's `op.settle()` (`narratedStop`'s Save and Shutdown facts,
                      `/api/7dtd/update`'s Build fact) or in the operation's return
                      `facts`. So a routine restart cannot flash a warning mid-step — the
                      only facts visible early are ones whose step has already concluded. */}
                  {op.facts.length > 0 && (
                    <dl className="op-chrome mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-[43px] font-mono text-[10px]">
                      {op.facts.map((f, i) => (
                        <div key={`${f.label}-${i}`} className="flex gap-1.5">
                          <dt className="uppercase tracking-[0.12em]">{f.label}</dt>
                          <dd
                            className={cn(
                              f.verdict === "bad"
                                ? "op-bad"
                                : f.verdict === "warn"
                                ? "op-warn"
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
      </div>
    </aside>
      )}
    </>
  );
}

/** "Project Zomboid", or the plain fallback for an operation with no world. */
function headline(op: OperationView): string {
  return op.game ? GAMES[op.game].name : "The server";
}

/**
 * The world's glyph, or a neutral one when the operation names no world.
 *
 * `OperationView.game` is `GameId | null` and three call sites here did
 * `game={(op.game ?? "minecraft") as GameId}` — so the first genuinely cross-world
 * operation would have been given a creeper face and a green rail, silently attributing
 * it to Minecraft. `headline()` already had this right ("The server"), which is why the
 * glyph and the text disagreed; this makes them agree. Nothing produces a world-less
 * operation today, so this is a latent defect rather than a live one — but the cast was
 * doing the lying, and a cast is exactly what stops the compiler catching it.
 *
 * Not a branch in `glyphs.tsx`: `GameMark` is keyed on `GameId` and the convention is
 * that it stays the single place a *game* maps to a mark. This is the absence of a game,
 * which is a different question, so it is answered here rather than by widening `GameMark`.
 */
function OpMark({
  op,
  className,
  color,
}: {
  op: OperationView;
  className: string;
  color: string;
}) {
  if (!op.game) return <Server className={className} style={{ color }} aria-hidden />;
  return <GameMark game={op.game} className={className} style={{ color }} />;
}

/** The accent for one record — the world's tint, or the app default. */
function opTint(op: OperationView): string {
  return op.game ? GAMES[op.game].tint : "var(--primary)";
}

/** We stopped hearing from it. NOT the same claim as "it failed". */
function isLost(op: OperationView, now: number): boolean {
  return !op.endedAt && !op.synthetic && now - op.heartbeatAt > OPERATION_STALE_MS;
}

/** The pip has not moved for a while. Browser-clock only — we stamp `beat.at`. */
function isQuiet(beat: { at: number } | undefined, browserNow: number): boolean {
  return beat ? browserNow - beat.at > OPERATION_QUIET_MS : false;
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

/**
 * The second collapsed line: the most concrete thing known about the live step.
 *
 * In preference order, because each is strictly more specific than the next: the step's
 * own `detail` (set by `op.detail()` — "Asked the server to quit over RCON — waiting for it
 * to exit"), then a recorded `count`, then a `fraction`.
 *
 * Both progress branches are skipped for a redacted record. `redact()` blanks
 * `step.label`, `step.detail` and `step.count` but deliberately leaves `progress` alone,
 * because a redacted synthetic boot needs its percentage — that percentage is the only
 * thing its pip beats on (`beatSignal`'s synthetic branch excludes `heartbeatAt`). So
 * reading a count or a percentage off `progress` here would route around the redaction
 * that `step.count` already gets. The `detail` branch needs no guard: it is already blank.
 */
function collapsedDetail(op: OperationView): string | undefined {
  if (op.redacted) return undefined;
  // A real count outranks the newest log line, matching `operation-tape.tsx:201`. The
  // reverse order made the whole point of wiring `progress` up unreachable from the
  // collapsed strip: `install-modpack` sets a per-mod `detail` on every single mod, so
  // `detail` is never empty during the one operation that HAS a count, and "42 of 166
  // mods" lost every time to a churning jar filename.
  if (op.progress.kind === "count") {
    return `${op.progress.done} of ${op.progress.total} ${op.progress.noun}`;
  }
  const d = liveStep(op)?.detail;
  if (d) return d;
  if (op.progress.kind === "fraction") return `${op.progress.percent}%`;
  return undefined;
}

/**
 * The newest fact that is bad news, or nothing.
 *
 * Newest rather than first: facts accumulate through a hand-off (a `Save` warning for the
 * world going down, then a `Shutdown` warning for the same world), and the latest one is
 * the state of play.
 */
function newestConcern(op: OperationView): OperationFact | undefined {
  for (let i = op.facts.length - 1; i >= 0; i--) {
    const f = op.facts[i];
    if (f.verdict === "warn" || f.verdict === "bad") return f;
  }
  return undefined;
}

/**
 * `lede` with every per-second figure removed, for the live region.
 *
 * `lede`'s stale branch embeds `formatElapsed(now - heartbeatAt)`, which changes once a
 * second — and the region it sat in has no terminal state, so NVDA/VoiceOver read the
 * whole sentence once a second, indefinitely, talking over the user's search for the
 * Dismiss button that is the only escape. The counting figure stays on screen in an
 * `aria-hidden` span; the announcement says the thing that is true and stops.
 */
function announce(op: OperationView, now: number): string {
  if (op.endedAt) return op.summary ?? `${op.title} finished.`;
  if (isLost(op, now)) return `${op.title} — lost contact with this operation. Check the console.`;
  return liveStep(op)?.label ?? op.title;
}

/**
 * The world, then the sentence — unless the sentence already names the world.
 *
 * The name must stay for the live case, where the text is a bare step label ("Copying the
 * world") and, in the live region, this is the only place the world is spoken at all (the
 * visible name is `hidden sm:inline` and every `GameMark` is `aria-hidden`). What it must
 * not do is read "Minecraft — Minecraft — started in 5m 04s…", which is what it did.
 *
 * `includes`, not `startsWith`, for the reason spelled out at `needsName` above: a power
 * step label names its world **mid-sentence** ("Stopping Project Zomboid"), so the
 * original `startsWith` guard never fired on a live record and a screen-reader user heard
 * the duplication verbatim for the whole operation — five minutes, for a PZ stop.
 */
function withName(op: OperationView, text: string): string {
  const name = headline(op);
  return text.includes(name) ? text : `${name} — ${text}`;
}

/** What the live region says. */
function announceLine(op: OperationView, now: number): string {
  return withName(op, announce(op, now));
}

/**
 * The sub-line under an expanded operation. Always about THAT operation.
 *
 * Time-derived parts render only after mount. `Started 15:26:58` is formatted in the
 * viewer's zone (the box is Europe/Berlin) and `2m 26s ago` moves once a second, so both
 * differed between the server pass and hydration — an uncaught React #418 on most loads
 * while anything was live. The `Finished after …` figure is derived from two server
 * epochs and is stable, so it stays.
 */
function chrome(op: OperationView, now: number, elapsed: number, mounted: boolean): string {
  if (op.endedAt) {
    return `Finished after ${formatElapsed(op.endedAt - op.startedAt)}${
      op.startedBy ? ` — started by ${op.startedBy.name}` : ""
    }`;
  }
  const started = new Date(op.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const at = `${p(started.getHours())}:${p(started.getMinutes())}:${p(started.getSeconds())}`;
  const locked = op.holdsPower
    ? "Server controls are locked until this finishes"
    : op.stalled
    ? "The container is up but the game is not answering; Restart is the way out"
    : op.synthetic
    ? "The server is not answering yet"
    : "";
  // Before mount, the clock-dependent half is simply omitted; the note that explains why
  // the buttons are dead is not, because that is the useful half.
  if (!mounted) return locked || "Started";
  const note = locked ? ` — ${lowerFirst(locked)}` : "";
  if (now - op.heartbeatAt > OPERATION_STALE_MS && !op.synthetic) {
    return `Started ${at}, ${formatElapsed(elapsed)} ago — no heartbeat since`;
  }
  return `Started ${at}, ${formatElapsed(elapsed)} ago${note}`;
}

/**
 * `op-warn` / `op-bad`, not `text-chart-5` / `text-destructive`.
 *
 * In Latte `--chart-5` (#df8e1d) on the strip's wash is 2.15:1 at 13px and
 * `--destructive` (#d20f39) is 4.49:1 — both short of AA for the single most important
 * sentence this feature produces. See `globals.css`: `.op-bad` mixes toward
 * `--foreground`, and `.op-warn` needed a dedicated Latte token because no amber mix
 * reaches AA there.
 *
 * The uncoloured cases are `text-foreground`, not `text-muted-foreground`. This *is* the
 * record's headline sentence, and muted measured 3.99:1 on the strip's wash in Latte —
 * so the one line the feature exists to deliver was the one below AA.
 */
function statusToneClass(op: OperationView): string {
  if (!op.endedAt) return "text-foreground";
  switch (op.outcome) {
    case "failed":
      return "op-bad";
    case "partial":
    case "nothing":
      return "op-warn";
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

/**
 * `progress` is deliberately NOT in the real-operation signature, and does not need to be.
 *
 * Every `OpHandle` mutator in `operations.ts` — `step`, `settle`, `reject`, `detail`,
 * `fact` and `progress` — ends with `entry.heartbeatAt = Date.now()`, and `heartbeatAt` is
 * the first field below. So a lone `op.progress({kind:"count", …})` with no other change
 * already moves the pip. Adding `progress` here would be redundant for a real operation.
 *
 * And it must NOT be added to the synthetic branch, which is the one that looks like it is
 * missing it. `syntheticBoots` re-derives each boot on every read with `heartbeatAt: now`,
 * which is exactly why that branch excludes it: including a value that changes on every
 * poll would make the pip beat forever and fake liveness for a container that has stopped
 * answering — the failure this whole component is built to refuse. Synthetic boots only
 * ever carry `fraction` or `indeterminate` progress, never `count`, so there is nothing
 * for a `count` case to do there anyway.
 */
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
