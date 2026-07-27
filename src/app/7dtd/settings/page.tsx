"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { SectionHeading } from "@/components/ui-bits";
import { Reveal } from "@/components/motion";
import { PhotoFooter } from "@/components/photo-footer";
import { SdtdAllSettings } from "@/components/sdtd-all-settings";
import { SdtdWorldUpload } from "@/components/sdtd-world-upload";
import { SdtdMaintenance } from "@/components/sdtd-maintenance";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GAMES } from "@/lib/games";

interface SdtdConfig {
  serverName: string;
  password: string;
  maxPlayers: number;
  gameDifficulty: number;
  dayLength: number;
  version: string;
  maxMemory: string;
  sandboxCode: string;
}

const DIFFICULTY = [
  { v: 1, label: "Scavenger (easiest)" },
  { v: 2, label: "Adventurer" },
  { v: 3, label: "Nomad" },
  { v: 4, label: "Warrior" },
  { v: 5, label: "Survivalist (hardest)" },
];

export default function SevenDtdSettings() {
  const tint = GAMES["7dtd"].tint;
  const [config, setConfig] = useState<SdtdConfig>({
    serverName: "Yoshling 7DTD",
    password: "",
    maxPlayers: 8,
    gameDifficulty: 2,
    dayLength: 60,
    version: "stable",
    maxMemory: "5G",
    sandboxCode: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/7dtd/config")
      .then((r) => r.json())
      .then((data) => {
        if (data && !data.error) {
          setConfig({
            serverName: data.serverName ?? "Yoshling 7DTD",
            password: data.password ?? "",
            maxPlayers: data.maxPlayers ?? 8,
            gameDifficulty: data.gameDifficulty ?? 2,
            dayLength: data.dayLength ?? 60,
            version: data.version ?? "stable",
            maxMemory: data.maxMemory ?? "5G",
            sandboxCode: data.sandboxCode ?? "",
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/7dtd/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (res.ok) toast.success(data.warning || "Settings saved. Restart 7DTD to apply.");
      else toast.error(data.error || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof SdtdConfig>(key: K, value: SdtdConfig[K]) {
    setConfig((p) => ({ ...p, [key]: value }));
  }

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="7 Days to Die · Settings"
        title="World settings"
        sub="The essentials, written straight into the server config. Restart to apply."
        tint={tint}
      />

      {loading ? (
        <div className="skeleton h-80 rounded-2xl" />
      ) : (
        <Reveal>
          <div className="space-y-6 rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
            <p className="eyebrow text-muted-foreground">Quick settings</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Server name" hint="Shown in the server browser">
                <Input value={config.serverName} onChange={(e) => set("serverName", e.target.value)} maxLength={80} />
              </Field>
              <Field label="Password" hint="Leave blank for a public server">
                <Input
                  type="text"
                  value={config.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder="No password"
                />
              </Field>

              <Field label="Max players" hint="1–16 (mind the 8 GB box)">
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={config.maxPlayers}
                  onChange={(e) => set("maxPlayers", parseInt(e.target.value) || 1)}
                />
              </Field>

              <Field label="Difficulty">
                <Select value={String(config.gameDifficulty)} onValueChange={(v) => v && set("gameDifficulty", parseInt(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIFFICULTY.map((d) => (
                      <SelectItem key={d.v} value={String(d.v)}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Day length" hint="Real minutes per in-game day">
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={10}
                    max={120}
                    step={5}
                    value={config.dayLength}
                    onChange={(e) => set("dayLength", parseInt(e.target.value))}
                    className="flex-1 accent-[var(--tint)]"
                    style={{ accentColor: tint }}
                  />
                  <span className="w-16 text-right font-mono text-sm font-semibold" style={{ color: tint }}>
                    {config.dayLength} min
                  </span>
                </div>
              </Field>

              {/* Sandbox code spans both columns — it's long and important. */}
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm">Sandbox code</Label>
                <textarea
                  value={config.sandboxCode}
                  onChange={(e) => set("sandboxCode", e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
                  placeholder="Paste a sandbox code, or leave blank for defaults"
                  spellCheck={false}
                  rows={2}
                  className="w-full resize-y break-all rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus:ring-2"
                  style={{ ["--tw-ring-color" as string]: `color-mix(in oklab, ${tint} 45%, transparent)` }}
                />
                <p className="text-xs text-muted-foreground">
                  The game&rsquo;s difficulty/loot/XP preset. In 7DTD: <span className="text-foreground">New Game → Sandbox Options</span>, adjust settings, then <span className="text-foreground">Copy Code</span> and paste it here.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 border-t border-border/50 pt-5">
              <Button onClick={save} disabled={saving} style={{ background: tint, color: "var(--background)" }}>
                {saving ? "Saving…" : "Save settings"}
              </Button>
              <p className="text-xs text-muted-foreground">Changes apply on the next server restart.</p>
            </div>
          </div>
        </Reveal>
      )}

      <SdtdMaintenance tint={tint} />

      <SdtdWorldUpload tint={tint} />

      <SdtdAllSettings tint={tint} />

      <PhotoFooter src="/pub-table.jpg" caption="I cant let you get close!" />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
