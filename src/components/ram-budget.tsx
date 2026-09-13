"use client";

import { motion } from "motion/react";
import { GAMES, HOST_RAM_GB, type GameId } from "@/lib/games";

/**
 * Shows the server's 8GB memory: filled by whichever game is running, empty
 * when they're all stopped. Makes the one-at-a-time limit clear.
 */
export function RamBudget({ activeGame }: { activeGame: GameId | null }) {
  const used = activeGame ? GAMES[activeGame].ramGb : 0;
  const tint = activeGame ? GAMES[activeGame].tint : "var(--muted-foreground)";
  const pct = Math.min(100, (used / HOST_RAM_GB) * 100);

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="eyebrow text-muted-foreground">Server memory · {HOST_RAM_GB} GB</span>
        <span className="font-mono font-medium" style={{ color: tint }}>
          {used} / {HOST_RAM_GB} GB
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10">
        {/* ghost tick marks per GB */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: HOST_RAM_GB }).map((_, i) => (
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
          ? `${GAMES[activeGame].name} is using the server's memory. Starting another one stops it first.`
          : "All servers are stopped."}
      </p>
    </div>
  );
}
