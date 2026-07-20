"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { GAMES, otherGame, type GameId } from "@/lib/games";
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
  const { games, refresh } = useGames(4000);
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";
  const reduced = usePrefersReducedMotion();

  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const other = otherGame(game);
  const otherOnline = games?.[other]?.status === "online" || games?.[other]?.status === "starting";

  const coreState: CoreState = busy && !isOnline ? { kind: "booting", game } : isOnline ? { kind: "holding", game } : { kind: "idle" };

  function onPower() {
    if (busy) return;
    if (isOnline) return void control("stop");
    if (otherOnline) setConfirm(true);
    else void control("start");
  }

  async function control(action: "start" | "stop" | "restart") {
    setBusy(true);
    setConfirm(false);
    try {
      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, action }),
      });
      const data = await res.json();
      if (!res.ok) return void toast.error(data.error || "Command failed");
      toast.success(
        action === "stop" ? `${meta.name} saved & stopped` : action === "restart" ? `${meta.name} restarting` : `${meta.name} powering on`
      );
      setTimeout(refresh, reduced ? 0 : 1500);
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  const players = snap?.players;

  return (
    <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]" style={{ ["--tint" as string]: meta.tint }}>
      {/* Status panel with live core */}
      <div
        className="relative overflow-hidden rounded-2xl bg-card/70 p-6 ring-1 backdrop-blur"
        style={{
          boxShadow: isOnline ? `inset 0 0 0 1px color-mix(in oklab, ${meta.tint} 40%, transparent)` : undefined,
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow text-muted-foreground">Reactor status</p>
            <p className="mt-1 font-display text-2xl font-bold">
              {isOnline ? "Energized" : busy ? "Working…" : "Idle"}
            </p>
          </div>
          <StatusPill status={busy && !isOnline ? "starting" : status} tint={meta.tint} />
        </div>

        <div className="my-4 flex justify-center">
          <PowerCore state={coreState} size={120} />
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Cell label="Players" value={isOnline && players ? `${players.online}/${players.max}` : "—"} tint={meta.tint} />
          <Cell label={game === "minecraft" ? "Uptime" : "In-game"} value={isOnline ? snap?.detail ?? snap?.uptime ?? "live" : "—"} tint={meta.tint} />
          <Cell label="RAM" value={`${meta.ramGb}G`} tint={meta.tint} />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-3 rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Controls</p>
        <button
          onClick={onPower}
          disabled={busy}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-xl font-semibold transition-all disabled:opacity-60"
          style={{
            background: isOnline ? "transparent" : meta.tint,
            color: isOnline ? meta.tint : "var(--background)",
            boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 10px 30px -10px ${meta.tint}`,
          }}
        >
          <PowerGlyph className="h-5 w-5" />
          {busy ? "Working…" : isOnline ? "Power off" : "Power on"}
        </button>
        <Button variant="outline" className="h-11" disabled={busy || !isOnline} onClick={() => control("restart")}>
          <RotateCw className="h-4 w-4" /> Restart
        </Button>

        <div className="mt-1 rounded-lg bg-background/50 p-3 text-xs text-muted-foreground ring-1 ring-foreground/10">
          {otherOnline ? (
            <span>
              <strong className="text-foreground">{GAMES[other].name}</strong> holds the reactor. Powering
              this on hands it over.
            </span>
          ) : isOnline ? (
            "Stopping saves the world first, then frees the box."
          ) : (
            "The box runs one world at a time."
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
              <PowerGlyph className="h-4 w-4" style={{ color: meta.tint }} /> Hand over the reactor?
            </DialogTitle>
            <DialogDescription>
              This saves and stops <strong>{GAMES[other].name}</strong>, then boots <strong>{meta.name}</strong>.
              Players on {GAMES[other].name} will be disconnected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={() => control("start")} style={{ background: meta.tint, color: "var(--background)" }}>
              Hand over & boot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
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
