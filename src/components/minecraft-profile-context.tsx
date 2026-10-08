"use client";
import Link from "next/link";
import { useMinecraftProfiles } from "@/lib/use-minecraft-profiles";
import { Button } from "@/components/ui/button";

export function MinecraftProfileContext() {
  const { data, error, loading, refresh } = useMinecraftProfiles();
  const selected = data?.profiles.find(profile => profile.id === data.runtime.selectedProfileId);
  return <aside data-minecraft-tour="profile-context" aria-label="Minecraft profile context" className="space-y-2 rounded-xl bg-card/70 p-4 ring-1 ring-foreground/10">
    {loading ? <p role="status">Checking the Minecraft profile…</p> : error ? <><p role="alert">{error}</p><Button variant="outline" onClick={() => void refresh()}>Retry profile context</Button></> : data?.requiresAdoption ? <p>The existing world has not been adopted as a profile. <Link className="underline" href="/minecraft">Open profiles to keep it.</Link></p> : selected ? <>
      <p className="text-sm">Selected profile: <Link className="font-semibold underline" href={`/minecraft/profiles/${encodeURIComponent(selected.id)}`}>{selected.name}</Link> · {selected.target.mcVersion} · {selected.target.loader}</p>
      <p className="text-xs text-muted-foreground">{data?.runtime.verified && data.runtime.appliedProfileId === selected.id ? "This page reads and changes this profile. Shared host resources and access remain server settings." : data?.runtime.reason || "The applied profile identity is unconfirmed. Recheck before editing."}</p>
    </> : <p>No profile is selected. <Link className="underline" href="/minecraft">Choose a profile.</Link></p>}
    {!loading && !error && <Link href="/minecraft" className="inline-flex min-h-10 items-center text-sm underline">All Minecraft profiles</Link>}
  </aside>;
}
