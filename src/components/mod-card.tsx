"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { ModrinthProject } from "@/lib/modrinth";

interface ModCardProps {
  mod: ModrinthProject;
}

interface SimpleModpack {
  id: string;
  name: string;
  mods?: { modrinthId: string }[];
}

interface Dependency {
  modrinthId: string;
  slug: string;
  name: string;
}

export function ModCard({ mod }: ModCardProps) {
  const [showPackDialog, setShowPackDialog] = useState(false);
  const [modpacks, setModpacks] = useState<SimpleModpack[]>([]);
  const [selectedPack, setSelectedPack] = useState("");
  const [addingToPack, setAddingToPack] = useState(false);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [depsFetched, setDepsFetched] = useState(false);
  const [missingDeps, setMissingDeps] = useState<Dependency[]>([]);
  const [showDepsDialog, setShowDepsDialog] = useState(false);
  const [loadingDeps, setLoadingDeps] = useState(false);

  function fetchDepsIfNeeded() {
    if (depsFetched) return;
    setDepsFetched(true);
    fetch(`/api/mods/dependencies?modrinthId=${mod.project_id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.dependencies) setDependencies(data.dependencies);
      })
      .catch(() => {});
  }

  async function openPackDialog() {
    setShowPackDialog(true);
    setSelectedPack("");
    setDependencies([]);
    setMissingDeps([]);
    const res = await fetch("/api/modpacks");
    const data = await res.json();
    if (Array.isArray(data)) {
      setModpacks(data);
    }
  }

  async function handleAddToPack() {
    if (!selectedPack) return;

    setLoadingDeps(true);
    try {
      const depsRes = await fetch(
        `/api/mods/dependencies?modrinthId=${mod.project_id}`
      );
      const depsData = await depsRes.json();
      const deps: Dependency[] = depsData.dependencies || [];
      setDependencies(deps);

      if (deps.length > 0) {
        const pack = modpacks.find((p) => p.id === selectedPack);
        const packModIds = new Set(
          (pack?.mods || []).map((m: any) => m.modrinthId)
        );
        const missing = deps.filter((d) => !packModIds.has(d.modrinthId));

        if (missing.length > 0) {
          setMissingDeps(missing);
          setShowPackDialog(false);
          setShowDepsDialog(true);
          setLoadingDeps(false);
          return;
        }
      }

      await doAddToPack(false);
    } finally {
      setLoadingDeps(false);
    }
  }

  async function doAddToPack(includeDeps: boolean) {
    setAddingToPack(true);
    try {
      const res = await fetch(`/api/modpacks/${selectedPack}/mods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modrinthId: mod.project_id,
          slug: mod.slug,
          name: mod.title,
        }),
      });
      if (res.status === 409) {
        toast.info("Mod already in this modpack");
      } else if (res.ok) {
        toast.success(`Added ${mod.title} to modpack`);
      } else {
        toast.error("Failed to add to modpack");
      }

      if (includeDeps && missingDeps.length > 0) {
        let addedDeps = 0;
        for (const dep of missingDeps) {
          try {
            const depRes = await fetch(`/api/modpacks/${selectedPack}/mods`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                modrinthId: dep.modrinthId,
                slug: dep.slug,
                name: dep.name,
              }),
            });
            if (depRes.ok) addedDeps++;
          } catch {}
        }
        if (addedDeps > 0) {
          toast.success(`Also added ${addedDeps} required dependenc${addedDeps === 1 ? "y" : "ies"}`);
        }
      }
    } finally {
      setAddingToPack(false);
      setShowPackDialog(false);
      setShowDepsDialog(false);
    }
  }

  return (
    <>
      <Card className="flex flex-col border-2 border-border/50 rounded-xl shadow-sm hover:shadow-[0_0_15px_rgba(203,166,247,0.3)] hover:border-[#cba6f7] dark:hover:border-[#cba6f7] hover:border-[#8839ef] transition-all duration-300 group" onMouseEnter={fetchDepsIfNeeded}>
        <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-3">
          {mod.icon_url ? (
            <img
              src={mod.icon_url}
              alt=""
              className="h-11 w-11 rounded-lg object-cover ring-1 ring-border/50"
            />
          ) : (
            <div className="h-11 w-11 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary ring-1 ring-primary/20">
              {mod.title[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm leading-tight truncate group-hover:text-primary transition-colors">
              {mod.title}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              by {mod.author}
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col justify-between gap-3">
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {mod.description}
          </p>
          <div className="space-y-3">
            {depsFetched && dependencies.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/70">Depends on: </span>
                {dependencies.slice(0, 3).map((d) => d.name).join(", ")}
                {dependencies.length > 3 && (
                  <span className="text-muted-foreground"> +{dependencies.length - 3} more</span>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              {mod.categories.slice(0, 3).map((cat) => (
                <Badge key={cat} variant="secondary" className="text-[10px] font-normal">
                  {cat}
                </Badge>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {formatDownloads(mod.downloads)} downloads
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={openPackDialog}
                className="shadow-sm"
              >
                + Add to Pack
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showPackDialog} onOpenChange={setShowPackDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to Modpack</DialogTitle>
            <DialogDescription>
              Add &quot;{mod.title}&quot; to a modpack.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {modpacks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No modpacks yet. Create one from the Modpacks tab first.
              </p>
            ) : (
              <>
                <Select value={selectedPack} onValueChange={(v) => { if (v) setSelectedPack(v); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a modpack" />
                  </SelectTrigger>
                  <SelectContent>
                    {modpacks.map((pack) => (
                      <SelectItem key={pack.id} value={pack.id}>
                        {pack.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setShowPackDialog(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleAddToPack}
                    disabled={!selectedPack || addingToPack || loadingDeps}
                  >
                    {loadingDeps ? "Checking deps..." : addingToPack ? "Adding..." : "Add"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDepsDialog} onOpenChange={setShowDepsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Missing Dependencies</DialogTitle>
            <DialogDescription>
              &quot;{mod.title}&quot; requires the following mods that are not in
              the selected modpack:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            {missingDeps.map((dep) => (
              <div
                key={dep.modrinthId}
                className="flex items-center gap-2 text-sm py-1.5 border-b border-border/50 last:border-0"
              >
                <Badge variant="outline" className="text-xs">Required</Badge>
                <span>{dep.name}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => doAddToPack(false)}
              disabled={addingToPack}
            >
              Add without dependencies
            </Button>
            <Button
              onClick={() => doAddToPack(true)}
              disabled={addingToPack}
            >
              {addingToPack ? "Adding..." : "Add all"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
