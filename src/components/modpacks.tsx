"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface ModpackMod {
  id: string;
  modrinthId: string;
  slug: string;
  name: string;
  versionId: string | null;
}

interface Modpack {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  mods: ModpackMod[];
}

interface ExportMod {
  name: string;
  slug: string;
  modrinthId: string;
  fileName: string | null;
  downloadUrl: string | null;
  version: string | null;
}

export function Modpacks() {
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [exportData, setExportData] = useState<{ modpack: any; mods: ExportMod[] } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [showInstallConfirm, setShowInstallConfirm] = useState<string | null>(null);
  const [editingPack, setEditingPack] = useState<Modpack | null>(null);
  const [removeWarning, setRemoveWarning] = useState<{ mod: ModpackMod; dependents: string[] } | null>(null);

  useEffect(() => {
    fetchModpacks();
  }, []);

  async function fetchModpacks() {
    try {
      const res = await fetch("/api/modpacks");
      const data = await res.json();
      if (Array.isArray(data)) setModpacks(data);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/modpacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, description: newDesc }),
      });
      if (res.ok) {
        const pack = await res.json();
        setModpacks((prev) => [pack, ...prev]);
        setShowCreate(false);
        setNewName("");
        setNewDesc("");
        toast.success("Modpack created");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this modpack?")) return;
    const res = await fetch(`/api/modpacks/${id}`, { method: "DELETE" });
    if (res.ok) {
      setModpacks((prev) => prev.filter((p) => p.id !== id));
      toast.success("Modpack deleted");
    }
  }

  async function handleRemoveMod(modpackId: string, modId: string) {
    const res = await fetch(`/api/modpacks/${modpackId}/mods?modId=${modId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setModpacks((prev) =>
        prev.map((p) =>
          p.id === modpackId
            ? { ...p, mods: p.mods.filter((m) => m.id !== modId) }
            : p
        )
      );
    }
  }

  async function checkDependentsAndRemove(pack: Modpack, mod: ModpackMod) {
    const otherMods = pack.mods.filter((m) => m.id !== mod.id);
    const dependents: string[] = [];

    for (const other of otherMods) {
      try {
        const res = await fetch(`/api/mods/dependencies?modrinthId=${other.modrinthId}`);
        const data = await res.json();
        const deps = data.dependencies || [];
        if (deps.some((d: any) => d.modrinthId === mod.modrinthId)) {
          dependents.push(other.name);
        }
      } catch {}
    }

    if (dependents.length > 0) {
      setRemoveWarning({ mod, dependents });
    } else {
      await handleRemoveMod(pack.id, mod.id);
      setEditingPack((prev) =>
        prev ? { ...prev, mods: prev.mods.filter((m) => m.id !== mod.id) } : null
      );
    }
  }

  async function handleExport(modpackId: string) {
    setExporting(modpackId);
    try {
      const res = await fetch(`/api/modpacks/${modpackId}/export`);
      const data = await res.json();
      setExportData(data);
    } catch {
      toast.error("Failed to generate export");
    } finally {
      setExporting(null);
    }
  }

  async function handleInstallToServer(modpackId: string) {
    setShowInstallConfirm(null);
    setInstalling(modpackId);
    try {
      const res = await fetch("/api/mods/install-modpack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modpackId }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(
          `Installed ${data.installed}/${data.total} mods. Restart the server to apply.`
        );
        if (data.errors?.length > 0) {
          toast.warning(`Some mods failed: ${data.errors.join(", ")}`);
        }
      } else {
        toast.error(data.error || "Failed to install modpack");
      }
    } catch {
      toast.error("Failed to install modpack");
    } finally {
      setInstalling(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Create modpacks to group mods together and share with friends
        </p>
        <Button onClick={() => setShowCreate(true)}>Create Modpack</Button>
      </div>

      <div className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-4">
        <p className="text-sm font-medium text-chart-5">Warning</p>
        <p className="text-xs text-muted-foreground mt-1">
          Installing a modpack to the server will <strong>remove all currently installed mods</strong> and
          replace them with the modpack&apos;s mods. Changing mods on an existing world can cause
          corruption or loss of modded items/blocks. It&apos;s recommended to <strong>delete the world
          folder</strong> and start fresh when switching modpacks.
        </p>
      </div>

      {modpacks.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No modpacks yet</p>
          <p className="text-sm mt-1">
            Create a modpack to organize mods into sets
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {modpacks.map((pack) => (
            <Card key={pack.id} className="border-border/50 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-lg">{pack.name}</CardTitle>
                    {pack.description && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {pack.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {pack.mods.length} mod{pack.mods.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingPack(pack)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleExport(pack.id)}
                      disabled={exporting === pack.id || pack.mods.length === 0}
                    >
                      {exporting === pack.id ? "..." : "Export"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setShowInstallConfirm(pack.id)}
                      disabled={installing === pack.id || pack.mods.length === 0}
                    >
                      {installing === pack.id ? "Installing..." : "Install to Server"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDelete(pack.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {pack.mods.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No mods yet. Add mods from the Browse tab using the &quot;+ Add to Pack&quot; button.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pack.mods.map((mod) => (
                      <Badge
                        key={mod.id}
                        variant="secondary"
                        className="py-1 px-2.5"
                      >
                        {mod.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Modpack</DialogTitle>
            <DialogDescription>
              Group mods together so you can install/export them as a set.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <Input
              placeholder="Modpack name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!showInstallConfirm} onOpenChange={() => setShowInstallConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Confirm Installation</DialogTitle>
            <DialogDescription className="pt-2 space-y-2">
              <p>
                This will <strong>remove ALL currently installed mods</strong> from the server
                and replace them with this modpack&apos;s mods.
              </p>
              <p>
                If you have an existing world with modded content, it may become corrupted
                or unplayable. Consider deleting the world folder first (Server &gt; Files &gt; world).
              </p>
              <p className="font-medium">Are you sure?</p>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setShowInstallConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => showInstallConfirm && handleInstallToServer(showInstallConfirm)}
            >
              Yes, replace all mods
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!exportData} onOpenChange={() => setExportData(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Install &quot;{exportData?.modpack.name}&quot; Locally
            </DialogTitle>
            <DialogDescription>
              Download these mods to your local Minecraft{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">mods/</code>{" "}
              folder ({exportData?.modpack.mcVersion} / {exportData?.modpack.loader}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            {exportData?.mods.map((mod) => (
              <div
                key={mod.modrinthId}
                className="flex items-center justify-between border-b border-border/50 pb-2 last:border-0"
              >
                <div>
                  <span className="text-sm font-medium">{mod.name}</span>
                  {mod.version && (
                    <span className="text-xs text-muted-foreground ml-2">
                      v{mod.version}
                    </span>
                  )}
                </div>
                {mod.downloadUrl ? (
                  <a
                    href={mod.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Not available
                  </span>
                )}
              </div>
            ))}
            <div className="pt-3 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Place downloaded .jar files in your Minecraft instance&apos;s{" "}
                <code className="bg-muted px-1 py-0.5 rounded">mods/</code> folder:
              </p>
              <ul className="text-xs text-muted-foreground mt-2 space-y-1 list-disc list-inside">
                <li>Windows: <code className="bg-muted px-1 py-0.5 rounded">%appdata%\.minecraft\mods\</code></li>
                <li>macOS: <code className="bg-muted px-1 py-0.5 rounded">~/Library/Application Support/minecraft/mods/</code></li>
                <li>Linux: <code className="bg-muted px-1 py-0.5 rounded">~/.minecraft/mods/</code></li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingPack} onOpenChange={() => setEditingPack(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit &quot;{editingPack?.name}&quot;</DialogTitle>
            <DialogDescription>
              Remove mods from this modpack.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-2 max-h-[400px] overflow-y-auto">
            {editingPack?.mods.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No mods in this pack.
              </p>
            ) : (
              editingPack?.mods.map((mod) => (
                <div
                  key={mod.id}
                  className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"
                >
                  <span className="text-sm">{mod.name}</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => checkDependentsAndRemove(editingPack, mod)}
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removeWarning} onOpenChange={() => setRemoveWarning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Dependency Warning</DialogTitle>
            <DialogDescription className="pt-2">
              The following mods in this pack require &quot;{removeWarning?.mod.name}&quot;:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 pt-2">
            {removeWarning?.dependents.map((name) => (
              <div key={name} className="flex items-center gap-2 text-sm py-1">
                <Badge variant="outline" className="text-xs text-destructive border-destructive/30">Depends on it</Badge>
                <span>{name}</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Removing this mod may cause the above mods to crash or not load.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setRemoveWarning(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (removeWarning && editingPack) {
                  await handleRemoveMod(editingPack.id, removeWarning.mod.id);
                  setEditingPack((prev) =>
                    prev ? { ...prev, mods: prev.mods.filter((m) => m.id !== removeWarning.mod.id) } : null
                  );
                  setRemoveWarning(null);
                }
              }}
            >
              Remove anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
