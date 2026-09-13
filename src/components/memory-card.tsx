"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GAMES, type GameId } from "@/lib/games";
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
      toast.error("Couldn't change the memory setting");
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
              disabled={saving || !dirty}
              style={{ background: tint, color: "var(--background)" }}
            >
              {saving ? "Applying…" : "Save memory"}
            </Button>
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            {state.applied && !dirty ? (
              <>
                <Check className="h-3.5 w-3.5" style={{ color: tint }} />
                {state.liveGb === null
                  ? `Set to ${state.configuredGb} GB; applies when the server is first started.`
                  : `In effect: the server container is running with ${state.liveGb} GB.`}
              </>
            ) : state.running ? (
              "Saving saves the world, recreates the container and starts it again — expect about a minute of downtime."
            ) : (
              "The server is stopped, so this applies without starting it."
            )}
          </p>
        </>
      )}
    </div>
  );
}
