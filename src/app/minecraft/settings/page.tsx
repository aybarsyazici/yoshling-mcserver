"use client";

import { useState, useEffect } from "react";
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
import { SectionHeading } from "@/components/ui-bits";
import { PhotoFooter } from "@/components/photo-footer";
import { MemoryCard } from "@/components/memory-card";
import { GAMES } from "@/lib/games";

interface ServerConfig {
  mcVersion: string;
  modLoader: string;
}

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

interface WhitelistEntry {
  uuid: string;
  name: string;
}

// Known select options for specific keys
const KNOWN_SELECTS: Record<string, string[]> = {
  "difficulty": ["peaceful", "easy", "normal", "hard"],
  "gamemode": ["survival", "creative", "adventure", "spectator"],
  "level-type": ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"],
};

function inferType(key: string, value: string): "boolean" | "select" | "number" | "text" {
  if (key in KNOWN_SELECTS) return "select";
  if (value === "true" || value === "false") return "boolean";
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
  const [saving, setSaving] = useState(false);
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [propsSaving, setPropsSaving] = useState(false);
  const [ops, setOps] = useState<OpEntry[]>([]);
  const [opsSaving, setOpsSaving] = useState(false);
  const [newOp, setNewOp] = useState("");
  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [wlSaving, setWlSaving] = useState(false);
  const [newWl, setNewWl] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.mcVersion) {
          setConfig({ mcVersion: data.mcVersion, modLoader: data.modLoader });
          // Kept so Save can tell "applied a change" from "pressed Save on the values
          // that were already there" — the two produce completely different server
          // behaviour and used to produce the same green toast.
          setSavedConfig({ mcVersion: data.mcVersion, modLoader: data.modLoader });
        }
      })
      .catch(() => {});

    fetch("/api/minecraft-versions")
      .then((r) => r.json())
      .then((data) => { if (data.versions) setMcVersions(data.versions); })
      .catch(() => {});

    fetch("/api/server/properties")
      .then((r) => r.json())
      .then((data) => { if (!data.error) setProperties(data); })
      .catch(() => {});

    fetch("/api/server/ops")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setOps(data); })
      .catch(() => {});

    fetch("/api/server/mc-whitelist")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setWhitelist(data); })
      .catch(() => {});
  }, []);

  async function handleSaveConfig() {
    setSaving(true);
    const changed =
      !savedConfig ||
      savedConfig.mcVersion !== config.mcVersion ||
      savedConfig.modLoader !== config.modLoader;
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // This used to be `toast.error("Failed to save")`, which **discarded
        // `data.error`** — throwing away both the 409 busy message and the route's
        // deliberately-worded "Saved … to settings, but applying it to the container
        // failed … The configured and running versions now disagree."
        toast.error(data.error || "Failed to save");
        return;
      }
      // And the old success text — "Server will restart with new version" — was false
      // twice over: nothing is recreated when nothing changed, and `applyServiceEnv`
      // uses `create` never `up`, so a stopped world stays stopped. When something did
      // change it is a tracked operation, and its completion toast carries the
      // container's read-back version.
      if (!changed) toast.info("Nothing changed — the version and loader are already set to that.");
      else setSavedConfig({ ...config });
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
    setPropsSaving(true);
    try {
      const res = await fetch("/api/server/properties", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(properties),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to save");
        return;
      }
      // The API only updates keys the file already has, and says which it didn't
      // recognise. Surfacing that is the difference between "saved" and "saved,
      // except the setting you came here for".
      if (Array.isArray(data.ignored) && data.ignored.length > 0) {
        toast.warning(`Not in server.properties, so not written: ${data.ignored.join(", ")}`);
      }
      toast.success("server.properties saved. Restart server to apply.");
    } catch {
      toast.error("Failed to save");
    } finally {
      setPropsSaving(false);
    }
  }

  async function handleSaveOps() {
    setOpsSaving(true);
    try {
      const res = await fetch("/api/server/ops", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ops),
      });
      // The route validates every entry and names the one it rejected, so show
      // its message — "Failed to save" alone leaves no way to tell what was wrong.
      const data = await res.json();
      if (res.ok) toast.success("ops.json saved. Restart server to apply.");
      else toast.error(data.error || "Failed to save");
    } catch {
      toast.error("Failed to save");
    } finally {
      setOpsSaving(false);
    }
  }

  async function handleSaveWhitelist() {
    setWlSaving(true);
    try {
      const res = await fetch("/api/server/mc-whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(whitelist),
      });
      const data = await res.json();
      if (res.ok) toast.success("whitelist.json saved. Restart server to apply.");
      else toast.error(data.error || "Failed to save");
    } catch {
      toast.error("Failed to save");
    } finally {
      setWlSaving(false);
    }
  }

  function updateProp(key: string, value: string) {
    setProperties((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
      <SectionHeading
        eyebrow="Minecraft · Settings"
        title="Server settings"
        sub="Version, resources, game rules, operators, and the whitelist."
        tint={GAMES.minecraft.tint}
      />

      {/* Server Config */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Server Version &amp; Resources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Minecraft Version</Label>
              <Select value={config.mcVersion} onValueChange={(v) => setConfig((p) => ({ ...p, mcVersion: v ?? p.mcVersion }))}>
                <SelectTrigger><SelectValue placeholder="Select version" /></SelectTrigger>
                <SelectContent>
                  {mcVersions.length > 0 ? mcVersions.map((v) => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  )) : (
                    <SelectItem value={config.mcVersion}>{config.mcVersion}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mod Loader</Label>
              <Select value={config.modLoader} onValueChange={(v) => setConfig((p) => ({ ...p, modLoader: v ?? p.modLoader }))}>
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
          <Button onClick={handleSaveConfig} disabled={saving}>
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
          {Object.keys(properties).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No server.properties file found. Start the server once to generate it.
            </p>
          ) : (
            <>
              {/* Say why the list is short, so a missing key doesn't read as a bug. */}
              <p className="text-xs text-muted-foreground">
                RCON, the server port and the level name aren&apos;t listed: the deployment owns
                them, and changing them here would cut the dashboard off from the server or leave
                backups pointing at a folder the server no longer writes.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(properties).map(([key, value]) => {
                  const type = inferType(key, value);
                  return (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs font-mono">{formatLabel(key)}</Label>
                      {type === "boolean" ? (
                        <div className="flex items-center gap-2 pt-1">
                          <Switch
                            checked={value === "true"}
                            onCheckedChange={(v) => updateProp(key, v ? "true" : "false")}
                          />
                          <span className="text-xs text-muted-foreground">
                            {value === "true" ? "Enabled" : "Disabled"}
                          </span>
                        </div>
                      ) : type === "select" ? (
                        <Select value={value} onValueChange={(v) => { if (v) updateProp(key, v); }}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {KNOWN_SELECTS[key].map((o) => (
                              <SelectItem key={o} value={o}>{o}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          className="h-8 text-xs"
                          type={type === "number" ? "number" : "text"}
                          value={value}
                          onChange={(e) => updateProp(key, e.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <Button onClick={handleSaveProperties} disabled={propsSaving}>
                {propsSaving ? "Saving..." : "Save Properties"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Ops */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Operators (ops.json)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {ops.map((op) => (
              <Badge key={op.uuid || op.name} variant="secondary" className="gap-1.5 py-1.5 px-3">
                {op.name}
                <span className="text-[10px] text-muted-foreground ml-1">lvl {op.level}</span>
                <button
                  onClick={() => setOps((prev) => prev.filter((o) => o.name !== op.name))}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  x
                </button>
              </Badge>
            ))}
            {ops.length === 0 && <p className="text-sm text-muted-foreground">No operators</p>}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Minecraft username"
              value={newOp}
              onChange={(e) => setNewOp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newOp.trim()) {
                  setOps((prev) => [...prev, { uuid: "", name: newOp.trim(), level: 4, bypassesPlayerLimit: false }]);
                  setNewOp("");
                }
              }}
              className="max-w-xs"
            />
            <Button variant="outline" onClick={() => {
              if (newOp.trim()) {
                setOps((prev) => [...prev, { uuid: "", name: newOp.trim(), level: 4, bypassesPlayerLimit: false }]);
                setNewOp("");
              }
            }}>
              Add Op
            </Button>
          </div>
          <Button onClick={handleSaveOps} disabled={opsSaving}>
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
          </p>
          <div className="flex flex-wrap gap-2">
            {whitelist.map((wl) => (
              <Badge key={wl.uuid || wl.name} variant="secondary" className="gap-1.5 py-1.5 px-3">
                {wl.name}
                <button
                  onClick={() => setWhitelist((prev) => prev.filter((w) => w.name !== wl.name))}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  x
                </button>
              </Badge>
            ))}
            {whitelist.length === 0 && <p className="text-sm text-muted-foreground">No players whitelisted</p>}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Minecraft username"
              value={newWl}
              onChange={(e) => setNewWl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newWl.trim()) {
                  setWhitelist((prev) => [...prev, { uuid: "", name: newWl.trim() }]);
                  setNewWl("");
                }
              }}
              className="max-w-xs"
            />
            <Button variant="outline" onClick={() => {
              if (newWl.trim()) {
                setWhitelist((prev) => [...prev, { uuid: "", name: newWl.trim() }]);
                setNewWl("");
              }
            }}>
              Add Player
            </Button>
          </div>
          <Button onClick={handleSaveWhitelist} disabled={wlSaving}>
            {wlSaving ? "Saving..." : "Save Whitelist"}
          </Button>
        </CardContent>
      </Card>

      <PhotoFooter src="/the-rizzler.jpg" />
    </div>
  );
}
