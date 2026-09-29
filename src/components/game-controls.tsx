"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { GAMES, otherGames, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import {
  blockedReason,
  fileOperationLabel,
  liveFileOperations,
  namedFileOperations,
  powerBlocker,
} from "@/lib/operation-ui";
import { liveStep } from "@/lib/operations-types";
import { StatusPill } from "@/components/ui-bits";
import { PowerCore, type CoreState } from "@/components/power-core";
import { PowerGlyph } from "@/components/glyphs";
import { usePrefersReducedMotion } from "@/components/motion";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { RotateCw, Users } from "lucide-react";

export function GameControls({ game }: { game: GameId }) {
  const meta = GAMES[game];
  // Poll faster while an operation is in flight so buttons re-enable promptly.
  const [localBusy, setLocalBusy] = useState(false);
  const { games, busy: serverBusy, can, memoryGb, clockSkewMs, refresh } = useGames(
    localBusy ? 1500 : 4000
  );
  // The registry, not just the power lock: a four-minute backup of this world also
  // has to disable these buttons, and the single-slot lock could never say so.
  const { operations, elapsedMs } = useOperations();
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";
  const reduced = usePrefersReducedMotion();

  const [confirm, setConfirm] = useState(false);
  const [confirmPreempt, setConfirmPreempt] = useState<"stop" | "restart" | null>(null);

  const blocker = powerBlocker(operations, game);
  /**
   * A file operation on this world (a backup, a modpack apply). It does NOT disable
   * the power buttons — on this box a wedged server is a documented real event and
   * Power off / Restart is the recovery path, so a four-minute backup must never hold
   * recovery hostage. The consequence is stated in a confirm dialog instead; the
   * dialog is what "force" looks like here.
   */
  const preemptable = blocker && !blocker.holdsPower ? blocker : undefined;
  /**
   * Everything a power action here would cut short — on every world, not just this one.
   *
   * A power operation declares every `files:` lane, so it pre-empts all of them. Keyed on
   * this world's lane, pressing Power off while ANOTHER world's backup ran skipped the
   * confirm entirely and destroyed that backup with nothing said. `preemptable` stays
   * per-world for the disabled-control reason text, which is a claim about this world.
   */
  const cutShort = liveFileOperations(operations);
  /**
   * Whatever holds the box's power slot, from the REGISTRY — not from the projected
   * `busy`.
   *
   * `projectLock()` returns null for an operation with no `action`, deliberately
   * (`busyLabel()` renders a verb straight out of `action`, so projecting one would put
   * a lie in the verb). But `/api/7dtd/update` holds `POWER_RESOURCES` with no action,
   * so `busy` stayed null for the whole ~20-minute update while the ledger said "server
   * controls are locked until this finishes" — and Power off, Restart, the memory card
   * and the version save all stayed live and returned 409 with a red toast. That is the
   * "pressed the button, got an unexplained refusal" shape the `can:{}` flags were
   * shipped to remove, reintroduced for the longest operation on the box.
   */
  const powerHeld = blocker?.holdsPower ? blocker : undefined;
  // Busy if THIS tab fired a request, or a *power* operation is in flight anywhere
  // (another admin, another tab, the Workshop watcher). Either way, controls lock.
  const busy = localBusy || serverBusy !== null || powerHeld !== undefined;
  const busyAction = serverBusy?.action;

  /**
   * Busy *about this world*, as opposed to busy at all.
   *
   * The distinction matters because the two drive different things. Every power
   * control locks on any power operation anywhere — one world at a time, so someone
   * else's start is our business. But the **status panel** describes one container,
   * and it must not borrow another world's activity: with only the global flag, a
   * Minecraft hand-off made the Project Zomboid page report "Working…", show the
   * `starting` pill and animate a blue Power Core, directly under a sentence that
   * correctly said *Minecraft* was starting. Project Zomboid was stopped the whole
   * time.
   *
   * Pre-dates the operations registry (the same expression is in 08abbc8) — the
   * registry only made it legible, by naming the other world in the reason text and
   * so putting the contradiction on screen in one glance.
   */
  /**
   * The live step of the blocking power operation, when that step is about THIS world.
   *
   * A hand-off is one operation whose `game` is the world coming **up**, and its steps are
   * tagged per world — so the world being saved and shut down appears only in the steps.
   * Keying ownership on `op.game` alone therefore left the outgoing world's own page
   * claiming nothing was happening to it: measured on production 2m 35s into Project
   * Zomboid's save+stop, `/zomboid/server` read "Running / Online / 0h 14m" with its uptime
   * still counting up, and the only mention of its shutdown was inside a sentence about
   * Minecraft. That is a five-minute window on every hand-off, and it is the mirror image
   * of the bug 8760454 fixed.
   */
  const ownStep = powerHeld && liveStep(powerHeld)?.game === game ? liveStep(powerHeld) : undefined;
  const ownBusy =
    localBusy || serverBusy?.game === game || powerHeld?.game === game || ownStep !== undefined;
  /**
   * What is being done to THIS world, which is not always the operation's own action.
   *
   * On a hand-off away from us the operation's action is `start` (of the other world) while
   * what is happening here is a stop — so the pill must not say "Booting" and the Power
   * Core must not animate as though we were coming up.
   */
  const ownAction: "start" | "stop" | "restart" | undefined =
    powerHeld?.game === game ? powerHeld.action : ownStep ? "stop" : serverBusy?.action;
  const ownStopping = ownAction === "stop";

  // Only one world can hold the box at a time, but check every other one
  // rather than assume which — a stale container would otherwise be missed.
  const blocking = otherGames(game).filter((g) => {
    const s = games?.[g]?.status;
    return s === "online" || s === "starting";
  });
  const blockingNames = blocking.map((g) => GAMES[g].name).join(" and ");
  const blockingVerb = blocking.length > 1 ? "are" : "is";
  const blockingThem = blocking.length > 1 ? "them" : "it";

  const coreState: CoreState =
    ownBusy && !isOnline
      ? // "booting" energises the core, which is a claim about coming up. A world being
        // shut down gets the working-but-not-held state instead.
        ownStopping
        ? { kind: "working", game }
        : { kind: "booting", game }
      : isOnline
      ? { kind: "holding", game }
      : { kind: "idle" };

  /**
   * The container is up but the game is not answering.
   *
   * This is its own state, not "stopped". Treating it as stopped is what left a
   * wedged server unrecoverable from the dashboard: the UI offered **Power on**,
   * which runs `docker start` on an already-running container — a silent no-op —
   * while Restart was disabled because Restart required `isOnline`. Both the useful
   * action and the honest label were missing at once.
   */
  const containerUp = snap?.containerRunning ?? isOnline;
  const unreachable = containerUp && !isOnline;
  // A normal boot also sits here, so only call it stuck once it has taken clearly
  // longer than a boot ever does. Below that, it is just starting.
  // Skew-corrected: `startedAtMs` is the box's clock (docker's `StartedAt`), so a laptop
  // a few minutes fast declared a healthy 30-second boot "Not responding", and one a few
  // minutes slow would never say it at all.
  const startedFor = snap?.startedAtMs ? Date.now() + clockSkewMs - snap.startedAtMs : 0;
  const looksStuck = unreachable && startedFor > 12 * 60 * 1000;

  // Power on cannot help when the container is already up, so offer stop instead —
  // and Restart, below, becomes the recommended way out.
  const canPower = containerUp ? can.stop : can.start;

  // Only *this* world's work should caption this card — but a hand-off's save-and-stop of
  // this world IS this world's work, and it lives in the step rather than in `busy.stage`.
  const busyStage =
    ownStep?.label ?? (serverBusy?.game === game ? serverBusy.stage : undefined);

  // Drop the pending intent once the thing it was about is gone, so a later file
  // operation on this world cannot re-open a dialog nobody asked for.
  useEffect(() => {
    if (cutShort.length === 0 && confirmPreempt !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirmPreempt(null);
    }
  }, [cutShort.length, confirmPreempt]);

  function onPower() {
    if (busy) return;
    // `containerUp`, not `isOnline`: a wedged server is still running, so the only
    // meaningful power action is to stop it.
    if (containerUp) {
      if (cutShort.length > 0) return setConfirmPreempt("stop");
      return void control("stop");
    }
    if (blocking.length > 0 || cutShort.length > 0) setConfirm(true);
    else void control("start");
  }

  function onRestart() {
    if (busy) return;
    if (cutShort.length > 0) return setConfirmPreempt("restart");
    void control("restart");
  }

  async function control(action: "start" | "stop" | "restart") {
    if (localBusy) return;
    setLocalBusy(true);
    setConfirm(false);
    setConfirmPreempt(null);
    try {
      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) return void toast.error(data.error || "A server operation is already in progress");
      if (!res.ok) return void toast.error(data.error || "Command failed");
      // No success toast: the operation's own completion toast carries the server's
      // summary, and it cannot say more than was actually observed. A "saved &
      // stopped" here would fire before the 300s Project Zomboid stop had finished.
      setTimeout(refresh, reduced ? 0 : 1500);
    } catch {
      // The request died; the operation did not. `/api/games/control` awaits the
      // whole thing, and a Project Zomboid stop is a fixed 300s ending in SIGKILL —
      // well past Cloudflare's ~100s origin read timeout. So EVERY successful PZ stop
      // and restart used to report a red "Network error" from all three power UIs,
      // which is the most-hit lie in the app. The strip at the top of the page is the
      // source of truth, and it survives this.
      toast.info(
        `Still working on ${meta.name}. The connection timed out before it finished, which is ` +
          `normal for a long stop — watch the strip at the top of the page.`
      );
    } finally {
      setLocalBusy(false);
    }
  }

  const players = snap?.players;

  return (
    <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]" style={{ ["--tint" as string]: meta.tint }}>
      {/* Status panel */}
      <div
        className="relative overflow-hidden rounded-2xl bg-card/70 p-6 ring-1 backdrop-blur"
        style={{
          boxShadow: isOnline ? `inset 0 0 0 1px color-mix(in oklab, ${meta.tint} 40%, transparent)` : undefined,
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow text-muted-foreground">Status</p>
            <p className="mt-1 font-display text-2xl font-bold">
              {/* `ownBusy`, not `busy`: this line states what THIS container is
                  doing. Another world's operation locks our buttons but does not
                  change our state. */}
              {isOnline
                ? "Running"
                : ownBusy
                ? "Working…"
                : looksStuck
                ? "Not responding"
                : unreachable
                ? "Starting…"
                : "Stopped"}
            </p>
          </div>
          <StatusPill
            status={ownBusy && !isOnline ? (ownStopping ? "stopping" : "starting") : status}
            tint={meta.tint}
          />
        </div>

        <div className="my-4 flex justify-center">
          <PowerCore state={coreState} size={120} />
        </div>

        {/* What's actually happening, as words and a clock-time — never as a bar.
            The sweep that used to live here (`width: ["15%","85%","15%"]`) animated
            identically whether the server was alive, wedged or gone, which in a
            codebase whose recurring defect is "reports success after doing nothing"
            is that same defect at the animation layer. The full step history lives in
            the strip at the top of the page; this is the one-line version. */}
        {(busyStage || snap?.boot) && (
          <div className="mb-4 rounded-lg bg-background/50 px-3 py-2 ring-1 ring-foreground/10">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">
                {busyStage ?? snap?.boot?.stage}
              </span>
              {!busyStage && snap?.boot?.percent != null && (
                <span className="font-mono tabular-nums" style={{ color: meta.tint }}>
                  {snap.boot.percent}%
                </span>
              )}
            </div>
            {!busyStage && snap?.boot?.detail && (
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                {snap.boot.detail}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-center">
          <Cell label="Players" value={isOnline && players ? `${players.online}/${players.max}` : "—"} tint={meta.tint} />
          <Cell label={meta.detailLabel} value={isOnline ? snap?.detail ?? snap?.uptime ?? "live" : "—"} tint={meta.tint} />
          {/* The configured heap, not a hardcoded guess — it changes when someone
              edits it on the Settings page or the box is resized. */}
          <Cell
            label="RAM"
            value={memoryGb[game] != null ? `${memoryGb[game]}G` : "—"}
            tint={meta.tint}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-3 rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Controls</p>
        <button
          onClick={onPower}
          disabled={busy || !canPower}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-xl font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            background: isOnline ? "transparent" : meta.tint,
            color: isOnline ? meta.tint : "var(--background)",
            boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 10px 30px -10px ${meta.tint}`,
          }}
        >
          <PowerGlyph className="h-5 w-5" />
          {/* Only narrate a verb for an operation on THIS world. A Minecraft
              hand-off used to relabel Project Zomboid's button "Starting…". The
              button is still disabled either way; the reason line below says why. */}
          {ownBusy ? busyLabel(busyAction) : containerUp ? "Power off" : "Power on"}
        </button>
        <Button variant="outline" className="h-11 disabled:cursor-not-allowed" disabled={busy || !containerUp || !can.restart} onClick={onRestart}>
          {/* Not a spinner. `animate-spin` on a 1s CSS loop says "something is
              happening" whether or not anything is, which is the claim we refuse to
              make anywhere in this feature. */}
          <RotateCw className="h-4 w-4" />
          {ownBusy && busyAction === "restart" ? "Restarting…" : "Restart"}
        </Button>

        <div className="mt-1 rounded-lg bg-background/50 p-3 text-xs text-muted-foreground ring-1 ring-foreground/10">
          {powerHeld ? (
            // One helper for every "why is this dead" sentence in the app, so this and
            // `/{game}/backups` and the 7DTD maintenance card cannot drift. It also
            // covers the action-less power holder (the 7DTD update), which the old
            // inline `serverBusy` branch structurally could not see — and it no longer
            // lowercases the stage, which now embeds world names ("saving project
            // zomboid").
            <span>{blockedReason(powerHeld, elapsedMs(powerHeld))}</span>
          ) : preemptable ? (
            <span>
              <strong className="text-foreground">{meta.name}</strong> is being worked on —{" "}
              {fileOperationLabel(preemptable, elapsedMs(preemptable))}. Powering off or restarting
              now cuts it short; you&apos;ll be asked to confirm.
            </span>
          ) : looksStuck ? (
            <span>
              The container is up but the game has not answered for{" "}
              {Math.round(startedFor / 60000)} minutes. It is most likely wedged —{" "}
              <strong className="text-foreground">Restart</strong> is the way out. Powering off and
              on again does the same thing more slowly.
            </span>
          ) : unreachable ? (
            <span>
              Running but still loading, so it can&apos;t answer yet. Watch the bar at the top of the
              page for progress; <strong className="text-foreground">Restart</strong> is available if
              it stops moving.
            </span>
          ) : !canPower && !can.restart ? (
            "You can view this server but not power it. Ask an admin for Mod access."
          ) : blocking.length > 0 ? (
            <span>
              <strong className="text-foreground">{blockingNames}</strong> {blockingVerb} running.
              Starting this one stops {blockingThem} first.
            </span>
          ) : isOnline ? (
            "Stopping saves the world first."
          ) : (
            "Only one server runs at a time."
          )}
        </div>
      </div>

      {/* Online players */}
      <AnimatePresence>
        {isOnline && players && players.players.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:col-span-2 overflow-hidden"
          >
            <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
              <p className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
                <Users className="h-4 w-4" style={{ color: meta.tint }} /> Online now
              </p>
              <div className="flex flex-wrap gap-2">
                {players.players.map((p) => (
                  <motion.span
                    key={p}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="rounded-full px-3 py-1 text-sm font-medium"
                    style={{ background: `color-mix(in oklab, ${meta.tint} 14%, transparent)`, color: meta.tint }}
                  >
                    {p}
                  </motion.span>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PowerGlyph className="h-4 w-4" style={{ color: meta.tint }} /> Switch servers?
            </DialogTitle>
            <DialogDescription>
              {blocking.length > 0 && (
                <>
                  This saves and stops <strong>{blockingNames}</strong>, then starts{" "}
                  <strong>{meta.name}</strong>. Players on {blockingNames} will be disconnected.
                </>
              )}
              {/* Every live file operation, on every world: a power operation pre-empts
                  all of them, and naming only this world's made the dialog's promise true
                  same-world and false everywhere else. */}
              {cutShort.length > 0 && (
                <>
                  {blocking.length > 0 ? " " : ""}
                  Work is in progress and starting now cuts it short:{" "}
                  <strong>{namedFileOperations(cutShort, elapsedMs)}</strong>.
                  Any backup among them is deleted rather than kept as a restore point.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={() => control("start")} style={{ background: meta.tint, color: "var(--background)" }}>
              {blocking.length > 0 ? "Switch & start" : "Start anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-empting a file operation. The dialog IS the force flag: there is no
          `{force:true}` in the request body, because the only honest gate on a
          destructive interruption is a sentence naming the consequence. */}
      {/* `open` is derived from the CONTENT, not from the intent. Gating it on
          `confirmPreempt` alone meant that when the backup finished three seconds after
          the dialog opened, `preemptable` went undefined and the modal stayed open
          containing only its X button — no title, so no accessible name, and the
          decision the user was mid-way through making had silently vanished. */}
      <Dialog
        open={confirmPreempt !== null && cutShort.length > 0}
        onOpenChange={(o) => !o && setConfirmPreempt(null)}
      >
        <DialogContent>
          {cutShort.length > 0 && confirmPreempt && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PowerGlyph className="h-4 w-4" style={{ color: meta.tint }} />
                  {confirmPreempt === "stop" ? "Power off anyway?" : "Restart anyway?"}
                </DialogTitle>
                <DialogDescription>
                  Going ahead cuts this short:{" "}
                  <strong>
                    {namedFileOperations(cutShort, elapsedMs)}
                  </strong>
                  . If it is a backup, the archive is deleted rather than kept as a restore
                  point; if it is a mod install, some mods will be missing.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmPreempt(null)}>
                  Wait for it
                </Button>
                <Button variant="destructive" onClick={() => control(confirmPreempt)}>
                  {confirmPreempt === "stop" ? "Power off anyway" : "Restart anyway"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function busyLabel(action?: "start" | "stop" | "restart"): string {
  switch (action) {
    case "restart":
      return "Restarting…";
    case "stop":
      return "Stopping…";
    case "start":
      return "Starting…";
    default:
      return "Working…";
  }
}

function Cell({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className="rounded-lg bg-background/50 py-2 ring-1 ring-foreground/10">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold" style={{ color: tint }}>
        {value}
      </div>
    </div>
  );
}
