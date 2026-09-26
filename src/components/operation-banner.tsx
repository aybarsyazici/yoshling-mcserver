"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { GAMES, GAME_LIST, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";

/**
 * A bar at the top of every page while a server is doing something slow.
 *
 * It covers two phases that used to be reported very differently:
 *
 *  1. **Our own operation** — save, stop, download mods, start. Tracked by the
 *     control lock, which carries a stage but no percentage, so the bar sweeps.
 *  2. **The server booting** — the long part. The control lock is released the
 *     instant `docker start` returns, but the game then takes minutes to come up.
 *     Driven by `snap.boot`, which has a real stage and percentage.
 *
 * Showing only (1) was the original mistake: the banner appeared for a few seconds
 * and vanished, leaving four silent minutes where a boot is indistinguishable from
 * a hang — exactly the complaint. Both phases now feed one continuous bar.
 *
 * `boot.detail` is the last concrete line the server logged. It matters because a
 * percentage can sit still for a minute during a big mod load; a changing detail
 * line is how you tell "working" from "wedged" without reading logs.
 */
export function OperationBanner() {
  const { games, busy } = useGames(4000);
  const [now, setNow] = useState(() => Date.now());
  const wasActive = useRef<string | null>(null);

  // Prefer whatever we are deliberately doing; otherwise surface a boot.
  const bootingGame: GameId | undefined = GAME_LIST.map((g) => g.id).find(
    (id) => games?.[id]?.status === "starting"
  );
  const game: GameId | undefined = busy?.game ?? bootingGame;
  const snap = game ? games?.[game] : undefined;
  const active = Boolean(busy || bootingGame);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Only the finishing toast survives. The banner already says "in progress"
  // persistently and better; a toast that vanishes in seconds was the thing that
  // made a six-minute operation look like nothing was happening. This one is worth
  // keeping because it fires when you have tabbed away.
  useEffect(() => {
    const key = active && game ? `${game}:${busy?.action ?? "boot"}` : null;
    if (key === wasActive.current) return;
    if (!key && wasActive.current) {
      const [prev] = wasActive.current.split(":") as [GameId];
      toast.success(`${GAMES[prev]?.name ?? "The server"} is ready`);
    }
    wasActive.current = key;
  }, [active, game, busy?.action]);

  if (!active || !game) return null;

  const meta = GAMES[game];
  const boot = snap?.boot;
  // Our own stage wins: it describes what WE are doing, which the server's own
  // boot markers cannot know about.
  const stage = busy?.stage ?? boot?.stage ?? (busy ? verb(busy.action) : "Starting up");
  const percent = busy ? null : boot?.percent ?? null;
  const detail = busy ? undefined : tidy(boot?.detail);
  const since = busy?.since ?? snap?.startedAtMs;
  const elapsed = since ? Math.max(0, Math.round((now - since) / 1000)) : null;

  return (
    <div
      className="flex-shrink-0 border-b px-4 py-2.5 sm:px-6 lg:px-8"
      style={{
        background: `color-mix(in oklab, ${meta.tint} 10%, transparent)`,
        borderColor: `color-mix(in oklab, ${meta.tint} 25%, transparent)`,
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" style={{ color: meta.tint }} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <strong className="font-semibold" style={{ color: meta.tint }}>
              {meta.name}
            </strong>{" "}
            — {stage}
            {percent != null && (
              <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                {percent}%
              </span>
            )}
          </p>
          {detail && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{detail}</p>
          )}
        </div>

        <span className="flex-shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {elapsed != null ? formatElapsed(elapsed) : ""}
        </span>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10">
        <motion.div
          className="h-full rounded-full"
          style={{ background: meta.tint }}
          initial={false}
          // No percentage for our own operations, and none for a game whose boot we
          // cannot measure — sweep rather than invent a number.
          animate={
            percent == null
              ? { width: ["12%", "80%", "12%"], x: ["0%", "25%", "0%"] }
              : { width: `${percent}%`, x: "0%" }
          }
          transition={
            percent == null
              ? { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
              : { type: "spring", stiffness: 90, damping: 22 }
          }
        />
      </div>
    </div>
  );
}

function verb(action: "start" | "stop" | "restart"): string {
  return action === "start" ? "Starting up" : action === "stop" ? "Shutting down" : "Restarting";
}

/**
 * Turn a raw server log line into something worth reading.
 *
 * PZ writes `LOG  : Mod  f:0 st:5,252,142> loading Secretz42`; the part after the
 * last `>` is the only bit anyone cares about.
 */
function tidy(line?: string): string | undefined {
  if (!line) return undefined;
  const after = line.includes(">") ? line.slice(line.lastIndexOf(">") + 1) : line;
  const clean = after.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 120) : undefined;
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
