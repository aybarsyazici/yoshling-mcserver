"use client";

import { motion } from "motion/react";
import { GAMES, GAME_LIST, type GameId } from "@/lib/games";
import { coResidency, perWorldCeiling, ramNote, ramUse } from "@/lib/coresidency";

/**
 * The box's memory: what every running world is allocated, against the host total.
 * Makes the one-at-a-time limit legible — and, when the limit has been broken, says so.
 *
 * Every number comes from the server (host RAM, each world's configured heap, the
 * per-world ceiling) rather than a constant: a hardcoded 8 GB was still being shown after
 * the box was resized to 16.
 *
 * ## Two things this used to get wrong
 *
 * It took a singular `activeGame` and computed `memoryGb[activeGame] ?? 0`.
 *
 *  1. **It could not show two worlds.** The one element on this page whose job is making
 *     the box's RAM limit legible was structurally unable to show the over-commit that
 *     limit exists to prevent — and that over-commit is a thing that happened, on
 *     2026-09-26, with the box 2.2 GB into swap when it was found.
 *  2. **It read 0 GB whenever 7 Days to Die was the live world.** `memoryGb["7dtd"]` is
 *     `null` *by design* — a Unity native server with no JVM and no heap setting — and
 *     `?? 0` turned that unknown into a zero, so the bar said the box was idle while a
 *     server was running on it. An unmetered world is now rendered as unmetered.
 *
 * The arithmetic and the sentences both live in `lib/coresidency.ts` so they are pinned by
 * tests; this file is the drawing.
 */
export function RamBudget({
  running,
  hostGb,
  maxGb,
  memoryGb,
}: {
  /** Every world with a container up, from `useGames().running`. */
  running: GameId[];
  hostGb: number | null;
  /** `maxGameGb()` — the per-world ceiling, which assumes the world is alone. */
  maxGb: number | null;
  memoryGb: Partial<Record<GameId, number | null>>;
}) {
  const use = ramUse({ running, memoryGb, hostGb });
  const co = coResidency(running);
  const total = hostGb != null ? Math.round(hostGb) : 0;
  /** Something is running and none of it has a heap figure — i.e. 7 Days to Die, alone. */
  const unknownOnly = use.metered.length === 0 && use.unmetered.length > 0;

  // The bar wears the tint of the single running world; with two up there is no single
  // world's accent that would be honest, so it goes amber. `--op-warn` is the token the
  // operation ledger uses for a real warning and it has a value in both themes.
  //
  // What is NOT claimed here: `docs/OPERATIONS.md` records a measured 5.47:1 for
  // `--op-warn`, but that measurement is *text on the ledger's wash*. This is a 12px bar
  // fill on `--muted`, which is a different pair and has not been measured — so the
  // warning is never carried by colour alone. The sentence under the bar says it in
  // words, which is what a reader actually acts on.
  const tint = co.coResident
    ? "var(--op-warn)"
    : running.length === 1
    ? GAMES[running[0]].tint
    : "var(--muted-foreground)";

  /**
   * The ceiling, with the assumption baked into it stated out loud.
   *
   * `maxGameGb()` subtracts a host reserve and *nothing* for whatever else is running, so
   * with Project Zomboid up it will happily offer 13 GB on a box that has about 1 GB left.
   * That has been recorded in `CLAUDE.md` for weeks and nowhere a user could read it.
   *
   * **`forGame` is a world that is NOT running, when there is one.** `perWorldCeiling`
   * excludes its subject from the subtraction, because on a settings page the subject's own
   * heap is the thing being replaced. On this page there is no subject — the question is
   * "how much is left for the next server you might start" — so picking a running world
   * would leave that world's own heap out of the sum and overstate the headroom: with
   * Minecraft (4) and Project Zomboid (12) both up, `forGame: "minecraft"` reports 1 GB
   * free when the honest answer is none.
   */
  const ceiling = perWorldCeiling({
    maxGb,
    forGame: GAME_LIST.find((g) => !running.includes(g.id))?.id ?? running[0],
    running,
    memoryGb,
  });

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="eyebrow text-muted-foreground">
          Server memory{total > 0 ? ` · ${total} GB` : ""}
        </span>
        <span className="font-mono font-medium" style={{ color: tint }}>
          {/* Three cases, and the point of splitting them is that the second must not be
              rendered as the third.
                - nothing metered but something running → "? / 16 GB". 7 Days to Die has no
                  heap setting to report; "0 / 16 GB" said the box was idle while a server
                  ran on it, which is the defect this replaces.
                - a metered world alongside an unmetered one → "12+ / 16 GB". The "+" says
                  the figure is a floor, not the total.
                - everything metered → the plain sum. */}
          {unknownOnly ? "?" : use.meteredGb}
          {use.incomplete && !unknownOnly ? "+" : ""} / {total} GB
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10">
        {/* ghost tick marks per GB */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: Math.max(1, total) }).map((_, i) => (
            <div key={i} className="flex-1 border-r border-background/60 last:border-r-0" />
          ))}
        </div>
        {/* A running world whose usage cannot be measured: hatched across the whole track,
            not left at 0%. An empty bar is a claim ("nothing is using this box") and it was
            the wrong one for every minute 7 Days to Die held the box. Static, not animated
            — an animated fill would claim liveness it does not have, which is this
            codebase's defect class at the animation layer. */}
        {unknownOnly && (
          <div
            className="absolute inset-0"
            style={{
              background: `repeating-linear-gradient(135deg, color-mix(in oklab, ${tint} 38%, transparent) 0 6px, transparent 6px 12px)`,
            }}
            aria-hidden
          />
        )}
        <motion.div
          className="relative h-full rounded-full"
          style={{
            background: `linear-gradient(90deg, color-mix(in oklab, ${tint} 55%, transparent), ${tint})`,
            boxShadow: use.meteredGb > 0 ? `0 0 16px -2px ${tint}` : "none",
          }}
          initial={false}
          animate={{ width: `${use.pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        >
          {use.meteredGb > 0 && (
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
        {/* Where the per-world ceiling sits on the bar, when it is inside it. A line, not
            a fill: it is a limit, not usage. */}
        {maxGb != null && total > 0 && maxGb < total && (
          <div
            className="absolute inset-y-0 w-px bg-foreground/30"
            style={{ left: `${(maxGb / total) * 100}%` }}
            aria-hidden
          />
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{ramNote(use)}</p>
      {/* The ceiling's assumption, said out loud in the one place a user is already
          looking at the box's memory. */}
      {ceiling.note && (
        <p className="mt-1 text-[11px] text-muted-foreground">{ceiling.note}</p>
      )}
    </div>
  );
}
