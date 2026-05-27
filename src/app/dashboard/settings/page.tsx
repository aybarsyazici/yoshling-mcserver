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

interface ServerConfig {
  mcVersion: string;
  modLoader: string;
  maxMemory: string;
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
    maxMemory: "4G",
  });
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
          setConfig({ mcVersion: data.mcVersion, modLoader: data.modLoader, maxMemory: data.maxMemory });
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
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) toast.success("Server config saved. Server will restart with new version.");
      else toast.error("Failed to save");
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
      if (res.ok) toast.success("server.properties saved. Restart server to apply.");
      else toast.error("Failed to save");
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
      if (res.ok) toast.success("ops.json saved. Restart server to apply.");
      else toast.error("Failed to save");
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
      if (res.ok) toast.success("whitelist.json saved. Restart server to apply.");
      else toast.error("Failed to save");
    } finally {
      setWlSaving(false);
    }
  }

  function updateProp(key: string, value: string) {
    setProperties((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Configure your Minecraft server
        </p>
      </div>

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
            <div className="space-y-2">
              <Label>Max Memory</Label>
              <Select value={config.maxMemory} onValueChange={(v) => setConfig((p) => ({ ...p, maxMemory: v ?? p.maxMemory }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="2G">2 GB</SelectItem>
                  <SelectItem value="4G">4 GB</SelectItem>
                  <SelectItem value="6G">6 GB</SelectItem>
                  <SelectItem value="8G">8 GB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleSaveConfig} disabled={saving}>
            {saving ? "Saving..." : "Save & Restart Server"}
          </Button>
        </CardContent>
      </Card>

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
    </div>
  );
}
