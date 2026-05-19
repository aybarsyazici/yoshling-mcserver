"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Stats {
  container: {
    cpu: string;
    memory: string;
    memoryPercent: string;
    network: string;
    processes: string;
  };
  host: {
    disk: { used: string; total: string; percent: string };
    uptime: string | null;
  };
}

interface DataPoint {
  time: string;
  cpu: number;
  memory: number;
}

const MAX_POINTS = 60;

export function ServerMonitor() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"cards" | "graphs">("graphs");
  const [history, setHistory] = useState<DataPoint[]>([]);
  const historyRef = useRef<DataPoint[]>([]);

  async function fetchStats() {
    try {
      const res = await fetch("/api/server/stats");
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setError(null);

        const cpuNum = parseFloat(data.container.cpu);
        const memNum = parseFloat(data.container.memoryPercent);
        const now = new Date();
        const timeStr = `${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;

        const newPoint: DataPoint = {
          time: timeStr,
          cpu: isNaN(cpuNum) ? 0 : cpuNum,
          memory: isNaN(memNum) ? 0 : memNum,
        };

        historyRef.current = [...historyRef.current, newPoint].slice(-MAX_POINTS);
        setHistory(historyRef.current);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to fetch stats");
      }
    } catch {
      setError("Failed to connect");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-border/50 shadow-sm">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={fetchStats}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const cpuNum = parseFloat(stats.container.cpu);
  const memNum = parseFloat(stats.container.memoryPercent);
  const diskNum = parseFloat(stats.host.disk.percent);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Auto-refreshes every 5 seconds</p>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          <Button
            size="sm"
            variant={viewMode === "graphs" ? "default" : "ghost"}
            className="h-7 px-3 text-xs"
            onClick={() => setViewMode("graphs")}
          >
            Graphs
          </Button>
          <Button
            size="sm"
            variant={viewMode === "cards" ? "default" : "ghost"}
            className="h-7 px-3 text-xs"
            onClick={() => setViewMode("cards")}
          >
            Cards
          </Button>
        </div>
      </div>

      {viewMode === "graphs" ? (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  CPU Usage
                </CardTitle>
                <span className="text-lg font-bold">{stats.container.cpu}</span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      formatter={(value: any) => [`${Number(value).toFixed(1)}%`, "CPU"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="cpu"
                      stroke="#cba6f7"
                      strokeWidth={2}
                      dot={false}
                      animationDuration={300}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Memory Usage
                </CardTitle>
                <span className="text-lg font-bold">{stats.container.memoryPercent}</span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      formatter={(value: any) => [`${Number(value).toFixed(1)}%`, "Memory"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="memory"
                      stroke="#89b4fa"
                      strokeWidth={2}
                      dot={false}
                      animationDuration={300}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground text-center mt-2">
                {stats.container.memory}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="CPU Usage"
            value={stats.container.cpu}
            percent={cpuNum}
            color={cpuNum > 80 ? "bg-destructive" : cpuNum > 50 ? "bg-chart-5" : "bg-chart-4"}
          />
          <StatCard
            title="Memory"
            value={stats.container.memory}
            subtitle={stats.container.memoryPercent}
            percent={memNum}
            color={memNum > 85 ? "bg-destructive" : memNum > 60 ? "bg-chart-5" : "bg-chart-4"}
          />
        </div>
      )}

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Disk"
          value={`${stats.host.disk.used} / ${stats.host.disk.total}`}
          subtitle={stats.host.disk.percent}
          percent={diskNum}
          color={diskNum > 90 ? "bg-destructive" : diskNum > 70 ? "bg-chart-5" : "bg-chart-4"}
        />
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network I/O</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{stats.container.network}</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Processes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{stats.container.processes}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  percent,
  color,
}: {
  title: string;
  value: string;
  subtitle?: string;
  percent: number;
  color: string;
}) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold">{value}</span>
          {subtitle && (
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          )}
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${color}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
