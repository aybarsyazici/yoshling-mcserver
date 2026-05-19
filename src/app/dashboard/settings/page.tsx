"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toast } from "sonner";

interface ServerConfig {
  mcVersion: string;
  modLoader: string;
  maxMemory: string;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig>({
    mcVersion: "1.21.4",
    modLoader: "fabric",
    maxMemory: "4G",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/server/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setConfig(data.config);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        toast.success("Settings saved. Restart server to apply changes.");
      } else {
        toast.error("Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Configure your Minecraft server
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="mcVersion">Minecraft Version</Label>
              <Input
                id="mcVersion"
                value={config.mcVersion}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, mcVersion: e.target.value }))
                }
                placeholder="e.g. 1.21.4"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="modLoader">Mod Loader</Label>
              <Select
                value={config.modLoader}
                onValueChange={(v) =>
                  setConfig((prev) => ({ ...prev, modLoader: v ?? prev.modLoader }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fabric">Fabric</SelectItem>
                  <SelectItem value="forge">Forge</SelectItem>
                  <SelectItem value="neoforge">NeoForge</SelectItem>
                  <SelectItem value="quilt">Quilt</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxMemory">Max Memory</Label>
              <Select
                value={config.maxMemory}
                onValueChange={(v) =>
                  setConfig((prev) => ({ ...prev, maxMemory: v ?? prev.maxMemory }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2G">2 GB</SelectItem>
                  <SelectItem value="4G">4 GB</SelectItem>
                  <SelectItem value="6G">6 GB</SelectItem>
                  <SelectItem value="8G">8 GB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="pt-4">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
