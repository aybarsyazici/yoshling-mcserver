"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

export function ServerMonitor() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchStats() {
    try {
      const res = await fetch("/api/server/stats");
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setError(null);
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
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="CPU Usage"
          value={stats.container.cpu}
          percent={cpuNum}
          color={cpuNum > 80 ? "destructive" : cpuNum > 50 ? "chart-5" : "chart-4"}
        />
        <StatCard
          title="Memory"
          value={stats.container.memory}
          subtitle={stats.container.memoryPercent}
          percent={memNum}
          color={memNum > 85 ? "destructive" : memNum > 60 ? "chart-5" : "chart-4"}
        />
        <StatCard
          title="Disk"
          value={`${stats.host.disk.used} / ${stats.host.disk.total}`}
          subtitle={stats.host.disk.percent}
          percent={diskNum}
          color={diskNum > 90 ? "destructive" : diskNum > 70 ? "chart-5" : "chart-4"}
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
        {stats.host.uptime && (
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Host Up Since</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium">{stats.host.uptime}</p>
            </CardContent>
          </Card>
        )}
      </div>
      <p className="text-xs text-muted-foreground text-center">
        Auto-refreshes every 5 seconds
      </p>
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
            className={`h-full rounded-full transition-all duration-500 bg-${color}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
