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
import { readOperationResponse } from "@/lib/operation-client";
import { toast } from "sonner";
import { ModDetailDialog } from "@/components/mod-detail-dialog";
import { useOperations } from "@/components/operations-provider";
import type { ModrinthProject } from "@/lib/modrinth";

interface ModCardProps {
  mod: ModrinthProject;
  /**
   * `can.modsInstall`, from the browser that owns the grid.
   *
   * A **required** prop, and read from the parent rather than from `useGames()` here: the
   * search appends 20 cards per "Load More", so a hook per card is 20, 40, 60 pollers on
   * one page for one boolean. Required means a new call site cannot silently default to
   * showing a control that answers 403 — the compiler asks.
   */
  canAddToPack: boolean;
  /**
   * Same capability (`mods.install`) and the same required-prop reasoning, for the button
   * that puts the jar on the running server rather than into a pack.
   */
  canInstall: boolean;
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

export function ModCard({ mod, canAddToPack, canInstall }: ModCardProps) {
  const { refresh: refreshOperations } = useOperations();
  const [showDetail, setShowDetail] = useState(false);
  const [installing, setInstalling] = useState(false);
  /**
   * The route's own refusal sentence, held while the override dialog is open.
   *
   * `/api/mods/install` already answered 409 `{error:"client-only", serverSide, decidedBy}`
   * and already accepted `allowClientOnly` — and **nothing read either**, because the route
   * had no caller at all. The sentence is not re-written here: `refusal` is composed in the
   * route from `CLIENT_ONLY_CONSEQUENCE`, which exists because this exact claim was once
   * stated twice and the two copies disagreed about whether a client-only jar is harmless.
   */
  const [clientOnlyRefusal, setClientOnlyRefusal] = useState<string | null>(null);
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

  /**
   * Install this one mod on the server.
   *
   * `allowClientOnly` is only ever sent from the dialog below — the one that appears *after*
   * the route has refused and said why. Sending it by default would turn the refusal into a
   * control that is broken in a new way, which is the same argument the version guard's
   * `confirm` is built on.
   */
  async function install(allowClientOnly = false) {
    setInstalling(true);
    const unconfirmed = `The connection ended before ${mod.title}'s install result was confirmed. Check the operation strip before retrying.`;
    try {
      const res = await fetch("/api/mods/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modrinthId: mod.project_id,
          slug: mod.slug,
          name: mod.title,
          ...(allowClientOnly ? { allowClientOnly: true } : {}),
        }),
      });
      const data = await readOperationResponse(res);

      if (res.ok) {
        setClientOnlyRefusal(null);
        // The registry derives completion and integrity caveats from readback.
        return;
      }

      if (res.status === 409 && data.error === "client-only") {
        setClientOnlyRefusal(typeof data.refusal === "string" ? data.refusal : data.message || "");
        return;
      }

      setClientOnlyRefusal(null);
      // `message` first: the incompatible-version 409 puts its explanation there and leaves
      // `error` as the bare code `"incompatible"`.
      if (typeof data.operationId !== "string" || !data.operationId) {
        if (res.status === 502 || res.status === 504) toast.info(unconfirmed);
        else toast.error(data.message || data.error || `Couldn't install ${mod.title}`);
      }
    } catch {
      setClientOnlyRefusal(null);
      toast.info(unconfirmed);
    } finally {
      setInstalling(false);
      void refreshOperations();
    }
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
          (pack?.mods || []).map((m) => m.modrinthId)
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
        const data = await res.json();
        if (data.error === "incompatible") {
          toast.error(data.message);
          setAddingToPack(false);
          setShowPackDialog(false);
          setShowDepsDialog(false);
          return;
        }
        toast.info("Mod already in this modpack");
      } else if (res.ok) {
        toast.success(`Added ${mod.title} to modpack`);
      } else {
        const data = await res.json();
        toast.error(data.message || data.error || "Failed to add to modpack");
      }

      if (includeDeps && missingDeps.length > 0) {
        let addedDeps = 0;
        const failedDeps: string[] = [];
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
            if (depRes.ok) {
              addedDeps++;
            } else if (depRes.status === 409) {
              const depData = await depRes.json();
              if (depData.error === "incompatible") {
                failedDeps.push(`${dep.name} (incompatible)`);
              } else {
                // Already in modpack - that's fine
                addedDeps++;
              }
            } else {
              failedDeps.push(dep.name);
            }
          } catch {
            failedDeps.push(dep.name);
          }
        }
        if (addedDeps > 0) {
          toast.success(`Also added ${addedDeps} required dependenc${addedDeps === 1 ? "y" : "ies"}`);
        }
        if (failedDeps.length > 0) {
          toast.warning(`Could not add: ${failedDeps.join(", ")} (incompatible version)`);
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
      {/*
        **The accent is `--tint`, not a hard-coded hex.** This was
        `hover:border-[#cba6f7] dark:hover:border-[#cba6f7] hover:border-[#8839ef]` plus a
        purple glow — three classes for one property, two of which could never win, and all
        three the *wrong world's* colour: `#cba6f7` is Catppuccin mauve and Minecraft's
        accent here is green/teal (`--mc`). CLAUDE.md's convention is per-game accent through
        `--tint`, and these cards are the only place on the page that ignored it.
      */}
      <Card
        className="group flex cursor-pointer flex-col rounded-xl ring-1 ring-border transition-colors hover:ring-[var(--tint)]/60 focus-within:ring-2 focus-within:ring-[var(--tint)]"
        onMouseEnter={fetchDepsIfNeeded}
        onClick={() => setShowDetail(true)}
      >
        <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-3">
          {mod.icon_url ? (
            <img
              src={mod.icon_url}
              alt=""
              className="h-11 w-11 rounded-lg object-cover ring-1 ring-border/50"
            />
          ) : (
            <div className="h-11 w-11 rounded-lg bg-[var(--tint)]/10 flex items-center justify-center text-xs font-bold text-[var(--tint)] ring-1 ring-[var(--tint)]/20">
              {mod.title[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm leading-tight truncate group-hover:text-[var(--tint)] transition-colors">
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {formatDownloads(mod.downloads)} downloads
              </span>
              <div className="flex items-center gap-1.5">
                {/* Both actions call a route that checks `mods.install`, so both are gated.
                    Two props rather than one because they are different jobs — staging a mod
                    into a pack versus putting a jar on the running server — and a later change
                    may well want to separate them. The card itself stays clickable for a viewer
                    who can do neither: that opens the mod's details, which is a read.

                    Increment 2's first version gated only `Add to pack` and left `Install`
                    visible to everyone, so a MEMBER got a bare `{error:"Forbidden"}` from
                    `/api/mods/install` — the exact defect this pair of increments exists to
                    remove, reintroduced by the increment that added the button. */}
                {canAddToPack && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); openPackDialog(); }}
                  >
                    Add to pack
                  </Button>
                )}
                {canInstall && (
                  <Button
                    size="sm"
                    disabled={installing}
                    onClick={(e) => { e.stopPropagation(); install(); }}
                    className="shadow-sm"
                  >
                    {installing ? "Installing..." : "Install"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/*
        The client-only override. The 409 has carried `serverSide` and `decidedBy` since the
        side filter was added (2026-10-01) with no UI reading them, so both the refusal and
        the way past it were unreachable from the dashboard.

        `decidedBy` is deliberately NOT rendered: its values are `version-environment` /
        `project-server-side` / `file-env`, which are names for our own signal ordering, and
        the sentence above already says which publisher made the claim ("this build declares
        `client_only`" vs "Modrinth lists this project as server-side unsupported") — which is
        the part a user can check.
      */}
      <Dialog
        open={clientOnlyRefusal !== null}
        onOpenChange={(open) => { if (!open) setClientOnlyRefusal(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install {mod.title} anyway?</DialogTitle>
            <DialogDescription>{clientOnlyRefusal}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setClientOnlyRefusal(null)}>
              Cancel
            </Button>
            {/* `destructive`, because the stated consequence includes a server that does not
                start — the same weight the modpack apply's confirm carries. */}
            <Button
              variant="destructive"
              disabled={installing}
              onClick={() => install(true)}
            >
              {installing ? "Installing..." : "Install it anyway"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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

      <ModDetailDialog
        projectId={mod.project_id}
        open={showDetail}
        onClose={() => setShowDetail(false)}
      />
    </>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
