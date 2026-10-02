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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";

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
  targetMcVersion: string | null;
  targetLoader: string | null;
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

// Typed rather than `any` so the dialog below can't read through a field the
// export endpoint didn't send. See handleExport for why that mattered.
interface ExportPayload {
  modpack: { name: string; description: string; mcVersion: string; loader: string };
  mods: ExportMod[];
}

interface InstallReport {
  packName: string;
  installed: number;
  total: number;
  errors: string[];
  warnings: string[];
  /**
   * Mods the installer declined to put on the server because they are client-only.
   *
   * Separate from `errors` on purpose: a skip is the installer working, and listing it
   * among the failures would make every correct apply of a real pack look broken (a large
   * pack is 30-50% client mods). Separate from `warnings` too, because these have names
   * worth showing one per row rather than a sentence with "+34 more".
   */
  skipped: { name: string; reason: string }[];
  /**
   * The route's headline sentence, when it has one.
   *
   * Needed because a refusal can now arrive *with* a list worth showing. The all-mods-are-
   * client-only 409 answers `installed: 0, total: 0` plus the named skips, which is enough
   * for the shape check below to open the dialog — and without this field the one sentence
   * saying why nothing happened ("this is a client-side pack, use Export") would be the
   * part that got dropped.
   */
  error?: string;
}

export function Modpacks() {
  // `can.modsInstall` / `can.modsRemove` only; see `CAPABILITY_POLL_MS` for the interval.
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newMcVersion, setNewMcVersion] = useState("");
  const [newLoader, setNewLoader] = useState("");
  const [creating, setCreating] = useState(false);
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  const [exportData, setExportData] = useState<ExportPayload | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installReport, setInstallReport] = useState<InstallReport | null>(null);
  const [showInstallConfirm, setShowInstallConfirm] = useState<string | null>(null);
  const [editingPack, setEditingPack] = useState<Modpack | null>(null);
  const [removeWarning, setRemoveWarning] = useState<{ mod: ModpackMod; dependents: string[] } | null>(null);
  /**
   * The dependency scan in flight, so it can be seen and not started twice.
   *
   * `checkDependentsAndRemove` asks `/api/mods/dependencies` once per *other* mod in the
   * pack, sequentially — 74 requests on a 75-mod pack. There was no feedback of any kind:
   * the Remove button stayed live and nothing moved, so the only reading available was
   * "this is broken", and clicking a second Remove started a second scan on top of the
   * first.
   */
  const [depScan, setDepScan] = useState<{ modId: string; done: number; total: number } | null>(
    null
  );

  useEffect(() => {
    fetchModpacks();
    fetch("/api/minecraft-versions")
      .then((r) => r.json())
      .then((data) => { if (data.versions) setMcVersions(data.versions); })
      .catch(() => {});
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
        body: JSON.stringify({
          name: newName,
          description: newDesc,
          targetMcVersion: newMcVersion || undefined,
          targetLoader: newLoader || undefined,
        }),
      });
      if (res.ok) {
        const pack = await res.json();
        setModpacks((prev) => [pack, ...prev]);
        setShowCreate(false);
        setNewName("");
        setNewDesc("");
        toast.success("Modpack created");
      } else {
        // No `else` at all before this, so a 403 or a 500 produced total silence and
        // the row either did or did not appear depending on a code path nobody could see.
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Couldn't create the modpack");
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
    } else {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Couldn't delete the modpack");
    }
  }

  /** True when the mod is gone from the pack. The callers prune their own copy on that. */
  async function handleRemoveMod(modpackId: string, modId: string): Promise<boolean> {
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
      return true;
    }
    // No `else` at all before this, so a 403 or a 500 produced total silence — the two
    // siblings above (`handleCreate`, `handleDelete`) both read the body and say what
    // happened. Returning false matters as much as the toast: both callers used to prune
    // the row out of the edit dialog unconditionally, so a refused remove showed an error
    // and the mod vanished from the list it was still in.
    const d = await res.json().catch(() => ({}));
    toast.error(d.error || "Couldn't remove that mod from the modpack");
    return false;
  }

  async function checkDependentsAndRemove(pack: Modpack, mod: ModpackMod) {
    const otherMods = pack.mods.filter((m) => m.id !== mod.id);
    const dependents: string[] = [];

    // One request per other mod, sequential, so the count is the honest unit of progress.
    // What this computes is unchanged; it just says where it is while it does it.
    setDepScan({ modId: mod.id, done: 0, total: otherMods.length });
    try {
      for (const other of otherMods) {
        try {
          const res = await fetch(`/api/mods/dependencies?modrinthId=${other.modrinthId}`);
          const data = await res.json();
          const deps = data.dependencies || [];
          if (deps.some((d: any) => d.modrinthId === mod.modrinthId)) {
            dependents.push(other.name);
          }
        } catch {}
        setDepScan((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
    } finally {
      setDepScan(null);
    }

    if (dependents.length > 0) {
      setRemoveWarning({ mod, dependents });
    } else if (await handleRemoveMod(pack.id, mod.id)) {
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
      // The endpoint answers {error} on 401/403/404 (a pack deleted in another
      // tab is enough), and storing that opened the dialog on a payload with no
      // `modpack` — reading .name off undefined throws during render, which, before
      // `src/app/error.tsx` existed, took the whole app to a blank page. It now lands
      // in the segment boundary instead, but failing just this dialog is still the
      // right outcome, so the shape check stays.
      if (!res.ok || !data?.modpack || !Array.isArray(data.mods)) {
        toast.error(data?.error || "Failed to generate export");
        return;
      }
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
    const packName = modpacks.find((p) => p.id === modpackId)?.name ?? "Modpack";
    try {
      const res = await fetch("/api/mods/install-modpack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modpackId }),
      });
      const data = await res.json();

      // The route answers non-2xx when it couldn't install every mod, so the counts
      // have to be read on both paths. Trusting res.ok alone is what reported
      // "Installed 0/166 mods" in a green toast for every pack whose rows carry no
      // download source.
      if (typeof data.installed !== "number" || typeof data.total !== "number") {
        toast.error(data.error || "Failed to install modpack");
        return;
      }

      const failures: string[] = data.errors ?? [];
      const warnings: string[] = data.warnings ?? [];
      const skipped: { name: string; reason: string }[] = data.skipped ?? [];
      const missing = data.total - data.installed;

      // 166 failures concatenated into one toast is unreadable and gone in seconds,
      // so the list lives in a dialog you can scroll and the toast only counts.
      //
      // `skipped.length` opens it too. A clean apply of a real pack is now exactly the
      // case where `missing`, `failures` and `warnings` are all empty and 40 mods were
      // nonetheless held back — without this the one outcome the filter was built to
      // report would be the one outcome that reports nothing.
      if (missing > 0 || failures.length > 0 || warnings.length > 0 || skipped.length > 0) {
        setInstallReport({
          packName,
          installed: data.installed,
          total: data.total,
          errors: failures,
          warnings,
          skipped,
          error: typeof data.error === "string" ? data.error : undefined,
        });
      }

      // NO outcome toast here, for any outcome.
      //
      // The operation's own completion toast carries `op.summary`, which is derived
      // server-side from the recorded count and cannot overstate — and the
      // visibility-suppression rule only silences `ok`, so these two fired *together*
      // for exactly the non-clean outcomes: "Installed 142 of 166 mods — 24 failed."
      // beside "Installed 142 of 166 mods; 24 failed. Open the report for which ones.",
      // filling two of three toast slots with one sentence. `setInstallReport` above
      // stays: the scrollable per-mod dialog carries detail no summary can.
    } catch {
      // Up to 166 sequential Modrinth fetches, so past ~100s a *successful* apply
      // reported failure — and `setInstallReport` never ran, so the scrollable per-mod
      // dialog built specifically because "166 failures in one toast is unreadable"
      // never opened. Open it with what we know, and say the truth about the response.
      setInstallReport({
        packName,
        installed: 0,
        total: 0,
        errors: [],
        warnings: [
          "The connection timed out before the install finished. It is still running on the " +
            "server — watch the strip at the top of the page for the per-mod result, and don't " +
            "start it again.",
        ],
        skipped: [],
      });
      toast.info(
        `Still installing ${packName}. The connection timed out before it finished, which is ` +
          `normal for a large pack — watch the strip at the top of the page.`
      );
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* This said "import from Modrinth/Technic tabs". The Technic tab was removed in
            e718acd — the page has had exactly two sub-tabs since (My Modpacks / Modrinth,
            `src/app/minecraft/mods/page.tsx:42-43`), so it pointed at a control that does
            not exist. True independently of whether the orphaned Technic components are
            deleted: their upstream `api.technicpack.net` answers 401, so remounting the
            tab would show an empty browser forever. */}
        <p className="text-sm text-muted-foreground">
          Create modpacks to group mods together, or import one from the Modrinth tab
        </p>
        {/* The route behind this checks `mods.install`, so a MEMBER was shown a dialog
            whose Create button answered a bare 403. Hidden rather than disabled: there is
            nothing to read in a disabled Create, and the Install/Delete controls below take
            the same approach. */}
        {can.modsInstall && <Button onClick={() => setShowCreate(true)}>Create Modpack</Button>}
      </div>

      <div className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-4">
        <p className="text-sm font-medium text-chart-5">Warning</p>
        {/* This used to end "it's recommended to **delete the world folder** and start
            fresh" — advice to destroy the save, on the page whose own install takes a
            world archive precisely so the save survives. The replacement states what the
            install actually does: `/api/mods/install-modpack` runs
            `tar -czf … -C MC_DIR world` before touching anything, and that archive's only
            member is `world`, so the mods folder is not in it. */}
        <p className="text-xs text-muted-foreground mt-1">
          Installing a modpack to the server <strong>removes every mod currently
          installed</strong> and replaces them with the modpack&apos;s mods. Changing mods under
          an existing world can lose modded items and blocks. The install archives the world
          first as a rollback point; that archive holds the world only, not the mods folder.
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
                      {pack.targetMcVersion && (
                        <span className="ml-2 font-mono bg-muted px-1.5 py-0.5 rounded">
                          MC {pack.targetMcVersion}
                        </span>
                      )}
                      {pack.targetLoader && (
                        <span className="ml-1 capitalize bg-muted px-1.5 py-0.5 rounded">
                          {pack.targetLoader}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    {/* Edit opens one thing — a list with a Remove beside each mod — so it
                        is gated on `mods.remove`, the capability those Removes need. The
                        names it would show are already on the card as badges below, so a
                        viewer who cannot remove loses no information with it hidden. */}
                    {can.modsRemove && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingPack(pack)}
                      >
                        Edit
                      </Button>
                    )}
                    {/* Export is NOT gated, and that is checked rather than assumed:
                        `/api/modpacks/[id]/export` calls `denyGame` and no `hasPermission`,
                        so it answers a MEMBER. It is a read that returns download links for
                        the viewer's own launcher, which is the one thing on this page a
                        read-only account is meant to do. */}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleExport(pack.id)}
                      disabled={exporting === pack.id || pack.mods.length === 0}
                    >
                      {exporting === pack.id ? "..." : "Export"}
                    </Button>
                    {can.modsInstall && (
                      <Button
                        size="sm"
                        onClick={() => setShowInstallConfirm(pack.id)}
                        disabled={installing === pack.id || pack.mods.length === 0}
                      >
                        {installing === pack.id ? "Installing..." : "Install to Server"}
                      </Button>
                    )}
                    {can.modsRemove && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(pack.id)}
                      >
                        Delete
                      </Button>
                    )}
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">MC Version</Label>
                <Select value={newMcVersion} onValueChange={(v) => setNewMcVersion(v ?? "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Server default" />
                  </SelectTrigger>
                  <SelectContent>
                    {mcVersions.map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Mod Loader</Label>
                <Select value={newLoader} onValueChange={(v) => setNewLoader(v ?? "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Server default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fabric">Fabric</SelectItem>
                    <SelectItem value="forge">Forge</SelectItem>
                    <SelectItem value="neoforge">NeoForge</SelectItem>
                    <SelectItem value="quilt">Quilt</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Only mods compatible with this version/loader can be added.
            </p>
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
                This will <strong>remove every mod currently installed</strong> on the server
                and replace them with this modpack&apos;s mods.
              </p>
              {/* Was "Consider deleting the world folder first (Server > Files > world)" —
                  the same advice-to-destroy-the-save as the banner on the page, and worse
                  here because this is the last thing read before pressing the button. */}
              <p>
                If your world has modded content in it, it can lose those items and blocks.
                The install archives the world first as a rollback point; that archive holds
                the world only, not the mods folder.
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

      <Dialog open={!!installReport} onOpenChange={() => setInstallReport(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className={installReport?.installed === 0 ? "text-destructive" : undefined}>
              Installed {installReport?.installed} of {installReport?.total} mods
            </DialogTitle>
            <DialogDescription>
              {installReport?.packName}
              {installReport && installReport.installed > 0
                ? " — restart the server to apply."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {installReport?.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs text-destructive">{installReport.error}</p>
              </div>
            )}

            {installReport?.warnings.map((w, i) => (
              <div key={i} className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-3">
                <p className="text-xs text-chart-5">{w}</p>
              </div>
            ))}

            {/* Skipped client-only mods, bordered in the world's own accent
                (`--tint`) rather than the amber `chart-5` the warning blocks above use.
                The colour is the claim: nothing went wrong here, and dressing a correct
                decision as a warning is how a report teaches people to ignore it.

                That claim was false when it was written — the route also pushed the skip
                sentence into `warnings`, so the same decision rendered twice, once amber
                two blocks up. The amber copy is gone (see `ApplyReport.warnings`); the
                skips arrive only in `skipped` and only this block shows them. Named one
                per row with the reason, because a count alone cannot be checked. */}
            {installReport && installReport.skipped.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {installReport.skipped.length} client-only mod
                  {installReport.skipped.length === 1 ? "" : "s"} skipped
                </p>
                <p className="text-xs text-muted-foreground">
                  These do not run on a dedicated server, so they were left out instead of
                  being copied into the server&apos;s mods folder. Install them in your own
                  launcher.
                </p>
                <div className="max-h-[30vh] overflow-y-auto rounded-lg border border-[var(--tint)]/30">
                  {installReport.skipped.map((s, i) => (
                    <p
                      key={i}
                      className="px-3 py-1.5 text-xs border-b border-border/40 last:border-0 break-words"
                    >
                      <span className="font-mono">{s.name}</span>
                      <span className="text-muted-foreground"> — {s.reason}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {installReport && installReport.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {installReport.errors.length} mod
                  {installReport.errors.length === 1 ? "" : "s"} failed
                </p>
                <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border/50">
                  {installReport.errors.map((err, i) => (
                    <p
                      key={i}
                      className="px-3 py-1.5 text-xs font-mono border-b border-border/40 last:border-0 break-words"
                    >
                      {err}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setInstallReport(null)}>
                Close
              </Button>
            </div>
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
              Download these mods to play on the server with your friends.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
              <p className="text-sm font-medium">Before you start</p>
              <p className="text-xs text-muted-foreground">
                You need <strong>{exportData?.modpack.loader === "fabric" ? "Fabric Loader" : "Forge"}</strong> installed
                for Minecraft <strong>{exportData?.modpack.mcVersion}</strong>.
                {exportData?.modpack.loader === "fabric" ? (
                  <> We recommend using <a href="https://prismlauncher.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Prism Launcher</a> (free, open-source) or the official <a href="https://fabricmc.net/use/installer/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Fabric Installer</a>.</>
                ) : (
                  <> Download the installer from <a href="https://files.minecraftforge.net" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Forge</a>, or use <a href="https://prismlauncher.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Prism Launcher</a> (recommended).</>
                )}
              </p>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {exportData?.mods.filter((m) => m.downloadUrl).length} mods available
              </p>
              <Button
                size="sm"
                onClick={() => {
                  const urls = exportData?.mods
                    .filter((m) => m.downloadUrl)
                    .map((m) => m.downloadUrl!) || [];
                  // The green "Starting download of 0 mods…" below used to fire
                  // unconditionally — which is exactly the case for the 224 legacy
                  // `ModpackMod` rows that carry no `downloadUrl` at all.
                  if (urls.length === 0) {
                    toast.warning(
                      "None of these mods has a download link recorded, so there is nothing to " +
                        "download. Re-import the pack to repair it."
                    );
                    return;
                  }
                  for (const url of urls) {
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "";
                    a.target = "_blank";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }
                  /**
                   * What this loop does is ask the browser N times; whether the browser
                   * accepts N is not ours to claim. The old copy was
                   * `toast.success("Starting download of N mods...")`, which asserts every
                   * one started — and this is a list of up to 166 synthesised anchor
                   * clicks, so the per-mod Download links below are the recovery and are
                   * what the sentence now points at. Green also claimed an outcome, so
                   * `info`.
                   */
                  toast.info(
                    `Requested ${urls.length} download${urls.length === 1 ? "" : "s"}. Your ` +
                      `browser may not accept them all at once — use the Download link next ` +
                      `to any mod that did not arrive.`
                  );
                }}
              >
                Download All
              </Button>
            </div>

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
                  {mod.fileName && (
                    <span className="text-[10px] text-muted-foreground ml-2 font-mono">
                      {mod.fileName}
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
            <div className="pt-3 border-t border-border space-y-2">
              <p className="text-xs text-muted-foreground">
                Place all downloaded <code className="bg-muted px-1 py-0.5 rounded">.jar</code> files
                in your <code className="bg-muted px-1 py-0.5 rounded">mods/</code> folder:
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li>Windows: <code className="bg-muted px-1 py-0.5 rounded">%appdata%\.minecraft\mods\</code></li>
                <li>macOS: <code className="bg-muted px-1 py-0.5 rounded">~/Library/Application Support/minecraft/mods/</code></li>
                <li>Linux: <code className="bg-muted px-1 py-0.5 rounded">~/.minecraft/mods/</code></li>
                <li>Prism Launcher: Right-click instance &gt; Folder &gt; mods</li>
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                Make sure to <strong>delete any old mods</strong> in the folder before adding these, to avoid conflicts.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingPack} onOpenChange={() => setEditingPack(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit &quot;{editingPack?.name}&quot;</DialogTitle>
            <DialogDescription>
              {depScan
                ? // The count on the button says how far; this says what it is counting.
                  // Without it the only thing on screen is a number with no noun, for what
                  // is 74 requests on a 75-mod pack.
                  `Checking which of the other mods in this pack need this one — ` +
                  `${depScan.done} of ${depScan.total} checked.`
                : "Remove mods from this modpack."}
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
                  {/* Every Remove is dead while a scan runs, not just the one that started
                      it: the scan is sequential and a second click used to start a second
                      one over the top. The button that owns the scan carries the count,
                      because the request total is known up front and is the only honest
                      unit of progress here. */}
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={depScan !== null}
                    onClick={() => checkDependentsAndRemove(editingPack, mod)}
                  >
                    {depScan?.modId === mod.id
                      ? `Checking ${depScan.done}/${depScan.total}...`
                      : "Remove"}
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
                  // Gated on the result for the same reason as the other caller: this used
                  // to filter the row out whatever the DELETE answered.
                  if (await handleRemoveMod(editingPack.id, removeWarning.mod.id)) {
                    setEditingPack((prev) =>
                      prev ? { ...prev, mods: prev.mods.filter((m) => m.id !== removeWarning.mod.id) } : null
                    );
                  }
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
