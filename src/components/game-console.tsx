"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { GAMES, type GameId } from "@/lib/games";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Terminal } from "lucide-react";

// Same UI for every world; only the transport and the example commands differ.
const TRANSPORT: Record<GameId, string> = {
  minecraft: "RCON",
  "7dtd": "telnet",
  zomboid: "RCON",
};

const EXAMPLES: Record<GameId, string> = {
  minecraft: "say Hello · time set day · op Player",
  "7dtd": "say Hello · settime day · listplayers",
  zomboid: "servermsg \"Hello\" · players · save",
};

export function GameConsole({ game }: { game: GameId }) {
  const meta = GAMES[game];
  const endpoint = meta.api.console;
  const [logs, setLogs] = useState("");
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function fetchLogs() {
    try {
      const res = await fetch(`${endpoint}?lines=200`);
      const data = await res.json();
      if (data.logs != null) setLogs(data.logs);
    } catch {}
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
    fetchLogs();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;
    setSending(true);
    setHistory((h) => [command.trim(), ...h].slice(0, 50));
    setHistIdx(-1);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setLogs((prev) => prev + `\n> ${command}\n${data.response ?? ""}\n`);
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

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      if (history[next]) {
        setHistIdx(next);
        setCommand(history[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = histIdx - 1;
      if (next < 0) {
        setHistIdx(-1);
        setCommand("");
      } else {
        setHistIdx(next);
        setCommand(history[next]);
      }
    }
  }

  return (
    <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: meta.tint }}>
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 font-display text-base font-semibold">
          <Terminal className="h-4 w-4" style={{ color: meta.tint }} /> Console
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={fetchLogs}>
            Refresh
          </Button>
          <Button size="sm" variant={autoRefresh ? "default" : "outline"} onClick={() => setAutoRefresh((v) => !v)}>
            {autoRefresh ? "Auto: ON" : "Auto: OFF"}
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scanlines relative h-[460px] overflow-y-auto rounded-xl border border-foreground/10 bg-[#0c0c14] p-4 font-mono text-xs leading-relaxed text-[#a6e3a1]"
        style={{ color: meta.tint }}
      >
        <pre className="relative whitespace-pre-wrap break-all">
          {logs || "// no output yet — is the server running?"}
        </pre>
      </div>

      <form onSubmit={send} className="mt-3 flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm" style={{ color: meta.tint }}>
            ›
          </span>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKey}
            placeholder={EXAMPLES[game]}
            className="pl-7 font-mono text-sm"
            disabled={sending}
          />
        </div>
        <Button type="submit" disabled={sending || !command.trim()}>
          Send
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Sent via {TRANSPORT[game]}. No leading slash needed. ↑/↓ for history.
      </p>
    </div>
  );
}
