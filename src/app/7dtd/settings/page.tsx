"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { SectionHeading } from "@/components/ui-bits";
import { Reveal } from "@/components/motion";
import { PhotoFooter } from "@/components/photo-footer";
import { SdtdAllSettings } from "@/components/sdtd-all-settings";
import { SdtdWorldUpload } from "@/components/sdtd-world-upload";
import { SdtdMaintenance } from "@/components/sdtd-maintenance";
import { MemoryCard } from "@/components/memory-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { GAMES } from "@/lib/games";

/**
 * Only the fields this page can actually change.
 *
 * **Difficulty and Day length used to be here and were deleted**, along with the
 * `DIFFICULTY` preset list. They rendered a Select and a slider for
 * `GameDifficulty` / `DayNightLength`, XML properties that **do not exist** on this
 * server: measured 2026-09-29, the live `sdtdserver.xml` has 69 `<property>` entries
 * and neither of those is among them — modern 7DTD folds both into the sandbox preset,
 * i.e. into Sandbox code. So setting a difficulty stored a number in the DB, produced
 * an amber "that setting had no effect in-game" toast, and then kept displaying the
 * value it had not applied. The API has reported them as `skipped` for a while; the
 * controls simply never read it.
 *
 * **Correction, 2026-10-01.** This used to say the DB columns and the route's `XML_KEYS`
 * entries for them "stay on purpose", because the route "still writes those keys whenever
 * the property does turn out to exist". Both halves are gone now. Nothing can change
 * `gameDifficulty` or `dayLength` any more, so the only thing that mapping could do was
 * write a frozen default nobody chose into a future game version's property — which is the
 * same defect as writing a property that does not exist, one version later. The four dead
 * columns (`gameDifficulty`, `dayLength`, `version`, `maxMemory`) are no longer written at
 * all; dropping them needs a hand-applied production migration.
 *
 * `version` and `maxMemory` were never read either: `/api/7dtd/update` reads the Steam
 * branch off compose, and 7DTD is a native server with no JVM heap to set.
 *
 * `sandboxCode` is the one field here that is **not** read out of the DB row — the GET
 * reads it from `sdtdserver.xml`, because the file has a second writer ("All settings")
 * and the row went stale behind it. See the GET in `/api/7dtd/config`.
 */
interface SdtdConfig {
  serverName: string;
  password: string;
  maxPlayers: number;
  sandboxCode: string;
}

export default function SevenDtdSettings() {
  const tint = GAMES["7dtd"].tint;
  const [config, setConfig] = useState<SdtdConfig>({
    serverName: "Yoshling 7DTD",
    password: "",
    maxPlayers: 8,
    sandboxCode: "",
  });
  // Whether the sandbox code on screen came from `sdtdserver.xml` or from the stored
  // recovery copy, which is only the case before 7DTD's first install has produced the
  // file. A blank box with no explanation reads as "no code set".
  const [sandboxFromFile, setSandboxFromFile] = useState(true);
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
            sandboxCode: data.sandboxCode ?? "",
          });
          setSandboxFromFile(data.sandboxCodeSource !== "db");
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to save");
        return;
      }
      // Redisplay what the server stored, not what was typed. `maxPlayers` is clamped to
      // 1–16, so asking for 99 stored 16 and left "99" in the box — the UI manufacturing a
      // confirmation the server had not given, which is this project's house defect.
      if (data.stored) {
        setConfig((p) => ({
          serverName: data.stored.serverName ?? p.serverName,
          password: data.stored.password ?? p.password,
          maxPlayers: data.stored.maxPlayers ?? p.maxPlayers,
          sandboxCode: data.stored.sandboxCode ?? p.sandboxCode,
        }));
      }
      // `data.warning` is the route being honest and this line used to paint it green.
      // The strings it can hold include "Saved here, but writing the server config
      // failed, so nothing changed on the server: …", "Max players was set to 16, not
      // 99 …" and the sandbox code's "only applies to a new world".
      // A warning rendered as a success is the defect class this whole change is about.
      if (data.warning) toast.warning(data.warning);
      else toast.success("Settings saved. Restart 7DTD to apply.");
    } finally {
      setSaving(false);
    }
  }

  // Shape check, mirrored from `sandboxCodeIssue` in `lib/sdtd-settings.ts`: the textarea
  // only accepts A-Z (so there is nothing for the character check to catch here), and the
  // length rule is a **warning**, not a refusal — one of 23 boot logs on the box printed a
  // code one character short of the rule and nothing explains it, so refusing on length
  // could reject something the game itself emitted. See that file for the measurements.
  const sandboxLooksIncomplete =
    config.sandboxCode.length > 0 && (config.sandboxCode.length - 1) % 3 !== 0;

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

              {/* `max={16}` is a player count, not gigabytes — the hint used to read
                  "1–16 (mind the 8 GB box)", a figure that was wrong twice over: it is a
                  16 GB box, and the number is derived by `maxGameGb()` rather than
                  hardcoded anywhere. */}
              <Field label="Max players" hint="1–16">
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={config.maxPlayers}
                  onChange={(e) => set("maxPlayers", parseInt(e.target.value) || 1)}
                />
              </Field>

              {/* Sandbox code spans both columns — it's long and important. */}
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm">Sandbox code</Label>
                <textarea
                  value={config.sandboxCode}
                  /* A-Z only, uppercased. The old filter was `[^A-Za-z0-9]`, which let
                     digits through — no sandbox code anywhere on this box contains one
                     (the live 94-character preset, the 19-character fresh-install default
                     and the game's own example preset are all A-Z), so a digit is a
                     mis-paste that would be stored and written to the file as-is. */
                  onChange={(e) => set("sandboxCode", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                  placeholder="Paste a sandbox code, or leave blank for defaults"
                  spellCheck={false}
                  rows={2}
                  className="w-full resize-y break-all rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus:ring-2"
                  style={{ ["--tw-ring-color" as string]: `color-mix(in oklab, ${tint} 45%, transparent)` }}
                />
                {/* The one thing this card has to say, and did not.
                    Measured live on 2026-10-01 while Reveo Valley / Fresh2 was running:
                    `getgamepref` over telnet reported `SandboxCode` as exactly the
                    94-character string in sdtdserver.xml — so the file does reach the game
                    — while `BloodMoonEnemyCount` was 8 where that code decodes to
                    `5/16 Enemies`, `ZombieMove` 0 (Walk) where it says `1/Jog`, and
                    `ZombieFeralMove` 3 (Sprint) where it says `4/Nightmare`. The save wins.
                    The previous copy said this was "the only place difficulty and day
                    length can be set", which is true and reads as "so set it here and the
                    server changes" — which is false for the world that exists. */}
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">Applies to a new world only.</span> A 7DTD save
                  keeps the sandbox settings it was created with, so pasting a code here does not change
                  the world that is running — checked against the live server, which reports this exact
                  code and still runs the old zombie speeds and blood-moon count. Starting a fresh save
                  (Server maintenance → Reset world, below) is what applies it.
                </p>
                <p className="text-xs text-muted-foreground">
                  It is still the only place difficulty, loot and XP can be set — current 7DTD versions
                  fold them into this code rather than exposing them as server properties. In 7DTD:{" "}
                  <span className="text-foreground">New Game → Sandbox Options</span>, adjust settings,
                  then <span className="text-foreground">Copy Code</span> and paste it here.
                </p>
                {sandboxLooksIncomplete && (
                  <p className="op-warn text-xs">
                    That looks like a partial code — every code on this server is one letter followed by
                    groups of three, and this one is {config.sandboxCode.length} letters. Saving is
                    allowed; re-copy the whole code if the game ignores it.
                  </p>
                )}
                {!sandboxFromFile && (
                  <p className="op-warn text-xs">
                    Showing the stored copy: the server config file isn&rsquo;t present yet, so this is
                    what will be written once 7DTD finishes its first install.
                  </p>
                )}
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

      {/* Mounted even though 7DTD has no memory setting.
          `/api/games/memory?game=7dtd` has always returned a fully-formed
          `supported: false` plus the sentence explaining why (a Unity native server, no
          JVM heap to size), and 7DTD was the one settings page of three that did not
          render it — so an absent card read as "the feature is missing here" rather than
          "it does not apply here". The card's own `supported` branch shows the reason
          with no control; do NOT invent a slider for it. */}
      <MemoryCard game="7dtd" tint={tint} />

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
