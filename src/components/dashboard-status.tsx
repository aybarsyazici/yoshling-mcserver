"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DashboardStatus() {
  const [status, setStatus] = useState<string | null>(null);
  const [players, setPlayers] = useState<{ online: number; max: number } | null>(null);

  useEffect(() => {
    fetch("/api/server/status")
      .then((r) => r.json())
      .then((data) => {
        setStatus(data.status || "offline");
        if (data.players) setPlayers(data.players);
      })
      .catch(() => setStatus("offline"));
  }, []);

  const isOnline = status === "online";

  return (
    <Card className="border-border/50 shadow-sm hover:shadow-md transition-shadow">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Server Status
        </CardTitle>
        <div className="h-8 w-8 rounded-lg bg-chart-3/10 flex items-center justify-center">
          <div
            className={`h-2.5 w-2.5 rounded-full ${
              status === null
                ? "bg-muted-foreground animate-pulse"
                : isOnline
                ? "bg-chart-4 animate-pulse"
                : "bg-destructive"
            }`}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold capitalize">
          {status === null ? "Checking..." : status}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {status === null
            ? "Connecting..."
            : isOnline && players
            ? `${players.online}/${players.max} players online`
            : isOnline
            ? "Server is running"
            : "Server is stopped"}
        </p>
      </CardContent>
    </Card>
  );
}
