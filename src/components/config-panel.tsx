"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SlidersHorizontal, ChevronDown, Search } from "lucide-react";
import type { GameId } from "@/lib/games";
import { fetchLiveSettings } from "@/lib/use-games";
import {
  NEXT_WORLD_LABEL,
  compareSetting,
  compareSettings,
  gameFromConfigEndpoint,
  liveSummaryLine,
  type LiveSettings,
  type LiveVerdict,
} from "@/lib/live-settings";

/**
 * The "All settings" expander, shared by 7 Days to Die (sdtdserver.xml) and
 * Project Zomboid (the server .ini). Both config formats document themselves
 * with a comment per setting, so both endpoints return the same shape and only
 * the grouping, the dropdowns and the copy differ.
 *
 *   GET  <endpoint> → { properties: [{ name, value, help }], warning? }
 *   PUT  <endpoint> ← { updates: { name: value } } → { applied: string[] }
 *
 * It also shows **what the server is actually running** next to what the file says, which
 * is the generalisation of the memory card's configured-versus-live warning — see
 * `lib/live-settings.ts` for why that matters more than the settings themselves. Doing it
 * here covers 7 Days to Die and Project Zomboid at once, because both already share this
 * component.
 */
export interface ConfigProperty {
  name: string;
  value: string;
  help: string;
}

export type SelectOption = { value: string; label: string };

function inferType(value: string): "boolean" | "number" | "text" {
  if (value === "true" || value === "false") return "boolean";
  if (/^-?\d+$/.test(value)) return "number";
  return "text";
}

function humanize(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function ConfigPanel({
  tint,
  endpoint,
  subtitle,
  restartNote,
  groupOrder,
  groupOf,
  selects = {},
  loadDynamicSelects,
  game,
}: {
  tint: string;
  endpoint: string;
  subtitle: string;
  /** What the user has to do for the change to take effect. */
  restartNote: string;
  groupOrder: string[];
  groupOf: (name: string) => string;
  selects?: Record<string, SelectOption[]>;
  /** Options that can only be known at runtime (e.g. the installed world list). */
  loadDynamicSelects?: () => Promise<Record<string, SelectOption[]>>;
  /**
   * Which world these settings belong to, for the configured-versus-live comparison.
   * Inferred from `endpoint` when not given, so the existing wrappers need no change;
   * if neither resolves, the comparison is simply off rather than guessed.
   */
  game?: GameId;
}) {
  const [open, setOpen] = useState(false);
  const [props, setProps] = useState<ConfigProperty[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dynamic, setDynamic] = useState<Record<string, SelectOption[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * What the server says it is running. `null` means "not read", which renders as nothing
   * at all — never as a mismatch. The whole feature is only worth having if that
   * distinction holds, because most of the time two of the three worlds are stopped.
   */
  const [live, setLive] = useState<LiveSettings | null>(null);
  const gameId = game ?? gameFromConfigEndpoint(endpoint);

  async function load() {
    setLoading(true);
    try {
      const [res, extra, liveNow] = await Promise.all([
        fetch(endpoint),
        loadDynamicSelects?.().catch(() => ({})) ?? Promise.resolve({}),
        // In parallel with the config read, so the comparison costs the user no extra
        // wait. A failure answers `null` and the panel just doesn't compare.
        gameId ? fetchLiveSettings(gameId) : Promise.resolve(null),
      ]);
      setDynamic(extra ?? {});
      setLive(liveNow);
      const data = await res.json();
      if (data.properties) {
        setProps(data.properties);
        setDraft(Object.fromEntries(data.properties.map((p: ConfigProperty) => [p.name, p.value])));
        if (data.warning) toast.info(data.warning);
      } else {
        toast.error(data.error || "Couldn't load the settings");
      }
    } catch {
      toast.error("Couldn't load the settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Load once, when first opened. `load`/`props` intentionally excluded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && props === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Known options for a setting, plus whatever it's set to now, so an
   *  unrecognised value is still shown instead of silently blanked. */
  function optionsFor(name: string, current: string): SelectOption[] | undefined {
    const known = dynamic[name] ?? selects[name];
    if (!known) return undefined;
    if (current && !known.some((o) => o.value === current)) {
      return [...known, { value: current, label: current }];
    }
    return known;
  }

  const dirty = props ? props.filter((p) => draft[p.name] !== p.value) : [];

  async function save() {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const updates = Object.fromEntries(dirty.map((p) => [p.name, draft[p.name]]));
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't save");
        return;
      }

      // `applied` and `ignored` are what the route actually did, and both were thrown
      // away here. `applied: []` toasted a green "Saved 0 setting(s)", and `ignored` —
      // returned for exactly this purpose, e.g. 7DTD's Difficulty and Day length, which
      // are not properties this server's XML has — was never read at all.
      const applied: string[] = Array.isArray(data.applied) ? data.applied : [];
      const ignored: string[] = Array.isArray(data.ignored) ? data.ignored : [];

      // Only write back what the server says it wrote. This used to optimistically
      // copy EVERY draft value into the displayed props, so a property the server
      // refused was redisplayed as if it had been saved — the UI manufacturing the
      // confirmation the server had declined to give.
      const accepted = new Set(data.applied ? applied : dirty.map((p) => p.name));
      setProps(
        (prev) =>
          prev?.map((p) =>
            accepted.has(p.name) && draft[p.name] !== undefined
              ? { ...p, value: draft[p.name] }
              : p
          ) ?? prev
      );
      // And put the refused fields back to the server's value, so the form stops
      // showing a pending edit that will never land.
      if (ignored.length > 0) {
        setDraft((d) => {
          const next = { ...d };
          for (const p of props ?? []) if (ignored.includes(p.name)) next[p.name] = p.value;
          return next;
        });
      }

      const n = data.applied ? applied.length : dirty.length;
      if (n === 0 && ignored.length > 0) {
        toast.warning(
          `Nothing was saved. ${ignored.join(", ")} ${
            ignored.length === 1 ? "is not a setting" : "are not settings"
          } this server has.`
        );
      } else if (n === 0) {
        toast.warning("Nothing was saved — the server applied none of those settings.");
      } else if (ignored.length > 0) {
        toast.warning(
          `Saved ${n} of ${n + ignored.length} settings. ${ignored.join(", ")} ${
            ignored.length === 1 ? "isn't a setting" : "aren't settings"
          } this server has, so ${ignored.length === 1 ? "it was" : "they were"} not written. ${restartNote}`
        );
      } else {
        toast.success(`Saved ${n} setting${n === 1 ? "" : "s"}. ${restartNote}`);
      }

      // Re-read the live side after a write, because that is the moment the question
      // "did this reach the game?" has an answer worth showing. A saved-but-not-running
      // value is the normal state until a restart, and saying so is the point: the toast
      // can only report what the route wrote, which is exactly the evidence that has been
      // mistaken for success here for months.
      if (gameId) setLive(await fetchLiveSettings(gameId));
    } catch {
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  // Verdicts come from the SAVED values (`p.value`), not the draft: the question is
  // whether what is on disk reached the game, and an unsaved edit has not been claimed
  // to reach anything yet.
  // Nothing to compare before the settings themselves load — and a summary over an empty
  // list would read "0 settings match what the server is running", which is a statement
  // about the config read having failed, worded as a statement about the server.
  const comparison = gameId && props && props.length > 0 ? compareSettings(gameId, props, live) : null;
  const summary = comparison ? liveSummaryLine(comparison, live) : null;

  const q = query.trim().toLowerCase();
  const filtered = (props ?? []).filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.help.toLowerCase().includes(q)
  );
  const groups = groupOrder
    .map((g) => ({ group: g, items: filtered.filter((p) => groupOf(p.name) === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className="rounded-2xl bg-card/70 ring-1 ring-foreground/10 backdrop-blur"
      style={{ ["--tint" as string]: tint }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <span
            className="grid h-9 w-9 place-items-center rounded-lg"
            style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          <span>
            <span className="block font-display text-base font-semibold">All settings</span>
            <span className="block text-xs text-muted-foreground">{subtitle}</span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-5 w-5 flex-shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 p-5">
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="skeleton h-10 rounded-lg" />
                  ))}
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <div className="relative min-w-[200px] flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter settings…"
                        className="pl-9"
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {dirty.length > 0 ? `${dirty.length} changed` : "No changes"}
                      </span>
                      <Button
                        onClick={save}
                        disabled={saving || dirty.length === 0}
                        style={{ background: tint, color: "var(--background)" }}
                      >
                        {saving ? "Saving…" : "Save all"}
                      </Button>
                    </div>
                  </div>

                  {/* Configured versus live, in one sentence.
                      Amber ONLY when something genuinely disagrees — a stopped or silent
                      server reads as muted text saying so, because "I could not ask" and
                      "the answer was different" are different facts and this project's
                      defect class is stating the second when it means the first.
                      No `role="status"`: persistent state, created with its content, which
                      is the case screen readers do not announce anyway (same note as on the
                      co-residency line in `mission-control.tsx`). */}
                  {summary && (
                    <p
                      className={cn(
                        "mb-4 rounded-xl px-4 py-2.5 text-xs",
                        summary.tone === "warn"
                          ? "op-warn ring-1"
                          : "bg-muted/40 text-muted-foreground"
                      )}
                      style={
                        summary.tone === "warn"
                          ? {
                              background: "color-mix(in oklab, var(--op-warn) 10%, transparent)",
                              ["--tw-ring-color" as string]:
                                "color-mix(in oklab, var(--op-warn) 35%, transparent)",
                            }
                          : undefined
                      }
                    >
                      {summary.text}
                      {summary.tone === "warn" ? ` ${restartNote}` : ""}
                    </p>
                  )}

                  <div className="space-y-6">
                    {groups.map(({ group, items }) => (
                      <div key={group}>
                        <p className="eyebrow mb-2 text-muted-foreground">{group}</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          {items.map((p) => (
                            <PropField
                              key={p.name}
                              prop={p}
                              value={draft[p.name] ?? p.value}
                              changed={draft[p.name] !== p.value}
                              tint={tint}
                              select={optionsFor(p.name, draft[p.name] ?? p.value)}
                              verdict={gameId ? compareSetting(gameId, p.name, p.value, live) : null}
                              onChange={(v) => setDraft((d) => ({ ...d, [p.name]: v }))}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        {props === null || props.length === 0
                          ? "Nothing to show yet."
                          : `No settings match “${query}”.`}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PropField({
  prop,
  value,
  changed,
  tint,
  select,
  verdict,
  onChange,
}: {
  prop: ConfigProperty;
  value: string;
  changed: boolean;
  tint: string;
  select?: SelectOption[];
  /** Configured versus live for this one key. `null` = no comparison for this game. */
  verdict?: LiveVerdict | null;
  onChange: (v: string) => void;
}) {
  const type = inferType(prop.value);

  return (
    <div className="space-y-1.5">
      <Label className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-mono text-[13px]">{humanize(prop.name)}</span>
        {changed && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: tint }}
            title="changed"
          />
        )}
        {/* Three of the four verdicts are visible, and which three is the honest part.
            `agrees` says nothing — on a 137-key page a tick per row is noise, and the
            summary above already states the count. `unknown` is only shown for the key
            the server does not report: the other `unknown` (nothing could be asked) is
            stated once in the summary rather than 137 times. */}
        {verdict?.kind === "disagrees" && (
          <span
            className="op-warn rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: "color-mix(in oklab, var(--op-warn) 12%, transparent)" }}
            title={`Saved as ${prop.value || "(empty)"}, but the server is running ${
              verdict.live || "(empty)"
            }.`}
          >
            running: {verdict.live || "(empty)"}
          </span>
        )}
        {verdict?.kind === "next-world" && (
          <span
            className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="The game reads this when it creates a world, so the running server can't be compared against it."
          >
            {NEXT_WORLD_LABEL}
          </span>
        )}
        {verdict?.kind === "unknown" && verdict.why === "not-reported" && (
          <span
            className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={verdict.reason}
          >
            not reported
          </span>
        )}
      </Label>

      {select ? (
        <Select value={value} onValueChange={(v) => v && onChange(v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {select.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : type === "boolean" ? (
        <div className="flex h-9 items-center gap-2">
          <Switch
            checked={value === "true"}
            onCheckedChange={(c) => onChange(c ? "true" : "false")}
          />
          <span className="text-xs text-muted-foreground">
            {value === "true" ? "Enabled" : "Disabled"}
          </span>
        </div>
      ) : (
        <Input
          type={type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {prop.help && <p className="text-[11px] leading-snug text-muted-foreground">{prop.help}</p>}
    </div>
  );
}
