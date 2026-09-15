"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GAMES } from "@/lib/games";
import { useGames } from "@/lib/use-games";

/**
 * A persistent bar, on every page, whenever a long server operation is running.
 *
 * The problem it solves: applying a mod update takes about six minutes — save,
 * stop, download, boot — and used to announce itself nowhere. The power buttons
 * correctly locked out for the whole window but said nothing about why, so the
 * honest reading of the dashboard was that the feature had done nothing at all.
 *
 * Deliberately a banner and not just a toast. A toast disappears after a few
 * seconds; the operation lasts minutes. Anyone who looked thirty seconds late saw
 * silence again, which is the original bug wearing a hat. So: the banner answers
 * "what is happening right now" whenever you happen to look, and toasts fire only
 * on the transitions, to say something *changed*.
 *
 * Driven by the control lock (`busy`) rather than anything update-specific, so it
 * covers every long operation — automatic updates, a manual restart, a memory
 * change — because six minutes of silence is no better when you caused it.
 */
export function OperationBanner() {
  const { busy } = useGames(4000);
  const [now, setNow] = useState(() => Date.now());
  const previous = useRef<string | null>(null);

  // Re-render once a second so the elapsed time actually moves. Without it the
  // banner looks frozen, which is the feeling we are trying to remove.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    const key = busy ? `${busy.game}:${busy.action}` : null;
    if (key === previous.current) return;

    if (key && busy) {
      toast.info(`${GAMES[busy.game].name} is ${verb(busy.action)}`, {
        description: busy.stage ?? "Server controls are locked until it finishes.",
      });
    } else if (previous.current) {
      const [game] = previous.current.split(":");
      toast.success(`${GAMES[game as keyof typeof GAMES]?.name ?? "The server"} is back up`);
    }
    previous.current = key;
  }, [busy]);

  if (!busy) return null;

  const meta = GAMES[busy.game];
  const elapsed = Math.max(0, Math.round((now - busy.since) / 1000));

  return (
    <div
      className="flex flex-shrink-0 items-center gap-3 border-b px-4 py-2 text-sm sm:px-6 lg:px-8"
      style={{
        background: `color-mix(in oklab, ${meta.tint} 10%, transparent)`,
        borderColor: `color-mix(in oklab, ${meta.tint} 25%, transparent)`,
      }}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
          style={{ background: meta.tint }}
        />
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: meta.tint }}
        />
      </span>

      <span className="min-w-0 flex-1 truncate">
        <strong className="font-semibold" style={{ color: meta.tint }}>
          {meta.name}
        </strong>{" "}
        is {verb(busy.action)}
        {busy.stage ? ` — ${busy.stage.toLowerCase()}` : ""}.{" "}
        <span className="text-muted-foreground">
          Controls are locked until it finishes; a restart usually takes about five minutes.
        </span>
      </span>

      <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}

function verb(action: "start" | "stop" | "restart"): string {
  return action === "start" ? "starting up" : action === "stop" ? "shutting down" : "restarting";
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
