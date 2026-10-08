"use client";
import { useEffect, useId, useState } from "react";
import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { readOperationResponse, UnconfirmedOperationResult, unconfirmedOperationMessage } from "@/lib/operation-client";
import { isMinecraftProfile } from "@/lib/minecraft-profiles-client";
import { MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS, type MinecraftProfilesDTO, type CreateMinecraftProfileInput, type MinecraftJavaVariant, type MinecraftProfileLoader } from "@/lib/minecraft-profile-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SourceChoice { id: string; title: string; mcVersion?: string | null; loader?: string | null }
interface PackBuild { id: string; name: string; versionNumber: string; mcVersions: string[]; loaders: string[]; publishedAt: string; supported: boolean; reason?: string }
export function MinecraftProfileCreate({ open, onOpenChange, data, adopt = false, onPrepared }: { open: boolean; onOpenChange(open: boolean): void; data: MinecraftProfilesDTO | null; adopt?: boolean; onPrepared(): void }) {
  return open ? <CreateSession onOpenChange={onOpenChange} data={data} adopt={adopt} onPrepared={onPrepared} /> : null;
}
function CreateSession({ onOpenChange, data, adopt, onPrepared }: Omit<Parameters<typeof MinecraftProfileCreate>[0], "open">) {
  const labelId = useId();
  const games = useGames(CAPABILITY_POLL_MS);
  const { refresh: refreshOperations } = useOperations();
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"vanilla" | "saved-set" | "modrinth">("vanilla");
  const [version, setVersion] = useState(""); const [loader, setLoader] = useState<MinecraftProfileLoader>("vanilla");
  const [loaderVersion, setLoaderVersion] = useState(""); const [java, setJava] = useState<MinecraftJavaVariant | "">("");
  const [seed, setSeed] = useState(""); const [query, setQuery] = useState(""); const [source, setSource] = useState("");
  const [build, setBuild] = useState(""); const [choices, setChoices] = useState<SourceChoice[]>([]); const [versions, setVersions] = useState<string[]>([]);
  const [builds, setBuilds] = useState<PackBuild[]>([]); const [buildSource, setBuildSource] = useState<string | null>(null); const [buildLoading, setBuildLoading] = useState(false); const [buildError, setBuildError] = useState<string | null>(null); const [buildAttempt, setBuildAttempt] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(!adopt); const [sourceError, setSourceError] = useState<string | null>(null); const [attempt, setAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false); const [sending, setSending] = useState(false); const [error, setError] = useState<string | null>(null); const [blocked, setBlocked] = useState(false);
  const currentRunning = games.games?.minecraft?.containerRunning === true || ["online", "starting"].includes(games.games?.minecraft?.status ?? "");
  const allowed = !!data?.capabilities.manage && !games.loading && !games.pollError && games.access.includes("minecraft") && games.can.settingsEdit === true && (!adopt || !!games.lastSuccessAt);
  useEffect(() => {
    if (adopt) return;
    const controller = new AbortController(); let current = true;
    const timer = setTimeout(() => {
      setSourceLoading(true); setSourceError(null);
      void (async () => {
        try {
          const endpoint = kind === "vanilla" ? "/api/minecraft-versions" : kind === "saved-set" ? "/api/modpacks" : `/api/modpacks/search?version=any&loader=any&q=${encodeURIComponent(query)}`;
          const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" }); const body = await response.json();
          if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The profile source could not be read.");
          if (kind === "vanilla") {
            if (!Array.isArray(body.versions) || !body.versions.every((v: unknown) => typeof v === "string" && v.length > 0)) throw new Error("The Minecraft version list is incomplete.");
            if (current) setVersions(body.versions);
          } else if (kind === "saved-set") {
            if (!Array.isArray(body) || !body.every(v => v && typeof v.id === "string" && typeof v.name === "string" && (v.targetMcVersion === null || typeof v.targetMcVersion === "string") && (v.targetLoader === null || typeof v.targetLoader === "string"))) throw new Error("The saved mod sets response is incomplete.");
            if (current) setChoices(body.map(v => ({ id: v.id, title: v.name, mcVersion: v.targetMcVersion, loader: v.targetLoader })));
          } else {
            if (!Array.isArray(body.hits) || !body.hits.every((v: Record<string, unknown>) => v && typeof v.project_id === "string" && typeof v.title === "string")) throw new Error("The Modrinth pack search response is incomplete.");
            if (current) setChoices(body.hits.map((v: Record<string, string>) => ({ id: v.project_id, title: v.title })));
          }
        } catch (e) { if (current) setSourceError(e instanceof Error ? e.message : "The source could not be read."); }
        finally { if (current) setSourceLoading(false); }
      })();
    }, kind === "modrinth" ? 350 : 0);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [adopt, kind, query, attempt]);
  useEffect(() => {
    if (adopt || kind !== "modrinth" || !source) return;
    let current = true; const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/minecraft/profile-sources/modrinth?ref=${encodeURIComponent(source)}`, { signal: controller.signal, cache: "no-store" }); const body = await response.json();
        const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string" && v.length > 0);
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The pack builds could not be read.");
        if (!body.project || body.project.id !== source || typeof body.project.title !== "string" || !Array.isArray(body.versions) || !body.versions.every((v: PackBuild) => v && typeof v.id === "string" && typeof v.name === "string" && typeof v.versionNumber === "string" && strings(v.mcVersions) && strings(v.loaders) && typeof v.publishedAt === "string" && Number.isFinite(Date.parse(v.publishedAt)) && typeof v.supported === "boolean" && (v.reason === undefined || typeof v.reason === "string")) || new Set(body.versions.map((v: PackBuild) => v.id)).size !== body.versions.length) throw new Error("The pack build response is incomplete or belongs to another pack.");
        if (current) { setBuilds(body.versions); setBuildSource(source); setBuildError(null); }
      } catch (e) { if (current) setBuildError(e instanceof Error ? e.message : "The pack builds could not be read."); }
      finally { if (current) setBuildLoading(false); }
    })();
    return () => { current = false; controller.abort(); };
  }, [adopt, kind, source, buildAttempt]);
  const chosen = choices.find(choice => choice.id === source);
  const validSource = adopt || (!sourceLoading && !sourceError && (kind === "vanilla" ? versions.includes(version) && (loader !== "neoforge" || !!loaderVersion.trim()) : !!chosen && (kind === "saved-set" ? !!chosen.mcVersion && !!chosen.loader : buildSource === source && !buildLoading && !buildError && builds.some(v => v.id === build && v.supported))));
  async function submit() {
    if (!allowed || !name.trim() || !validSource || sending || blocked || (adopt && currentRunning && !confirmed)) return;
    setSending(true); setError(null);
    try {
      const input: CreateMinecraftProfileInput = {
        name: name.trim(), description: description.trim(),
        source: kind === "vanilla" ? { kind, mcVersion: version, loader, ...(loaderVersion.trim() ? { loaderVersion: loaderVersion.trim() } : {}) } : kind === "saved-set" ? { kind, ref: source, ...(loaderVersion.trim() ? { loaderVersion: loaderVersion.trim() } : {}) } : { kind, ref: source, ...(build.trim() ? { versionId: build.trim() } : {}) },
        ...(java ? { javaVariant: java } : {}), ...(seed.trim() ? { settings: { "level-seed": seed.trim() } } : {}),
      };
      const response = await fetch(`/api/minecraft/profiles${adopt ? "/adopt" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(adopt ? { name: name.trim(), description: description.trim(), confirmStopCurrent: confirmed, ...(loaderVersion.trim() ? { loaderVersion: loaderVersion.trim() } : {}), ...(java ? { javaVariant: java } : {}) } : input) });
      const receipt = await readOperationResponse(response);
      if (!receipt.operationId) {
        if (!response.ok && receipt.error) { setError(receipt.error); if (response.status === 409) setBlocked(true); return; }
        throw new UnconfirmedOperationResult();
      }
      if (response.ok && !isMinecraftProfile(receipt.profile)) throw new UnconfirmedOperationResult(receipt.operationId);
      onPrepared(); onOpenChange(false);
    } catch (e) { setError(unconfirmedOperationMessage(adopt ? "existing world adoption" : "profile preparation", e)); setBlocked(true); onPrepared(); }
    finally { void refreshOperations(); setSending(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !sending) onOpenChange(false); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!sending}>
    <DialogHeader><DialogTitle>{adopt ? "Keep the existing Minecraft world" : "Create a Minecraft profile"}</DialogTitle><DialogDescription>{adopt ? "Adoption preserves the existing world, mods and settings as one profile. It saves and stops Minecraft if running, then leaves it stopped. Other games are left alone." : "Prepare a separate world with its own version, mods and settings. Creating a profile does not start it or switch the current world."}</DialogDescription></DialogHeader>
    <fieldset disabled={sending || !allowed} className="space-y-4">
      <div className="space-y-2"><Label htmlFor={`${labelId}-name`}>Profile name</Label><Input id={`${labelId}-name`} value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor={`${labelId}-description`}>Description</Label><Input id={`${labelId}-description`} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></div>
      {!adopt && <>
        <div className="space-y-2"><Label htmlFor={`${labelId}-source`}>Start from</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-source`} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setSource(""); setSourceLoading(true); }}><option value="vanilla">Vanilla or a custom loader</option><option value="saved-set">Saved mod set</option><option value="modrinth">Published Modrinth pack</option></select></div>
        {kind === "vanilla" ? <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${labelId}-version`}>Minecraft version</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-version`} value={version} disabled={sourceLoading || !!sourceError} onChange={e => setVersion(e.target.value)}><option value="">Choose an exact version</option>{versions.map(v => <option key={v} value={v}>{v}</option>)}</select></div><div className="space-y-2"><Label htmlFor={`${labelId}-loader`}>Loader</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-loader`} value={loader} onChange={e => setLoader(e.target.value as MinecraftProfileLoader)}>{MINECRAFT_PROFILE_LOADERS.map(v => <option key={v}>{v}</option>)}</select></div></div> : <>
          {kind === "modrinth" && <div className="space-y-2"><Label htmlFor={`${labelId}-query`}>Search published packs</Label><Input id={`${labelId}-query`} value={query} onChange={e => { setQuery(e.target.value); setSource(""); setSourceLoading(true); }} /><p className="text-xs text-muted-foreground">Search covers all versions. The profile uses the selected pack&apos;s target, not the current server&apos;s target.</p></div>}
          <div className="space-y-2"><Label htmlFor={`${labelId}-choice`}>{kind === "saved-set" ? "Saved mod set" : "Published pack"}</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-choice`} disabled={sourceLoading || !!sourceError} value={source} onChange={e => { setSource(e.target.value); setBuild(""); setBuildSource(null); setBuildLoading(true); setBuildError(null); }}><option value="">Choose a source</option>{choices.map(choice => <option key={choice.id} value={choice.id} disabled={kind === "saved-set" && (!choice.mcVersion || !choice.loader)}>{choice.title}{kind === "saved-set" ? choice.mcVersion && choice.loader ? ` · ${choice.mcVersion} / ${choice.loader}` : " · no exact target recorded" : ""}</option>)}</select></div>
          {kind === "modrinth" && source && <div className="space-y-2"><Label htmlFor={`${labelId}-build`}>Published pack build</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-build`} value={build} disabled={buildLoading || !!buildError || buildSource !== source} onChange={e => setBuild(e.target.value)}><option value="">Choose an exact published build</option>{builds.map(v => <option key={v.id} value={v.id} disabled={!v.supported}>{v.name} · {v.versionNumber} · MC {v.mcVersions.join(", ")} · {v.loaders.join(", ")}{!v.supported ? ` · ${v.reason || "unsupported"}` : ""}</option>)}</select><p className="text-xs text-muted-foreground">These are the author’s declared targets. Preparation verifies the downloaded pack and pins this exact build.</p>{buildLoading && <p role="status">Reading published builds…</p>}{buildError && <p role="alert">{buildError}</p>}{!buildLoading && !buildError && buildSource === source && !builds.some(v => v.supported) && <p>No supported published builds were found for this pack.</p>}<Button variant="outline" disabled={buildLoading} onClick={() => { setBuildLoading(true); setBuildError(null); setBuildAttempt(v => v + 1); }}>Recheck pack builds</Button></div>}
        </>}
        {(kind === "saved-set" || kind === "vanilla" && loader !== "vanilla") && <div className="space-y-2"><Label htmlFor={`${labelId}-loader-version`}>{loader === "neoforge" ? "Exact NeoForge build (required for a custom loader)" : "Exact loader build (optional)"}</Label><Input id={`${labelId}-loader-version`} value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /><p className="text-xs text-muted-foreground">Fabric, Forge and Quilt can be resolved and pinned automatically. A custom NeoForge profile needs an exact build.</p></div>}
        <div className="space-y-2"><Label htmlFor={`${labelId}-seed`}>New world seed (optional)</Label><Input id={`${labelId}-seed`} value={seed} onChange={e => setSeed(e.target.value)} /><p className="text-xs text-muted-foreground">The game creates this fresh world on its first start. No existing world is replaced.</p></div>
        <div className="space-y-2"><Label htmlFor={`${labelId}-java`}>Java runtime</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-java`} value={java} onChange={e => setJava(e.target.value as typeof java)}><option value="">Automatic from Minecraft metadata</option>{MINECRAFT_JAVA_VARIANTS.map(v => <option key={v}>{v}</option>)}</select></div>
      </>}
      {adopt && <details className="space-y-3 rounded-xl border p-3"><summary className="cursor-pointer text-sm">Advanced: resolve an ambiguous existing installation</summary><p className="text-xs text-muted-foreground">Only enter the exact loader build and Java variant reviewed for this existing world. These hints resolve unknown installation details; they do not select a different Minecraft version or loader.</p><Label htmlFor={`${labelId}-adopt-loader`}>Reviewed existing loader build (optional)</Label><Input id={`${labelId}-adopt-loader`} value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /><Label htmlFor={`${labelId}-adopt-java`}>Reviewed existing Java runtime (optional)</Label><select className="h-10 w-full rounded-lg border bg-background px-3" id={`${labelId}-adopt-java`} value={java} onChange={e => setJava(e.target.value as typeof java)}><option value="">Read the existing installation automatically</option>{MINECRAFT_JAVA_VARIANTS.map(v => <option key={v}>{v}</option>)}</select></details>}
    </fieldset>
    {sourceLoading && !adopt && <p role="status">Reading available sources…</p>}
    {sourceError && <><p role="alert">{sourceError}</p><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>Retry profile sources</Button></>}
    {adopt && currentRunning && <label className="flex gap-2 rounded-xl bg-muted p-3 text-sm"><input type="checkbox" disabled={sending} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I understand Minecraft players will be disconnected and Minecraft will remain stopped after adoption.</label>}
    {!allowed && <p role="status">Verified profile management and Minecraft settings permission are required.</p>}
    {error && <p role="alert">{error}</p>}
    {blocked && <p className="text-sm">Close this dialog and recheck the profile list and operation strip before another attempt.</p>}
    {!adopt && <p className="text-xs text-muted-foreground">You can add a world screenshot from the profile details after preparation.</p>}
    <DialogFooter><Button variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!allowed || !name.trim() || !validSource || sending || blocked || (adopt && currentRunning && !confirmed)} onClick={() => void submit()}>{sending ? "Submitting…" : adopt ? "Keep existing world" : "Prepare profile"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
