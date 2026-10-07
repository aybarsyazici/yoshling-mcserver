"use client";

import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { SectionHeading } from "@/components/ui-bits";
import { PhotoFooter } from "@/components/photo-footer";
import { MemoryCard } from "@/components/memory-card";
import { McGameRules } from "@/components/mc-game-rules";
import { McBansCard } from "@/components/mc-bans-card";
import { GAMES } from "@/lib/games";
import { gameRuleControlHint } from "@/lib/mc-gamerules";
import {
  MC_INERT_HERE,
  MC_SELECTS,
  MC_TEXT_KEYS,
  gameRuleReplacing,
  groupMcProperties,
  mcCouplingNote,
  mcSelectOptions,
} from "@/lib/mc-properties";

interface ServerConfig {
  mcVersion: string;
  modLoader: string;
}

/**
 * `uuid` is optional on the way *out* and always present on the way *in*.
 *
 * This page used to push `uuid: ""` for every name typed in, and Minecraft matches
 * both of these files by UUID and discards an entry it cannot resolve — so the save
 * reported success and granted nobody anything. The routes now resolve the name to
 * the id the game derives (computed locally in offline mode, looked up from Mojang
 * otherwise) and refuse the write if they can't, so there is nothing for the page to
 * send. Don't reintroduce a blank one to satisfy a type: the empty string is exactly
 * the value that made this fail silently.
 */
interface OpEntry {
  uuid?: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

interface WhitelistEntry {
  uuid?: string;
  name: string;
}

function isNameList(value: unknown): value is WhitelistEntry[] {
  return Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" &&
    typeof entry.name === "string" && entry.name.length > 0 &&
    (entry.uuid === undefined || typeof entry.uuid === "string")
  );
}

async function readSettings(url: string, fallback: string): Promise<{ data: unknown; revision: string | null }> {
  const response = await fetch(url);
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = data !== null && typeof data === "object" && "error" in data ? data.error : null;
    throw new Error(typeof error === "string" ? error : fallback);
  }
  return { data, revision: fileRevision(response) };
}

/**
 * The dropdown lists, the "this key is inert" notes and the grouping all come from
 * `@/lib/mc-properties`, which the API route shares. They used to be a `KNOWN_SELECTS`
 * literal in this file, and one of its three entries never matched a value: the file
 * holds `level-type=minecraft\:normal` (java.util.Properties escapes `:`) against the
 * list's `minecraft:normal`, so that select rendered empty on every load.
 */
function inferType(key: string, value: string): "boolean" | "select" | "number" | "text" {
  if (key in MC_SELECTS) return "select";
  if (value === "true" || value === "false") return "boolean";
  // `level-seed` is the reason this is not purely value-shaped: a seed is an opaque
  // 64-bit token that may be negative or a word, and a number input both rejects the
  // minus sign and offers a spinner that can silently nudge a 19-digit seed by one.
  if (MC_TEXT_KEYS.has(key)) return "text";
  if (/^\d+$/.test(value)) return "number";
  return "text";
}

function formatLabel(key: string): string {
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig>({
    mcVersion: "1.21.4",
    modLoader: "fabric",
  });
  const [savedConfig, setSavedConfig] = useState<ServerConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  // What `world/level.dat` says, i.e. what the game itself last wrote. Shown next to the
  // dropdown so the consequence of changing it is visible before the save, not only in
  // the refusal afterwards.
  const [worldVersion, setWorldVersion] = useState<string | null>(null);
  // The route's refusal, held so the user can read it and then explicitly override. Not a
  // toast: a toast lives 4 s and this sentence is several lines of consequence.
  const [versionBlock, setVersionBlock] = useState<string | null>(null);
  const [properties, setProperties] = useState<Record<string, string>>({});
  /**
   * Which keys the user actually touched. The save used to PUT all ~58 properties every
   * time, so the activity log recorded "58 settings edited" for a one-switch change and
   * the route could not tell a real edit from a re-send — which matters now that it
   * reports the keys this Minecraft version ignores: re-sending `pvp` untouched would
   * warn about it on every save and train everyone to ignore the warning.
   */
  const [dirtyProps, setDirtyProps] = useState<Set<string>>(new Set());
  const [propsSaving, setPropsSaving] = useState(false);
  const [opsRevision, setOpsRevision] = useState<string | null>(null);
  const [wlRevision, setWlRevision] = useState<string | null>(null);
  const [propsRevision, setPropsRevision] = useState<string | null>(null);
  const [propsReady, setPropsReady] = useState(false);
  const [propsError, setPropsError] = useState<string | null>(null);
  const [ops, setOps] = useState<OpEntry[] | null>(null);
  const [opsLoading, setOpsLoading] = useState(true);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsSaving, setOpsSaving] = useState(false);
  const [newOp, setNewOp] = useState("");
  const [whitelist, setWhitelist] = useState<WhitelistEntry[] | null>(null);
  const [wlLoading, setWlLoading] = useState(true);
  const [wlError, setWlError] = useState<string | null>(null);
  const [wlSaving, setWlSaving] = useState(false);
  const [newWl, setNewWl] = useState("");

  const loadConfig = useCallback(() => {
    return readSettings("/api/settings", "Could not load the server version.").then(({ data }) => {
      if (!data || typeof data !== "object" || !("mcVersion" in data) ||
          typeof data.mcVersion !== "string" || !data.mcVersion ||
          !("modLoader" in data) || typeof data.modLoader !== "string" || !data.modLoader) {
        throw new Error("The server version response is incomplete. Reload before saving.");
      }
      const current = { mcVersion: data.mcVersion, modLoader: data.modLoader };
      setConfig(current);
      setSavedConfig(current);
      setConfigError(null);
      if ("worldVersion" in data && typeof data.worldVersion === "string") setWorldVersion(data.worldVersion);
    }).catch((error) => {
      setSavedConfig(null);
      setConfigError(error instanceof Error ? error.message : "Could not load the server version.");
    }).finally(() => {
      setConfigLoading(false);
    });
  }, []);

  const loadOps = useCallback(() => {
    return readSettings("/api/server/ops", "Could not load operators.").then(({ data, revision }) => {
      if (!isNameList(data) || !data.every((entry) =>
        "level" in entry && typeof entry.level === "number" && Number.isInteger(entry.level) &&
        entry.level >= 1 && entry.level <= 4 && "bypassesPlayerLimit" in entry &&
        typeof entry.bypassesPlayerLimit === "boolean"
      )) {
        throw new Error("The operators response is incomplete. Reload before editing.");
      }
      setOps(data as OpEntry[]); setOpsRevision(revision);
      setOpsError(null);
    }).catch((error) => {
      setOps(null);
      setOpsError(error instanceof Error ? error.message : "Could not load operators.");
    }).finally(() => {
      setOpsLoading(false);
    });
  }, []);

  const loadWhitelist = useCallback(() => {
    return readSettings("/api/server/mc-whitelist", "Could not load the Minecraft whitelist.").then(({ data, revision }) => {
      if (!isNameList(data)) {
        throw new Error("The Minecraft whitelist response is incomplete. Reload before editing.");
      }
      setWhitelist(data); setWlRevision(revision);
      setWlError(null);
    }).catch((error) => {
      setWhitelist(null);
      setWlError(error instanceof Error ? error.message : "Could not load the Minecraft whitelist.");
    }).finally(() => {
      setWlLoading(false);
    });
  }, []);

  const loadProperties = useCallback(() => readSettings("/api/server/properties", "Could not read server.properties.").then(({ data, revision }) => {
    if (!data || typeof data !== "object" || Array.isArray(data) || "error" in data || !Object.values(data).every((v) => typeof v === "string")) throw new Error("The properties response is incomplete.");
    setProperties(data as Record<string, string>); setPropsRevision(revision); setPropsReady(true); setPropsError(null);
  }).catch((error) => { setPropsReady(false); setPropsError(error instanceof Error ? error.message : "Could not read server.properties."); }), []);

  useEffect(() => {
    void loadConfig();
    void loadOps();
    void loadWhitelist();

    fetch("/api/minecraft-versions")
      .then((r) => r.json())
      .then((data) => { if (data.versions) setMcVersions(data.versions); })
      .catch(() => {});

    void loadProperties();

  }, [loadConfig, loadOps, loadWhitelist, loadProperties]);

  /**
   * `confirm` is the explicit override of the version guard, and it is only ever sent
   * from the second button — the one that appears *after* the route has refused and
   * explained why. Sending it by default would turn the guard back into the unguarded
   * control it replaced.
   */
  async function handleSaveConfig(confirm = false) {
    if (!savedConfig || configLoading || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirm ? { ...config, confirm: true } : config),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A refusal the user can act on, kept on screen rather than toasted: it names the
        // world's version and every mod that disagrees, and the only way past it is the
        // button it reveals.
        if (data.needsConfirm) {
          setVersionBlock(data.error || "That version doesn't match what's on disk.");
          return;
        }
        // This used to be `toast.error("Failed to save")`, which **discarded
        // `data.error`** — throwing away both the 409 busy message and the route's
        // deliberately-worded "Saved … to settings, but applying it to the container
        // failed … The configured and running versions now disagree."
        toast.error(data.error || "Failed to save");
        return;
      }
      // The operation ledger reports the actual container read-back and outcome.
      // An identical DB value can still repair container drift, so this page cannot
      // infer "nothing changed" from its initially loaded configuration.
      setVersionBlock(null);
      setSavedConfig({ ...config });
    } catch {
      // A version change stops and recreates the container, which outlasts
      // Cloudflare's ~100s origin read timeout for a world that takes a while to save.
      toast.info(
        "Still applying the version change. The connection timed out before it finished — watch " +
          "the strip at the top of the page."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveProperties() {
    if (!propsReady || propsSaving) return;
    // Only what was touched. An untouched key resent is indistinguishable from an edit at
    // the route, and it is what made every save log "58 settings edited".
    const changedKeys = [...dirtyProps].filter((k) => k in properties);
    if (changedKeys.length === 0) {
      toast.info("Nothing changed — edit a setting first.");
      return;
    }
    setPropsSaving(true);
    try {
      const res = await fetch("/api/server/properties", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(propsRevision) },
        body: JSON.stringify(Object.fromEntries(changedKeys.map((k) => [k, properties[k]]))),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.stale) { setPropsReady(false); setPropsError(data.error); }
        toast.error(data.error || "Failed to save");
        return;
      }
      // The API only updates keys the file already has, and says which it didn't
      // recognise. Surfacing that is the difference between "saved" and "saved,
      // except the setting you came here for".
      if (Array.isArray(data.ignored) && data.ignored.length > 0) {
        toast.warning(`Not in server.properties, so not written: ${data.ignored.join(", ")}`);
      }
      // `noEffect` is the keys this Minecraft version reads as game rules instead. The
      // fields are read-only, so this should only ever fire for a tab that was open
      // before a version change — but it is the one warning that must not be swallowed,
      // because its whole history is a green toast over a setting that never applied.
      if (Array.isArray(data.noEffect) && data.noEffect.length > 0) {
        toast.warning(data.warning || "Some settings were not written.");
      }
      const applied = Array.isArray(data.applied) ? data.applied.length : changedKeys.length;
      toast.success(
        `server.properties saved (${applied} ${applied === 1 ? "setting" : "settings"}). ` +
          `Restart server to apply.`
      );
      setDirtyProps(new Set());
      await loadProperties();
    } catch {
      toast.error("Failed to save");
    } finally {
      setPropsSaving(false);
    }
  }

  async function handleSaveOps() {
    if (ops === null || opsLoading || opsSaving) return;
    setOpsSaving(true);
    try {
      const res = await fetch("/api/server/ops", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(opsRevision) },
        body: JSON.stringify(ops),
      });
      // The route validates every entry and names the one it rejected, so show
      // its message — "Failed to save" alone leaves no way to tell what was wrong.
      const data = await res.json();
      if (res.ok) { toast.success("ops.json saved. Restart server to apply."); await loadOps(); }
      else { if (data.stale) { setOps(null); setOpsError(data.error); } toast.error(data.error || "Failed to save"); }
    } catch {
      toast.error("Failed to save");
    } finally {
      setOpsSaving(false);
    }
  }

  async function handleSaveWhitelist() {
    if (whitelist === null || wlLoading || wlSaving) return;
    setWlSaving(true);
    try {
      const res = await fetch("/api/server/mc-whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(wlRevision) },
        body: JSON.stringify(whitelist),
      });
      const data = await res.json();
      if (res.ok) { toast.success("whitelist.json saved. Restart server to apply."); await loadWhitelist(); }
      else { if (data.stale) { setWhitelist(null); setWlError(data.error); } toast.error(data.error || "Failed to save"); }
    } catch {
      toast.error("Failed to save");
    } finally {
      setWlSaving(false);
    }
  }

  function updateProp(key: string, value: string) {
    setProperties((prev) => ({ ...prev, [key]: value }));
    setDirtyProps((prev) => new Set(prev).add(key));
  }

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
      <SectionHeading
        eyebrow="Minecraft · Settings"
        title="Server settings"
        sub="Version, resources, game rules, operators, the whitelist, and bans."
        tint={GAMES.minecraft.tint}
      />

      {/* Server Config */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Server Version &amp; Resources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {configLoading && <p className="text-sm text-muted-foreground">Loading server version…</p>}
          {configError && (
            <div role="alert" className="space-y-2">
              <p className="op-warn text-sm">{configError}</p>
              <Button variant="outline" disabled={configLoading} onClick={() => {
                setConfigLoading(true);
                setConfigError(null);
                void loadConfig();
              }}>Retry server version</Button>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Minecraft Version</Label>
              {/* Changing the selection invalidates the refusal that was on screen — a
                  "Change anyway" button left over from a different version would apply
                  something the user was never warned about. */}
              <Select
                value={config.mcVersion}
                disabled={configLoading || savedConfig === null || saving}
                onValueChange={(v) => {
                  setVersionBlock(null);
                  setConfig((p) => ({ ...p, mcVersion: v ?? p.mcVersion }));
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select version" /></SelectTrigger>
                <SelectContent>
                  {/*
                    Mark the one the world records. The list is 30 Modrinth release
                    versions and exactly one of them can open the save, so saying which
                    inside the dropdown is where the information is actually needed.
                  */}
                  {mcVersions.length > 0 ? mcVersions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v === worldVersion ? `${v} — the world's version` : v}
                    </SelectItem>
                  )) : (
                    <SelectItem value={config.mcVersion}>{config.mcVersion}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mod Loader</Label>
              <Select
                value={config.modLoader}
                disabled={configLoading || savedConfig === null || saving}
                onValueChange={(v) => {
                  setVersionBlock(null);
                  setConfig((p) => ({ ...p, modLoader: v ?? p.modLoader }));
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fabric">Fabric</SelectItem>
                  <SelectItem value="forge">Forge</SelectItem>
                  <SelectItem value="neoforge">NeoForge</SelectItem>
                  <SelectItem value="quilt">Quilt</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {/*
            What the world itself says, next to the dropdown that can make it unopenable.
            The dropdown lists 30 Modrinth release versions down to 1.18.2; only the one
            the world records can open the 215 MB save, and a mod loader additionally
            refuses to start when a mod's dependency is unmet. Stating it here is cheaper
            than only refusing later.
          */}
          {worldVersion && (
            <p className="text-xs text-muted-foreground">
              The world on disk was last opened by Minecraft{" "}
              <strong className="text-foreground">{worldVersion}</strong>
              {worldVersion !== config.mcVersion
                ? " — a different version is selected above."
                : "."}{" "}
              Installed mods have to match the version too.
            </p>
          )}

          {versionBlock && (
            <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{versionBlock}</p>
                <div className="flex flex-wrap gap-2">
                  {/* The only place `confirm` is sent. */}
                  <Button size="sm" variant="outline" onClick={() => handleSaveConfig(true)} disabled={saving}>
                    {saving ? "Applying..." : "Change anyway"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setVersionBlock(null);
                      if (savedConfig) setConfig({ ...savedConfig });
                    }}
                    disabled={saving}
                  >
                    Keep {savedConfig?.mcVersion ?? "the current version"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <Button onClick={() => handleSaveConfig()} disabled={saving || configLoading || savedConfig === null}>
            {saving ? "Saving..." : "Save & Restart Server"}
          </Button>
        </CardContent>
      </Card>

      <MemoryCard game="minecraft" tint={GAMES.minecraft.tint} />

      {/* Server Properties */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Game Settings (server.properties)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {propsError ? <div role="alert"><p>{propsError}</p><Button onClick={loadProperties}>Retry properties</Button></div> : !propsReady ? <div className="skeleton h-32" /> : Object.keys(properties).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No server.properties file found. Start the server once to generate it.
            </p>
          ) : (
            <>
              {/*
                Say why the list is short, so a missing key doesn't read as a bug.

                This used to name only "RCON, the server port and the level name", which made
                the omission look deliberate and complete — while the API was in fact also
                printing Minecraft 26's whole `management-server-*` block, bearer token
                included. The list has to name everything that is withheld, or it becomes the
                reason nobody checks.
              */}
              <p className="text-xs text-muted-foreground">
                RCON, the management server, the server port, the bind address and the level
                name aren&apos;t listed here — they&apos;re the dashboard&apos;s own control
                channel, and pointing the bind address at loopback takes the game port and
                RCON down together.
              </p>
              {/*
                Grouped, because this was a flat alphabetical grid of 58 bare labels and
                server.properties — unlike 7DTD's XML and PZ's .ini — carries no comments to
                render help from. Unknown keys land in an "Other" group rather than being
                dropped, so a version that adds a key cannot hide it here.
              */}
              {groupMcProperties(properties).map((group) => (
                <div key={group.title} className="space-y-2">
                  <p className="eyebrow text-muted-foreground">{group.title}</p>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {group.keys.map((key) => {
                      const value = properties[key];
                      const type = inferType(key, value);
                      // The one note that disables the control: this version does not read
                      // the key at all, so an editable field could only ever report a
                      // success that never happened.
                      const gameRule = gameRuleReplacing(key, config.mcVersion);
                      // The field stays read-only — this version really does not read the
                      // key — but the note now points at a control instead of at a command
                      // to type. `gameRuleControlHint` is shared with the properties route's
                      // refusal so the two cannot word it differently.
                      const note = gameRule
                        ? `Minecraft ${config.mcVersion} takes this from the game rule ` +
                          `${gameRule}, not from this file. ${gameRuleControlHint([gameRule])}`
                        : mcCouplingNote(key, properties) ?? MC_INERT_HERE[key] ?? null;
                      return (
                        <div key={key} className="space-y-1.5">
                          <Label className="text-xs font-mono">{formatLabel(key)}</Label>
                          {type === "boolean" ? (
                            <div className="flex items-center gap-2 pt-1">
                              <Switch
                                checked={value === "true"}
                                disabled={!!gameRule}
                                onCheckedChange={(v) => updateProp(key, v ? "true" : "false")}
                              />
                              <span className="text-xs text-muted-foreground">
                                {value === "true" ? "Enabled" : "Disabled"}
                              </span>
                            </div>
                          ) : type === "select" ? (
                            <Select
                              value={value}
                              disabled={!!gameRule}
                              onValueChange={(v) => { if (v) updateProp(key, v); }}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {mcSelectOptions(key, value).map((o) => (
                                  <SelectItem key={o} value={o}>{o}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              className="h-8 text-xs"
                              type={type === "number" ? "number" : "text"}
                              value={value}
                              readOnly={!!gameRule}
                              onChange={(e) => updateProp(key, e.target.value)}
                            />
                          )}
                          {note && (
                            <p className={`text-[11px] leading-snug ${gameRule ? "op-warn" : "text-muted-foreground"}`}>
                              {note}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <Button onClick={handleSaveProperties} disabled={!propsReady || propsSaving || dirtyProps.size === 0}>
                {propsSaving
                  ? "Saving..."
                  : dirtyProps.size === 0
                    ? "Save Properties"
                    : `Save ${dirtyProps.size} ${dirtyProps.size === 1 ? "change" : "changes"}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/*
        Directly under the properties editor, because that editor's read-only fields point
        here by name: on 26.x four of its keys moved into game rules, and until this panel
        existed the only thing it could say was "go type `gamerule pvp false` in the
        console".
      */}
      <McGameRules tint={GAMES.minecraft.tint} />

      {/* Ops */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Operators (ops.json)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Point at this card rather than at the console, because `/op` in the console
            has a failure mode nobody can read: the server resolves the name through its
            profile cache and falls back to a Mojang lookup even with online-mode=false
            (the boot log reports `profilesHost=https://api.mojang.com` regardless), that
            lookup happens on the server thread, and RCON gives up after 3 s — so the
            console answers "The Minecraft server isn't reachable — it may be powered off"
            about a server that is fine and is still working on the command. This card
            never asks Mojang on an offline-mode server: it derives the UUID locally with
            md5("OfflinePlayer:" + name), the same way the game does.
          */}
          <p className="text-xs text-muted-foreground">
            Add operators here rather than with <code>/op</code> in the console. Usernames
            are resolved to the UUID Minecraft matches on when you save.
          </p>
          {opsLoading && <p className="text-sm text-muted-foreground">Loading operators…</p>}
          {opsError && (
            <div role="alert" className="space-y-2">
              <p className="op-warn text-sm">{opsError}</p>
              <Button variant="outline" disabled={opsLoading} onClick={() => {
                setOpsLoading(true);
                setOpsError(null);
                void loadOps();
              }}>Retry operators</Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {ops?.map((op) => (
              <Badge key={op.uuid || op.name} variant="secondary" className="gap-1.5 py-1.5 px-3">
                {op.name}
                <span className="text-[10px] text-muted-foreground ml-1">lvl {op.level}</span>
                <button
                  aria-label={`Remove operator ${op.name}`}
                  disabled={opsLoading || opsSaving}
                  onClick={() => { if (!opsLoading && !opsSaving) setOps((prev) => prev?.filter((o) => o.name !== op.name) ?? null); }}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  x
                </button>
              </Badge>
            ))}
            {ops?.length === 0 && <p className="text-sm text-muted-foreground">No operators</p>}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Minecraft username"
              disabled={ops === null || opsLoading || opsSaving}
              value={newOp}
              onChange={(e) => setNewOp(e.target.value)}
              onKeyDown={(e) => {
                if (ops !== null && !opsLoading && !opsSaving && e.key === "Enter" && newOp.trim()) {
                  setOps((prev) => prev && [...prev, { name: newOp.trim(), level: 4, bypassesPlayerLimit: false }]);
                  setNewOp("");
                }
              }}
              className="max-w-xs"
            />
            <Button variant="outline" disabled={ops === null || opsLoading || opsSaving} onClick={() => {
              if (ops !== null && !opsLoading && !opsSaving && newOp.trim()) {
                setOps((prev) => prev && [...prev, { name: newOp.trim(), level: 4, bypassesPlayerLimit: false }]);
                setNewOp("");
              }
            }}>
              Add Op
            </Button>
          </div>
          <Button onClick={handleSaveOps} disabled={ops === null || opsLoading || opsSaving}>
            {opsSaving ? "Saving..." : "Save Ops"}
          </Button>
        </CardContent>
      </Card>

      {/* Whitelist */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>MC Whitelist (whitelist.json)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Players who can join the server when whitelist is enabled in Game Settings above.
            Usernames are resolved to the UUID Minecraft matches on when you save.
          </p>
          {wlLoading && <p className="text-sm text-muted-foreground">Loading Minecraft whitelist…</p>}
          {wlError && (
            <div role="alert" className="space-y-2">
              <p className="op-warn text-sm">{wlError}</p>
              <Button variant="outline" disabled={wlLoading} onClick={() => {
                setWlLoading(true);
                setWlError(null);
                void loadWhitelist();
              }}>Retry Minecraft whitelist</Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {whitelist?.map((wl) => (
              <Badge key={wl.uuid || wl.name} variant="secondary" className="gap-1.5 py-1.5 px-3">
                {wl.name}
                <button
                  aria-label={`Remove whitelisted player ${wl.name}`}
                  disabled={wlLoading || wlSaving}
                  onClick={() => { if (!wlLoading && !wlSaving) setWhitelist((prev) => prev?.filter((w) => w.name !== wl.name) ?? null); }}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  x
                </button>
              </Badge>
            ))}
            {whitelist?.length === 0 && <p className="text-sm text-muted-foreground">No players whitelisted</p>}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Minecraft username"
              disabled={whitelist === null || wlLoading || wlSaving}
              value={newWl}
              onChange={(e) => setNewWl(e.target.value)}
              onKeyDown={(e) => {
                if (whitelist !== null && !wlLoading && !wlSaving && e.key === "Enter" && newWl.trim()) {
                  setWhitelist((prev) => prev && [...prev, { name: newWl.trim() }]);
                  setNewWl("");
                }
              }}
              className="max-w-xs"
            />
            <Button variant="outline" disabled={whitelist === null || wlLoading || wlSaving} onClick={() => {
              if (whitelist !== null && !wlLoading && !wlSaving && newWl.trim()) {
                setWhitelist((prev) => prev && [...prev, { name: newWl.trim() }]);
                setNewWl("");
              }
            }}>
              Add Player
            </Button>
          </div>
          <Button onClick={handleSaveWhitelist} disabled={whitelist === null || wlLoading || wlSaving}>
            {wlSaving ? "Saving..." : "Save Whitelist"}
          </Button>
        </CardContent>
      </Card>

      {/*
        The third member of the whitelist/ops set, and deliberately the one card here with
        no Save button: while the server is running a ban is an RCON command that applies
        immediately, so there is no pending-edit state to save. See `mc-bans-card.tsx`.
      */}
      <McBansCard />

      <PhotoFooter src="/the-rizzler.jpg" />
    </div>
  );
}
