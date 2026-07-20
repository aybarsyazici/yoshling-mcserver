"use client";

import { useState, useEffect } from "react";
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
import { AnimatedNumber } from "@/components/motion";
import { Cpu, MemoryStick, HardDrive, Network, Activity, Server } from "lucide-react";

interface Stats {
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
  const [history, setHistory] = useState<DataPoint[]>([]);

  async function fetchStats() {
    try {
      const res = await fetch(`/api/games/stats?game=${game}`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        if (data.history) {
          setHistory(
            data.history.map((p: { time: number; cpu: number; memory: number }) => {
              const d = new Date(p.time);
              return {
                time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
                cpu: p.cpu,
                memory: p.memory,
              };
            })
          );
        }
      }
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (!stats) return null;

  const cpuNum = parseFloat(stats.container.cpu) || 0;
  const memNum = parseFloat(stats.container.memoryPercent) || 0;
  const diskNum = parseFloat(stats.host.disk.percent) || 0;
  const offline = stats.offline;

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: meta.tint }}>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            {!offline && (
              <motion.span
                className="absolute inline-flex h-full w-full rounded-full"
                style={{ background: meta.tint }}
                animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
            )}
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: offline ? "var(--muted-foreground)" : meta.tint }} />
          </span>
          {offline ? "Server offline — showing last session" : "Live · refreshes every 5s"}
        </p>
      </div>

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
