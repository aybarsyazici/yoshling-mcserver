"use client";

import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";

import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { ModListFilters } from "@/components/mod-list-filters";
import { filterZomboidMods, filterUnpairedModIds, ZOMBOID_MOD_STATES, type ZomboidModStateFilter } from "@/lib/mod-list-filters";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [revision, setRevision] = useState<string | null>(null);
  const [mods, setMods] = useState<ZomboidMod[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  const editEpoch = useRef(0);
  function beginEdit(id: string) { editEpoch.current++; editingRef.current = id; setEditing(id); }
  const closeEdit = useCallback(() => { editingRef.current = null; setEditing(null); }, []);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ZomboidModStateFilter>("all");
  const visibleMods = filterZomboidMods(mods, query, stateFilter);
  const visibleOrphans = filterUnpairedModIds(orphans, query);
  const filtersActive = query.trim().length > 0 || stateFilter !== "all";
  const filtersLocked = editing !== null;
  const resetFilters = () => { setQuery(""); setStateFilter("all"); };

  const load = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    const epoch = editEpoch.current;
    const obsolete = () => background && (editingRef.current !== null || editEpoch.current !== epoch);
    if (obsolete()) return;
    try {
      const res = await fetch("/api/zomboid/mods");
      const data = await res.json();
      if (obsolete()) return;
      if (!res.ok) throw new Error(data?.error || `Couldn't read the mod list (HTTP ${res.status})`);
      if (!isModList(data)) throw new Error("The mod list response is incomplete");
      setRevision(fileRevision(res));
      setMods(data.mods); closeEdit(); setLoadError(null);
      setOrphans(Array.isArray(data.orphanModIds) ? data.orphanModIds : []);
      setWarning(typeof data.warning === "string" ? data.warning : null);
    } catch (error) {
      if (obsolete()) return;
      setLoadError(error instanceof Error ? error.message : "Couldn't load the mod list");
    } finally {
      if (!obsolete()) setLoading(false);
    }
  }, [closeEdit]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // While items are still arriving, poll so the progress bar moves on its own
  // instead of needing a manual refresh.
  const pending = mods.filter((m) => !m.downloaded).length;
  useEffect(() => {
    if (pending === 0 || editing !== null) return;
    const id = setInterval(() => void load({ background: true }), 15000);
    return () => clearInterval(id);
  }, [pending, editing, load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!can.modsInstall || filtersLocked || loading || loadError || !input.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/zomboid/mods", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...revisionHeaders(revision) },
        body: JSON.stringify({ url: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.stale) setLoadError(data.error);
        toast.error(data.error || "Couldn't add that mod");
        return;
      }
      setInput("");
      const deps = (data.addedDependencies ?? []) as { title: string }[];
      const depNote =
        deps.length > 0
          ? `Also added ${deps.length} required mod${deps.length === 1 ? "" : "s"}: ${deps
              .map((d) => d.title)
              .join(", ")}. `
          : "";
      toast.success(`Added ${data.title || data.workshopId}`, {
        description: depNote + (data.warning ?? "Restart Project Zomboid to download and load it."),
      });
      await load();
    } catch {
      toast.error("Couldn't add that mod");
    } finally {
      setAdding(false);
    }
  }

  async function remove(mod: ZomboidMod) {
    if (!can.modsRemove || filtersLocked || loading || loadError) return;
    if (!confirm(`Remove ${mod.title || mod.workshopId}? Saves that rely on it may not load.`)) return;
    try {
      const res = await fetch(`/api/zomboid/mods?workshopId=${mod.workshopId}`, { method: "DELETE", headers: revisionHeaders(revision) });
      if (res.ok) {
        setMods((prev) => prev.filter((m) => m.workshopId !== mod.workshopId));
        toast.success("Removed. Restart Project Zomboid to apply.");
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.stale) setLoadError(data.error);
        toast.error(data.error || "Couldn't remove that mod");
      }
    } catch { setLoadError("The removal result is unconfirmed. Reload the mod list before retrying."); }
  }

  async function saveIds(mod: ZomboidMod, raw: string) {
    if (!can.modsInstall || loading || loadError) return;
    const modIds = raw
      .split(/[;,\s]+/)
      .map((s) => s.replace(/^\\+/, "").trim())
      .filter(Boolean);
    try {
      const res = await fetch("/api/zomboid/mods", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...revisionHeaders(revision) },
        body: JSON.stringify({ workshopId: mod.workshopId, modIds }),
      });
      if (res.ok) {
        closeEdit();
        toast.success("Mod ids saved. Restart Project Zomboid to apply.");
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.stale) setLoadError(data.error);
        toast.error(data.error || "Couldn't save the mod ids");
      }
    } catch { setLoadError("The mod save result is unconfirmed. Reload the mod list before retrying."); }
  }

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: tint }}>
      {/* Add */}
      {can.modsInstall && <form
        onSubmit={add}
        className="space-y-2 rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="pz-mod-input"
            disabled={filtersLocked}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=2169435993"
            spellCheck={false}
            className="font-mono text-sm"
          />
          <Button
            type="submit"
            disabled={filtersLocked || loading || !!loadError || adding || !input.trim()}
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
      </form>}

      {loadError && <div role="alert"><p>{loadError}. Any visible mods are from the last successful read.</p><Button onClick={() => void load()}>Retry mod list</Button></div>}
      {warning && (
        <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
          <p className="text-xs text-muted-foreground">{warning}</p>
        </div>
      )}

      {!loading && (!loadError || mods.length > 0) && <ModListFilters
        searchLabel="Search PZ mods" placeholder="Name, Workshop ID or mod ID"
        query={query} onQueryChange={(value) => { if (!filtersLocked) setQuery(value); }} active={filtersActive} onReset={() => { if (!filtersLocked) resetFilters(); }} disabled={filtersLocked}
        filters={[{ label: "Workshop state", value: stateFilter, options: ZOMBOID_MOD_STATES, onChange: (value) => { if (!filtersLocked) setStateFilter(value as ZomboidModStateFilter); } }]}
        count={`Showing ${visibleMods.length} of ${mods.length} Workshop items · ${visibleOrphans.length} of ${orphans.length} unpaired mod IDs`}
        note={filtersLocked ? "Save or cancel the mod ID edit before changing filters." : "Workshop state filters apply to items. Unpaired mod IDs below are searched by text; the download summary covers all items."} />}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      ) : loadError && mods.length === 0 ? null : mods.length === 0 && orphans.length === 0 ? (
        <div className="rounded-2xl bg-card/70 py-12 text-center ring-1 ring-foreground/10">
          <Package className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {can.modsInstall ? "No mods installed. Paste a Workshop link above to add the first one." : "No mods installed."}
          </p>
        </div>
      ) : (
        <>
          {mods.length > 0 && <ModSummary mods={mods} tint={tint} />}
          {visibleMods.length === 0 && <div className="rounded-2xl bg-card/50 p-6 text-center">
            <p className="text-sm text-muted-foreground">{filtersActive ? "No Workshop items match these filters." : "No Workshop items are recorded."}</p>
            {visibleOrphans.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Matching unpaired mod IDs are shown below.</p>}
            {filtersActive && <Button variant="outline" size="sm" className="mt-3" onClick={resetFilters} disabled={filtersLocked}>Show all mods</Button>}
          </div>}
          <div className="space-y-2" data-mod-list="zomboid">
            <AnimatePresence initial={false}>
              {visibleMods.map((mod) => (
                <ModRow
                  key={mod.workshopId}
                  mod={mod}
                  canEdit={can.modsInstall && !loadError && (editing === null || editing === mod.workshopId)}
                  canRemove={can.modsRemove && !loadError && !filtersLocked}
                  tint={tint}
                  editing={editing === mod.workshopId}
                  onEdit={() => beginEdit(mod.workshopId)}
                  onCancelEdit={closeEdit}
                  onSaveIds={(raw) => saveIds(mod, raw)}
                  onRemove={() => remove(mod)}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* Mod ids with no Workshop item behind them */}
      {visibleOrphans.length > 0 && (
        <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
          <p className="eyebrow text-muted-foreground">Loaded without a Workshop item</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {visibleOrphans.map((id) => (
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
  canEdit, canRemove,
}: {
  mod: ZomboidMod;
  canEdit: boolean; canRemove: boolean;
  tint: string;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveIds: (raw: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(mod.enabled.join("; "));
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
              {canEdit && !editing && (
                <Button size="sm" variant="ghost" onClick={() => { setDraft(mod.enabled.join("; ")); onEdit(); }} title="Edit mod ids">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              {canRemove && <Button size="sm" variant="ghost" onClick={onRemove} title="Remove mod">
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>}
            </div>
          </div>
        </div>

        {/* The load instruction — the half people forget */}
        {editing ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              disabled={!canEdit}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="AuthenticZ; AuthenticZExtra"
              spellCheck={false}
              className="h-9 flex-1 font-mono text-xs"
            />
            <Button size="sm" disabled={!canEdit} onClick={() => onSaveIds(draft)} style={{ background: tint, color: "var(--background)" }}>
              Save
            </Button>
            <Button size="sm" variant="outline" aria-label="Cancel mod edit" onClick={() => { setDraft(mod.enabled.join("; ")); onCancelEdit(); }}>
              <X className="h-3.5 w-3.5" />
            </Button>
            {!canEdit && <p className="w-full text-xs text-muted-foreground">This draft is read-only until editing is available again. Cancel to resume mod list updates, or reload after a read error.</p>}
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

/**
 * How far the download has got, and how many mods can't load yet. Workshop items
 * download on the server's next start (or, for a big list, by pre-seeding with
 * SteamCMD), and until an item is on disk its mod id can't be read — so this is
 * the difference between "still working" and "actually broken".
 */
function ModSummary({ mods, tint }: { mods: ZomboidMod[]; tint: string }) {
  const onDisk = mods.filter((m) => m.downloaded).length;
  const noId = mods.filter((m) => m.provides.length === 0).length;
  const pending = mods.length - onDisk;
  const pct = mods.length > 0 ? Math.round((onDisk / mods.length) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        {/*
         * "they load in the order listed" — which this list is not.
         *
         * The endpoint builds this array from `WorkshopItems=`, the order Steam
         * *downloads* in. Load order is `Mods=`, a different list in a different
         * order: verified on the live .ini 2026-09-29, `WorkshopItems=` starts
         * 3787530735;2799152995;3171184800 while `Mods=` starts
         * \MoodleFramework;\StarlitLibrary;\TrueSmoking — libraries first, which is the
         * whole point, since PZ loads `Mods=` in order and a library has to precede its
         * consumers. One Workshop item can also provide five mod ids, so the two lists
         * are not even the same length. No screen shows the real load order; naming what
         * this one *is* beats asserting what it isn't.
         */}
        <span className="text-muted-foreground">
          {mods.length} mod{mods.length === 1 ? "" : "s"} · listed in install order
        </span>
        <span className="font-mono" style={{ color: pending > 0 ? tint : undefined }}>
          {onDisk} of {mods.length} downloaded
          {pending > 0 ? ` · ${pending} pending` : ""}
          {noId > 0 ? ` · ${noId} without a mod id` : ""}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Load order is set by <span className="font-mono">Mods=</span> in the server config.
      </p>
      {pending > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: tint }}
          />
        </div>
      )}
    </div>
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

function isModList(value: unknown): value is { mods: ZomboidMod[]; orphanModIds: string[]; warning?: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as { mods: ZomboidMod[]; orphanModIds: string[] };
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
  return strings(v.orphanModIds) && Array.isArray(v.mods) && v.mods.every((m) => m && typeof m.workshopId === "string" && typeof m.title === "string" &&
    (m.previewUrl === null || typeof m.previewUrl === "string") && strings(m.provides) && strings(m.enabled) && typeof m.downloaded === "boolean");
}
