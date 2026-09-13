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

/**
 * The "All settings" expander, shared by 7 Days to Die (sdtdserver.xml) and
 * Project Zomboid (the server .ini). Both config formats document themselves
 * with a comment per setting, so both endpoints return the same shape and only
 * the grouping, the dropdowns and the copy differ.
 *
 *   GET  <endpoint> → { properties: [{ name, value, help }], warning? }
 *   PUT  <endpoint> ← { updates: { name: value } } → { applied: string[] }
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
}) {
  const [open, setOpen] = useState(false);
  const [props, setProps] = useState<ConfigProperty[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dynamic, setDynamic] = useState<Record<string, SelectOption[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [res, extra] = await Promise.all([
        fetch(endpoint),
        loadDynamicSelects?.().catch(() => ({})) ?? Promise.resolve({}),
      ]);
      setDynamic(extra ?? {});
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
      const data = await res.json();
      if (res.ok) {
        toast.success(`Saved ${data.applied?.length ?? dirty.length} setting(s). ${restartNote}`);
        setProps(
          (prev) =>
            prev?.map((p) => (draft[p.name] !== undefined ? { ...p, value: draft[p.name] } : p)) ??
            prev
        );
      } else {
        toast.error(data.error || "Couldn't save");
      }
    } catch {
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

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
  onChange,
}: {
  prop: ConfigProperty;
  value: string;
  changed: boolean;
  tint: string;
  select?: SelectOption[];
  onChange: (v: string) => void;
}) {
  const type = inferType(prop.value);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-sm">
        <span className="font-mono text-[13px]">{humanize(prop.name)}</span>
        {changed && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: tint }}
            title="changed"
          />
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
