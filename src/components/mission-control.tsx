"use client";

import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES, GAME_LIST, otherGames, type GameId, type GameMeta } from "@/lib/games";
import { useGames } from "@/lib/use-games";
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

type Phase = { key: string; label: string };

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
  const { games, activeGame, busy: serverBusy, memoryGb, hostGb, loading, refresh } =
    useGames(localBusy ? 1500 : 5000);
  const reduced = usePrefersReducedMotion();
  const worlds = GAME_LIST.filter((g) => access.includes(g.id));
  const layout = LAYOUT[worlds.length] ?? LAYOUT[3];

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

  /** The other worlds currently holding (or claiming) the box. */
  function runningOthers(game: GameId): GameId[] {
    return otherGames(game).filter((g) => {
      const s = games?.[g]?.status;
      return s === "online" || s === "starting";
    });
  }

  function onPowerClick(game: GameId, isOnline: boolean) {
    if (busy) return;
    if (isOnline) {
      // Power OFF this game
      void doControl(game, "stop");
      return;
    }
    // Power ON — if another world is running, confirm the switch first
    if (runningOthers(game).length > 0) {
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

    const stopping = runningOthers(game);
    const stoppingNames = stopping.map((g) => GAMES[g].name).join(" and ");

    try {
      if (action === "start" && stopping.length > 0) {
        setPhase({ key: "save", label: `Saving ${stoppingNames}…` });
        await sleep(reduced ? 0 : 700);
        setPhase({ key: "stop", label: `Powering down ${stoppingNames}…` });
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
          description: stopping.length > 0 ? `${stoppingNames} was saved and stopped.` : undefined,
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

  if (worlds.length === 0) return <NoWorlds userName={userName} />;

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
              className="text-center font-mono text-[11px] leading-relaxed text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {activeGame ? `${GAMES[activeGame].short} running` : "all stopped"}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Which world the slot is currently wired to */}
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
            busy={busy}
            pending={pending}
            onPower={onPowerClick}
            delay={0.1 + i * 0.08}
          />
        ))}
      </div>

      {/* RAM budget bar */}
      <motion.div
        className="mx-auto mt-8 max-w-2xl rounded-2xl bg-card/60 p-5 ring-1 ring-foreground/10 backdrop-blur"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.35 }}
      >
        <RamBudget activeGame={activeGame} hostGb={hostGb} memoryGb={memoryGb} />
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
                  This will{" "}
                  <strong>
                    save and stop {runningOthers(confirmFor).map((g) => GAMES[g].name).join(" and ")}
                  </strong>
                  , then start <strong>{GAMES[confirmFor].name}</strong>. Anyone currently playing will
                  be disconnected. Takes about a minute.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-xs">
                {runningOthers(confirmFor).map((g) => (
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
            <StatusPill status={isBusyThis ? "starting" : status} tint={meta.tint} />
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
