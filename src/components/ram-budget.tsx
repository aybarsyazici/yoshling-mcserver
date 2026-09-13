"use client";

import { motion } from "motion/react";
import { GAMES, type GameId } from "@/lib/games";

/**
 * The box's memory: filled by whichever game is running, empty when they're all
 * stopped. Makes the one-at-a-time limit clear.
 *
 * Both numbers come from the server (host RAM, and the world's configured heap)
 * rather than constants — a hardcoded 8 GB was still being shown after the box
 * was resized to 16.
 */
export function RamBudget({
  activeGame,
  hostGb,
  memoryGb,
}: {
  activeGame: GameId | null;
  hostGb: number | null;
  memoryGb: Partial<Record<GameId, number | null>>;
}) {
  const total = Math.round(hostGb ?? 0);
  const used = activeGame ? memoryGb[activeGame] ?? 0 : 0;
  const tint = activeGame ? GAMES[activeGame].tint : "var(--muted-foreground)";
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="eyebrow text-muted-foreground">
          Server memory{total > 0 ? ` · ${total} GB` : ""}
        </span>
        <span className="font-mono font-medium" style={{ color: tint }}>
          {used} / {total} GB
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10">
        {/* ghost tick marks per GB */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: Math.max(1, total) }).map((_, i) => (
            <div key={i} className="flex-1 border-r border-background/60 last:border-r-0" />
          ))}
        </div>
        <motion.div
          className="relative h-full rounded-full"
          style={{
            background: `linear-gradient(90deg, color-mix(in oklab, ${tint} 55%, transparent), ${tint})`,
            boxShadow: activeGame ? `0 0 16px -2px ${tint}` : "none",
          }}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        >
          {activeGame && (
            <motion.div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent, color-mix(in oklab, white 30%, transparent), transparent)",
                backgroundSize: "200% 100%",
              }}
              animate={{ backgroundPosition: ["-100% 0", "200% 0"] }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            />
          )}
        </motion.div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {activeGame
          ? `${GAMES[activeGame].name} is allocated ${used} GB of the box's ${total} GB. Starting another one stops it first.`
          : "All servers are stopped."}
      </p>
    </div>
  );
}
