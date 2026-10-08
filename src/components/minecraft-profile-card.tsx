"use client";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Clock3, Package, Play } from "lucide-react";
import { motion, usePrefersReducedMotion } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { profileLastPlayed, profileSourceLabel } from "@/lib/minecraft-profiles-client";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";

export function MinecraftProfileCard({ profile, selected, applied, canPlay, running, onPlay }: { profile: MinecraftProfileDTO; selected: boolean; applied: boolean; canPlay: boolean; running: boolean; onPlay(profile: MinecraftProfileDTO): void }) {
  const reducedMotion = usePrefersReducedMotion();
  const scene = profile.source.kind === "legacy" ? "adopt" : profile.source.kind === "saved-set" ? "saved-set" : profile.source.kind === "modrinth" ? "modrinth" : "vanilla";
  return <motion.article initial={reducedMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : 0.3 }} className={`group overflow-hidden rounded-3xl bg-card/80 ring-1 transition-shadow hover:shadow-xl hover:shadow-black/10 ${applied ? "ring-[var(--tint)]/60" : "ring-foreground/10"}`} aria-label={`Profile ${profile.name}`}>
    <Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`} className="relative grid aspect-video place-items-center overflow-hidden bg-muted focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open ${profile.name}`}>
      {profile.coverUrl ? <Image src={profile.coverUrl} alt="" fill sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" className="object-cover motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-105" unoptimized /> : <><MinecraftProfileScene variant={scene} className="absolute inset-0 size-full" /><span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-10 text-xs text-white/85">No world screenshot yet</span></>}
      <span className="absolute left-3 top-3 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur">{applied ? "Applied" : selected ? "Selected" : profile.status === "ready" ? "Ready to start" : profile.status === "preparing" ? "Preparation incomplete" : "Needs attention"}</span>
      <span aria-hidden="true" className="absolute right-3 top-3 grid size-8 place-items-center rounded-full bg-background/80 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><ArrowUpRight className="size-4" /></span>
    </Link>
    <div className="space-y-3 p-5">
      <h2 className="font-display text-xl font-semibold tracking-tight"><Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`} className="break-words hover:underline">{profile.name}</Link></h2>
      {profile.description && <p className="line-clamp-2 text-sm text-muted-foreground">{profile.description}</p>}
      <p className="font-mono text-xs">Minecraft {profile.target.mcVersion} · {profile.target.loader}</p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Package className="size-3.5" />Created from {profileSourceLabel(profile)}{profile.modCount !== undefined ? ` · ${profile.modCount} mods` : ""}</p>
      {profile.error && <p role="alert" className="text-xs">{profile.error}</p>}
      {profile.status === "preparing" && <p className="text-xs text-muted-foreground">Check the operation strip to see whether preparation is running or was interrupted.</p>}
      <p className="flex items-center gap-1.5 border-t border-foreground/10 pt-3 text-xs text-muted-foreground"><Clock3 aria-hidden="true" className="size-3.5" />Last played: {profileLastPlayed(profile)}</p>
      <div className="flex flex-wrap gap-2"><Button className="min-h-10 flex-1" disabled={!canPlay || profile.status !== "ready"} onClick={() => onPlay(profile)}><Play aria-hidden="true" className="size-3.5" />{running && applied ? "Already running" : running ? "Switch & restart" : "Start this profile"}</Button><Button nativeButton={false} variant="outline" className="min-h-10" render={<Link href={`/minecraft/profiles/${encodeURIComponent(profile.id)}`} />}>Details</Button></div>
    </div>
  </motion.article>;
}
