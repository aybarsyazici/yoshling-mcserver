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
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { motion } from "motion/react";
import { ArrowRight, Check, Compass, Leaf, PackageOpen, ShieldCheck, SlidersHorizontal, Sparkles } from "lucide-react";
import { usePrefersReducedMotion } from "@/components/motion";
import { ProfileDialogHero, ProfileDialogReveal, ProfileDraftPreview, ProfileFormSection } from "@/components/minecraft-profile-dialog-visuals";
import { GAMES } from "@/lib/games";
import styles from "@/components/minecraft-profile-dialog.module.css";

interface SourceChoice { id: string; title: string; mcVersion?: string | null; loader?: string | null }
interface PackBuild { id: string; name: string; versionNumber: string; mcVersions: string[]; loaders: string[]; publishedAt: string; supported: boolean; reason?: string }
export function MinecraftProfileCreate({ open, onOpenChange, data, adopt = false, onPrepared }: { open: boolean; onOpenChange(open: boolean): void; data: MinecraftProfilesDTO | null; adopt?: boolean; onPrepared(): void }) {
  return open ? <CreateSession onOpenChange={onOpenChange} data={data} adopt={adopt} onPrepared={onPrepared} /> : null;
}
function CreateSession({ onOpenChange, data, adopt, onPrepared }: Omit<Parameters<typeof MinecraftProfileCreate>[0], "open">) {
  const labelId = useId();
  const reduced = usePrefersReducedMotion();
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
  const selectedBuild = kind === "modrinth" && source && buildSource === source && !buildLoading && !buildError ? builds.find(item => item.id === build && item.supported) : undefined;
  const previewSource = adopt ? "Existing world, mods & settings" : kind === "vanilla" ? loader === "vanilla" ? "Vanilla · Make it your own" : `Custom ${loader} world` : chosen?.title || (kind === "saved-set" ? "Choose a saved mod set" : "Choose a published pack");
  const previewTarget = adopt ? "Keeps your existing version and loader." : kind === "vanilla" ? `${version || "Choose a Minecraft version"} · ${loader}` : kind === "saved-set" ? `${chosen?.mcVersion || "Target not selected"} · ${chosen?.loader || "Loader not selected"}` : selectedBuild ? `Declared MC ${selectedBuild.mcVersions.join(", ")} · ${selectedBuild.loaders.join(", ")} · ${selectedBuild.versionNumber}` : "Choose an exact published build";
  const sourceTiles = [
    { value: "vanilla" as const, title: "Vanilla", detail: "A fresh start. Add a loader if you like.", icon: Leaf },
    { value: "saved-set" as const, title: "Saved mod set", detail: "A recipe you've already put together.", icon: PackageOpen },
    { value: "modrinth" as const, title: "Published pack", detail: "Discover a new way to play.", icon: Compass },
  ];
  function changeSource(value: typeof kind) {
    if (!allowed || sending || value === kind) return;
    setKind(value); setSource(""); setSourceLoading(true);
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !sending) onOpenChange(false); }}>
      <DialogContent className={`${styles.dialog} sm:max-w-4xl`} showCloseButton={!sending} style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
        <ProfileDialogHero
          variant={adopt ? "adopt" : kind}
          eyebrow={adopt ? "Minecraft · Keep your world" : "Minecraft · World builder"}
          title={adopt ? "Keep the existing Minecraft world" : "Create a Minecraft profile"}
          description={adopt ? "Adoption preserves the existing world, mods and settings as one profile. It saves and stops Minecraft if running, then leaves it stopped. Other games are left alone." : "Prepare a separate world with its own version, mods and settings. Creating a profile does not start it or switch the current world."}
        />
        <div className={styles.body}>
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
            <fieldset disabled={sending || !allowed} className="min-w-0 space-y-4">
              <ProfileDialogReveal delay={.05}>
                <ProfileFormSection step="01" title={adopt ? "Give this world a home" : "Name your next adventure"} hint="You'll see this name whenever you choose a world.">
                  <div className="space-y-4">
                    <div className="space-y-2"><Label htmlFor={`${labelId}-name`}>Profile name</Label><Input id={`${labelId}-name`} className="h-11 bg-background/70" placeholder={adopt ? "Our original world" : "Sunday survival, a fresh adventure…"} value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
                    <div className="space-y-2"><Label htmlFor={`${labelId}-description`}>Description</Label><Input id={`${labelId}-description`} className="h-11 bg-background/70" placeholder="What makes this world yours?" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></div>
                  </div>
                </ProfileFormSection>
              </ProfileDialogReveal>
              {!adopt && <>
                <ProfileDialogReveal delay={.1}>
                  <ProfileFormSection step="02" title="Pick your starting point" hint="A blank canvas, a familiar recipe, or something new.">
                    <div className="mb-5 grid gap-2 sm:grid-cols-3" role="group" aria-label="Start from">
                      {sourceTiles.map(tile => <motion.button key={tile.value} type="button" aria-label={tile.title} aria-describedby={`${labelId}-hint-${tile.value}`} aria-pressed={kind === tile.value} disabled={sending || !allowed} onClick={() => changeSource(tile.value)} whileHover={reduced ? undefined : { y: -3 }} whileTap={reduced ? undefined : { scale: .98 }} className={`${styles.sourceTile} sm:flex-col`}>
                        <span className={styles.sourceIcon}><tile.icon className="size-4" aria-hidden="true" /></span><span className="min-w-0"><span className="block text-xs font-semibold">{tile.title}</span><span id={`${labelId}-hint-${tile.value}`} className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{tile.detail}</span></span>{kind === tile.value && <Check className="absolute right-2 top-2 size-3.5 text-foreground" aria-hidden="true" />}
                      </motion.button>)}
                    </div>
                    <ProfileDialogReveal key={kind}>
                      {kind === "vanilla" ? <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2"><Label htmlFor={`${labelId}-version`}>Minecraft version</Label><select className={styles.select} id={`${labelId}-version`} value={version} disabled={sourceLoading || !!sourceError} onChange={e => setVersion(e.target.value)}><option value="">Choose an exact version</option>{versions.map(v => <option key={v} value={v}>{v}</option>)}</select></div>
                        <div className="space-y-2"><Label htmlFor={`${labelId}-loader`}>Loader</Label><select className={styles.select} id={`${labelId}-loader`} value={loader} onChange={e => setLoader(e.target.value as MinecraftProfileLoader)}>{MINECRAFT_PROFILE_LOADERS.map(v => <option key={v}>{v}</option>)}</select></div>
                      </div> : <div className="space-y-4">
                        {kind === "modrinth" && <div className="space-y-2"><Label htmlFor={`${labelId}-query`}>Search published packs</Label><Input id={`${labelId}-query`} className="h-11" placeholder="Find a pack to build your world around…" value={query} onChange={e => { setQuery(e.target.value); setSource(""); setSourceLoading(true); }} /><p className="text-xs leading-relaxed text-muted-foreground">Search covers all versions. The profile uses the selected pack&apos;s target, not the current server&apos;s target.</p></div>}
                        <div className="space-y-2"><Label htmlFor={`${labelId}-choice`}>{kind === "saved-set" ? "Saved mod set" : "Published pack"}</Label><select className={styles.select} id={`${labelId}-choice`} disabled={sourceLoading || !!sourceError} value={source} onChange={e => { setSource(e.target.value); setBuild(""); setBuildSource(null); setBuildLoading(true); setBuildError(null); }}><option value="">Choose a source</option>{choices.map(choice => <option key={choice.id} value={choice.id} disabled={kind === "saved-set" && (!choice.mcVersion || !choice.loader)}>{choice.title}{kind === "saved-set" ? choice.mcVersion && choice.loader ? ` · ${choice.mcVersion} / ${choice.loader}` : " · no exact target recorded" : ""}</option>)}</select></div>
                        {kind === "modrinth" && source && <div className="space-y-2 rounded-xl bg-muted/40 p-3"><Label htmlFor={`${labelId}-build`}>Published pack build</Label><select className={styles.select} id={`${labelId}-build`} value={build} disabled={buildLoading || !!buildError || buildSource !== source} onChange={e => setBuild(e.target.value)}><option value="">Choose an exact published build</option>{builds.map(v => <option key={v.id} value={v.id} disabled={!v.supported}>{v.name} · {v.versionNumber} · MC {v.mcVersions.join(", ")} · {v.loaders.join(", ")}{!v.supported ? ` · ${v.reason || "unsupported"}` : ""}</option>)}</select><p className="text-xs leading-relaxed text-muted-foreground">These are the author’s declared targets. Preparation verifies the downloaded pack and pins this exact build.</p>{buildLoading && <p role="status">Reading published builds…</p>}{buildError && <p role="alert">{buildError}</p>}{!buildLoading && !buildError && buildSource === source && !builds.some(v => v.supported) && <p>No supported published builds were found for this pack.</p>}<Button variant="outline" disabled={buildLoading} onClick={() => { setBuildLoading(true); setBuildError(null); setBuildAttempt(v => v + 1); }}>Recheck pack builds</Button></div>}
                      </div>}
                      {(kind === "saved-set" || kind === "vanilla" && loader !== "vanilla") && <div className="mt-4 space-y-2"><Label htmlFor={`${labelId}-loader-version`}>{loader === "neoforge" ? "Exact NeoForge build (required for a custom loader)" : "Exact loader build (optional)"}</Label><Input id={`${labelId}-loader-version`} className="h-11" value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /><p className="text-xs leading-relaxed text-muted-foreground">Fabric, Forge and Quilt can be resolved and pinned automatically. A custom NeoForge profile needs an exact build.</p></div>}
                    </ProfileDialogReveal>
                    {sourceLoading && <p role="status" className="mt-3 text-xs text-muted-foreground">Reading available sources…</p>}
                    {sourceError && <div className="mt-3 space-y-2"><p role="alert">{sourceError}</p><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>Retry profile sources</Button></div>}
                  </ProfileFormSection>
                </ProfileDialogReveal>
                <ProfileDialogReveal delay={.15}>
                  <ProfileFormSection step="03" title="Make it yours" hint="Optional details for a world that starts fresh.">
                    <div className="space-y-4"><div className="space-y-2"><Label htmlFor={`${labelId}-seed`}>New world seed (optional)</Label><Input id={`${labelId}-seed`} className="h-11 font-mono" placeholder="Let Minecraft surprise you" value={seed} onChange={e => setSeed(e.target.value)} /><p className="text-xs leading-relaxed text-muted-foreground">The game creates this fresh world on its first start. No existing world is replaced.</p></div><div className="space-y-2"><Label htmlFor={`${labelId}-java`}>Java runtime</Label><select className={styles.select} id={`${labelId}-java`} value={java} onChange={e => setJava(e.target.value as typeof java)}><option value="">Automatic from Minecraft metadata</option>{MINECRAFT_JAVA_VARIANTS.map(v => <option key={v}>{v}</option>)}</select></div></div>
                  </ProfileFormSection>
                </ProfileDialogReveal>
              </>}
              {adopt && <ProfileDialogReveal delay={.1}><div className={styles.note}><ShieldCheck className="mt-px size-4 shrink-0 text-[var(--mc)]" aria-hidden="true" /><p>Your world gets its own profile. Its progress, mods and settings stay together; you choose when to start it again.</p></div><details className="mt-4 space-y-3 rounded-xl border border-border/70 bg-card/40 p-4"><summary className="flex cursor-pointer items-center gap-2 text-xs font-medium"><SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden="true" />Advanced: resolve an ambiguous existing installation</summary><p className="text-xs leading-relaxed text-muted-foreground">Only enter the exact loader build and Java variant reviewed for this existing world. These hints resolve unknown installation details; they do not select a different Minecraft version or loader.</p><Label htmlFor={`${labelId}-adopt-loader`}>Reviewed existing loader build (optional)</Label><Input id={`${labelId}-adopt-loader`} className="h-11" value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /><Label htmlFor={`${labelId}-adopt-java`}>Reviewed existing Java runtime (optional)</Label><select className={styles.select} id={`${labelId}-adopt-java`} value={java} onChange={e => setJava(e.target.value as typeof java)}><option value="">Read the existing installation automatically</option>{MINECRAFT_JAVA_VARIANTS.map(v => <option key={v}>{v}</option>)}</select></details></ProfileDialogReveal>}
            </fieldset>
            <ProfileDialogReveal delay={.2} className="lg:sticky lg:top-2"><ProfileDraftPreview name={name} description={description} source={previewSource} target={previewTarget} variant={adopt ? "adopt" : kind} adopt={adopt} /></ProfileDialogReveal>
          </div>
          <div className="mt-5 space-y-3">
            {adopt && currentRunning && <label className={`${styles.note} ${styles.warning} cursor-pointer`}><input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--mc)]" disabled={sending} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>I understand Minecraft players will be disconnected and Minecraft will remain stopped after adoption.</span></label>}
            {!allowed && <p role="status" className={styles.note}>Verified profile management and Minecraft settings permission are required.</p>}
            {error && <p role="alert" className={`${styles.note} ${styles.warning}`}>{error}</p>}
            {blocked && <p className="text-xs leading-relaxed text-muted-foreground">Close this dialog and recheck the profile list and operation strip before another attempt.</p>}
            {!adopt && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Sparkles className="size-3.5 shrink-0 text-[var(--mc)]" aria-hidden="true" />You can add a world screenshot from the profile details after preparation.</p>}
          </div>
        </div>
        <DialogFooter className={`${styles.footer} items-center sm:justify-between`}>
          <p className="mr-auto hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><ShieldCheck className="size-3.5 text-[var(--mc)]" aria-hidden="true" />{adopt ? "Keeps your world · Leaves Minecraft stopped" : "Prepare now · Start when you're ready"}</p>
          <div className="flex w-full gap-2 sm:w-auto"><Button className="h-11 flex-1 sm:flex-none" variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>Cancel</Button><Button className="h-11 flex-1 gap-2 sm:flex-none" disabled={!allowed || !name.trim() || !validSource || sending || blocked || (adopt && currentRunning && !confirmed)} onClick={() => void submit()}>{sending ? "Submitting…" : adopt ? "Keep existing world" : "Prepare profile"}<ArrowRight className="size-4" aria-hidden="true" /></Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
