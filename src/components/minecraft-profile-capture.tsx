"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Camera, Check, Copy, Download, LoaderCircle, Link2 } from "lucide-react";
import type { MinecraftProfileDTO, MinecraftProfileRuntimeDTO } from "@/lib/minecraft-profile-types";
import type { MinecraftCaptureCompanionManifest, MinecraftCaptureGrant, MinecraftCaptureReceipt } from "@/lib/minecraft-capture-types";
import { parseMinecraftCaptureCompanion, parseMinecraftCaptureGrant, parseMinecraftCaptureReceipt } from "@/lib/minecraft-capture-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CaptureProps {
  profile: MinecraftProfileDTO;
  runtime: MinecraftProfileRuntimeDTO;
  canEdit: boolean;
  onCaptured: (profile: MinecraftProfileDTO, baseline: MinecraftProfileDTO) => Promise<void>;
  onRecheck: () => Promise<boolean>;
}
const terminal = (receipt: MinecraftCaptureReceipt | null) => receipt && ["complete", "expired", "stale", "unverified"].includes(receipt.session.state);
const messages = {
  waiting: "Waiting for your client. Install the companion, join this world, then enter the pairing command.",
  paired: "Client paired. Capture waits until the world has loaded for 20 seconds and pairing has lasted at least 3 seconds.",
  uploading: "Your client is uploading the screenshot. Waiting for cover readback…",
  complete: "Checking the screenshot against the current profile…",
  expired: "This pairing session expired. Request a new session when you are ready.",
  stale: "The profile or cover changed. This session cannot publish a screenshot.",
  unverified: "The capture could not be verified. Recheck the profile before pairing again.",
} as const;
export function MinecraftProfileCapture(props: CaptureProps) { return <CaptureSession key={props.profile.id} {...props} />; }

function CaptureSession({ profile, runtime, canEdit, onCaptured, onRecheck }: CaptureProps) {
  const label = useId();
  const [manifest, setManifest] = useState<MinecraftCaptureCompanionManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [pairing, setPairing] = useState<{ grant: MinecraftCaptureGrant; baseline: MinecraftProfileDTO } | null>(null);
  const [receipt, setReceipt] = useState<MinecraftCaptureReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [replace, setReplace] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const completed = useRef<string | null>(null);
  const endpoint = `/api/minecraft/profiles/${encodeURIComponent(profile.id)}/capture`;
  const supported = profile.target.mcVersion === "26.1.2" && ["fabric", "vanilla"].includes(profile.target.loader);
  const running = profile.status === "ready" && runtime.verified && runtime.state === "running" && runtime.appliedProfileId === profile.id && runtime.selectedProfileId === profile.id;
  const expired = !!pairing && clock >= Date.parse(pairing.grant.expiresAt);
  const ended = !!terminal(receipt);
  const live = !!pairing && !expired && !terminal(receipt);
  const canPair = canEdit && supported && running && !!manifest && !manifestError && !busy && !blocked && !live && (!profile.coverUrl || replace);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch("/api/minecraft/capture/companion", { cache: "no-store" });
        const raw: unknown = await response.json();
        const parsed = parseMinecraftCaptureCompanion(raw);
        if (!response.ok || !parsed) throw new Error("The supported companion download could not be verified.");
        if (current) { setManifest(parsed); setManifestError(null); }
      } catch (e) { if (current) { setManifest(null); setManifestError(e instanceof Error ? e.message : "The companion could not be read."); } }
    })();
    return () => { current = false; };
  }, [manifestAttempt]);
  useEffect(() => {
    if (!pairing || expired || ended) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing, expired, ended]);
  useEffect(() => {
    if (!pairing || completed.current === pairing.grant.id) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      if (!current) return;
      if (Date.now() >= Date.parse(pairing!.grant.expiresAt)) return;
      if (document.hidden) { timer = setTimeout(() => void poll(), 3000); return; }
      try {
        const response = await fetch(`${endpoint}/${encodeURIComponent(pairing!.grant.id)}`, { cache: "no-store", signal: controller.signal });
        const raw: unknown = await response.json();
        if (!current) return;
        const parsed = parseMinecraftCaptureReceipt(raw, pairing!.grant);
        if (!response.ok || !parsed) throw new Error("The capture result is unconfirmed. Recheck its status before requesting another session.");
        setReceipt(parsed); setError(null);
        if (["stale", "unverified"].includes(parsed.session.state)) setBlocked(true);
        if (parsed.session.state === "complete" && parsed.verified && parsed.profile) {
          completed.current = pairing!.grant.id;
          await onCaptured(parsed.profile, pairing!.baseline);
          if (current) setAccepted(true);
          return;
        }
        if (!terminal(parsed)) timer = setTimeout(() => void poll(), 3000);
      } catch (e) {
        if (current) { setError(e instanceof Error ? e.message : "The capture result is unconfirmed. Recheck its status."); if (completed.current === pairing!.grant.id) setBlocked(true); }
      }
    }
    void poll();
    return () => { current = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [pairing, endpoint, onCaptured, pollAttempt]);
  async function requestPairing() {
    if (!canPair) return;
    const request = ++generation.current, baseline = profile;
    let knownRefusal = false;
    setBusy(true); setError(null); setCopied(false); setCopyError(false);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: baseline.revision, replaceExisting: !!baseline.coverUrl && replace }) });
      const raw: unknown = await response.json();
      if (request !== generation.current) return;
      const refusal = raw && typeof raw === "object" && "error" in raw && typeof raw.error === "string" ? raw.error : null;
      if (!response.ok && response.status >= 400 && response.status < 500 && refusal) { knownRefusal = true; throw new Error(refusal); }
      const grant = parseMinecraftCaptureGrant(raw, baseline.id, baseline.revision);
      if (!response.ok || !grant || Date.parse(grant.expiresAt) <= Date.now()) { setBlocked(true); throw new Error("The pairing request result is unconfirmed. Reload the profile before requesting another session."); }
      setPairing({ grant, baseline }); setReceipt(null); setAccepted(false); setClock(Date.now()); completed.current = null;
    } catch (e) { if (request === generation.current) { setError(knownRefusal && e instanceof Error ? e.message : "The pairing request result is unconfirmed. Reload the profile before requesting another session."); setBlocked(true); } }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function cancelPairing() {
    if (!pairing || !canEdit || busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(pairing.grant.id)}`, { method: "DELETE" });
      const raw = await response.json();
      if (request !== generation.current) return;
      if (!response.ok || raw?.cancelled !== true || raw.sessionId !== pairing.grant.id) throw new Error("Cancellation is unconfirmed. Recheck the session before requesting another.");
      setPairing(null); setReceipt(null); setError(null); setCopied(false); setCopyError(false); setAccepted(false); setBlocked(false);
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : "Cancellation is unconfirmed. Recheck the session."); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function recheckProfile() {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const acceptedRead = await onRecheck();
      if (request !== generation.current || !acceptedRead) return;
      setPairing(null); setReceipt(null); setError(null); setBlocked(false); setAccepted(false); setReplace(false); setCopied(false); setCopyError(false);
    } catch { if (request === generation.current) setError("The profile recheck is unconfirmed. Pairing remains blocked; recheck again when the profile can be read."); }
    finally { if (request === generation.current) setBusy(false); }
  }
  const copyCommand = useCallback(async () => {
    if (!pairing || !canEdit || !live || busy) return;
    const request = generation.current;
    setCopied(false); setCopyError(false);
    try { await navigator.clipboard.writeText(pairing.grant.command); if (request === generation.current) setCopied(true); }
    catch { if (request === generation.current) setCopyError(true); }
  }, [pairing, canEdit, live, busy]);
  const reason = !supported ? "Client capture currently supports Minecraft 26.1.2 with a Fabric client, for Fabric or vanilla server profiles. Manual upload remains available." : !running ? "Start this profile and wait for its running identity to be verified before pairing. This panel does not start or switch worlds." : !canEdit ? "Current profile-management permission is required to request a capture." : null;
  return <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4" aria-labelledby={`${label}-title`}>
    <div className="flex items-start gap-3"><Camera aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-foreground" /><div><h3 id={`${label}-title`} className="font-display font-semibold">Capture from your game</h3><p className="text-sm text-muted-foreground">A real screenshot from your player camera, using an optional client companion. Your client uploads one custom cover, separate from the generated world overview.</p></div></div>
    <ol className="space-y-4 text-sm">
      <li className="space-y-2"><p className="font-medium">1. Install the client companion</p><p className="text-muted-foreground">Use Minecraft 26.1.2 with Fabric Loader 0.19.5+ and Java 25. Place the companion in your client&apos;s mods folder before launching Minecraft; it does not belong in the server mods folder. Fabric API is not required by this companion.</p>
        {manifest ? <div className="space-y-2"><a href={manifest.downloadUrl} download={manifest.fileName} className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 font-medium underline"><Download aria-hidden="true" className="size-4" />Download client companion {manifest.version}</a><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">File details and SHA-256</summary><p className="mt-2 break-all">{manifest.fileName} · {manifest.bytes.toLocaleString()} bytes</p><code className="block break-all">{manifest.sha256}</code></details></div> : manifestError ? <div role="alert"><p>{manifestError}</p><Button variant="outline" disabled={busy} onClick={() => setManifestAttempt(v => v + 1)}>Retry companion download</Button></div> : <p role="status">Reading supported companion…</p>}
      </li>
      <li className="space-y-2"><p className="font-medium">2. Pair this profile</p><p className="text-muted-foreground">Join {profile.name}, then enter the local pairing command. The code expires after 15 minutes, authorizes one screenshot for this profile and should stay private.</p>
        {reason && <p className="text-muted-foreground">{reason}</p>}
        {profile.coverUrl && !live && <Label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={replace} disabled={!canEdit || busy} onChange={e => setReplace(e.target.checked)} />Replace this profile&apos;s current cover with the captured screenshot</Label>}
        <Button disabled={!canPair} onClick={() => void requestPairing()}><Link2 aria-hidden="true" />{busy && !pairing ? "Requesting pairing…" : pairing ? "Request a new pairing session" : "Request pairing session"}</Button>
        {pairing && canEdit && <div className="space-y-2"><Label htmlFor={`${label}-command`}>Local Minecraft command</Label><div className="flex flex-wrap gap-2"><Input id={`${label}-command`} readOnly value={live ? pairing.grant.command : "Session no longer active"} className="min-w-0 flex-1 font-mono" onFocus={e => e.target.select()} /><Button variant="outline" disabled={!live || busy} onClick={() => void copyCommand()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Command copied" : "Copy command"}</Button></div>{copyError && <p role="alert">Clipboard unavailable. Select and copy the command above.</p>}<p className="text-xs text-muted-foreground">Expires {new Date(pairing.grant.expiresAt).toLocaleTimeString()}.</p><Button variant="outline" disabled={busy} onClick={() => void cancelPairing()}>Cancel pairing session</Button></div>}
      </li>
      <li className="space-y-2"><p className="font-medium">3. Let your world come into view</p><p className="text-muted-foreground">After pairing, capture waits for the world to load. You can also use <code>/yoshling capture</code> in the client to request it. Review what is visible on screen; screenshots may include player information.</p>
        {pairing && <p role="status" className="flex items-start gap-2">{accepted ? <Check aria-hidden="true" className="size-4 shrink-0" /> : live ? <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" /> : null}{accepted ? "Screenshot cover read back and saved. Your other drafts are preserved." : expired && !terminal(receipt) ? messages.expired : messages[receipt?.session.state ?? "waiting"]}</p>}
        {receipt?.session.reason && <p className="text-sm text-muted-foreground">{receipt.session.reason}</p>}
      </li>
    </ol>
    {error && <div role="alert" className="space-y-2"><p>{error}</p>{pairing && !blocked && <Button variant="outline" disabled={busy} onClick={() => { setError(null); setPollAttempt(v => v + 1); }}>Recheck capture status</Button>}</div>}
    {(blocked || (supported && !running)) && <div className="space-y-2"><p className="text-sm text-muted-foreground">{blocked ? "Recheck the profile before another pairing request." : "Recheck this profile after it starts to confirm it is ready for capture."} Unsaved changes will need your explicit discard confirmation.</p><Button variant="outline" disabled={busy} onClick={() => void recheckProfile()}>{busy ? "Rechecking profile…" : "Recheck profile for capture"}</Button></div>}
  </div>;
}
