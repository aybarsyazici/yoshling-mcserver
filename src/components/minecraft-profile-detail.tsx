"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { useUnsavedSettings } from "@/lib/use-unsaved-settings";
import { parseMinecraftProfileDetail, parseMinecraftProfiles, parseProfileWorldSettings, isMinecraftProfile, profileSourceLabel, profileLastPlayed } from "@/lib/minecraft-profiles-client";
import { readOperationResponse, UnconfirmedOperationResult, unconfirmedOperationMessage } from "@/lib/operation-client";
import { useOperations } from "@/components/operations-provider";
import { gameRuleReplacing } from "@/lib/mc-properties";
import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";
import type { MinecraftProfileDetailDTO, MinecraftProfileWorldSettingsDTO } from "@/lib/minecraft-profile-types";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { MinecraftProfileCapture } from "@/components/minecraft-profile-capture";
import { MinecraftProfileImage } from "@/components/minecraft-profile-image";
import { MinecraftProfileOverview } from "@/components/minecraft-profile-overview";
import type { MinecraftProfileOverviewDTO } from "@/lib/minecraft-profile-overview-types";
import { sameCaptureMetadata } from "@/lib/minecraft-capture-client";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import { GAMES } from "@/lib/games";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function MinecraftProfileDetail({ id }: { id: string }) { return <DetailSession key={id} id={id} />; }
function DetailSession({ id }: { id: string }) {
  const labels = useId(); const games = useGames(CAPABILITY_POLL_MS);
  const { refresh: refreshOperations } = useOperations();
  const [data, setData] = useState<MinecraftProfileDetailDTO | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [saving, setSaving] = useState(false); const [play, setPlay] = useState(false);
  const [settings, setSettings] = useState<MinecraftProfileWorldSettingsDTO | null>(null); const [draft, setDraft] = useState<Record<string, string>>({}); const [revision, setRevision] = useState<string | null>(null); const [settingsError, setSettingsError] = useState<string | null>(null);
  const settingsGeneration = useRef(0); const [settingsLoading, setSettingsLoading] = useState(true);
  const [cover, setCover] = useState<File | null>(null); const [notice, setNotice] = useState<string | null>(null); const generation = useRef(0);
  const [deleting, setDeleting] = useState(false); const [deleteName, setDeleteName] = useState(""); const [deleted, setDeleted] = useState(false);
  const [overviewEpoch, setOverviewEpoch] = useState(0);
  const captureSnapshot = useRef<{ data: MinecraftProfileDetailDTO | null; saving: boolean }>({ data: null, saving: false });
  useEffect(() => { captureSnapshot.current = { data, saving }; }, [data, saving]);
  const endpoint = `/api/minecraft/profiles/${encodeURIComponent(id)}`;
  const dirtyMetadata = !!data && (name !== data.profile.name || description !== data.profile.description);
  const dirtySettings = !!settings && Object.entries(draft).some(([key, value]) => value !== settings.properties[key]);
  useUnsavedSettings(dirtyMetadata || dirtySettings || cover !== null);
  const currentPermission = !games.loading && !games.pollError && games.access.includes("minecraft") && games.can.settingsEdit === true;
  const canEdit = !loading && !error && !saving && data?.capabilities.manage === true && currentPermission;
  const active = !!data && [data.runtime.selectedProfileId, data.runtime.appliedProfileId].includes(id);
  const canEditWorld = canEdit && !active && settings?.editable === true && !!revision && !settingsError && !settingsLoading;
  const canDelete = canEdit && !active && data?.runtime.verified === true && data.runtime.state !== "unknown";
  const readDetail = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" }); const raw = await response.json();
    if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "The profile could not be read.");
    const parsed = parseMinecraftProfileDetail(raw, id); if (!parsed || !parsed.capabilities.read) throw new Error("The profile response is incomplete or cannot be read by this account.");
    return parsed;
  }, [endpoint, id]);
  const acceptOverview = useCallback((overview: MinecraftProfileOverviewDTO) => {
    setData(current => current?.profile.id === id ? { ...current, profile: { ...current.profile, overview } } : current);
  }, [id]);
  const acceptCapture = useCallback(async (captured: MinecraftProfileDTO, baseline: MinecraftProfileDTO) => {
    const request = generation.current;
    try {
    const current = await readDetail();
    if (request !== generation.current) throw new Error("The profile changed while checking the capture. Reload it before another edit.");
    const latest = captureSnapshot.current;
    if (!latest.data || latest.saving || latest.data.profile.revision !== baseline.revision || !sameCaptureMetadata(latest.data.profile, baseline) || !sameCaptureMetadata(captured, baseline) || !sameCaptureMetadata(current.profile, captured) || current.profile.revision !== captured.revision || captured.revision !== baseline.revision + 1 || current.profile.coverUrl !== captured.coverUrl || !captured.coverUrl) {
      const message = "The profile or cover changed while checking the screenshot. Your drafts are preserved; reload before another edit.";
      setError(message); throw new Error(message);
    }
    setData(current);
    setNotice("Screenshot cover read back and saved. Unsaved profile details, world settings and selected uploads are preserved.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "The screenshot cover readback is unconfirmed. Your drafts are preserved; reload before another edit.";
      if (request === generation.current) setError(message);
      throw new Error(message);
    }
  }, [readDetail]);
  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setOverviewEpoch(value => value + 1);
    try { const parsed = await readDetail(); if (request !== generation.current) return false; setData(parsed); setName(parsed.profile.name); setDescription(parsed.profile.description); setError(null); setCover(null); setOverviewEpoch(value => value + 1); return true; }
    catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : "The profile could not be read."); return false; }
    finally { if (request === generation.current) setLoading(false); }
  }, [readDetail]);
  const loadSettings = useCallback(async () => {
    const request = ++settingsGeneration.current, detailRequest = generation.current; setSettingsLoading(true);
    const obsolete = () => request !== settingsGeneration.current || detailRequest !== generation.current;
    try { const response = await fetch(`${endpoint}/world-settings`, { cache: "no-store" }); const raw = await response.json(); if (obsolete()) return;
      const parsed = parseProfileWorldSettings(raw, id); if (!response.ok || !parsed) throw new Error(typeof raw?.error === "string" ? raw.error : "The world settings response is incomplete.");
      const observed = fileRevision(response); setSettings(parsed); setDraft(parsed.properties); setRevision(observed); setSettingsError(observed ? null : "The world settings revision is missing. Reload before saving.");
    } catch (e) { if (!obsolete()) setSettingsError(e instanceof Error ? e.message : "World settings could not be read."); }
    finally { if (!obsolete()) setSettingsLoading(false); }
  }, [endpoint, id]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { let current = true; void Promise.resolve().then(() => { if (current) return load(); }); return () => { current = false; invalidate(); }; }, [load, invalidate]);
  const loadedProfileId = data?.profile.id;
  useEffect(() => { if (loadedProfileId) void Promise.resolve().then(loadSettings); }, [loadedProfileId, loadSettings]);
  async function reload(): Promise<boolean> { if ((dirtyMetadata || dirtySettings || cover) && !window.confirm("Reload this profile and discard your unsaved changes?")) return false; setNotice(null); const accepted = await load(); if (accepted) await loadSettings(); return accepted; }
  async function saveMetadata() {
    if (!canEdit || !data || !dirtyMetadata || !name.trim()) return; setSaving(true); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: data.profile.revision, name: name.trim(), description: description.trim() }) }); const raw = await response.json();
      if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "The profile save was refused.");
      if (!isMinecraftProfile(raw.profile) || raw.profile.id !== id || raw.profile.name !== name.trim() || raw.profile.description !== description.trim() || raw.profile.revision <= data.profile.revision) throw new Error("The profile save receipt is unconfirmed.");
      const current = await readDetail(); if (current.profile.revision !== raw.profile.revision || current.profile.name !== raw.profile.name || current.profile.description !== raw.profile.description) throw new Error("The profile changed during save readback.");
      setData(current); setName(current.profile.name); setDescription(current.profile.description); setNotice("Profile details read back and saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "The profile save result is unconfirmed. Reload before retrying."); }
    finally { setSaving(false); }
  }
  async function saveCover(remove = false) {
    if (!canEdit || !data || (!remove && !cover)) return; setSaving(true); setNotice(null);
    try {
      const form = new FormData(); if (cover) form.set("cover", cover); form.set("expectedRevision", String(data.profile.revision));
      const response = await fetch(`${endpoint}/cover`, remove ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: data.profile.revision }) } : { method: "POST", body: form }); const raw = await response.json();
      if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "The cover update was refused.");
      if (!isMinecraftProfile(raw.profile) || raw.profile.id !== id || raw.profile.revision <= data.profile.revision || (remove ? raw.profile.coverUrl !== null : raw.profile.coverUrl === null)) throw new Error("The cover receipt is unconfirmed.");
      const current = await readDetail(); if (current.profile.revision !== raw.profile.revision || current.profile.coverUrl !== raw.profile.coverUrl) throw new Error("The cover changed during readback.");
      setData(current); setCover(null); setNotice(remove ? "Cover removal read back." : "Cover upload read back.");
    } catch (e) { setError(e instanceof Error ? e.message : "The cover result is unconfirmed. Reload before retrying."); }
    finally { setSaving(false); }
  }
  async function saveWorld() {
    if (!canEditWorld || !settings || !dirtySettings) return;
    const updates = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== settings.properties[key] && settings.editableKeys.includes(key) && !settings.lockedKeys.includes(key) && !(settings.worldGenerated && settings.creationOnlyKeys.includes(key)) && !gameRuleReplacing(key, data!.profile.target.mcVersion)));
    if (Object.keys(updates).length === 0) return; setSaving(true); setNotice(null);
    try {
      const response = await fetch(`${endpoint}/world-settings`, { method: "PUT", headers: { "Content-Type": "application/json", ...revisionHeaders(revision) }, body: JSON.stringify({ updates }) }); const raw = await response.json();
      if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "The settings update was refused.");
      if (raw.profileId !== id || !Array.isArray(raw.applied) || !raw.applied.every((key: unknown) => typeof key === "string" && Object.hasOwn(updates, key)) || new Set(raw.applied).size !== raw.applied.length || !Array.isArray(raw.ignored)) throw new Error("The world settings receipt is unconfirmed.");
      const readback = await fetch(`${endpoint}/world-settings`, { cache: "no-store" }); const parsed = parseProfileWorldSettings(await readback.json(), id);
      if (!readback.ok || !parsed || (fileRevision(response) && fileRevision(response) !== fileRevision(readback)) || Object.entries(updates).some(([key, value]) => !raw.applied.includes(key) || parsed.properties[key] !== value)) throw new Error("The settings could not be confirmed by readback.");
      setSettings(parsed); setDraft(parsed.properties); setRevision(fileRevision(readback)); setNotice("World settings file values read back and saved. This does not verify what a running game uses.");
    } catch (e) { setSettingsError(e instanceof Error ? e.message : "The settings save result is unconfirmed. Reload before retrying."); }
    finally { setSaving(false); }
  }
  async function deleteProfile() {
    if (!canDelete || !data || deleteName !== data.profile.name || saving) return;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: data.profile.revision, confirm: true }) });
      const receipt = await readOperationResponse(response);
      if (!response.ok && !receipt.operationId && receipt.error) throw new Error(receipt.error);
      if (!response.ok || !receipt.operationId || receipt.deleted !== true || receipt.id !== id) throw new UnconfirmedOperationResult(receipt.operationId);
      const readback = await fetch("/api/minecraft/profiles", { cache: "no-store" }); const current = parseMinecraftProfiles(await readback.json());
      if (!readback.ok || !current || !current.capabilities.read || current.profiles.some(profile => profile.id === id) || current.runtime.selectedProfileId === id || current.runtime.appliedProfileId === id) throw new UnconfirmedOperationResult(receipt.operationId);
      setDeleted(true); setDeleting(false); setCover(null); setName(data.profile.name); setDescription(data.profile.description); setDraft(settings?.properties ?? {});
    } catch (e) { setError(e instanceof UnconfirmedOperationResult ? unconfirmedOperationMessage("profile deletion", e) : e instanceof Error ? e.message : "The profile deletion result is unconfirmed. Reload before retrying."); setDeleting(false); }
    finally { void refreshOperations(); setSaving(false); }
  }
  if (deleted) return <div className="space-y-3"><h1 className="font-display text-2xl font-bold">Profile removed from the list</h1><p>The deletion receipt and profile list were read back. Check the operation strip for the recorded outcome.</p><Link href="/minecraft" className="inline-flex min-h-10 items-center underline">All Minecraft profiles</Link></div>;
  if (loading && !data) return <p role="status">Reading profile…</p>;
  return <div className="space-y-6" style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
    <Link href="/minecraft" className="inline-flex min-h-10 items-center text-sm underline">All Minecraft profiles</Link>
    {error && <div role="alert" className="space-y-2"><p>{error} Reload before another edit.</p><Button variant="outline" disabled={saving} onClick={() => void reload()}>Reload profile</Button></div>}
    {data && <>
      <header className="space-y-2"><h1 className="font-display text-3xl font-bold">{data.profile.name}</h1><p>{data.profile.target.mcVersion} · {data.profile.target.loader}{data.profile.target.loaderVersion ? ` ${data.profile.target.loaderVersion}` : ""} · {data.profile.target.javaVariant} · Created from {profileSourceLabel(data.profile)}</p><p className="text-sm text-muted-foreground">{data.profile.status === "preparing" ? "Preparation incomplete; check the operation strip" : data.profile.status} · Last played: {profileLastPlayed(data.profile)}</p><p className="text-sm">{active ? "This profile is selected or applied. Use its current Mods, Settings and Backups pages for game changes." : "This is an inactive profile. Editing it leaves the current Minecraft world untouched."}</p><Button disabled={data.runtime.verified && data.runtime.appliedProfileId === id && ["running", "starting"].includes(data.runtime.state) || loading || !!error || data.profile.status !== "ready" || !data.capabilities.start || games.loading || !!games.pollError || !games.can.start} onClick={() => setPlay(true)}>{data.runtime.verified && data.runtime.appliedProfileId === id && ["running", "starting"].includes(data.runtime.state) ? "Already running" : "Choose this profile to play"}</Button></header>
      <section className="space-y-3 rounded-2xl bg-card/70 p-5"><h2 className="font-display text-lg font-semibold">Profile details</h2><Label htmlFor={`${labels}-name`}>Name</Label><Input id={`${labels}-name`} disabled={!canEdit} value={name} maxLength={80} onChange={e => setName(e.target.value)} /><Label htmlFor={`${labels}-description`}>Description</Label><Input id={`${labels}-description`} disabled={!canEdit} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /><Button disabled={!canEdit || !dirtyMetadata || !name.trim()} onClick={() => void saveMetadata()}>Save profile details</Button></section>
      <section data-minecraft-tour="profile-image" className="space-y-4 rounded-2xl bg-card/70 p-5"><h2 className="font-display text-lg font-semibold">Profile image</h2>
        <div className="relative aspect-video overflow-hidden rounded-xl"><MinecraftProfileImage profile={data.profile} /></div>
        <MinecraftProfileOverview profile={data.profile} canRender={canEdit} readEpoch={overviewEpoch} onOverviewRead={acceptOverview} onProfileRecheck={reload} />
        <div className="space-y-3 border-t border-border/70 pt-4"><h3 className="font-display font-semibold">Optional custom cover</h3><p className="text-sm text-muted-foreground">Upload a screenshot or capture one from your client to override the generated overview. Removing a custom cover reveals the generated default, when available.</p>
          <Label htmlFor={`${labels}-cover`}>JPEG, PNG or WebP cover</Label><Input id={`${labels}-cover`} type="file" accept="image/jpeg,image/png,image/webp" disabled={!canEdit} onChange={e => { const file = e.target.files?.[0]; if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setNotice("Choose a JPEG, PNG or WebP image."); setCover(null); } else setCover(file ?? null); }} />
          <div className="flex flex-wrap gap-2"><Button disabled={!canEdit || !cover} onClick={() => void saveCover()}>Upload cover</Button>{data.profile.coverUrl && <Button variant="outline" disabled={!canEdit} onClick={() => void saveCover(true)}>Remove cover</Button>}</div>
          <MinecraftProfileCapture profile={data.profile} runtime={data.runtime} canEdit={canEdit} onCaptured={acceptCapture} onRecheck={reload} />
        </div>
      </section>
      <section data-minecraft-tour="profile-settings" className="space-y-3 rounded-2xl bg-card/70 p-5"><h2 className="font-display text-lg font-semibold">World settings</h2>{active && <p className="text-sm"><Link className="underline" href="/minecraft/settings">Open the applied profile&apos;s settings</Link>. Inactive editing is unavailable for the selected or applied profile.</p>}{settingsError && <div role="alert"><p>{settingsError}</p><Button variant="outline" disabled={saving || settingsLoading} onClick={() => { if (!dirtySettings || window.confirm("Reload world settings and discard the draft?")) void loadSettings(); }}>Reload world settings</Button></div>}{settings && <><div className="grid gap-4 sm:grid-cols-2">{[...new Set([...Object.keys(settings.properties), ...settings.editableKeys])].filter(key => !settings.lockedKeys.includes(key)).map(key => { const value = settings.properties[key]; const creationLocked = settings.worldGenerated && settings.creationOnlyKeys.includes(key); const inert = gameRuleReplacing(key, data.profile.target.mcVersion); const editable = canEditWorld && settings.editableKeys.includes(key) && !settings.lockedKeys.includes(key) && !creationLocked && !inert; return <div key={key} className="space-y-1"><Label htmlFor={`${labels}-${key}`}>{key}</Label><Input id={`${labels}-${key}`} value={draft[key] ?? value ?? ""} placeholder={value === undefined ? "Not set; game default" : undefined} disabled={!editable} onChange={e => { if (editable) setDraft(prev => ({ ...prev, [key]: e.target.value })); }} />{inert && <p className="text-xs text-muted-foreground">This Minecraft version uses the {inert} game rule instead. Edit it after this profile starts.</p>}{creationLocked && <p className="text-xs text-muted-foreground">Used only when creating a new world; this world already exists.</p>}</div>; })}</div><Button disabled={!canEditWorld || !dirtySettings} onClick={() => void saveWorld()}>Save world settings</Button></>}</section>
      <p className="text-sm text-muted-foreground">The prepared Minecraft version, loader and mod source belong to this profile. Create another profile for a different target. Shared host resources and server access remain global.</p>
      {active && <nav className="flex flex-wrap gap-4 text-sm"><Link className="underline" href="/minecraft/mods">Applied profile mods</Link><Link className="underline" href="/minecraft/settings">Applied profile settings</Link><Link className="underline" href="/minecraft/backups">Applied profile backups</Link></nav>}
    </>}
    {data && <details className="rounded-xl border border-destructive/30 p-4"><summary className="cursor-pointer text-sm font-medium">Advanced: permanently delete this profile</summary><p className="my-3 text-sm">Deletion removes this profile’s world, mods, settings and checkpoints. Independent world backup files are retained.</p><p className="mb-3 text-xs text-muted-foreground">{active ? "Choose another profile first; selected or applied profiles cannot be deleted." : !canDelete ? "A verified inactive profile and current management permission are required." : "This cannot be undone from the profile gallery."}</p><Button variant="destructive" disabled={!canDelete} onClick={() => { setDeleteName(""); setDeleting(true); }}>Delete profile</Button></details>}
    <Dialog open={deleting} onOpenChange={open => { if (!saving) setDeleting(open); }}><DialogContent className="max-h-[85dvh] overflow-y-auto" showCloseButton={!saving}><DialogHeader><DialogTitle>Permanently delete {data?.profile.name}?</DialogTitle><DialogDescription>The world, mods, settings and checkpoints will be removed. Independent world backup files are retained. Type the exact profile name to confirm.</DialogDescription></DialogHeader><Label htmlFor={`${labels}-delete`}>Profile name confirmation</Label><Input id={`${labels}-delete`} value={deleteName} disabled={saving || !canDelete} onChange={e => setDeleteName(e.target.value)} /><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDeleting(false)}>Cancel</Button><Button variant="destructive" disabled={!canDelete || saving || deleteName !== data?.profile.name} onClick={() => void deleteProfile()}>{saving ? "Deleting…" : "Delete this profile permanently"}</Button></DialogFooter></DialogContent></Dialog>
    {notice && <p role="status">{notice}</p>}
    <MinecraftProfilePicker open={play} initialProfileId={id} onOpenChange={setPlay} onSubmitted={() => void load()} />
  </div>;
}
