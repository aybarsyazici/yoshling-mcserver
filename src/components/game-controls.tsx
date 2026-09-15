"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES, otherGames, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
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
  const { games, busy: serverBusy, can, memoryGb, refresh } = useGames(localBusy ? 1500 : 4000);
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";
  const reduced = usePrefersReducedMotion();

  const [confirm, setConfirm] = useState(false);

  // Busy if THIS tab fired a request, OR the server reports any op in flight
  // (e.g. another admin/tab). Either way, controls lock out.
  const busy = localBusy || serverBusy !== null;
  const busyAction = serverBusy?.action;

  // Only one world can hold the box at a time, but check every other one
  // rather than assume which — a stale container would otherwise be missed.
  const blocking = otherGames(game).filter((g) => {
    const s = games?.[g]?.status;
    return s === "online" || s === "starting";
  });
  const blockingNames = blocking.map((g) => GAMES[g].name).join(" and ");
  const blockingVerb = blocking.length > 1 ? "are" : "is";
  const blockingThem = blocking.length > 1 ? "them" : "it";

  const coreState: CoreState = busy && !isOnline ? { kind: "booting", game } : isOnline ? { kind: "holding", game } : { kind: "idle" };

  // Whether the power button would actually be allowed, so a viewer who can't
  // use it sees that up front instead of a "Forbidden" toast after pressing it.
  const canPower = isOnline ? can.stop : can.start;

  // Only *this* world's operation should describe itself here — a hand-off that
  // is stopping another world shouldn't caption this card.
  const busyStage = serverBusy?.game === game ? serverBusy.stage : undefined;

  function onPower() {
    if (busy) return;
    if (isOnline) return void control("stop");
    if (blocking.length > 0) setConfirm(true);
    else void control("start");
  }

  async function control(action: "start" | "stop" | "restart") {
    if (localBusy) return;
    setLocalBusy(true);
    setConfirm(false);
    try {
      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, action }),
      });
      const data = await res.json();
      if (res.status === 409) return void toast.error(data.error || "A server operation is already in progress");
      if (!res.ok) return void toast.error(data.error || "Command failed");
      toast.success(
        action === "stop" ? `${meta.name} saved & stopped` : action === "restart" ? `${meta.name} restarting` : `${meta.name} powering on`
      );
      setTimeout(refresh, reduced ? 0 : 1500);
    } catch {
      toast.error("Network error");
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
              {isOnline ? "Running" : busy ? "Working…" : "Stopped"}
            </p>
          </div>
          <StatusPill status={busy && !isOnline ? "starting" : status} tint={meta.tint} />
        </div>

        <div className="my-4 flex justify-center">
          <PowerCore state={coreState} size={120} />
        </div>

        {/* What's actually happening. A big mod list takes minutes to load, and
            without a stage + bar the UI reads as hung rather than working. The
            control lock's stage wins when set, because it describes what WE are
            doing (stopping / downloading); otherwise fall back to the server's
            own boot progress. */}
        {(busyStage || snap?.boot) && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">
                {busyStage ?? snap?.boot?.stage}
              </span>
              {!busyStage && snap?.boot?.percent != null && (
                <span className="font-mono tabular-nums" style={{ color: meta.tint }}>
                  {snap.boot.percent}%
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10">
              <motion.div
                className="h-full rounded-full"
                style={{ background: meta.tint }}
                initial={false}
                // No percentage to show (our own stage, or an unknown phase):
                // an indeterminate sweep rather than a fake number.
                animate={
                  busyStage || snap?.boot?.percent == null
                    ? { width: ["15%", "85%", "15%"], x: ["0%", "18%", "0%"] }
                    : { width: `${snap.boot.percent}%`, x: "0%" }
                }
                transition={
                  busyStage || snap?.boot?.percent == null
                    ? { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
                    : { type: "spring", stiffness: 90, damping: 22 }
                }
              />
            </div>
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
          {busy ? busyLabel(busyAction) : isOnline ? "Power off" : "Power on"}
        </button>
        <Button variant="outline" className="h-11 disabled:cursor-not-allowed" disabled={busy || !isOnline || !can.restart} onClick={() => control("restart")}>
          <RotateCw className={cn("h-4 w-4", busyAction === "restart" && "animate-spin")} />
          {busyAction === "restart" ? "Restarting…" : "Restart"}
        </Button>

        <div className="mt-1 rounded-lg bg-background/50 p-3 text-xs text-muted-foreground ring-1 ring-foreground/10">
          {serverBusy ? (
            <span>
              <strong className="text-foreground">{GAMES[serverBusy.game].name}</strong> is{" "}
              {serverBusy.action === "start"
                ? "starting up"
                : serverBusy.action === "stop"
                ? "shutting down"
                : "restarting"}
              {serverBusy.stage ? ` — ${serverBusy.stage.toLowerCase()}` : ""}. Controls unlock when
              it finishes.
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
              This saves and stops <strong>{blockingNames}</strong>, then starts <strong>{meta.name}</strong>.
              Players on {blockingNames} will be disconnected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={() => control("start")} style={{ background: meta.tint, color: "var(--background)" }}>
              Switch &amp; start
            </Button>
          </DialogFooter>
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
