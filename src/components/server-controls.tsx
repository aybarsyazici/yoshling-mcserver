"use client";

import Image from "next/image";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface ServerStatus {
  status: "online" | "offline" | "starting" | "stopping";
  uptime?: string;
  players?: { online: number; max: number; players: string[] };
  config?: { mcVersion: string; modLoader: string; maxMemory: string };
}

export function ServerControls() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/server/status");
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ status: "offline" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  async function handleAction(action: "start" | "stop" | "restart") {
    setActionPending(true);
    try {
      const res = await fetch("/api/server/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(`Server ${action} command sent`);
        setTimeout(fetchStatus, 3000);
      } else {
        const data = await res.json();
        toast.error(data.error || `Failed to ${action} server`);
      }
    } catch {
      toast.error(`Failed to ${action} server`);
    } finally {
      setActionPending(false);
    }
  }

  if (loading) {
    return <div className="h-48 bg-muted/50 rounded-xl animate-pulse" />;
  }

  const isOnline = status?.status === "online";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Status
            <Badge
              variant="outline"
              className={
                isOnline
                  ? "bg-chart-4/10 text-chart-4 border-chart-4/30"
                  : "bg-destructive/10 text-destructive border-destructive/30"
              }
            >
              <span className={`inline-block h-2 w-2 rounded-full mr-1.5 ${isOnline ? "bg-chart-4 animate-pulse" : "bg-destructive"}`} />
              {status?.status || "unknown"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {status?.uptime && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Uptime</span>
              <span className="font-medium">{status.uptime}</span>
            </div>
          )}
          {status?.players && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Players</span>
              <span className="font-medium">
                {status.players.online} / {status.players.max}
              </span>
            </div>
          )}
          {status?.config && (
            <>
              <div className="border-t border-border/50 pt-3 mt-3" />
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Version</span>
                <Badge variant="secondary" className="font-mono text-xs">
                  {status.config.mcVersion}
                </Badge>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Mod Loader</span>
                <Badge variant="secondary" className="capitalize text-xs">
                  {status.config.modLoader}
                </Badge>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Memory</span>
                <span className="font-medium">{status.config.maxMemory}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full shadow-sm"
            disabled={actionPending || isOnline}
            onClick={() => handleAction("start")}
          >
            Start Server
          </Button>
          <Button
            className="w-full"
            variant="destructive"
            disabled={actionPending || !isOnline}
            onClick={() => handleAction("stop")}
          >
            Stop Server
          </Button>
          <Button
            className="w-full"
            variant="outline"
            disabled={actionPending || !isOnline}
            onClick={() => handleAction("restart")}
          >
            Restart Server
          </Button>
        </CardContent>
      </Card>

      {status?.players && status.players.players.length > 0 && (
        <Card className="border-border/50 shadow-sm md:col-span-2">
          <CardHeader>
            <CardTitle>Online Players</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {status.players.players.map((player) => (
                <Badge key={player} variant="secondary" className="px-3 py-1">
                  {player}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-3 md:col-span-2 pt-2 opacity-80">
        <Image src="/cat.jpg" alt="cat" width={40} height={40} className="rounded-full" />
        <p className="text-xs text-muted-foreground italic">how i feel playing minecraft</p>
      </div>
    </div>
  );
}
