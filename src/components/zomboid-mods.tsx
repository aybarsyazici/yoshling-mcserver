"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, HardDriveDownload, Package, Pencil, Plus, Trash2, X } from "lucide-react";

/**
 * Project Zomboid mod manager.
 *
 * A mod is two things the server keeps in separate .ini lists, and it only works
 * when both are right: the Workshop id it downloads, and the mod id it loads.
 * Every card shows that pair, so a mod that will download but never load is
 * visible rather than mysterious.
 */
interface ZomboidMod {
  workshopId: string;
  title: string;
  previewUrl: string | null;
  /** Mod ids this Workshop item provides. */
  provides: string[];
  /** The subset the server is actually loading. */
  enabled: string[];
  /** Whether the server has already downloaded it. */
  downloaded: boolean;
}

export function ZomboidMods({ tint }: { tint: string }) {
  const [mods, setMods] = useState<ZomboidMod[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/zomboid/mods");
      const data = await res.json();
      if (Array.isArray(data.mods)) setMods(data.mods);
      setOrphans(Array.isArray(data.orphanModIds) ? data.orphanModIds : []);
      setWarning(data.warning ?? null);
    } catch {
      toast.error("Couldn't load the mod list");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/zomboid/mods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't add that mod");
        return;
      }
      setInput("");
      toast.success(`Added ${data.title || data.workshopId}`, {
        description: data.warning ?? "Restart Project Zomboid to download and load it.",
      });
      await load();
    } catch {
      toast.error("Couldn't add that mod");
    } finally {
      setAdding(false);
    }
  }

  async function remove(mod: ZomboidMod) {
    if (!confirm(`Remove ${mod.title || mod.workshopId}? Saves that rely on it may not load.`)) return;
    const res = await fetch(`/api/zomboid/mods?workshopId=${mod.workshopId}`, { method: "DELETE" });
    if (res.ok) {
      setMods((prev) => prev.filter((m) => m.workshopId !== mod.workshopId));
      toast.success("Removed. Restart Project Zomboid to apply.");
    } else {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Couldn't remove that mod");
    }
  }

  async function saveIds(mod: ZomboidMod, raw: string) {
    const modIds = raw
      .split(/[;,\s]+/)
      .map((s) => s.replace(/^\\+/, "").trim())
      .filter(Boolean);
    const res = await fetch("/api/zomboid/mods", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workshopId: mod.workshopId, modIds }),
    });
    if (res.ok) {
      setEditing(null);
      toast.success("Mod ids saved. Restart Project Zomboid to apply.");
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Couldn't save the mod ids");
    }
  }

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: tint }}>
      {/* Add */}
      <form
        onSubmit={add}
        className="space-y-2 rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="pz-mod-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=2169435993"
            spellCheck={false}
            className="font-mono text-sm"
          />
          <Button
            type="submit"
            disabled={adding || !input.trim()}
            className="flex-shrink-0"
            style={{ background: tint, color: "var(--background)" }}
          >
            <Plus className="h-4 w-4" /> {adding ? "Adding…" : "Add mod"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Paste the Steam Workshop link, or just its id. Mods download on the next start and load on
          the one after that.
        </p>
      </form>

      {warning && (
        <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
          <p className="text-xs text-muted-foreground">{warning}</p>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      ) : mods.length === 0 ? (
        <div className="rounded-2xl bg-card/70 py-12 text-center ring-1 ring-foreground/10">
          <Package className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No mods installed. Paste a Workshop link above to add the first one.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {mods.length} mod{mods.length === 1 ? "" : "s"} · they load in the order listed
          </p>
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {mods.map((mod) => (
                <ModRow
                  key={mod.workshopId}
                  mod={mod}
                  tint={tint}
                  editing={editing === mod.workshopId}
                  onEdit={() => setEditing(mod.workshopId)}
                  onCancelEdit={() => setEditing(null)}
                  onSaveIds={(raw) => saveIds(mod, raw)}
                  onRemove={() => remove(mod)}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* Mod ids with no Workshop item behind them */}
      {orphans.length > 0 && (
        <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
          <p className="eyebrow text-muted-foreground">Loaded without a Workshop item</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {orphans.map((id) => (
              <span key={id} className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {id}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            The server loads these but downloads nothing for them — either they were added to the
            .ini by hand, or they live in the server&rsquo;s own mods folder.
          </p>
        </div>
      )}
    </div>
  );
}

function ModRow({
  mod,
  tint,
  editing,
  onEdit,
  onCancelEdit,
  onSaveIds,
  onRemove,
}: {
  mod: ZomboidMod;
  tint: string;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveIds: (raw: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(mod.provides.join("; "));
  const missingId = mod.provides.length === 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex gap-3 rounded-2xl bg-card/70 p-4 ring-1 backdrop-blur sm:gap-4"
      style={{
        boxShadow: missingId
          ? "inset 0 0 0 1px color-mix(in oklab, var(--chart-5) 45%, transparent)"
          : undefined,
      }}
    >
      {/* Thumbnail */}
      <div
        className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-foreground/10 sm:h-16 sm:w-16"
        style={{ background: `color-mix(in oklab, ${tint} 10%, var(--muted))` }}
      >
        {mod.previewUrl ? (
          <Image src={mod.previewUrl} alt="" fill sizes="64px" className="object-cover" unoptimized />
        ) : (
          <span className="grid h-full w-full place-items-center" style={{ color: tint }}>
            <Package className="h-5 w-5 sm:h-6 sm:w-6" />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-semibold">
              {mod.title || `Workshop item ${mod.workshopId}`}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
              <a
                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshopId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                {mod.workshopId}
              </a>
              {/* Downloaded means nothing to do, so it stays quiet. Pending means
                  "restart to fetch it", which is worth reading. */}
              {mod.downloaded ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Check className="h-3 w-3" /> on disk
                </span>
              ) : (
                <span className="inline-flex items-center gap-1" style={{ color: tint }}>
                  <HardDriveDownload className="h-3 w-3" /> downloads on next start
                </span>
              )}
            </p>
          </div>

          {/* The load list sits opposite the name: it's the other half of the
              same fact, and the row has the width for it. */}
          <div className="flex flex-shrink-0 items-center gap-3">
            {!editing && !missingId && (
              <div className="hidden flex-wrap items-center justify-end gap-1.5 sm:flex">
                <span className="text-[11px] text-muted-foreground">loads</span>
                {mod.provides.map((id) => (
                  <ModIdChip key={id} id={id} on={mod.enabled.includes(id)} tint={tint} />
                ))}
              </div>
            )}
            <div className="flex gap-1">
              {!editing && (
                <Button size="sm" variant="ghost" onClick={onEdit} title="Edit mod ids">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onRemove} title="Remove mod">
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </div>

        {/* The load instruction — the half people forget */}
        {editing ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="AuthenticZ; AuthenticZExtra"
              spellCheck={false}
              className="h-9 flex-1 font-mono text-xs"
            />
            <Button size="sm" onClick={() => onSaveIds(draft)} style={{ background: tint, color: "var(--background)" }}>
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelEdit}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : missingId ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-chart-5" />
            No mod id yet, so the server downloads this but won&rsquo;t load it. Start the server
            once to read the id off disk, or add it by hand.
          </p>
        ) : (
          /* Narrow screens: the load list drops under the name instead of beside it */
          <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:hidden">
            <span className="text-[11px] text-muted-foreground">loads</span>
            {mod.provides.map((id) => (
              <ModIdChip key={id} id={id} on={mod.enabled.includes(id)} tint={tint} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** One mod id, struck through when the server isn't actually loading it. */
function ModIdChip({ id, on, tint }: { id: string; on: boolean; tint: string }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[11px]",
        on ? "font-medium" : "text-muted-foreground line-through"
      )}
      style={
        on
          ? { background: `color-mix(in oklab, ${tint} 16%, transparent)`, color: tint }
          : { background: "var(--muted)" }
      }
      title={on ? "in the server's load list" : "not in the server's load list"}
    >
      {id}
    </span>
  );
}
