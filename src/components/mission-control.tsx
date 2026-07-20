"use client";

import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES, otherGame, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { PowerCore, type CoreState } from "@/components/power-core";
import { RamBudget } from "@/components/ram-budget";
import { StatusPill } from "@/components/ui-bits";
import { AnimatedNumber, usePrefersReducedMotion } from "@/components/motion";
import { MinecraftGlyph, ZombieGlyph, PowerGlyph, ArrowGlyph, GearGlyph } from "@/components/glyphs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Phase = { key: string; label: string };

export function MissionControl({ userName }: { userName?: string | null }) {
  const [localBusy, setLocalBusy] = useState(false);
  const { games, activeGame, busy: serverBusy, loading, refresh } = useGames(localBusy ? 1500 : 5000);
  const reduced = usePrefersReducedMotion();

  const [pending, setPending] = useState<GameId | null>(null); // game being powered on/awaiting confirm
  const [confirmFor, setConfirmFor] = useState<GameId | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);

  // Locked out if this tab is working OR the server reports any op in flight.
  const busy = localBusy || serverBusy !== null;

  const coreState: CoreState = busy && pending
    ? { kind: "handoff", from: activeGame && activeGame !== pending ? activeGame : null, to: pending }
    : busy && serverBusy
    ? { kind: "handoff", from: null, to: serverBusy.game }
    : activeGame
    ? { kind: "holding", game: activeGame }
    : { kind: "idle" };

  function onPowerClick(game: GameId, isOnline: boolean) {
    if (busy) return;
    if (isOnline) {
      // Power OFF this game
      void doControl(game, "stop");
      return;
    }
    // Power ON — if the other is running, confirm the hand-off first
    const other = otherGame(game);
    const otherOnline = games?.[other]?.status === "online" || games?.[other]?.status === "starting";
    if (otherOnline) {
      setConfirmFor(game);
    } else {
      void doControl(game, "start");
    }
  }

  async function doControl(game: GameId, action: "start" | "stop") {
    if (localBusy) return;
    setLocalBusy(true);
    setConfirmFor(null);
    if (action === "start") setPending(game);

    const other = otherGame(game);
    const otherOnline = games?.[other]?.status === "online";

    try {
      if (action === "start" && otherOnline) {
        setPhase({ key: "save", label: `Saving ${GAMES[other].name}…` });
        await sleep(reduced ? 0 : 700);
        setPhase({ key: "stop", label: `Powering down ${GAMES[other].name}…` });
      } else if (action === "start") {
        setPhase({ key: "boot", label: `Starting ${GAMES[game].name}…` });
      } else {
        setPhase({ key: "save", label: `Saving & stopping ${GAMES[game].name}…` });
      }

      const res = await fetch("/api/games/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, action }),
      });
      const data = await res.json();

      if (res.status === 409) {
        toast.error(data.error || "A server operation is already in progress");
        return;
      }
      if (!res.ok) {
        toast.error(data.error || "Command failed");
        return;
      }

      if (action === "start") {
        setPhase({ key: "boot", label: `Starting ${GAMES[game].name}…` });
        toast.success(`${GAMES[game].name} is powering on`, {
          description: otherOnline ? `${GAMES[other].name} was saved and stopped.` : undefined,
        });
      } else {
        toast.success(`${GAMES[game].name} saved and stopped`);
      }

      await sleep(reduced ? 0 : 900);
      await refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setLocalBusy(false);
      setPending(null);
      setPhase(null);
    }
  }

  return (
    <div className="relative">
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
          Choose your world
        </motion.h1>
        <motion.p
          className="mx-auto mt-2 max-w-md text-sm text-muted-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.15 }}
        >
          {userName ? `Welcome back, ${userName}. ` : ""}
          Only one server runs at a time. Starting one stops the other.
        </motion.p>
      </div>

      {/* The trio: card — core — card */}
      <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <WorldCard
          game="minecraft"
          snapshot={games?.minecraft}
          loading={loading}
          busy={busy}
          pending={pending}
          onPower={onPowerClick}
          delay={0.1}
        />

        {/* Center power indicator */}
        <div className="flex flex-col items-center justify-center gap-4 py-2 lg:px-2">
          <PowerCore state={coreState} size={148} />
          <AnimatePresence mode="wait">
            {phase ? (
              <motion.div
                key={phase.key}
                className="text-center"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
              >
                <p className="font-mono text-xs text-foreground">{phase.label}</p>
                <div className="mx-auto mt-1.5 h-0.5 w-24 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    className="h-full w-1/3 rounded-full bg-primary"
                    animate={{ x: ["-100%", "300%"] }}
                    transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.p
                key="idle-caption"
                className="max-w-[10rem] text-center font-mono text-[11px] leading-relaxed text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {activeGame ? `${GAMES[activeGame].short} running` : "both stopped"}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <WorldCard
          game="7dtd"
          snapshot={games?.["7dtd"]}
          loading={loading}
          busy={busy}
          pending={pending}
          onPower={onPowerClick}
          delay={0.2}
        />
      </div>

      {/* RAM budget bar */}
      <motion.div
        className="mx-auto mt-8 max-w-2xl rounded-2xl bg-card/60 p-5 ring-1 ring-foreground/10 backdrop-blur"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.35 }}
      >
        <RamBudget activeGame={activeGame} />
      </motion.div>

      {/* Hand-off confirm */}
      <Dialog open={confirmFor !== null} onOpenChange={(o) => !o && setConfirmFor(null)}>
        <DialogContent>
          {confirmFor && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PowerGlyph className="h-4 w-4" style={{ color: GAMES[confirmFor].tint }} />
                  Switch servers?
                </DialogTitle>
                <DialogDescription>
                  This will <strong>save and stop {GAMES[otherGame(confirmFor)].name}</strong>, then start{" "}
                  <strong>{GAMES[confirmFor].name}</strong>. Anyone currently playing will be
                  disconnected. Takes about a minute.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center gap-3 py-2 text-xs">
                <span className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-mono">
                  <GameMark game={otherGame(confirmFor)} className="h-3.5 w-3.5" />
                  {GAMES[otherGame(confirmFor)].short} off
                </span>
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
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmFor(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => doControl(confirmFor, "start")}
                  style={{ background: GAMES[confirmFor].tint, color: "var(--background)" }}
                >
                  Switch &amp; start
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GameMark({ game, className }: { game: GameId; className?: string }) {
  return game === "minecraft" ? (
    <MinecraftGlyph className={className} />
  ) : (
    <ZombieGlyph className={className} />
  );
}

function WorldCard({
  game,
  snapshot,
  loading,
  busy,
  pending,
  onPower,
  delay,
}: {
  game: GameId;
  snapshot?: import("@/lib/use-games").GameSnapshot;
  loading: boolean;
  busy: boolean;
  pending: GameId | null;
  onPower: (g: GameId, online: boolean) => void;
  delay: number;
}) {
  const meta = GAMES[game];
  const status = snapshot?.status ?? "offline";
  const isOnline = status === "online";
  const isBusyThis = busy && pending === game;
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

        <div className="relative flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
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
            <div>
              <h2 className="font-display text-xl font-bold leading-tight">{meta.name}</h2>
              <p className="text-xs text-muted-foreground">{meta.tagline}</p>
            </div>
          </div>
          {loading ? (
            <div className="h-6 w-16 skeleton rounded-full" />
          ) : (
            <StatusPill status={isBusyThis ? "starting" : status} tint={meta.tint} />
          )}
        </div>

        {/* Live metrics */}
        <div className="relative mt-6 grid grid-cols-2 gap-3">
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
            label={game === "minecraft" ? "Uptime" : "In-game"}
            value={isOnline ? snapshot?.detail ?? snapshot?.uptime ?? "live" : "—"}
            tint={meta.tint}
          />
        </div>

        {/* Actions */}
        <div className="relative mt-6 flex items-center gap-2">
          <button
            onClick={() => onPower(game, isOnline)}
            disabled={busy}
            className="group/pw relative inline-flex h-11 flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl font-medium transition-all disabled:opacity-60"
            style={{
              background: isOnline ? "transparent" : meta.tint,
              color: isOnline ? meta.tint : "var(--background)",
              boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 8px 24px -8px ${meta.tint}`,
            }}
          >
            <PowerGlyph className="h-4 w-4" />
            {isBusyThis ? "Working…" : isOnline ? "Power off" : "Power on"}
          </button>
          <Link
            href={meta.base}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <GearGlyph className="h-4 w-4" />
            Manage
          </Link>
        </div>

        {/* Connect address(es) */}
        <div className="relative mt-4 rounded-lg bg-background/50 px-3 py-2 font-mono text-[11px] text-muted-foreground ring-1 ring-foreground/10">
          {meta.connect.map((addr, i) => (
            <div key={addr} className={cn("flex items-center justify-between", i > 0 && "mt-1")}>
              <span>{i === 0 ? "connect" : "or"}</span>
              <span className="text-foreground">{addr}</span>
            </div>
          ))}
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
