"use client";

import { useState } from "react";
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
}

export function ModCard({ mod }: ModCardProps) {
  const [showPackDialog, setShowPackDialog] = useState(false);
  const [modpacks, setModpacks] = useState<SimpleModpack[]>([]);
  const [selectedPack, setSelectedPack] = useState("");
  const [addingToPack, setAddingToPack] = useState(false);

  async function openPackDialog() {
    setShowPackDialog(true);
    const res = await fetch("/api/modpacks");
    const data = await res.json();
    if (Array.isArray(data)) {
      setModpacks(data.map((p: any) => ({ id: p.id, name: p.name })));
    }
  }

  async function handleAddToPack() {
    if (!selectedPack) return;
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
        setShowPackDialog(false);
      } else {
        toast.error("Failed to add to modpack");
      }
    } finally {
      setAddingToPack(false);
    }
  }

  return (
    <>
      <Card className="flex flex-col border-border/50 shadow-sm hover:shadow-md hover:border-primary/30 transition-all group">
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
                title="Add to modpack"
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
                    disabled={!selectedPack || addingToPack}
                  >
                    {addingToPack ? "Adding..." : "Add"}
                  </Button>
                </div>
              </>
            )}
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
