"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronDown, ChevronUp, Map as MapIcon, Plus } from "lucide-react";

interface MapEntry {
  name: string;
  workshopId: string;
  modId: string;
  title: string;
  cellCount: number;
  order: number;
}
interface Conflict {
  maps: [string, string];
  cells: string[];
}
interface MapsState {
  maps: MapEntry[];
  order: string[];
  conflicts: Conflict[];
  unlisted: string[];
  missing: string[];
  stock: string[];
  configMissing: boolean;
}

/**
 * Map load order and cell conflicts.
 *
 * Two map mods that claim the same 300x300 cell can't both win; `Map=` decides,
 * and the FIRST entry takes precedence. Cells are read off disk, so a conflict
 * here is a fact rather than a guess.
 */
export function ZomboidMaps({ tint }: { tint: string }) {
  const [state, setState] = useState<MapsState | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/zomboid/maps");
      const data = await res.json();
      setState(data);
      setOrder(data.order ?? []);
    } catch {
      toast.error("Couldn't read the map list");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  function move(name: string, delta: number) {
    setOrder((prev) => {
      const i = prev.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/zomboid/maps", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't save the map order");
        return;
      }
      toast.success("Map order saved. Restart Project Zomboid to apply.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (!state) return <div className="skeleton h-48 rounded-2xl" />;

  const dirty = JSON.stringify(order) !== JSON.stringify(state.order);
  const byName = new Map(state.maps.map((m) => [m.name, m]));
  /** Where a name sits in the order being edited; used to say who wins. */
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  return (
    <div
      className="space-y-4 rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur"
      style={{ ["--tint" as string]: tint }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}
        >
          <MapIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold">Maps</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Map mods claim cells on the world grid. Where two claim the same cell, the one higher in
            this list wins — keep the base game last. Cells are read from the installed mods, so the
            conflicts below are real, not guesses.
          </p>
        </div>
      </div>

      {state.configMissing && (
        <p className="text-xs text-muted-foreground">
          No server config yet — start Project Zomboid once and the map list appears here.
        </p>
      )}

      {/* Conflicts first: it's the reason to look at this card */}
      {state.conflicts.length > 0 && (
        <div className="space-y-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <AlertTriangle className="h-3.5 w-3.5 text-chart-5" />
            {state.conflicts.length} overlapping map{state.conflicts.length === 1 ? "" : "s"}
          </p>
          {state.conflicts.map((c) => {
            const [a, b] = c.maps;
            const winner = rank(a) <= rank(b) ? a : b;
            const loser = winner === a ? b : a;
            return (
              <p key={c.maps.join("::")} className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{a}</span> and{" "}
                <span className="font-mono text-foreground">{b}</span> both claim {c.cells.length}{" "}
                cell{c.cells.length === 1 ? "" : "s"} ({c.cells.slice(0, 6).join(", ")}
                {c.cells.length > 6 ? `, +${c.cells.length - 6} more` : ""}).{" "}
                {order.includes(winner) ? (
                  <>
                    <span className="font-mono text-foreground">{winner}</span> wins;{" "}
                    <span className="font-mono">{loser}</span> loses those cells.
                  </>
                ) : (
                  "Neither is in the load order, so neither loads."
                )}
              </p>
            );
          })}
        </div>
      )}

      {/* Load order */}
      {order.length > 0 && (
        <div className="space-y-1">
          <p className="eyebrow text-muted-foreground">Load order · first wins</p>
          {order.map((name, i) => {
            const m = byName.get(name);
            const isStock = state.stock.includes(name);
            const isMissing = state.missing.includes(name);
            return (
              <div
                key={name}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
              >
                <span className="w-5 text-right font-mono text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate font-mono text-sm", isMissing && "text-chart-5")}>
                    {name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {isMissing
                      ? "not installed — remove it or install the mod"
                      : isStock
                      ? "base game"
                      : `${
                          m?.cellCount
                            ? `${m.cellCount} cells`
                            : "no cells — spawn points or basements"
                        }${m?.title ? ` · ${m.title}` : ""}`}
                  </p>
                </div>
                <div className="flex flex-shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === 0}
                    onClick={() => move(name, -1)}
                    title="Higher priority"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === order.length - 1}
                    onClick={() => move(name, 1)}
                    title="Lower priority"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Installed but not loaded — the silent failure for map mods */}
      {state.unlisted.length > 0 && (
        <div className="space-y-2 rounded-xl bg-background/50 p-3 ring-1 ring-foreground/10">
          <p className="text-xs text-muted-foreground">
            Installed but not in the load order, so {state.unlisted.length === 1 ? "it does" : "they do"}{" "}
            nothing in game:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {state.unlisted.map((name) => (
              <button
                key={name}
                onClick={() => setOrder((prev) => [...prev.filter((n) => n !== name), name])}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] transition-colors hover:text-foreground"
                title="Add to the load order"
              >
                <Plus className="h-3 w-3" /> {name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Adding one puts it at the end — move it above the base game to see it.
          </p>
        </div>
      )}

      {(dirty || order.length > 0) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-3">
          <Button
            onClick={save}
            disabled={saving || !dirty}
            style={{ background: tint, color: "var(--background)" }}
          >
            {saving ? "Saving…" : "Save map order"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {dirty ? "Unsaved changes · applies on the next restart" : "Saved."}
          </p>
        </div>
      )}
    </div>
  );
}
