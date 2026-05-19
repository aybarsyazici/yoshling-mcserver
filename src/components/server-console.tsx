"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

export function ServerConsole() {
  const [logs, setLogs] = useState("");
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function fetchLogs() {
    try {
      const res = await fetch("/api/server/console?lines=200");
      const data = await res.json();
      if (data.logs) setLogs(data.logs);
    } catch {}
  }

  useEffect(() => {
    fetchLogs();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  async function handleSendCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;

    setSending(true);
    try {
      const res = await fetch("/api/server/console", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.response) {
          setLogs((prev) => prev + `\n> ${command}\n${data.response}\n`);
        } else {
          setLogs((prev) => prev + `\n> ${command}\n`);
        }
        setCommand("");
      } else {
        toast.error(data.error || "Failed to send command");
      }
    } catch {
      toast.error("Failed to send command");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>Server Console</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchLogs}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant={autoRefresh ? "default" : "outline"}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? "Auto: ON" : "Auto: OFF"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={scrollRef}
          className="h-[500px] overflow-y-auto rounded-lg bg-[#11111b] p-4 font-mono text-xs text-[#cdd6f4] border border-border/50"
        >
          <pre className="whitespace-pre-wrap break-all">{logs || "No logs available. Is the server running?"}</pre>
        </div>
        <form onSubmit={handleSendCommand} className="flex gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Enter server command (e.g. say Hello, time set day, op Player)"
            className="font-mono text-sm"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || !command.trim()}>
            Send
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Commands are sent via RCON. Do not include the leading slash.
        </p>
      </CardContent>
    </Card>
  );
}
