"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { GAMES, type GameId } from "@/lib/games";
import { Cpu, MemoryStick, HardDrive, Network } from "lucide-react";

interface Stats {
  /**
   * The container is not running, so every number below is a zero and the curve is
   * history rather than a live reading.
   *
   * Decided server-side from `docker inspect`, deliberately — this pane and the stats
   * route must never disagree about whether what you are looking at is live. The route
   * used to infer it from the *shape* of `docker stats` output, which for a stopped
   * container is five populated zero-fields, so this was always `false` and the pane
   * always claimed "Live".
   */
  offline?: boolean;
  container: { cpu: string; memory: string; memoryPercent: string; network: string; processes: string };
  host: { disk: { used: string; total: string; percent: string }; uptime: string | null };
  history: { time: number; cpu: number; memory: number }[];
}

interface DataPoint {
  time: string;
  cpu: number;
  memory: number;
}

export function ServerMonitor({ game = "minecraft" }: { game?: GameId }) {
  const meta = GAMES[game];
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [statsGame, setStatsGame] = useState<GameId | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const [history, setHistory] = useState<DataPoint[]>([]);

  useEffect(() => {
    let alive = true;
    async function fetchStats() {
      const request = ++generation.current;
      try {
        const res = await fetch(`/api/games/stats?game=${game}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Monitor refresh failed (HTTP ${res.status})`);
        const data: unknown = await res.json();
        if (!isStats(data)) throw new Error("The monitor response is incomplete");
        if (!alive || request !== generation.current) return;
        setStats(data); setStatsGame(game); setPollError(null); setLastSuccessAt(Date.now());
        setHistory(data.history.map((p) => ({
          time: new Date(p.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
          cpu: p.cpu, memory: p.memory,
        })));
      } catch (error) {
        if (alive && request === generation.current) setPollError(error instanceof Error ? error.message : "Couldn't refresh the monitor");
      } finally { if (alive) { setLoading(false); setNow(Date.now()); } }
    }
    void fetchStats();
    const poll = setInterval(fetchStats, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); };
  }, [game]);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-28 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (!stats || statsGame !== game) return <div role="alert" className="rounded-2xl bg-card/70 p-5">
    {pollError ?? "Reading monitor data…"} Polling retries every 5 seconds.
  </div>;

  const cpuNum = parseFloat(stats.container.cpu) || 0;
  const memNum = parseFloat(stats.container.memoryPercent) || 0;
  const diskNum = parseFloat(stats.host.disk.percent) || 0;
  const offline = stats.offline;
  const ageSeconds = lastSuccessAt === null ? null : Math.max(0, Math.floor((now - lastSuccessAt) / 1000));
  const fresh = !pollError && ageSeconds !== null && ageSeconds <= 15;

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: meta.tint }}>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            {fresh && !offline && (
              <motion.span
                className="absolute inline-flex h-full w-full rounded-full"
                style={{ background: meta.tint }}
                animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
            )}
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: !fresh || offline ? "var(--muted-foreground)" : meta.tint }} />
          </span>
          {!fresh
            ? `Last known reading · ${ageSeconds ?? "?"}s old${pollError ? ` · ${pollError}` : " · waiting for a fresh poll"}`
            : offline
            ? history.length > 0
              ? `${meta.name} is stopped — the graph is its last recorded session, not a live reading`
              : `${meta.name} is stopped, and nothing was recorded while it last ran`
            : `Live · refreshes every 5s · last read ${ageSeconds}s ago`}
        </p>
      </div>

      {!fresh && <p role="status" className="text-xs text-chart-5">These values are historical. The current server state has not been confirmed.</p>}
      {/* The x-axis is wall-clock times with no gap marker, so a historic curve is
          indistinguishable from a live one by looking at it. Say which it is, next to
          the numbers, rather than only in the line above the charts. */}
      {offline && history.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Times on the axis are when those readings were taken, which may be a while ago.
          The gauges below read zero because the container is not running.
        </p>
      )}

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="CPU" icon={Cpu} value={stats.container.cpu} tint={meta.tint} data={history} dataKey="cpu" />
        <ChartCard title="Memory" icon={MemoryStick} value={stats.container.memoryPercent} subtitle={stats.container.memory} tint={meta.tintSoft} data={history} dataKey="memory" />
      </div>

      {/* Gauges + info */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <GaugeCard title="CPU load" icon={Cpu} percent={cpuNum} display={stats.container.cpu} />
        <GaugeCard title="Memory" icon={MemoryStick} percent={memNum} display={stats.container.memoryPercent} subtitle={stats.container.memory} />
        <GaugeCard title="Host disk" icon={HardDrive} percent={diskNum} display={stats.host.disk.percent} subtitle={`${stats.host.disk.used} / ${stats.host.disk.total}`} />
        <InfoCard netIO={stats.container.network} pids={stats.container.processes} tint={meta.tint} />
      </div>
    </div>
  );
}

type IconType = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;

function ChartCard({
  title,
  icon: Icon,
  value,
  subtitle,
  tint,
  data,
  dataKey,
}: {
  title: string;
  icon: IconType;
  value: string;
  subtitle?: string;
  tint: string;
  data: DataPoint[];
  dataKey: "cpu" | "memory";
}) {
  const gradId = `grad-${dataKey}`;
  return (
    <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-4 w-4" style={{ color: tint }} /> {title}
        </span>
        <span className="font-display text-xl font-bold" style={{ color: tint }}>
          {value}
        </span>
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={tint} stopOpacity={0.5} />
                <stop offset="100%" stopColor={tint} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(v) => `${v}`} tickLine={false} axisLine={false} width={34} />
            <Tooltip
              contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }}
              formatter={((v: unknown) => [`${Number(v).toFixed(1)}%`, title]) as never}
            />
            <Area type="monotone" dataKey={dataKey} stroke={tint} strokeWidth={2} fill={`url(#${gradId})`} animationDuration={400} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {subtitle && <p className="mt-1 text-center text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function GaugeCard({
  title,
  icon: Icon,
  percent,
  display,
  subtitle,
}: {
  title: string;
  icon: IconType;
  percent: number;
  display: string;
  subtitle?: string;
}) {
  const color = percent > 85 ? "var(--destructive)" : percent > 60 ? "var(--chart-5)" : "var(--tint)";
  return (
    <div className="rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/10 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-muted-foreground">{title}</span>
        <Icon className="h-4 w-4" style={{ color }} />
      </div>
      <div className="mt-1.5 font-display text-2xl font-bold">{display}</div>
      {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(percent, 100)}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}

function InfoCard({ netIO, pids, tint }: { netIO: string; pids: string; tint: string }) {
  return (
    <div className="rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/10 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-muted-foreground">Network / Procs</span>
        <Network className="h-4 w-4" style={{ color: tint }} />
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Net I/O</span>
          <span className="font-mono font-medium">{netIO}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Processes</span>
          <span className="font-mono font-medium">{pids}</span>
        </div>
      </div>
    </div>
  );
}

function isStats(value: unknown): value is Stats {
  if (!value || typeof value !== "object") return false;
  const v = value as Stats;
  return !!v.container && [v.container.cpu, v.container.memory, v.container.memoryPercent, v.container.network, v.container.processes].every((s) => typeof s === "string") &&
    !!v.host?.disk && [v.host.disk.used, v.host.disk.total, v.host.disk.percent].every((s) => typeof s === "string") &&
    (v.offline === undefined || typeof v.offline === "boolean") && Array.isArray(v.history) &&
    v.history.every((p) => p && [p.time, p.cpu, p.memory].every(Number.isFinite));
}
