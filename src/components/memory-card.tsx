"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GAMES, type GameId } from "@/lib/games";
import { useOperations } from "@/components/operations-provider";
import { useGames } from "@/lib/use-games";
import { perWorldCeiling } from "@/lib/coresidency";
import { blockedReason, powerBlocker, spellMinutes } from "@/lib/operation-ui";
import { AlertTriangle, Check, MemoryStick } from "lucide-react";

interface MemoryState {
  hostGb: number | null;
  supported: boolean;
  reason?: string;
  configuredGb: number | null;
  liveGb: number | null;
  applied: boolean;
  running: boolean;
  maxGb: number;
  /** Lowest applicable heap (the service's MIN_MEMORY / -Xms). 1 when there is no floor. */
  minGb?: number;
  configuredLimitGb?: number | null;
  containerLimitGb?: number | null;
  nativeReserveGb?: number;
}

/**
 * Everything after the stop: `docker compose create --force-recreate`, then the boot.
 * An allowance, not a measurement — a Project Zomboid boot with 87 Workshop mods is
 * minutes, and the point of the sentence is that the number is not "about a minute".
 * Deliberately not on `GameMeta`: nothing else needs it, and a second per-game duration
 * table is a second thing to keep true.
 */
const RECREATE_AND_BOOT_SECONDS = 120;

/**
 * Server memory, with proof it took effect.
 *
 * A container's environment is fixed when it's created, so editing the compose
 * file and restarting looks like it worked and doesn't. This shows the value the
 * *existing container* was created with next to the configured one, and saving
 * recreates the container rather than restarting it.
 */
export function MemoryCard({ game, tint }: { game: GameId; tint: string }) {
  const meta = GAMES[game];
  const [state, setState] = useState<MemoryState | null>(null);
  const [gb, setGb] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Saving here IS a power operation — `setMemory` holds power and this world's files, saves and
   * stops the world, recreates the container and starts it again. This card never
   * consulted the registry, so during any other power operation Save stayed enabled, the
   * PUT came back 409 and the user got a red toast: the exact "pressed the button, got
   * an unexplained refusal" shape the `can:{}` flags were shipped to remove, on the one
   * settings control that is itself a power operation.
   */
  const { operations, elapsedMs } = useOperations();
  const blocker = powerBlocker(operations, game);
  // For the ceiling note only: which worlds are up, their heaps, and the raw cap. The same
  // three fields `/home` reads, from the same poll, so the two surfaces cannot disagree
  // about how much of the box is already spoken for.
  const { running, memoryGb, maxGb, can } = useGames(10000);
  const canEdit = can.settings;

  async function load() {
    try {
      const res = await fetch(`/api/games/memory?game=${game}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't read the memory setting");
      setState(data);
      setGb(data.configuredGb ?? null);
    } catch {
      toast.error("Couldn't read the memory setting");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  async function save() {
    if (gb === null || !canEdit) return;
    setSaving(true);
    try {
      const res = await fetch("/api/games/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, gb }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't change the memory setting");
        return;
      }
      setState(data);
      setGb(data.configuredGb ?? gb);
      // The registry owns the operation outcome. A running container does not
      // establish that the game has finished booting.
    } catch {
      // Long recreates or a fallback shutdown can outlive the proxy connection.
      // Loss of that connection does not establish the operation's result.
      toast.info(
        `Still applying the memory change to ${meta.name}. The connection timed out before it ` +
          `finished, which is normal — watch the strip at the top of the page, then reload this ` +
          `page to see the configured and running values.`
      );
    } finally {
      setSaving(false);
    }
  }

  if (!state) return <div className="skeleton h-40 rounded-2xl" />;

  const dirty = state.configuredGb !== gb;
  /**
   * The values that can actually be applied, `minGb`…`maxGb`.
   *
   * It used to start at 1 unconditionally, so Project Zomboid — whose compose block sets
   * `MIN_MEMORY` (`-Xms`) to 2 GB — offered a 1G button that writes `-Xmx1024m` under
   * `-Xms2048m`: a JVM that refuses to start. `setMemory` now refuses that before anything
   * is stopped, but offering an option you will refuse is a worse control than not
   * offering it. `minGb` is 1 for Minecraft, whose single `MEMORY` sets both bounds.
   */
  const minGb = Math.max(1, state.minGb ?? 1);
  const options = Array.from({ length: Math.max(0, state.maxGb - minGb + 1) }, (_, i) => minGb + i);
  const validSelection = gb !== null && Number.isInteger(gb) && gb >= minGb && gb <= state.maxGb;

  /**
   * The ceiling's assumption, said out loud — and deliberately **reported, not enforced**.
   *
   * The service-specific cap includes its container limits. It still assumes one
   * world runs at a time; the same neighbour calculation as `/home` names that assumption.
   *
   * Not a refusal, on purpose. A heap is configuration for the next boot, not an
   * allocation now: with Minecraft stopped and PZ up, changing Minecraft's heap
   * over-commits nothing, and `setMemory` starts a world only if it was already running.
   * Refusing here would be a false "no" for the common case, which is the mirror of the
   * defect this project keeps paying for. Saying it is what the reader needs.
   */
  const ceiling = perWorldCeiling({ maxGb, serviceMaxGb: state.maxGb, forGame: game, running, memoryGb });

  return (
    <div
      className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur"
      style={{ ["--tint" as string]: tint }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}
        >
          <MemoryStick className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold">Server memory</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {state.supported
              ? `Heap size for ${meta.name}. Up to ${state.maxGb} GB is available after the host reserve and ${state.nativeReserveGb ?? 2} GB for native memory below the configured and current container limits.`
              : state.reason}
          </p>
        </div>
      </div>

      {state.supported && (
        <>
          {/* The whole point: what the running container actually has */}
          {!state.applied && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
              <p className="text-xs text-muted-foreground">
                Configured for <strong className="text-foreground">{state.configuredGb} GB</strong>,
                {state.liveGb === null ? (
                  <>; the current container&apos;s heap could not be read. {canEdit ? "Save to recreate it and verify the value." : "An admin or moderator can apply and verify it."}</>
                ) : (
                  <> but the current container was created with{" "}
                    <strong className="text-foreground">{state.liveGb} GB</strong>. {canEdit ? "Save again to recreate it" : "Ask an admin or moderator to recreate it"} — a plain restart keeps the old value.</>
                )}
              </p>
            </div>
          )}

          {canEdit ? <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <p className="eyebrow text-muted-foreground">Allocate</p>
              <div className="inline-flex gap-1 rounded-xl bg-muted/60 p-1 ring-1 ring-foreground/10">
                {options.map((n) => {
                  const active = gb === n;
                  return (
                    <button
                      key={n}
                      onClick={() => setGb(n)}
                      className="rounded-lg px-3 py-1.5 font-mono text-sm font-medium transition-colors"
                      style={
                        active
                          ? {
                              background: `color-mix(in oklab, ${tint} 18%, var(--card))`,
                              color: tint,
                              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint} 40%, transparent)`,
                            }
                          : undefined
                      }
                      aria-pressed={active}
                    >
                      {n}G
                    </button>
                  );
                })}
              </div>
            </div>

            <Button
              onClick={save}
              disabled={saving || !validSelection || (!dirty && state.applied) || blocker !== undefined}
              style={{ background: tint, color: "var(--background)" }}
            >
              {saving ? "Applying…" : "Save memory"}
            </Button>
          </div> : <p className="mt-3 text-xs text-muted-foreground">Changing memory requires the admin or moderator role.</p>}

          {ceiling.note && (
            <p className="mt-3 text-xs text-muted-foreground">{ceiling.note}</p>
          )}

          {/* A newly disabled control without its reason is the defect being fixed, not
              the fix. Same three lines as `game-backups.tsx`. */}
          {blocker && (
            <p className="mt-3 text-xs text-muted-foreground">
              {blockedReason(blocker, elapsedMs(blocker))}
            </p>
          )}

          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            {state.applied && !dirty ? (
              <>
                <Check className="h-3.5 w-3.5" style={{ color: tint }} />
                {`Verified on the ${state.running ? "running" : "stopped"} container: ${state.liveGb} GB.`}
              </>
            ) : state.running ? (
              // The downtime, from `GameMeta.stopSeconds` rather than the flat "about a
              // minute" this used to promise for all three worlds.
              //
              // Deriving it is the point. This comment used to justify itself with "PZ's
              // stop alone is a measured 5m 03s — it never exits on SIGTERM", which was
              // true when written and was corrected on 2026-09-29: the driver now asks the
              // game to `quit` over RCON and it exits in ~12s with code 0, so
              // `GAMES.zomboid.stopSeconds` is 12 and the branch below correctly says
              // "about a minute". A number written into the copy would have gone on
              // promising five minutes of downtime that no longer happens; a number read
              // from the table followed the fix without anyone editing this file.
              meta.stopSeconds >= 120
                ? `Saving saves the world, recreates the container and starts it again. ` +
                  `${meta.name} takes up to ${spellMinutes(meta.stopSeconds)} to stop, so expect ` +
                  `${spellMinutes(meta.stopSeconds + RECREATE_AND_BOOT_SECONDS)} of downtime.`
                : "Saving saves the world, recreates the container and starts it again — expect about a minute of downtime."
            ) : (
              "The server is stopped, so this applies without starting it."
            )}
          </p>
        </>
      )}
    </div>
  );
}
