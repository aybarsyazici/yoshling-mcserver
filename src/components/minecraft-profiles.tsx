"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderHeart, Layers3, Plus, RefreshCw } from "lucide-react";
import { useMinecraftProfiles } from "@/lib/use-minecraft-profiles";
import { useGames } from "@/lib/use-games";
import { GAMES } from "@/lib/games";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import { MinecraftProfileCard } from "@/components/minecraft-profile-card";
import { MinecraftProfileCreate } from "@/components/minecraft-profile-create";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { MinecraftProfileImage } from "@/components/minecraft-profile-image";
import { GameControls } from "@/components/game-controls";
import { JoinPanel } from "@/components/join-panel";
import { SectionHeading } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { profileSourceLabel } from "@/lib/minecraft-profiles-client";
import { useOperations } from "@/components/operations-provider";

export function MinecraftProfiles() {
  const list = useMinecraftProfiles(); const status = useGames(5000);
  const { operations } = useOperations();
  const [create, setCreate] = useState(false); const [adopt, setAdopt] = useState(false); const [play, setPlay] = useState<MinecraftProfileDTO | null>(null);
  const active = list.data?.profiles.find(profile => profile.id === list.data?.runtime.appliedProfileId);
  const pending = operations.some(operation => operation.kind === "profile.prepare" && !operation.endedAt && !operation.stalled);
  const refreshProfiles = list.refresh;
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refreshProfiles(); }, pending ? 5000 : 10000); return () => clearInterval(timer); }, [pending, refreshProfiles]);
  const currentRunning = status.games?.minecraft?.containerRunning === true || ["online", "starting"].includes(status.games?.minecraft?.status ?? "");
  const currentPermission = !status.loading && !status.pollError && status.access.includes("minecraft");
  const manage = list.ready && currentPermission && list.data?.capabilities.manage === true && status.can.settingsEdit === true;
  const canPlay = list.ready && currentPermission && !list.data?.requiresAdoption && list.data?.runtime.state !== "unknown" && (currentRunning ? status.can.restart && list.data?.capabilities.switch === true : status.can.start && list.data?.capabilities.start === true);
  return <div className="space-y-6" style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
    <div data-minecraft-tour="profiles"><SectionHeading eyebrow="Minecraft · Worlds" title="Minecraft profiles" sub="Keep each world with its own version, mods and settings. Choose a prepared profile when you start Minecraft." tint={GAMES.minecraft.tint} /></div>
    {list.error && <div role="alert" className="space-y-2 rounded-xl bg-card p-4"><p>{list.error} Any displayed profiles are from the last successful read.</p><Button variant="outline" onClick={() => void list.refresh()}>Retry Minecraft profiles</Button></div>}
    {list.loading && !list.data && <p role="status">Reading Minecraft profiles…</p>}
    {list.data && <>
      <section data-minecraft-tour="current-profile" aria-label="Current Minecraft profile" className="relative overflow-hidden rounded-3xl bg-card/80 ring-1 ring-foreground/10">
        <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-24 size-72 rounded-full bg-[var(--tint)]/10 blur-3xl" />
        <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-3">
        <p className="eyebrow flex items-center gap-2 text-muted-foreground"><Layers3 aria-hidden="true" className="size-4" />Current Minecraft profile</p>
        {active && list.data.runtime.verified ? <><h2 className="font-display text-xl font-bold">{active.name}</h2><p className="text-sm">{active.target.mcVersion} · {active.target.loader} · Created from {profileSourceLabel(active)}</p><p className="text-xs text-muted-foreground">{currentRunning ? "The Minecraft container is running. Join availability is checked separately below." : "Applied and stopped. Starting opens the profile picker."}</p></> : <p>{list.data.requiresAdoption ? "The existing world has not been adopted yet." : list.data.runtime.reason || "No applied profile has been verified."}</p>}
        {list.data.runtime.selectedProfileId !== list.data.runtime.appliedProfileId && <p className="text-sm">The selected and applied profiles differ. Recheck the operation strip before editing or starting.</p>}
        <div data-minecraft-tour="join"><JoinPanel game="minecraft" snapshot={status.games?.minecraft} lastSuccessAt={status.lastSuccessAt} pollError={status.pollError} busy={!!status.busy} /></div>
        <details><summary className="cursor-pointer py-2 text-sm">Server controls and recovery</summary><GameControls game="minecraft" /></details>
        </div>
        <div aria-hidden="true" className="relative hidden aspect-video self-start overflow-hidden rounded-2xl bg-muted ring-1 ring-foreground/10 lg:block">
          {active ? <MinecraftProfileImage profile={active} decorative compact sizes="256px" /> : <><MinecraftProfileScene variant="adopt" className="size-full" /><span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-xs text-white/90">World illustration</span></>}
        </div>
        </div>
      </section>
      {list.data.requiresAdoption && <section aria-label="Keep existing world" className="flex flex-col gap-4 rounded-3xl border border-[var(--tint)]/30 bg-[var(--tint)]/5 p-5 sm:flex-row sm:items-center sm:p-6"><div aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[var(--tint)]/15"><FolderHeart className="size-6" /></div><div className="flex-1 space-y-2"><h2 className="font-display text-lg font-semibold">Keep the world already on this server</h2><p className="max-w-2xl text-sm text-muted-foreground">Adopt its existing save, mods and settings before switching profiles. Adoption is separate from starting Minecraft.</p></div><Button disabled={!manage} onClick={() => setAdopt(true)}>Keep existing world as a profile</Button></section>}
      <div className="flex flex-wrap items-end justify-between gap-3"><div className="space-y-1"><h2 className="font-display text-xl font-semibold">Your worlds</h2><p className="text-sm text-muted-foreground">{list.data.profiles.length} saved profile{list.data.profiles.length === 1 ? "" : "s"}. Preparing a profile leaves the current world untouched.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={list.loading} onClick={() => void list.refresh()}><RefreshCw aria-hidden="true" className="size-3.5" />Recheck profiles</Button>{list.data.capabilities.manage && <Button data-minecraft-tour="profile-create" disabled={!manage} onClick={() => setCreate(true)}><Plus aria-hidden="true" className="size-4" />Create profile</Button>}</div></div>
      <section data-minecraft-tour="worlds">{list.data.profiles.length === 0 ? <p className="rounded-xl bg-card/50 p-6 text-sm">No profiles have been prepared yet. Create a new world or keep the existing one above.</p> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{list.data.profiles.map(profile => <MinecraftProfileCard key={profile.id} profile={profile} selected={profile.id === list.data!.runtime.selectedProfileId} applied={list.data!.runtime.verified && profile.id === list.data!.runtime.appliedProfileId} canPlay={canPlay && !(currentRunning && profile.id === list.data!.runtime.appliedProfileId)} running={currentRunning} onPlay={setPlay} />)}</div>}</section>
      <p className="text-xs text-muted-foreground">Saved mod sets are recipes for new profiles; published packs are sources. Profile progress is kept with its world. <Link className="underline" href="/minecraft/mods">Open the applied profile&apos;s mods and saved sets</Link>.</p>
    </>}
    <MinecraftProfileCreate open={create || adopt} adopt={adopt} data={list.ready ? list.data : null} onOpenChange={open => { if (!open) { setCreate(false); setAdopt(false); } }} onPrepared={() => void list.refresh()} />
    <MinecraftProfilePicker open={play !== null} initialProfileId={play?.id} onOpenChange={open => { if (!open) setPlay(null); }} onSubmitted={() => void list.refresh()} />
  </div>;
}
