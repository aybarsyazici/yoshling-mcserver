"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { readOperationResponse, unconfirmedOperationMessage } from "@/lib/operation-client";
import { StatusFreshness } from "@/components/status-freshness";
import { JoinPanel } from "@/components/join-panel";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES, GAME_LIST, otherGames, type GameId, type GameMeta } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { coResidency } from "@/lib/coresidency";
import { useOperations } from "@/components/operations-provider";
import {
  blockedReason,
  liveFileOperations,
  namedFileOperations,
  powerState,
  slowestStopSeconds,
  spellMinutes,
  spellSeconds,
  type PowerSurface,
} from "@/lib/operation-ui";
import { formatElapsed, liveStep } from "@/lib/operations-types";
import { PowerCore, type CoreState } from "@/components/power-core";
import { RamBudget } from "@/components/ram-budget";
import { StatusPill } from "@/components/ui-bits";
import { AnimatedNumber, usePrefersReducedMotion } from "@/components/motion";
import { GameMark, PowerGlyph, ArrowGlyph, GearGlyph } from "@/components/glyphs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// How the world cards sit, and when the power bus above them is accurate: the
// bus only shows while the cards are on one row, so its branches line up with
// the columns underneath.
const LAYOUT: Record<number, { grid: string; bus: string }> = {
  1: { grid: "mx-auto max-w-sm", bus: "hidden" },
  2: { grid: "mx-auto max-w-3xl sm:grid-cols-2", bus: "hidden sm:block" },
  3: { grid: "sm:grid-cols-2 lg:grid-cols-3", bus: "hidden lg:block" },
};

export function MissionControl({
  userName,
  access,
}: {
  userName?: string | null;
  /** Worlds this user may open, from the session (so there's no empty flash). */
  access: GameId[];
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const {
    games,
    activeGame,
    running,
    busy: serverBusy,
    can,
    memoryGb,
    hostGb,
    maxGb,
    clockSkewMs,
    loading,
    lastSuccessAt, pollError,
    refresh,
  } = useGames(localBusy ? 1500 : 5000);
  /**
   * Two worlds up at once — the state this box cannot support and, until now, the state
   * nothing in the app reported.
   *
   * It is read here rather than only in `RamBudget` because RAM is the *consequence*, not
   * the fact. The landing page is where someone looks to find out which world holds the
   * box, so it is where "actually, two do" has to appear — above the cards, not buried in
   * a bar at the bottom.
   */
  const co = coResidency(running);
  /**
   * The live operation, read from the registry rather than kept here.
   *
   * This used to be local `phase` React state driven by `sleep()` calls — so the
   * caption was a *guess* at what the server was doing, and a page reload wiped it
   * and fell back to "all stopped". The landing page, with the Power Core on it, was
   * the one screen in the app with no refresh-surviving progress at all.
   */
  const { operations, elapsedMs, refresh: refreshOperations } = useOperations();
  const worlds = GAME_LIST.filter((g) => access.includes(g.id));
  const layout = LAYOUT[worlds.length] ?? LAYOUT[3];

  const [pending, setPending] = useState<GameId | null>(null); // game being powered on/awaiting confirm
  const [confirmFor, setConfirmFor] = useState<GameId | null>(null);
  const [profilePicker, setProfilePicker] = useState(false);
  const [confirmPreempt, setConfirmPreempt] = useState<GameId | null>(null);

  // The operation to caption the core with: whatever holds the power slot, else the
  // world that is booting.
  const headline =
    operations.find((o) => o.holdsPower) ?? operations.find((o) => o.synthetic);

  /**
   * Whatever holds the power slot, from the registry.
   *
   * `serverBusy` alone could not see it: `projectLock()` refuses to project an operation
   * with no `action` (correctly — `busy.action` drives a rendered verb), and the 7 Days
   * to Die update holds `POWER_RESOURCES` without one. So for ~20 minutes every card's
   * Power button stayed live and returned a red 409.
   */
  const powerHolder = operations.find((o) => o.holdsPower && !o.endedAt);
  // Locked out if this tab is working OR a power operation is in flight anywhere.
  const busy = localBusy || serverBusy !== null || powerHolder !== undefined;

  /**
   * What the pre-empt dialog is about, computed here so `open` can be derived from the
   * CONTENT. Gating `open` on the intent alone left the modal open with no title (and
   * therefore no accessible name) and no buttons when the file operation finished
   * mid-decision.
   */
  // The dialog's content, and therefore whether it may be open at all: any live file
  // operation, because a power action cuts every one of them short.
  const preemptBlocker = confirmPreempt ? liveFileOperations(operations)[0] : undefined;
  useEffect(() => {
    if (!preemptBlocker && confirmPreempt !== null) {
      // Reacting to the poll, which is external state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirmPreempt(null);
    }
  }, [preemptBlocker, confirmPreempt]);

  /**
   * The core's state, from three sources in falling order of specificity.
   *
   * The third case is the one that was missing. `pending` is this tab's own intent and
   * `serverBusy` is the *projected* lock — and `projectLock()` deliberately refuses to
   * project an operation with no `action`, because `busy.action` drives a rendered verb.
   * `/api/7dtd/update` holds `POWER_RESOURCES` with no action, so for the ~20 minutes of
   * an update both were null and the core fell through to `activeGame`/idle: it sat
   * "idle" directly underneath its own caption narrating the update. Reading
   * `powerHolder` — the registry, which has no such restriction — closes it.
   */
  const coreState: CoreState = busy && pending
    ? { kind: "handoff", from: activeGame && activeGame !== pending ? activeGame : null, to: pending }
    : busy && serverBusy
    ? { kind: "handoff", from: null, to: serverBusy.game }
    : busy && powerHolder?.game
    ? {
        kind: "handoff",
        from: activeGame && activeGame !== powerHolder.game ? activeGame : null,
        to: powerHolder.game,
      }
    : activeGame
    ? { kind: "holding", game: activeGame }
    : { kind: "idle" };

  /**
   * Each card's power state, from the same derivation `/{game}` and `/{game}/server`
   * use. The cards had their own, and it was missing two things:
   *
   *  - no `can` check at all, so a MEMBER's three Power buttons looked live and each
   *    returned an unexplained 403 — the exact shape `can:{}` was shipped to remove.
   *  - `isBusyThis` keyed on `pending`, which is this tab's own intent and is cleared in
   *    `doControl`'s `finally`. For Project Zomboid that fires at the ~100s origin
   *    timeout while the operation runs five minutes, so from ~100s on — and after any
   *    reload — /home showed three dead buttons wearing normal labels. The registry
   *    survives both, which is why `powerState` reads it instead.
   */
  function surfaceFor(game: GameId): PowerSurface {
    return powerState({
      game,
      games,
      can,
      localBusy: localBusy && pending === game,
      tabBusy: localBusy,
      serverBusy,
      powerHeld: powerHolder,
      elapsedMs,
      clockSkewMs,
    });
  }

  /**
   * Why every card's buttons are dead, said ONCE, under the grid rather than per card.
   *
   * Per card would be more precise and is the wrong shape here: the cards are
   * `items-stretch`, so a sentence that appears on one of three unbalances the row. And
   * the dominant reason on this page is global anyway — one world at a time means one
   * power operation blocks all three cards for the same reason.
   */
  const landingReason = powerHolder
    ? blockedReason(powerHolder, elapsedMs(powerHolder))
    : !can.start && !can.stop && !can.restart
    ? "You can view these servers but not power them. Ask an admin for Mod access."
    : null;

  /**
   * The other worlds currently holding (or claiming) the box.
   *
   * Must stay identical to `powerState`'s `blocking` — this is the predicate that decides
   * whether the "Switch servers?" dialog appears at all, and that one decides what it
   * says, so a divergence produces a dialog that names nothing or no dialog at all. Both
   * key on `containerRunning`, because a world that is up but not answering RCON reports
   * `status: "offline"` and `powerOn` will still stop it.
   */
  function runningOthers(game: GameId): GameId[] {
    return otherGames(game).filter((g) => {
      const snap = games?.[g];
      if (snap?.containerRunning !== undefined) return snap.containerRunning;
      const s = snap?.status;
      return s === "online" || s === "starting";
    });
  }

  // `containerUp`, not `isOnline` — the parameter was called `isOnline` while the caller
  // has always passed `containerRunning`, which is the sort of name that eventually gets
  // believed and then `isOnline` gets passed for real. Naming it for what it is.
  function onPowerClick(game: GameId, containerUp: boolean) {
    if (busy) return;
    // A file operation (a backup, a modpack apply) does not disable the button — Power
    // off is the recovery path and must never be held hostage — but cutting it short
    // needs saying out loud first.
    //
    // ANY live file operation, on any world: a power operation declares every `files:`
    // lane, so it pre-empts all of them. Keyed on this world's lane, starting a world
    // while another world's backup ran skipped the dialog entirely and deleted that
    // backup with nothing said at all.
    const preempting = liveFileOperations(operations).length > 0;
    if (containerUp) {
      // Power OFF: the pre-empt dialog alone is the whole story.
      if (preempting) return setConfirmPreempt(game);
      void doControl(game, "stop");
      return;
    }
    /**
     * Power ON always routes to the ONE `confirmFor` dialog, which renders both clauses.
     *
     * The pre-empt check used to `return` here, ahead of the hand-off confirm — so with
     * Project Zomboid online and players on it, starting Minecraft while a Minecraft
     * backup ran showed a dialog about the backup and never the "Switch servers? …
     * Players on Project Zomboid will be disconnected." one, then evicted PZ anyway.
     * `game-controls.tsx:99` already had this right (`if (blocking.length > 0 ||
     * preemptable) setConfirm(true)`); the landing page — the one with the world cards
     * on it — did not.
     */
    if (game === "minecraft") return setProfilePicker(true);
    if (runningOthers(game).length > 0 || preempting) {
      setConfirmFor(game);
    } else {
      void doControl(game, "start");
    }
  }

  async function doControl(game: GameId, action: "start" | "stop") {
    if (localBusy) return;
    setLocalBusy(true);
    setConfirmFor(null);
    setConfirmPreempt(null);
    if (action === "start") setPending(game);

    try {
      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, action }),
      });
      const data = await readOperationResponse(res);

      if (!data.operationId && res.status === 409) {
        toast.error(data.error || "A server operation is already in progress");
        return;
      }
      if (!data.operationId && !res.ok) {
        toast.error(data.error || "Command failed");
        return;
      }
      // No success toast. The strip above says what is happening while it happens,
      // and the completion toast carries the server's own summary — which is the only
      // text that cannot claim more than was observed. "Saved and stopped" here fired
      // before a 300s Project Zomboid stop had even reached the kill.
      await refresh();
    } catch (error) {
      toast.info(unconfirmedOperationMessage("power operation", error));
    } finally {
      void refreshOperations();
      setLocalBusy(false);
      setPending(null);
    }
  }

  if (worlds.length === 0) return <NoWorlds userName={userName} />;

  return (
    <div className="relative">
      <StatusFreshness lastSuccessAt={lastSuccessAt} pollError={pollError} />
      {/* Intro */}
      <div className="mb-8 text-center">
        <motion.div
          className="eyebrow mb-3 inline-flex items-center gap-2 text-muted-foreground"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Yoshling game server control
        </motion.div>
        <motion.h1
          className="font-display text-4xl font-bold tracking-tight sm:text-5xl"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05 }}
        >
          {worlds.length > 1 ? "Choose your world" : worlds[0].name}
        </motion.h1>
        <motion.p
          className="mx-auto mt-2 max-w-md text-sm text-muted-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.15 }}
        >
          {userName ? `Welcome back, ${userName}. ` : ""}
          {worlds.length > 1
            ? "Only one server runs at a time. Starting one stops the others."
            : "The box runs one server at a time, so starting this one stops anything else that's running."}
        </motion.p>
      </div>

      {/* The single power slot, above the worlds that compete for it */}
      <div className="flex flex-col items-center gap-4">
        <PowerCore state={coreState} size={148} />
        {/* The caption now reports the registry's live step and elapsed time instead
            of a `sleep()`-driven guess, and there is no indeterminate sweep under it:
            the bar moved the same way whether the server was alive or gone. The full
            step history is in the strip at the top of this page. */}
        <AnimatePresence mode="wait">
          {headline ? (
            <motion.div
              key={headline.id}
              className="text-center"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
            >
              <p className="font-mono text-xs text-foreground">
                {liveStep(headline)?.label ?? headline.title}
              </p>
              <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground" aria-hidden>
                {formatElapsed(elapsedMs(headline))}
              </p>
            </motion.div>
          ) : (
            <motion.p
              key="idle-caption"
              className="text-center font-mono text-[11px] leading-relaxed text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {/* Every running world, not just the first. `activeGame` is a singular, so
                  this caption named one world while two were up — and the power bus below
                  can only light one branch, which made the idle caption the only place the
                  truth could have appeared. */}
              {co.running.length === 0
                ? "all stopped"
                : `${co.running.map((g) => GAMES[g].short).join(" + ")} running`}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Two worlds at once, said plainly and above the fold.
          This is the oldest open item in the project: it happened on 2026-09-26 (PZ
          started on top of a 7DTD that had been up two days; 2.2 GB into swap when found)
          and it was found by accident, because nothing anywhere reported it. The cause was a hand-run `docker start`, which no amount of
          app-side refusal can prevent — so saying so is the part that has to work. */}
      {/* No `role="status"`. `OperationLedger` records, at length, that a live region
          created at the same moment as its content is the documented unreliable case for
          `aria-live` — which is exactly what a `{cond && <p role="status">}` is. Claiming an
          announcement that will not happen is the same class of lie as the rest of this
          file's history; the ledger's one unconditional region is the honest mechanism, and
          this is a persistent state notice rather than an event.

          Contrast, because `globals.css` records that a Latte amber's contrast is a
          measurement and not a derivation: `--op-warn` text on this 10%-alpha wash
          computes to **5.50:1 on `--background` and 5.13:1 on `--card` in Latte, 9.62 and
          10.43 in Mocha** — all clear of AA's 4.5. That is computed (sRGB compositing of a
          0.1-alpha overlay, then WCAG relative luminance), not pixel-sampled on the box
          the way the strip's 5.47 was, so treat it as one digit less certain. */}
      {co.message && (
        <p
          className="op-warn mx-auto mt-4 max-w-xl rounded-xl px-4 py-2.5 text-center text-xs ring-1"
          style={{
            background: "color-mix(in oklab, var(--op-warn) 10%, transparent)",
            ["--tw-ring-color" as string]: "color-mix(in oklab, var(--op-warn) 35%, transparent)",
          }}
        >
          {co.message}
        </p>
      )}

      {/* Which world the slot is currently wired to.
          `live` stays singular on purpose: the bus is a picture of ONE trunk feeding one
          branch, and lighting two would draw a box that can do something it cannot. The
          sentence above is what covers the case the diagram cannot. */}
      <div className="h-14 w-full">
        <PowerBus worlds={worlds} live={activeGame} linesClassName={layout.bus} />
      </div>

      {/* One card per world */}
      <div className={cn("grid items-stretch gap-4", layout.grid)}>
        {worlds.map((g, i) => (
          <WorldCard
            key={g.id}
            game={g.id}
            snapshot={games?.[g.id]}
            loading={loading}
            lastSuccessAt={lastSuccessAt}
            pollError={pollError}
            power={surfaceFor(g.id)}
            onPower={onPowerClick}
            onSwitchProfile={g.id === "minecraft" ? () => setProfilePicker(true) : undefined}
            delay={0.1 + i * 0.08}
          />
        ))}
      </div>

      {/* The sentence the cards used to be missing entirely. Height is not reserved
          because it sits under the grid, not inside a card. */}
      {landingReason && (
        <p className="mx-auto mt-3 max-w-2xl text-center text-xs text-muted-foreground">
          {landingReason}
        </p>
      )}

      <MinecraftProfilePicker open={profilePicker} onOpenChange={setProfilePicker} onSubmitted={() => { void refresh(); }} />
      {/* RAM budget bar */}
      <motion.div
        className="mx-auto mt-8 max-w-2xl rounded-2xl bg-card/60 p-5 ring-1 ring-foreground/10 backdrop-blur"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.35 }}
      >
        {/* `running`, not `activeGame`: the bar's whole job is the box's memory limit, and
            a singular could not show the limit being exceeded. */}
        <RamBudget running={running} hostGb={hostGb} maxGb={maxGb} memoryGb={memoryGb} />
      </motion.div>

      {/* Hand-off confirm */}
      <Dialog open={confirmFor !== null} onOpenChange={(o) => !o && setConfirmFor(null)}>
        <DialogContent>
          {confirmFor &&
            (() => {
              const others = runningOthers(confirmFor);
              // Every live file operation, not just this world's: starting a world
              // pre-empts all of them, so a dialog that names one is a promise about the
              // others it quietly breaks.
              const cutShort = liveFileOperations(operations);
              /**
               * How long this actually takes, from `GameMeta.stopSeconds`.
               *
               * This sentence used to end "Takes about a minute." for every hand-off, on
               * a box where Project Zomboid's stop was a measured 5m 03s. The owner
               * clicked the button, read "about a minute", and watched it sit for five.
               *
               * Both of this sentence's previous versions were wrong, in opposite
               * directions, and the second is the instructive one. "About a minute" for
               * every world understated PZ by 5x. The fix then asserted PZ "does not shut
               * down when asked, so this waits out its five minute timeout" — written in
               * the same session that made PZ exit in 9s over RCON, so it overstated by
               * ~30x and, worse, stated a *mechanism* that had just been removed. A
               * duration is a measurement; a mechanism is a claim. Do not put either here
               * without checking the driver still works that way.
               */
              const slowest = others.filter((g) => GAMES[g].stopSeconds >= 120);
              const stopSecs = slowestStopSeconds(others);
              return (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PowerGlyph className="h-4 w-4" style={{ color: GAMES[confirmFor].tint }} />
                  {others.length > 0 ? "Switch servers?" : "Start anyway?"}
                </DialogTitle>
                {/* BOTH consequences, in one dialog. Whichever applies. */}
                <DialogDescription>
                  {others.length > 0 && (
                    <>
                      This will{" "}
                      <strong>save and stop {others.map((g) => GAMES[g].name).join(" and ")}</strong>,
                      then start <strong>{GAMES[confirmFor].name}</strong>. Anyone currently playing
                      will be disconnected.
                      {slowest.length === 0 ? (
                        <>
                          {" "}
                          The stop takes about {spellSeconds(stopSecs)}; {GAMES[confirmFor].name}{" "}
                          then needs a few minutes to load before anyone can join.
                        </>
                      ) : (
                        <>
                          {" "}
                          Stopping {slowest.map((g) => GAMES[g].name).join(" and ")} can take up to{" "}
                          {spellMinutes(stopSecs)} if {slowest.length > 1 ? "they do" : "it does"} not
                          exit when asked.
                        </>
                      )}
                    </>
                  )}
                  {cutShort.length > 0 && (
                    <>
                      {others.length > 0 ? " " : ""}
                      Work is in progress and starting now cuts{" "}
                      {cutShort.length > 1 ? "all of it" : "it"} short:{" "}
                      <strong>{namedFileOperations(cutShort, elapsedMs)}</strong>. Any backup among
                      them is deleted rather than kept as a restore point.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              {/* The switch diagram only makes sense when something is actually being
                  switched away from. */}
              {others.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-xs">
                  {others.map((g) => (
                    <span key={g} className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-mono">
                      <GameMark game={g} className="h-3.5 w-3.5" />
                      {GAMES[g].short} off
                    </span>
                  ))}
                  <ArrowGlyph className="h-4 w-4 text-muted-foreground" />
                  <span
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono"
                    style={{
                      background: `color-mix(in oklab, ${GAMES[confirmFor].tint} 15%, transparent)`,
                      color: GAMES[confirmFor].tint,
                    }}
                  >
                    <GameMark game={confirmFor} className="h-3.5 w-3.5" />
                    {GAMES[confirmFor].short} on
                  </span>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmFor(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => doControl(confirmFor, "start")}
                  style={{ background: GAMES[confirmFor].tint, color: "var(--background)" }}
                >
                  {others.length > 0 ? "Switch & start" : "Start anyway"}
                </Button>
              </DialogFooter>
            </>
              );
            })()}
        </DialogContent>
      </Dialog>

      {/* Cutting a file operation short — the POWER OFF path only; the start path goes
          through the dialog above so the hand-off is never dropped on the floor. */}
      <Dialog
        open={confirmPreempt !== null && preemptBlocker !== undefined}
        onOpenChange={(o) => !o && setConfirmPreempt(null)}
      >
        <DialogContent>
          {confirmPreempt &&
            (() => {
              const blocker = preemptBlocker;
              if (!blocker) return null;
              const cutShort = liveFileOperations(operations);
              const online = games?.[confirmPreempt]?.containerRunning ?? false;
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <PowerGlyph
                        className="h-4 w-4"
                        style={{ color: GAMES[confirmPreempt].tint }}
                      />
                      {online ? "Power off anyway?" : "Start anyway?"}
                    </DialogTitle>
                    <DialogDescription>
                      Going ahead cuts {cutShort.length > 1 ? "all of this" : "this"} short:{" "}
                      <strong>
                        {namedFileOperations(
                          cutShort.length > 0 ? cutShort : [blocker],
                          elapsedMs
                        )}
                      </strong>
                      . Any backup among them is deleted rather than kept as a restore point.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmPreempt(null)}>
                      Wait for it
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => doControl(confirmPreempt, online ? "stop" : "start")}
                    >
                      {online ? "Power off anyway" : "Start anyway"}
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Signed in, but not on any world's list yet. */
function NoWorlds({ userName }: { userName?: string | null }) {
  return (
    <motion.div
      className="mx-auto max-w-md text-center"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="flex justify-center">
        <PowerCore state={{ kind: "idle" }} size={120} />
      </div>
      <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">No worlds yet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {userName
          ? `You're signed in as ${userName}, but this account can't see any of the servers yet.`
          : "This account can't see any of the servers yet."}{" "}
        Ask an admin to give you access on the Crew page.
      </p>
    </motion.div>
  );
}

/**
 * The power bus: one trunk out of the core, one branch per world, and only ever
 * one branch carrying current. It makes the box's hard rule — a single world at
 * a time — something you read at a glance instead of something we explain in a
 * paragraph. A world running that this user can't open lights no branch, which
 * is the truth: the slot is taken by something not on this page.
 */
function PowerBus({
  worlds,
  live,
  linesClassName,
}: {
  worlds: GameMeta[];
  live: GameId | null;
  /** Hides the wiring (but never the gap) when the cards aren't on one row. */
  linesClassName?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const liveIndex = worlds.findIndex((g) => g.id === live);
  const tint = live ? GAMES[live].tint : "var(--muted-foreground)";

  // viewBox is stretched to the grid width, so strokes have to opt out of it.
  const x = (i: number) => ((i + 0.5) / worlds.length) * 100;
  const branch = (i: number) => `M50 34 H${x(i)} M${x(i)} 34 V100`;

  return (
    <div className={cn("relative h-14 w-full", linesClassName)} aria-hidden>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
      >
        <g
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          stroke="color-mix(in oklab, var(--foreground) 15%, transparent)"
        >
          <path d="M50 0 V34" vectorEffect="non-scaling-stroke" />
          <path
            d={`M${x(0)} 34 H${x(worlds.length - 1)}`}
            vectorEffect="non-scaling-stroke"
          />
          {worlds.map((g, i) => (
            <path key={g.id} d={`M${x(i)} 34 V100`} vectorEffect="non-scaling-stroke" />
          ))}
        </g>

        {/* the energised branch */}
        {liveIndex >= 0 && (
          <motion.path
            d={`M50 0 V34 ${branch(liveIndex)}`}
            fill="none"
            stroke={tint}
            strokeWidth="2"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ filter: `drop-shadow(0 0 6px color-mix(in oklab, ${tint} 70%, transparent))` }}
            initial={{ opacity: 0 }}
            animate={
              reduced
                ? { opacity: 1 }
                : { opacity: 1, strokeDashoffset: [12, 0] }
            }
            transition={
              reduced
                ? { duration: 0.3 }
                : { strokeDashoffset: { duration: 0.9, repeat: Infinity, ease: "linear" } }
            }
            strokeDasharray={reduced ? undefined : "6 6"}
          />
        )}

      </svg>

      {/* Junction dots as elements, not SVG: the viewBox above is stretched to
          the grid width, which would squash a <circle> into an ellipse. */}
      {worlds.map((g, i) => (
        <span
          key={g.id}
          className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-foreground/15"
          style={{
            left: `${x(i)}%`,
            top: "34%",
            background: i === liveIndex ? tint : "var(--muted)",
            boxShadow:
              i === liveIndex ? `0 0 8px color-mix(in oklab, ${tint} 80%, transparent)` : undefined,
          }}
        />
      ))}
    </div>
  );
}

function WorldCard({
  game,
  snapshot,
  loading,
  lastSuccessAt,
  pollError,
  power,
  onPower,
  onSwitchProfile,
  delay,
}: {
  game: GameId;
  snapshot?: import("@/lib/use-games").GameSnapshot;
  loading: boolean;
  lastSuccessAt?: number | null;
  pollError?: string | null;
  /** Derived in `MissionControl` by the one shared `powerState`. */
  power: PowerSurface;
  onPower: (g: GameId, containerUp: boolean) => void;
  onSwitchProfile?: () => void;
  delay: number;
}) {
  const meta = GAMES[game];
  const status = snapshot?.status ?? "offline";
  const isOnline = status === "online";
  // `ownBusy`, not the old `busy && pending === game`: `pending` is this tab's intent
  // and dies with the request, while the operation can outlive it by minutes.
  const isBusyThis = power.ownBusy;
  const players = snapshot?.players;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -5 }}
      className="group relative"
      style={{ ["--tint" as string]: meta.tint }}
    >
      {/* Glow aura when online */}
      <motion.div
        className="absolute -inset-px rounded-3xl opacity-0 blur-xl transition-opacity duration-500 group-hover:opacity-60"
        style={{ background: `radial-gradient(circle at 50% 0%, ${meta.tint}, transparent 70%)`, opacity: isOnline ? 0.4 : undefined }}
      />
      <div
        className="sheen relative flex h-full flex-col overflow-hidden rounded-3xl bg-card/80 p-6 ring-1 backdrop-blur transition-all"
        style={{
          ["--tint" as string]: meta.tint,
          boxShadow: isOnline ? `0 0 0 1px color-mix(in oklab, ${meta.tint} 45%, transparent), 0 20px 60px -20px color-mix(in oklab, ${meta.tint} 55%, transparent)` : undefined,
        }}
      >
        {/* Themed corner glyph, big and faint */}
        <div className="pointer-events-none absolute -right-6 -top-6 opacity-[0.07] transition-transform duration-500 group-hover:scale-110 group-hover:opacity-[0.12]">
          <GameMark game={game} className="h-40 w-40" />
        </div>

        {/* Mark and status share a top rail; the name gets the card's full width
            below it, so no game's name wraps and all the cards line up. */}
        <div className="relative flex items-start justify-between gap-3">
          <div
            className="grid h-12 w-12 place-items-center rounded-2xl ring-1"
            style={{
              background: `color-mix(in oklab, ${meta.tint} 15%, transparent)`,
              color: meta.tint,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${meta.tint} 25%, transparent)`,
            }}
          >
            <GameMark game={game} className="h-6 w-6" />
          </div>
          {loading ? (
            <div className="skeleton h-6 w-16 rounded-full" />
          ) : (
            <StatusPill
              status={
                isBusyThis && !isOnline
                  ? power.ownStopping
                    ? "stopping"
                    : "starting"
                  : // An unreachable container is amber, not grey. The `status` it carries is
                    // literally `offline`, and this pill printed "Stopped" beside a button
                    // reading "Power off" — the last unfixed half of the `a7d76b8` honest-label
                    // work, and the only one of the three power surfaces that still had it.
                    // `game-controls.tsx` and `game-overview.tsx` both print `power.heading`.
                    power.unreachable
                    ? "starting"
                    : status
              }
              // The words come from the one shared derivation, so "Starting…" and "Not
              // responding" cannot be worded differently here than on the other two surfaces.
              label={!isBusyThis && power.unreachable ? power.heading : undefined}
              tint={meta.tint}
            />
          )}
        </div>

        <div className="relative mt-3">
          <h2 className="font-display text-xl font-bold leading-tight">{meta.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.tagline}</p>
        </div>

        {/* Live metrics */}
        <div className="relative mt-5 grid grid-cols-2 gap-3">
          <Metric
            label="Players"
            value={
              isOnline && players ? (
                <span>
                  <AnimatedNumber value={players.online} />
                  <span className="text-muted-foreground">/{players.max}</span>
                </span>
              ) : (
                "—"
              )
            }
            tint={meta.tint}
          />
          <Metric
            label={meta.detailLabel}
            value={isOnline ? snapshot?.detail ?? snapshot?.uptime ?? "live" : "—"}
            tint={meta.tint}
          />
        </div>

        {/* Actions */}
        <div className="relative mt-6 flex items-center gap-2">
          {/* Disabled on `can` too, not only on `busy`: without it these three buttons
              looked live to a MEMBER and each answered with a bare 403. */}
          <button
            onClick={() => onPower(game, power.containerUp)}
            disabled={power.busy || !power.canPower}
            className="group/pw relative inline-flex h-11 flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: isOnline ? "transparent" : meta.tint,
              color: isOnline ? meta.tint : "var(--background)",
              boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 8px 24px -8px ${meta.tint}`,
            }}
          >
            <PowerGlyph className="h-4 w-4" />
            {power.label}
          </button>
          <Link
            href={meta.base}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <GearGlyph className="h-4 w-4" />
            Manage
          </Link>
        </div>
        {game === "minecraft" && power.containerUp && <Button variant="outline" className="mt-2 min-h-11 w-full" disabled={power.busy || !power.canRestart} onClick={onSwitchProfile}>Switch profile &amp; restart</Button>}
        <div className="mt-4">
          <JoinPanel game={game} snapshot={snapshot} lastSuccessAt={lastSuccessAt} pollError={pollError} busy={isBusyThis} compact />
        </div>
      </div>
    </motion.div>
  );
}

function Metric({ label, value, tint }: { label: string; value: React.ReactNode; tint: string }) {
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2.5 ring-1 ring-foreground/10">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-lg font-semibold" style={{ color: tint }}>
        {value}
      </div>
    </div>
  );
}
