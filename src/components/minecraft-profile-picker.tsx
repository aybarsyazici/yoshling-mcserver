"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMinecraftProfiles } from "@/lib/use-minecraft-profiles";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { liveFileOperations, namedFileOperations } from "@/lib/operation-ui";
import { readOperationResponse, unconfirmedOperationMessage, UnconfirmedOperationResult } from "@/lib/operation-client";
import { GAMES, GAME_LIST } from "@/lib/games";
import { profileSourceLabel } from "@/lib/minecraft-profiles-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import Image from "next/image";
import { motion } from "motion/react";
import { ArrowRight, Check, HardDrive, ShieldCheck, Users } from "lucide-react";
import { usePrefersReducedMotion } from "@/components/motion";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { ProfileDialogHero, ProfileDialogReveal } from "@/components/minecraft-profile-dialog-visuals";
import styles from "@/components/minecraft-profile-dialog.module.css";

export function MinecraftProfilePicker({ open, onOpenChange, initialProfileId, onSubmitted }: { open: boolean; onOpenChange(open: boolean): void; initialProfileId?: string; onSubmitted?(): void }) {
  return open ? <PickerSession onOpenChange={onOpenChange} initialProfileId={initialProfileId} onSubmitted={onSubmitted} /> : null;
}
function PickerSession({ onOpenChange, initialProfileId, onSubmitted }: Omit<Parameters<typeof MinecraftProfilePicker>[0], "open">) {
  const reduced = usePrefersReducedMotion();
  const list = useMinecraftProfiles();
  const status = useGames(4000);
  const { operations, loading: ledgerLoading, elapsedMs, refresh: refreshOperations } = useOperations();
  const [chosen, setChosen] = useState(initialProfileId ?? "");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const profile = list.data?.profiles.find(item => item.id === chosen);
  const mc = status.games?.minecraft;
  const running = mc?.containerRunning === true || mc?.status === "online" || mc?.status === "starting";
  const peers = GAME_LIST.filter(game => game.id !== "minecraft" && (status.games?.[game.id]?.containerRunning === true || ["online", "starting"].includes(status.games?.[game.id]?.status ?? "")));
  const affectedLanes = new Set(["files:minecraft", ...peers.map(peer => `files:${peer.id}`)]);
  const interrupted = liveFileOperations(operations).filter(operation => operation.resources.some(resource => affectedLanes.has(resource)));
  const effects = running || peers.length > 0;
  const alreadyRunning = running && list.data?.runtime.verified === true && list.data.runtime.appliedProfileId === profile?.id;
  const effectKey = JSON.stringify({ chosen, running, startedAt: mc?.startedAtMs, players: mc?.players.online, peers: peers.map(peer => peer.id), interrupted: interrupted.map(operation => operation.id) });
  const confirmed = confirmation === effectKey;
  const freshStatus = !status.loading && !status.pollError && !!status.lastSuccessAt && now - status.lastSuccessAt <= 15000 && status.access.includes("minecraft");
  const allowed = !rechecking && !!list.ready && list.data?.runtime.state !== "unknown" && !list.data?.requiresAdoption && freshStatus && !ledgerLoading &&
    !alreadyRunning && !status.busy && interrupted.length === 0 && !operations.some(operation => operation.holdsPower && !operation.endedAt) &&
    (running ? status.can.restart && list.data?.capabilities.switch : status.can.start && list.data?.capabilities.start);
  async function submit() {
    if (!allowed || !profile || profile.status !== "ready" || sending || blocked || (effects && !confirmed)) return;
    setSending(true); setError(null);
    try {
      const response = await fetch(`/api/minecraft/profiles/${encodeURIComponent(profile.id)}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmStopPeers: confirmed, confirmedPeers: peers.map(peer => peer.id), expectedRevision: list.data!.runtime.revision }),
      });
      const receipt = await readOperationResponse(response);
      if (!receipt.operationId) {
        if (!response.ok && receipt.error) { setError(receipt.error); if (response.status === 409) setBlocked(true); return; }
        throw new UnconfirmedOperationResult();
      }
      // Admission and completion belong to the ledger; never select the card optimistically.
      onSubmitted?.(); onOpenChange(false); await status.refresh();
    } catch (e) { setError(unconfirmedOperationMessage("profile start or switch", e)); setBlocked(true); }
    finally { void refreshOperations(); setSending(false); }
  }
  async function retry() {
    if (rechecking || sending) return;
    setRechecking(true); setConfirmation(null);
    try {
      const accepted = await Promise.all([list.refresh(), status.refresh(), refreshOperations()]);
      if (!accepted.every(receipt => receipt === true)) throw new Error("The latest profile, status and operation readings could not all be confirmed. Recheck before another attempt.");
      setBlocked(false); setError(null);
    } catch (e) {
      setBlocked(true); setError(e instanceof Error ? e.message : "The profile readings could not be confirmed. Recheck before another attempt.");
    } finally { setRechecking(false); }
  }
  const sceneVariant = profile?.source.kind === "legacy" ? "adopt" : profile?.source.kind ?? "vanilla";
  return (
    <Dialog open onOpenChange={open => { if (!open && !sending) onOpenChange(false); }}>
      <DialogContent className={`${styles.dialog} sm:max-w-3xl`} showCloseButton={!sending} style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
        <ProfileDialogHero variant={sceneVariant} eyebrow={running ? "Minecraft · Your next chapter" : "Minecraft · Choose your world"} title={running ? "Switch Minecraft profile & restart" : "Choose a Minecraft profile to start"} description="Choose a prepared world. Starting saves and stops other running games; switching preserves the current profile before opening the selected one." />
        <div className={`${styles.body} space-y-5`}>
          <ProfileDialogReveal delay={.05}>
            <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Your worlds</h3><p className="text-[11px] text-muted-foreground">Choose one to continue</p></div>
            {list.loading ? <p role="status" className={styles.note}>Reading profiles…</p> : list.error ? <p role="alert" className={`${styles.note} ${styles.warning}`}>{list.error}</p> : list.data?.requiresAdoption ? <p role="alert" className={styles.note}>Keep the existing world as a profile before switching. <Link href="/minecraft" className="underline">Open Minecraft profiles</Link>.</p> : <div className="grid gap-3 sm:grid-cols-2">
              {list.data?.profiles.map(item => {
                const variant = item.source.kind === "legacy" ? "adopt" : item.source.kind;
                return <motion.button key={item.id} type="button" aria-pressed={chosen === item.id} disabled={item.status !== "ready" || sending} onClick={() => { setChosen(item.id); setConfirmation(null); }} whileHover={reduced ? undefined : { y: -3 }} whileTap={reduced ? undefined : { scale: .985 }} className={styles.profileTile}>
                  <div className={styles.profileScene}>{item.coverUrl ? <Image src={item.coverUrl} alt="" fill sizes="(max-width: 640px) 100vw, 400px" className="object-cover" unoptimized /> : <><MinecraftProfileScene variant={variant} /><span className="absolute bottom-2 left-2 rounded bg-popover/90 px-2 py-1 text-[9px] text-foreground">No world screenshot yet</span></>}{chosen === item.id && <span className={styles.selectedMark}><Check className="size-3.5" aria-hidden="true" /></span>}</div>
                  <div className={styles.profileText}><span className="block break-words font-display text-base font-semibold tracking-tight">{item.name}</span><span className="mt-1.5 block break-words text-[11px] leading-relaxed text-muted-foreground">{item.target.mcVersion} · {item.target.loader} · {profileSourceLabel(item)}</span><span className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-[10px] font-medium"><HardDrive className="size-3" aria-hidden="true" />{item.status === "ready" ? "Ready" : item.status === "preparing" ? "Preparation incomplete; check operations" : "Needs attention"}</span></div>
                </motion.button>;
              })}
            </div>}
            {!list.loading && !list.error && list.data?.profiles.length === 0 && <p className={styles.note}>No prepared profiles yet. <Link className="underline" href="/minecraft">Create a profile</Link>.</p>}
          </ProfileDialogReveal>
          {profile && <ProfileDialogReveal delay={.1}><div className={styles.note}><ShieldCheck className="mt-px size-4 shrink-0 text-[var(--mc)]" aria-hidden="true" /><p className="min-w-0 break-words">Selected: <strong>{profile.name}</strong> · Minecraft {profile.target.mcVersion} · {profile.target.loader}. Your client must match this profile.</p></div></ProfileDialogReveal>}
          <ProfileDialogReveal delay={.15} className="space-y-3">
            {alreadyRunning && <p className={styles.note}>This profile is already running. Use Recovery Restart on the server page to restart this same profile.</p>}
            {(running || peers.length > 0) && <div className={`${styles.note} ${styles.warning}`}><Users className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 space-y-2">
              {running && <p>Minecraft is running{mc ? ` with ${mc.players.online} connected player${mc.players.online === 1 ? "" : "s"}` : ""}. Switching saves and stops it; its players will be disconnected.</p>}
              {peers.map(peer => <p key={peer.id}>{peer.name} is running and will be saved and stopped. Its players will be disconnected.</p>)}
            </div></div>}
            {interrupted.length > 0 && <p className={`${styles.note} ${styles.warning}`}>Wait for {namedFileOperations(interrupted, elapsedMs)} to finish before starting or switching profiles. Profile switching does not interrupt these jobs.</p>}
            {effects && <label className={`${styles.note} cursor-pointer`}><input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" checked={confirmed} disabled={sending} onChange={event => setConfirmation(event.target.checked ? effectKey : null)} /><span>I understand the player disconnections above.</span></label>}
            {!allowed && !list.loading && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{list.data?.runtime.reason || "A current profile, permission, server status and operation reading are required before starting."}</p>}
            {error && <p role="alert" className={`${styles.note} ${styles.warning}`}>{error}</p>}
            {(list.error || blocked || rechecking || !freshStatus || interrupted.length > 0) && <Button variant="outline" className="h-10" disabled={sending || list.loading || rechecking} onClick={() => void retry()}>Recheck profiles and status</Button>}
          </ProfileDialogReveal>
        </div>
        <DialogFooter className={`${styles.footer} items-center sm:justify-between`}>
          <p className="mr-auto hidden min-w-0 items-center gap-2 text-xs text-muted-foreground sm:flex"><ShieldCheck className="size-3.5 shrink-0 text-[var(--mc)]" aria-hidden="true" /><span className="truncate">{profile ? profile.name : "Pick a world to continue"}</span></p>
          <div className="flex w-full gap-2 sm:w-auto"><Button className="h-11 flex-1 sm:flex-none" variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>Cancel</Button><Button className="h-11 flex-1 gap-2 sm:flex-none" disabled={!allowed || !profile || profile.status !== "ready" || sending || blocked || (effects && !confirmed)} onClick={() => void submit()}>{sending ? "Submitting…" : running ? "Switch & restart" : "Start selected profile"}<ArrowRight className="size-4" aria-hidden="true" /></Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
