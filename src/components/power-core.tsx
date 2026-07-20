"use client";

import { motion } from "motion/react";
import { useId } from "react";
import { type GameId } from "@/lib/games";
import { usePrefersReducedMotion } from "@/components/motion";

export type CoreState =
  | { kind: "idle" }
  | { kind: "holding"; game: GameId }
  | { kind: "handoff"; from: GameId | null; to: GameId }
  | { kind: "booting"; game: GameId };

const TINT: Record<GameId, string> = {
  minecraft: "var(--mc)",
  "7dtd": "var(--sd)",
};

/**
 * The Power Core — the signature element.
 * A single reactor that can only energize one world at a time, making the
 * host's 8GB "one world at a time" constraint physical and visible.
 */
export function PowerCore({
  state,
  size = 132,
}: {
  state: CoreState;
  size?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const uid = useId().replace(/:/g, "");

  const active =
    state.kind === "holding"
      ? state.game
      : state.kind === "booting"
      ? state.game
      : state.kind === "handoff"
      ? state.to
      : null;

  const tint = active ? TINT[active] : "var(--muted-foreground)";
  const energized = state.kind === "holding" || state.kind === "booting";
  const working = state.kind === "handoff" || state.kind === "booting";

  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size, height: size, ["--tint" as string]: tint }}
    >
      {/* Ambient bloom */}
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle, color-mix(in oklab, ${tint} 55%, transparent) 0%, transparent 68%)`,
          filter: "blur(14px)",
        }}
        animate={
          reduced
            ? { opacity: energized ? 0.6 : 0.2 }
            : {
                opacity: energized ? [0.45, 0.85, 0.45] : working ? [0.3, 0.6, 0.3] : 0.18,
                scale: energized ? [1, 1.12, 1] : 1,
              }
        }
        transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
      />

      <svg viewBox="0 0 120 120" width={size} height={size} className="relative">
        <defs>
          <radialGradient id={`core-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={tint} stopOpacity={energized ? 1 : 0.5} />
            <stop offset="55%" stopColor={tint} stopOpacity={energized ? 0.55 : 0.2} />
            <stop offset="100%" stopColor={tint} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`ring-${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={tint} stopOpacity="0.1" />
            <stop offset="50%" stopColor={tint} stopOpacity="0.9" />
            <stop offset="100%" stopColor={tint} stopOpacity="0.1" />
          </linearGradient>
        </defs>

        {/* Static outer bezel */}
        <circle cx="60" cy="60" r="52" fill="none" stroke="color-mix(in oklab, var(--foreground) 12%, transparent)" strokeWidth="1" />

        {/* Rotating containment rings */}
        <motion.g
          style={{ originX: "60px", originY: "60px" }}
          animate={reduced ? {} : { rotate: 360 }}
          transition={{ duration: working ? 5 : 16, repeat: Infinity, ease: "linear" }}
        >
          <circle
            cx="60" cy="60" r="46" fill="none"
            stroke={`url(#ring-${uid})`}
            strokeWidth="2.5"
            strokeDasharray="10 8"
            strokeLinecap="round"
          />
        </motion.g>
        <motion.g
          style={{ originX: "60px", originY: "60px" }}
          animate={reduced ? {} : { rotate: -360 }}
          transition={{ duration: working ? 8 : 26, repeat: Infinity, ease: "linear" }}
        >
          <circle
            cx="60" cy="60" r="38" fill="none"
            stroke={tint}
            strokeOpacity="0.35"
            strokeWidth="1.5"
            strokeDasharray="2 10"
            strokeLinecap="round"
          />
        </motion.g>

        {/* Core orb */}
        <motion.circle
          cx="60" cy="60"
          fill={`url(#core-${uid})`}
          animate={
            reduced
              ? { r: energized ? 26 : 18 }
              : {
                  r: energized ? [24, 29, 24] : working ? [20, 26, 20] : 16,
                }
          }
          transition={{ duration: working ? 0.9 : 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Bright core dot */}
        <motion.circle
          cx="60" cy="60" r="7"
          fill={tint}
          animate={reduced ? { opacity: energized ? 1 : 0.5 } : { opacity: energized ? [0.8, 1, 0.8] : working ? [0.6, 1, 0.6] : 0.45 }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          style={{ filter: `drop-shadow(0 0 8px ${tint})` }}
        />

        {/* Energy motes during work */}
        {working && !reduced && (
          <motion.g
            style={{ originX: "60px", originY: "60px" }}
            animate={{ rotate: 360 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
          >
            {[0, 120, 240].map((a) => {
              const rad = (a * Math.PI) / 180;
              return (
                <circle
                  key={a}
                  cx={60 + Math.cos(rad) * 34}
                  cy={60 + Math.sin(rad) * 34}
                  r="2.5"
                  fill={tint}
                  style={{ filter: `drop-shadow(0 0 4px ${tint})` }}
                />
              );
            })}
          </motion.g>
        )}
      </svg>
    </div>
  );
}
