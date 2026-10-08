"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMinecraftProfiles } from "@/lib/use-minecraft-profiles";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { liveFileOperations, namedFileOperations } from "@/lib/operation-ui";
import { readOperationResponse, unconfirmedOperationMessage, UnconfirmedOperationResult } from "@/lib/operation-client";
import { GAME_LIST } from "@/lib/games";
import { profileSourceLabel } from "@/lib/minecraft-profiles-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function MinecraftProfilePicker({ open, onOpenChange, initialProfileId, onSubmitted }: { open: boolean; onOpenChange(open: boolean): void; initialProfileId?: string; onSubmitted?(): void }) {
  return open ? <PickerSession onOpenChange={onOpenChange} initialProfileId={initialProfileId} onSubmitted={onSubmitted} /> : null;
}
function PickerSession({ onOpenChange, initialProfileId, onSubmitted }: Omit<Parameters<typeof MinecraftProfilePicker>[0], "open">) {
  const list = useMinecraftProfiles();
  const status = useGames(4000);
  const { operations, loading: ledgerLoading, elapsedMs, refresh: refreshOperations } = useOperations();
  const [chosen, setChosen] = useState(initialProfileId ?? "");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
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
  const allowed = !!list.ready && list.data?.runtime.state !== "unknown" && !list.data?.requiresAdoption && freshStatus && !ledgerLoading &&
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
  async function retry() { setBlocked(false); setError(null); setConfirmation(null); await Promise.all([list.refresh(), status.refresh(), refreshOperations()]); }
  return <Dialog open onOpenChange={open => { if (!open && !sending) onOpenChange(false); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!sending}>
    <DialogHeader><DialogTitle>{running ? "Switch Minecraft profile & restart" : "Choose a Minecraft profile to start"}</DialogTitle><DialogDescription>Choose a prepared world. Starting saves and stops other running games; switching preserves the current profile before opening the selected one.</DialogDescription></DialogHeader>
    {list.loading ? <p role="status">Reading profiles…</p> : list.error ? <p role="alert">{list.error}</p> : list.data?.requiresAdoption ? <p role="alert">Keep the existing world as a profile before switching. <Link href="/minecraft" className="underline">Open Minecraft profiles</Link>.</p> : <div className="grid gap-2 sm:grid-cols-2">{list.data?.profiles.map(item => <button key={item.id} type="button" aria-pressed={chosen === item.id} disabled={item.status !== "ready" || sending} onClick={() => { setChosen(item.id); setConfirmation(null); }} className="rounded-xl border p-3 text-left aria-pressed:border-[var(--tint)] aria-pressed:bg-muted disabled:opacity-50"><span className="block font-semibold">{item.name}</span><span className="block text-xs text-muted-foreground">{item.target.mcVersion} · {item.target.loader} · {profileSourceLabel(item)}</span><span className="block text-xs">{item.status === "ready" ? "Ready" : item.status === "preparing" ? "Preparation incomplete; check operations" : "Needs attention"}</span></button>)}</div>}
    {!list.loading && !list.error && list.data?.profiles.length === 0 && <p>No prepared profiles yet. <Link className="underline" href="/minecraft">Create a profile</Link>.</p>}
    {profile && <p className="text-sm">Selected: <strong>{profile.name}</strong> · Minecraft {profile.target.mcVersion} · {profile.target.loader}. Your client must match this profile.</p>}
    {alreadyRunning && <p className="text-sm">This profile is already running. Use Recovery Restart on the server page to restart this same profile.</p>}
    {running && <p className="text-sm">Minecraft is running{mc ? ` with ${mc.players.online} connected player${mc.players.online === 1 ? "" : "s"}` : ""}. Switching saves and stops it; its players will be disconnected.</p>}
    {peers.map(peer => <p key={peer.id} className="text-sm">{peer.name} is running and will be saved and stopped. Its players will be disconnected.</p>)}
    {interrupted.length > 0 && <p className="text-sm">Wait for {namedFileOperations(interrupted, elapsedMs)} to finish before starting or switching profiles. Profile switching does not interrupt these jobs.</p>}
    {effects && <label className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-sm"><input type="checkbox" checked={confirmed} disabled={sending} onChange={event => setConfirmation(event.target.checked ? effectKey : null)} />I understand the player disconnections above.</label>}
    {!allowed && !list.loading && <p role="status" className="text-sm">{list.data?.runtime.reason || "A current profile, permission, server status and operation reading are required before starting."}</p>}
    {error && <p role="alert">{error}</p>}
    {(list.error || blocked || !freshStatus || interrupted.length > 0) && <Button variant="outline" disabled={sending || list.loading} onClick={() => void retry()}>Recheck profiles and status</Button>}
    <DialogFooter><Button variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!allowed || !profile || profile.status !== "ready" || sending || blocked || (effects && !confirmed)} onClick={() => void submit()}>{sending ? "Submitting…" : running ? "Switch & restart" : "Start selected profile"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
