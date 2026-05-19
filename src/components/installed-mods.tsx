"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface InstalledMod {
  id: string;
  modrinthId: string;
  slug: string;
  name: string;
  version: string;
  fileName: string;
  mcVersion: string;
  loader: string;
  installedAt: string;
}

export function InstalledMods() {
  const [mods, setMods] = useState<InstalledMod[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    fetchMods();
  }, []);

  async function fetchMods() {
    try {
      const res = await fetch("/api/mods/installed");
      const data = await res.json();
      if (Array.isArray(data)) setMods(data);
    } catch {
      toast.error("Failed to load installed mods");
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(mod: InstalledMod) {
    setRemoving(mod.id);
    try {
      const res = await fetch(`/api/mods/${mod.id}`, { method: "DELETE" });
      if (res.ok) {
        setMods((prev) => prev.filter((m) => m.id !== mod.id));
        toast.success(`${mod.name} removed. Restart server to apply.`);
      } else {
        toast.error("Failed to remove mod");
      }
    } catch {
      toast.error("Failed to remove mod");
    } finally {
      setRemoving(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (mods.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-lg">No mods installed</p>
        <p className="text-sm mt-1">Browse and install mods from the search tab</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {mods.length} mod{mods.length !== 1 ? "s" : ""} installed
      </p>
      {mods.map((mod) => (
        <Card key={mod.id}>
          <CardContent className="flex items-center justify-between py-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{mod.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  v{mod.version}
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>MC {mod.mcVersion}</span>
                <span className="text-border">|</span>
                <span className="capitalize">{mod.loader}</span>
                <span className="text-border">|</span>
                <span>{mod.fileName}</span>
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={removing === mod.id}
              onClick={() => handleRemove(mod)}
            >
              {removing === mod.id ? "Removing..." : "Remove"}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
