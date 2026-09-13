"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES, otherGames, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { StatusPill, SectionHeading } from "@/components/ui-bits";
import { AnimatedNumber, Reveal, Stagger, StaggerItem, usePrefersReducedMotion } from "@/components/motion";
import { PowerGlyph, GearGlyph, GameMark } from "@/components/glyphs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Users, Puzzle, Server, Clock, Gauge, RotateCw } from "lucide-react";

export interface OverviewStat {
  label: string;
  value: number | string;
  kind: "mods" | "players" | "custom";
}

export interface ActivityItem {
  id: string;
  action: string;
  username: string;
  createdAt: string;
}

export function GameOverview({
  game,
  extraStats = [],
  recentActivity = [],
  children,
}: {
  game: GameId;
  extraStats?: OverviewStat[];
  recentActivity?: ActivityItem[];
  children?: React.ReactNode;
}) {
  const meta = GAMES[game];
  const [localBusy, setLocalBusy] = useState(false);
  const { games, busy: serverBusy, refresh } = useGames(localBusy ? 1500 : 5000);
  const snap = games?.[game];
  const status = snap?.status ?? "offline";
  const isOnline = status === "online";
  const reduced = usePrefersReducedMotion();

  const [confirm, setConfirm] = useState(false);

  const busy = localBusy || serverBusy !== null;
  const busyAction = serverBusy?.action;

  // Live memory usage from docker stats (real), instead of a static "reserved"
  // number — 7DTD has no configurable memory anyway.
  const [mem, setMem] = useState<string | null>(null);
  useEffect(() => {
    if (!isOnline) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMem(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetch(`/api/games/stats?game=${game}`)
        .then((r) => r.json())
        .then((d) => {
          if (alive && d?.container?.memory) setMem(d.container.memory as string);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [game, isOnline]);

  // The world(s) that would have to be saved and stopped to start this one.
  const blocking = otherGames(game).filter((g) => {
    const s = games?.[g]?.status;
    return s === "online" || s === "starting";
  });
  const blockingNames = blocking.map((g) => GAMES[g].name).join(" and ");

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
      toast.success(`${meta.name} ${action === "stop" ? "saved & stopped" : action === "restart" ? "restarting" : "powering on"}`);
      setTimeout(refresh, reduced ? 0 : 1200);
    } catch {
      toast.error("Network error");
    } finally {
      setLocalBusy(false);
    }
  }

  return (
    <div className="space-y-8" style={{ ["--tint" as string]: meta.tint }}>
      <SectionHeading
        eyebrow={`${meta.short} · Overview`}
        title={meta.name}
        sub={meta.tagline}
        tint={meta.tint}
        action={<StatusPill status={busy && !isOnline ? "starting" : status} tint={meta.tint} />}
      />

      {/* Hero control panel */}
      <Reveal>
        <div
          className="sheen relative overflow-hidden rounded-3xl bg-card/70 p-6 ring-1 backdrop-blur sm:p-8"
          style={{
            boxShadow: isOnline
              ? `0 0 0 1px color-mix(in oklab, ${meta.tint} 40%, transparent), 0 24px 70px -30px color-mix(in oklab, ${meta.tint} 60%, transparent)`
              : "inset 0 0 0 1px color-mix(in oklab, var(--foreground) 8%, transparent)",
          }}
        >
          <div
            className="pointer-events-none absolute -right-10 -top-10 opacity-[0.06]"
            style={{ color: meta.tint }}
          >
            <GameMark game={game} className="h-56 w-56" />
          </div>

          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <motion.div
                className="grid h-16 w-16 place-items-center rounded-2xl"
                style={{ background: `color-mix(in oklab, ${meta.tint} 15%, transparent)`, color: meta.tint }}
                animate={isOnline && !reduced ? { boxShadow: [`0 0 0 0 color-mix(in oklab, ${meta.tint} 40%, transparent)`, `0 0 0 10px transparent`] } : undefined}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <GameMark game={game} className="h-8 w-8" />
              </motion.div>
              <div>
                <p className="eyebrow text-muted-foreground">Server</p>
                <p className="font-display text-2xl font-bold">
                  {busyAction === "restart" ? "Restarting…" : busyAction === "stop" ? "Stopping…" : busyAction === "start" || (busy && !isOnline) ? "Starting…" : isOnline ? "Running" : "Powered down"}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{meta.connect.join("  ·  ")}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={onPower}
                disabled={busy}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  background: isOnline ? "transparent" : meta.tint,
                  color: isOnline ? meta.tint : "var(--background)",
                  boxShadow: isOnline ? `inset 0 0 0 1.5px ${meta.tint}` : `0 8px 24px -8px ${meta.tint}`,
                }}
              >
                <PowerGlyph className="h-4 w-4" />
                {busy ? "Working…" : isOnline ? "Power off" : "Power on"}
              </button>
              {isOnline && (
                <Button variant="outline" className="h-11 disabled:cursor-not-allowed" disabled={busy} onClick={() => control("restart")}>
                  <RotateCw className={cn("h-4 w-4", busyAction === "restart" && "animate-spin")} />
                  {busyAction === "restart" ? "Restarting…" : "Restart"}
                </Button>
              )}
              <Link
                href={`${meta.base}/server`}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-muted px-4 text-sm font-medium transition-colors hover:bg-accent"
              >
                <GearGlyph className="h-4 w-4" /> Console & files
              </Link>
            </div>
          </div>
        </div>
      </Reveal>

      {/* Stat tiles */}
      <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Users}
          label="Players online"
          value={isOnline && snap?.players ? snap.players.online : 0}
          hint={isOnline && snap?.players ? `of ${snap.players.max}` : "server offline"}
          tint={meta.tint}
          animate
        />
        {extraStats.map((s) => (
          <StatTile
            key={s.label}
            icon={s.kind === "mods" ? Puzzle : Gauge}
            label={s.label}
            value={s.value}
            tint={meta.tint}
            animate={typeof s.value === "number"}
          />
        ))}
        <StatTile
          icon={Clock}
          label={meta.detailLabel}
          value={isOnline ? snap?.detail ?? snap?.uptime ?? "live" : "—"}
          tint={meta.tint}
        />
        <StatTile icon={Server} label="Memory in use" value={isOnline ? mem ?? "…" : "—"} tint={meta.tint} />
      </Stagger>

      {children}

      {/* Recent activity */}
      <Reveal>
        <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
          <h3 className="mb-4 font-display text-lg font-semibold">Recent activity</h3>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet for this world.</p>
          ) : (
            <div className="space-y-1">
              {recentActivity.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center justify-between border-b border-border/40 py-2.5 text-sm last:border-0"
                >
                  <span>
                    <span className="font-medium">{a.username}</span>{" "}
                    <span className="text-muted-foreground">{formatAction(a.action)}</span>
                  </span>
                  <time className="font-mono text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </time>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </Reveal>

      {/* Switch confirm */}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PowerGlyph className="h-4 w-4" style={{ color: meta.tint }} /> Switch servers?
            </DialogTitle>
            <DialogDescription>
              This will <strong>save and stop {blockingNames}</strong>, then start{" "}
              <strong>{meta.name}</strong>. Players on {blockingNames} will be disconnected.
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

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tint,
  animate,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  hint?: string;
  tint: string;
  animate?: boolean;
}) {
  return (
    <StaggerItem>
      <motion.div
        whileHover={{ y: -3 }}
        className="sheen group relative h-full overflow-hidden rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/10 backdrop-blur"
      >
        <div className="flex items-center justify-between">
          <span className="eyebrow text-muted-foreground">{label}</span>
          <span
            className="grid h-8 w-8 place-items-center rounded-lg transition-colors"
            style={{ background: `color-mix(in oklab, ${tint} 12%, transparent)`, color: tint }}
          >
            <Icon className="h-4 w-4" />
          </span>
        </div>
        <div className="mt-2 font-display text-2xl font-bold">
          {animate && typeof value === "number" ? <AnimatedNumber value={value} /> : value}
        </div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </motion.div>
    </StaggerItem>
  );
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    install_mod: "installed a mod",
    remove_mod: "removed a mod",
    update_mod: "updated a mod",
    server_start: "powered on the server",
    server_stop: "powered off the server",
    server_restart: "restarted the server",
    edit_file: "edited a config file",
    delete_file: "deleted a file",
  };
  return map[action] || action.replace(/_/g, " ");
}
