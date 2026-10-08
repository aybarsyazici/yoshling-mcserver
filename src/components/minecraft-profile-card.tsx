"use client";
import Image from "next/image";
import Link from "next/link";
import { Package, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { profileLastPlayed, profileSourceLabel } from "@/lib/minecraft-profiles-client";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";

export function MinecraftProfileCard({ profile, selected, applied, canPlay, running, onPlay }: { profile: MinecraftProfileDTO; selected: boolean; applied: boolean; canPlay: boolean; running: boolean; onPlay(profile: MinecraftProfileDTO): void }) {
  return <article className="overflow-hidden rounded-2xl bg-card/70 ring-1 ring-foreground/10" aria-label={`Profile ${profile.name}`}>
    <Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`} className="relative grid aspect-video place-items-center overflow-hidden bg-muted focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open ${profile.name}`}>
      {profile.coverUrl ? <Image src={profile.coverUrl} alt="" fill sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" className="object-cover" unoptimized /> : <div className="text-center text-muted-foreground"><Mountain className="mx-auto size-10 opacity-40" /><p className="mt-2 text-xs">No world screenshot yet</p></div>}
    </Link>
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-lg font-semibold"><Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`}>{profile.name}</Link></h2><span className="rounded bg-muted px-2 py-1 text-xs">{applied ? "Applied" : selected ? "Selected" : profile.status === "ready" ? "Ready to start" : profile.status === "preparing" ? "Preparation incomplete" : "Needs attention"}</span></div>
      {profile.description && <p className="line-clamp-2 text-sm text-muted-foreground">{profile.description}</p>}
      <p className="font-mono text-xs">Minecraft {profile.target.mcVersion} · {profile.target.loader}</p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Package className="size-3.5" />Created from {profileSourceLabel(profile)}{profile.modCount !== undefined ? ` · ${profile.modCount} mods` : ""}</p>
      {profile.error && <p role="alert" className="text-xs">{profile.error}</p>}
      {profile.status === "preparing" && <p className="text-xs text-muted-foreground">Check the operation strip to see whether preparation is running or was interrupted.</p>}
      <p className="text-xs text-muted-foreground">Last played: {profileLastPlayed(profile)}</p>
      <div className="flex flex-wrap gap-2"><Button className="min-h-10" disabled={!canPlay || profile.status !== "ready"} onClick={() => onPlay(profile)}>{running && applied ? "Already running" : running ? "Switch & restart" : "Start this profile"}</Button><Button nativeButton={false} variant="outline" className="min-h-10" render={<Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`} />}>Details</Button></div>
    </div>
  </article>;
}
