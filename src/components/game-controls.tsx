"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { readOperationResponse, unconfirmedOperationMessage } from "@/lib/operation-client";
import { StatusFreshness } from "@/components/status-freshness";
import { useMinecraftRecoveryReady } from "@/hooks/use-minecraft-recovery-ready";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { toast } from "sonner";
import { GAMES, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { liveFileOperations, namedFileOperations, powerBlocker, powerState } from "@/lib/operation-ui";
import { coResidency } from "@/lib/coresidency";
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
  const { games, running, busy: serverBusy, can, memoryGb, clockSkewMs, lastSuccessAt, pollError, minecraftContext, refresh } = useGames(
    localBusy ? 1500 : 4000
  );
  /**
   * Two worlds up at once. A claim about the BOX, not about this world — which is why it
   * is not folded into `power.reason` (that line is per-world by construction, and
   * conflating "this world is busy" with "the box is in a bad state" is the same mistake
   * as the `busy`/`ownBusy` conflation `docs/OPERATIONS.md` records).
   *
   * It belongs on this page as well as on `/home` because this is where someone who has
   * noticed the server misbehaving ends up, and "why is it swapping" is answerable only if
   * something says two worlds are running.
   */
  const verifiedRecovery = useMinecraftRecoveryReady(minecraftContext, lastSuccessAt, pollError);
  const canRecover = game !== "minecraft" || verifiedRecovery;
  const co = coResidency(running);
  // The registry, not just the power lock: a four-minute backup of this world also
  // has to disable these buttons, and the single-slot lock could never say so.
  const { operations, elapsedMs, refresh: refreshOperations } = useOperations();
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";
  const reduced = usePrefersReducedMotion();

  const [confirm, setConfirm] = useState(false);
  const [profilePicker, setProfilePicker] = useState(false);
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

  /**
   * Everything about this world's power state, derived in ONE place.
   *
   * This logic was born here and is correct here; it was the other two surfaces
   * (`/{game}` and `/home`) that never got the `a7d76b8` reachability fix and offered a
   * `docker start` no-op for a wedged world. `powerState` is the shared derivation, so
   * the three can no longer disagree about one container. See its docstring for the two
   * properties that carry the fix.
   */
  const power = powerState({
    game,
    games,
    can,
    localBusy,
    serverBusy,
    powerHeld,
    preemptable,
    elapsedMs,
    clockSkewMs,
  });
  const { busy, ownBusy, ownAction, ownStopping, containerUp } = power;

  const blockingNames = power.blocking.map((g) => GAMES[g].name).join(" and ");

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

  // Only *this* world's work should caption this card — but a hand-off's save-and-stop of
  // this world IS this world's work, and it lives in the step rather than in `busy.stage`.
  const busyStage =
    power.ownStep?.label ?? (serverBusy?.game === game ? serverBusy.stage : undefined);

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
    if (game === "minecraft") return setProfilePicker(true);
    if (power.blocking.length > 0 || cutShort.length > 0) setConfirm(true);
    else void control("start");
  }

  function onRestart() {
    if (busy || !canRecover) return;
    if (cutShort.length > 0) return setConfirmPreempt("restart");
    void control("restart");
  }

  async function control(action: "start" | "stop" | "restart") {
    if (localBusy || action === "restart" && !canRecover) return;
    setLocalBusy(true);
    setConfirm(false);
    setConfirmPreempt(null);
    try {
      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(game === "minecraft" && action === "restart" && minecraftContext ? { "X-Minecraft-Context": minecraftContext } : {}) },
        body: JSON.stringify({ game, action }),
      });
      const data = await readOperationResponse(res);
      if (!data.operationId && res.status === 409) return void toast.error(data.error || "A server operation is already in progress");
      if (!data.operationId && !res.ok) return void toast.error(data.error || "Command failed");
      // No success toast: the operation's own completion toast carries the server's
      // summary, and it cannot say more than was actually observed. A "saved &
      // stopped" here would fire before the operation had verified its final state.
      setTimeout(refresh, reduced ? 0 : 1500);
    } catch (error) {
      toast.info(unconfirmedOperationMessage(`${meta.name} power operation`, error));
    } finally {
      void refreshOperations();
      setLocalBusy(false);
    }
  }

  const players = snap?.players;

  return (
    <div data-minecraft-tour={game === "minecraft" ? "server-controls" : undefined} className="grid gap-4 md:grid-cols-[1.4fr_1fr]" style={{ ["--tint" as string]: meta.tint }}>
      <StatusFreshness lastSuccessAt={lastSuccessAt} pollError={pollError} />
      {/* The box is running more than one world. One sentence, from `coResidency()`, so
          this page, `/{game}` and `/home` cannot word the same fact three ways — the
          three-copies drift that `docs/OPERATIONS.md` records for the power control. */}
      {/* No `role="status"` — see the note on the same element in `mission-control.tsx`: a
          live region created with its content is the case screen readers do not announce,
          and this is persistent state rather than an event. */}
      {co.message && (
        <p
          className="op-warn rounded-xl px-4 py-2.5 text-xs ring-1 md:col-span-2"
          style={{
            background: "color-mix(in oklab, var(--op-warn) 10%, transparent)",
            ["--tw-ring-color" as string]: "color-mix(in oklab, var(--op-warn) 35%, transparent)",
          }}
        >
          {co.message}
        </p>
      )}

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
            {/* `power.heading` is derived from `ownBusy`, not `busy`: this line states
                what THIS container is doing. Another world's operation locks our
                buttons but does not change our state. */}
            <p className="mt-1 font-display text-2xl font-bold">{power.heading}</p>
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
          disabled={busy || !power.canPower}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-xl font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            background: isOnline ? "transparent" : meta.tint,
            color: isOnline ? meta.tint : "var(--background)",
            boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 10px 30px -10px ${meta.tint}`,
          }}
        >
          <PowerGlyph className="h-5 w-5" />
          {/* `ownAction`, via `power.label` — NOT the operation's own `action`.
              The *gate* was fixed to be per-world and the verb was not, so during a
              hand-off this button read the incoming world's verb: pressing Power on for
              Minecraft relabelled Project Zomboid's own button "Starting…" while PZ was
              being shut down. `ownAction` falls back to `serverBusy.action`, so
              everything that is not a hand-off is byte-identical. */}
          {power.label}
        </button>
        <Button variant="outline" className="h-11 disabled:cursor-not-allowed" disabled={busy || !power.canRestart || !canRecover} onClick={onRestart}>
          {/* Not a spinner. `animate-spin` on a 1s CSS loop says "something is
              happening" whether or not anything is, which is the claim we refuse to
              make anywhere in this feature. */}
          <RotateCw className="h-4 w-4" />
          {ownBusy && ownAction === "restart" ? "Restarting…" : "Restart"}
        </Button>
        {game === "minecraft" && containerUp && <Button variant="outline" className="min-h-11" disabled={busy || !power.canRestart} onClick={() => setProfilePicker(true)}>Switch profile &amp; restart</Button>}

        {/* One sentence, from one derivation, for every "why is this dead / what will
            this do" case — so this and `/{game}`, `/home`, `/{game}/backups` and the
            7DTD maintenance card cannot drift. It covers the action-less power holder
            (the 7DTD update), which the old inline `serverBusy` branch structurally
            could not see.

            The words used to be bolded here with `<strong>` and nowhere else, including
            in the `powerHeld` case *in this same box*, which already rendered
            `blockedReason` unstyled. Plain text throughout is the consistent half of
            that pair, and it is what buys a single copy. */}
        <div className="mt-1 rounded-lg bg-background/50 p-3 text-xs text-muted-foreground ring-1 ring-foreground/10">
          {power.reason}
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

      {game === "minecraft" && containerUp && !canRecover && <p role="status" className="text-sm">Recovery Restart waits for a fresh verified Minecraft profile identity. Power off remains available.</p>}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PowerGlyph className="h-4 w-4" style={{ color: meta.tint }} /> Switch servers?
            </DialogTitle>
            <DialogDescription>
              {power.blocking.length > 0 && (
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
                  {power.blocking.length > 0 ? " " : ""}
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
              {power.blocking.length > 0 ? "Switch & start" : "Start anyway"}
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
      {game === "minecraft" && <MinecraftProfilePicker open={profilePicker} onOpenChange={setProfilePicker} onSubmitted={() => { void refresh(); }} />}
    </div>
  );
}

// `busyLabel` lived here; it is in `operation-ui.ts` now, next to the `ownAction` that
// is the only thing it may correctly be fed.

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
