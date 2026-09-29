"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GAMES, type GameId } from "@/lib/games";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker, spellMinutes } from "@/lib/operation-ui";
import { AlertTriangle, Check, MemoryStick } from "lucide-react";

interface MemoryState {
  hostGb: number;
  supported: boolean;
  reason?: string;
  configuredGb: number | null;
  liveGb: number | null;
  applied: boolean;
  running: boolean;
  maxGb: number;
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
   * Saving here IS a power operation — `setMemory` holds `POWER_RESOURCES`, saves and
   * stops the world, recreates the container and starts it again. This card never
   * consulted the registry, so during any other power operation Save stayed enabled, the
   * PUT came back 409 and the user got a red toast: the exact "pressed the button, got
   * an unexplained refusal" shape the `can:{}` flags were shipped to remove, on the one
   * settings control that is itself a power operation.
   */
  const { operations, elapsedMs } = useOperations();
  const blocker = powerBlocker(operations, game);

  async function load() {
    try {
      const res = await fetch(`/api/games/memory?game=${game}`);
      const data = await res.json();
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
    if (gb === null) return;
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
      toast.success(
        data.applied
          ? `${meta.name} is set to ${data.configuredGb} GB${data.running ? " and back up" : ""}.`
          : `Saved ${gb} GB, but the container still reports ${data.liveGb} GB.`
      );
    } catch {
      // For Project Zomboid `setMemory` opens with a 300s graceful stop, so the request
      // cannot come back inside Cloudflare's ~100s window — this fired red while the
      // change was being applied perfectly. The configured-vs-live read-back still
      // happens; it just arrives through the strip instead of through this response.
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
  const options = Array.from({ length: state.maxGb }, (_, i) => i + 1);

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
              ? `Heap size for ${meta.name}. This box has ${state.hostGb} GB, and the server's real memory use runs about a gigabyte above its heap — so ${state.maxGb} GB is the most that leaves room for the OS and the dashboard. Going higher gets the server killed, not faster.`
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
                but the current container was created with{" "}
                <strong className="text-foreground">{state.liveGb} GB</strong>. Save again to
                recreate it — a plain restart keeps the old value.
              </p>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3">
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
              disabled={saving || !dirty || blocker !== undefined}
              style={{ background: tint, color: "var(--background)" }}
            >
              {saving ? "Applying…" : "Save memory"}
            </Button>
          </div>

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
                {state.liveGb === null
                  ? `Set to ${state.configuredGb} GB; applies when the server is first started.`
                  : `In effect: the server container is running with ${state.liveGb} GB.`}
              </>
            ) : state.running ? (
              // The downtime, from `GameMeta.stopSeconds` rather than the flat "about a
              // minute" this used to promise for all three worlds. Project Zomboid's stop
              // alone is a measured 5m 03s — it never exits on SIGTERM — so the one world
              // whose heap you are most likely to change understated its own downtime by
              // 5×, and the operation that followed looked hung.
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
