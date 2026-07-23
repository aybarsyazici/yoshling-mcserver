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

interface SdtdProperty {
  name: string;
  value: string;
  help: string;
}

type Opt = { value: string; label: string };

// Known enumerations for a nicer dropdown instead of a raw text box.
// GameWorld is populated dynamically (stock + uploaded worlds) at runtime.
const SELECTS: Record<string, Opt[]> = {
  Region: ["NorthAmericaEast", "NorthAmericaWest", "CentralAmerica", "SouthAmerica", "Europe", "Russia", "Asia", "MiddleEast", "Africa", "Oceania"].map((v) => ({ value: v, label: v })),
  GameMode: [{ value: "GameModeSurvival", label: "Survival" }],
  ServerVisibility: [
    { value: "2", label: "Public (2)" },
    { value: "1", label: "Friends only (1)" },
    { value: "0", label: "Not listed (0)" },
  ],
  PlayerKillingMode: [
    { value: "0", label: "No killing" },
    { value: "1", label: "Kill allies only" },
    { value: "2", label: "Kill strangers only" },
    { value: "3", label: "Kill everyone" },
  ],
};

// Group properties by name prefix / topic so the long list is navigable.
function groupOf(name: string): string {
  if (/^Server(Name|Description|Website|Password|LoginConfirmation|Visibility|Disabled|MaxWorldTransfer|MaxPlayer|Reserved|Admin)/.test(name) || name === "Region" || name === "Language" || name === "ServerPort") return "Server";
  if (/^(WebDashboard|EnableMapRendering|Terminal|EAC|IgnoreEOS|HideCommand|ServerAllowCrossplay)/.test(name)) return "Access & tools";
  if (/^(GameWorld|WorldGen|GameName|GameMode|SaveDataLimit|MaxChunkAge|MaxUncovered|PersistentPlayer)/.test(name)) return "World";
  if (/^LandClaim/.test(name)) return "Land claims";
  if (/^DynamicMesh/.test(name)) return "Dynamic mesh";
  if (/^Twitch/.test(name)) return "Twitch";
  if (/^(Max(Spawned|Queued)|ServerMaxAllowedView|PartyShared)/.test(name)) return "Performance & limits";
  return "Gameplay";
}

const GROUP_ORDER = ["Server", "World", "Gameplay", "Performance & limits", "Land claims", "Dynamic mesh", "Access & tools", "Twitch"];

function inferType(value: string): "boolean" | "number" | "text" {
  if (value === "true" || value === "false") return "boolean";
  if (/^-?\d+$/.test(value)) return "number";
  return "text";
}

function humanize(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function SdtdAllSettings({ tint }: { tint: string }) {
  const [open, setOpen] = useState(false);
  const [props, setProps] = useState<SdtdProperty[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [worlds, setWorlds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [res, wr] = await Promise.all([
        fetch("/api/7dtd/config/all"),
        fetch("/api/7dtd/world").then((r) => r.json()).catch(() => ({})),
      ]);
      if (Array.isArray(wr.allWorlds)) setWorlds(wr.allWorlds);
      const data = await res.json();
      if (data.properties) {
        setProps(data.properties);
        setDraft(Object.fromEntries(data.properties.map((p: SdtdProperty) => [p.name, p.value])));
        if (data.warning) toast.info(data.warning);
      } else {
        toast.error(data.error || "Failed to load settings");
      }
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  // GameWorld dropdown = stock + uploaded worlds (plus whatever's currently set,
  // so an unknown value is still shown/selectable).
  function selectsFor(name: string, currentValue: string): Opt[] | undefined {
    if (name === "GameWorld") {
      const set = new Set<string>(worlds);
      if (currentValue) set.add(currentValue);
      return Array.from(set).map((v) => ({ value: v, label: v }));
    }
    return SELECTS[name];
  }

  useEffect(() => {
    // Load once when first opened. `load`/`props` intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
    if (open && props === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = props ? props.filter((p) => draft[p.name] !== p.value) : [];

  async function save() {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const updates = Object.fromEntries(dirty.map((p) => [p.name, draft[p.name]]));
      const res = await fetch("/api/7dtd/config/all", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Saved ${data.applied?.length ?? dirty.length} setting(s). Restart 7DTD to apply.`);
        setProps((prev) => prev?.map((p) => (draft[p.name] !== undefined ? { ...p, value: draft[p.name] } : p)) ?? prev);
      } else {
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (props ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.help.toLowerCase().includes(q));
  const groups = GROUP_ORDER
    .map((g) => ({ group: g, items: filtered.filter((p) => groupOf(p.name) === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: tint }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}>
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          <span>
            <span className="block font-display text-base font-semibold">All settings</span>
            <span className="block text-xs text-muted-foreground">Every option in sdtdserver.xml — world size, XP, day length, loot, PvP…</span>
          </span>
        </span>
        <ChevronDown className={cn("h-5 w-5 flex-shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
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
                  {/* Search + sticky save bar */}
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter settings…" className="pl-9" />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {dirty.length > 0 ? `${dirty.length} changed` : "No changes"}
                      </span>
                      <Button onClick={save} disabled={saving || dirty.length === 0} style={{ background: tint, color: "var(--background)" }}>
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
                              select={selectsFor(p.name, draft[p.name] ?? p.value)}
                              onChange={(v) => setDraft((d) => ({ ...d, [p.name]: v }))}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No settings match “{query}”.</p>}
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
  prop: SdtdProperty;
  value: string;
  changed: boolean;
  tint: string;
  select?: Opt[];
  onChange: (v: string) => void;
}) {
  const type = inferType(prop.value);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-sm">
        <span className="font-mono text-[13px]">{humanize(prop.name)}</span>
        {changed && <span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} title="changed" />}
      </Label>

      {select ? (
        <Select value={value} onValueChange={(v) => v && onChange(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {select.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : type === "boolean" ? (
        <div className="flex h-9 items-center gap-2">
          <Switch checked={value === "true"} onCheckedChange={(c) => onChange(c ? "true" : "false")} />
          <span className="text-xs text-muted-foreground">{value === "true" ? "Enabled" : "Disabled"}</span>
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
