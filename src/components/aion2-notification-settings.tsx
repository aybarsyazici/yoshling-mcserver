"use client";

import { useState, type FormEvent } from "react";
import { Bell, BellOff, Check, Loader2, Play, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_AION_NOTIFICATION_SETTING, type AionEventNotificationSetting, type AionNotificationTarget } from "@/lib/aion2-notifications";
import type { AionNotificationsController } from "@/hooks/use-aion2-notifications";

const sounds = [{ id: "chime", name: "Chime" }, { id: "bell", name: "Bell" }, { id: "pulse", name: "Pulse" }, { id: "silent", name: "Silent" }] as const;
const selectClass = "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function AionNotificationStatus({ controller: c, verifiedEvents }: { controller: AionNotificationsController; verifiedEvents: number }) {
  const [permissionBusy, setPermissionBusy] = useState(false);
  const enabled = Object.values(c.settings).filter(setting => setting.enabled).length;
  async function requestPermission() {
    if (permissionBusy) return;
    setPermissionBusy(true);
    try { await c.requestPermission(); } finally { setPermissionBusy(false); }
  }
  return <div className="mt-4 rounded-xl border border-[var(--chart-2)]/18 bg-background/60 p-3 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[11px] text-muted-foreground"><p className="flex items-center gap-1.5 rounded-lg bg-[var(--chart-2)]/10 px-2 py-1 text-foreground"><Bell className="size-3.5 text-[var(--chart-2)]" />{enabled} enabled preference{enabled === 1 ? "" : "s"} · {verifiedEvents} verified event time{verifiedEvents === 1 ? "" : "s"}</p><div className="flex flex-wrap items-center gap-3"><span className={cn("rounded-full border px-2 py-0.5", c.permission === "granted" ? "border-[var(--chart-4)]/25 bg-[var(--chart-4)]/10 text-foreground" : c.permission === "denied" ? "border-[var(--chart-5)]/25 bg-[var(--chart-5)]/10 text-foreground" : "border-border/60 bg-muted/25")}>Desktop: {c.permission === "granted" ? "allowed" : c.permission === "denied" ? "blocked" : c.permission === "unsupported" ? "unavailable" : "not enabled"}</span><span className={cn("rounded-full border px-2 py-0.5", c.audioStatus === "ready" ? "border-[var(--chart-4)]/25 bg-[var(--chart-4)]/10 text-foreground" : "border-border/60 bg-muted/25")}>Sound: {c.audioStatus === "ready" ? "active this session" : c.audioStatus === "unsupported" ? "unavailable" : c.audioStatus === "error" ? "needs activation again" : "not activated"}</span>{c.permission === "default" && <Button variant="outline" size="xs" onClick={() => void requestPermission()} disabled={permissionBusy}>{permissionBusy && <Loader2 className="size-3 animate-spin" />}Enable desktop notifications</Button>}</div></div>
    {c.permission === "denied" && <p className="mt-2 text-[10px] text-muted-foreground">Desktop notifications are blocked in this browser’s site settings. In-page reminders and activated sound can still work.</p>}
    {c.deliveryError && <p role="status" className="mt-2 text-[10px] text-muted-foreground">{c.deliveryError} In-page reminders remain available.</p>}
    {c.storageError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive"><span>{c.storageError} Alert changes are unavailable.</span><Button variant="outline" size="xs" onClick={() => void c.retryStorage()}>Retry alert settings</Button></div>}
    {c.coordination === "unavailable" && c.storageStatus === "ready" && <p role="status" className="mt-2 text-[10px] text-muted-foreground">This browser cannot safely run alerts across tabs. Alerts are paused.</p>}
    <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Keep this page open for alerts. Sleeping devices and inactive tabs can delay or stop them. These are browser reminders, not closed-tab push notifications.</p>
    {c.lastAlert && <p role="status" className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><span className="font-semibold">Reminder: {c.lastAlert.label}</span> · {c.lastAlert.estimate ? "Community-estimated spawn" : "Scheduled start"} {new Date(c.lastAlert.startsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{c.lastAlert.estimate && " · check in game"}</p>}
  </div>;
}

export function AionNotificationSettings({ eventId, label, target, contextLabel, now, controller, onClose }: {
  eventId: string; label: string; target?: AionNotificationTarget; contextLabel: string; now: number;
  controller: AionNotificationsController; onClose: () => void;
}) {
  return <section id="aion-event-alert-settings" aria-label={`${label} alert settings`} className="mt-3 rounded-xl border border-[var(--chart-2)]/30 bg-gradient-to-br from-[var(--chart-2)]/12 via-background/90 to-[var(--chart-3)]/6 p-4 shadow-md shadow-[var(--chart-2)]/5">
    <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><span className="rounded-lg border border-[var(--chart-2)]/25 bg-[var(--chart-2)]/15 p-1.5"><Bell className="size-4 text-[var(--chart-2)]" /></span>{label} alerts</h3><p className="mt-1 text-[11px] text-muted-foreground">{contextLabel} · saved in this browser</p></div><Button variant="ghost" size="icon-xs" aria-label="Close alert settings" onClick={onClose}><X className="size-3.5" /></Button></div>
    {controller.storageStatus === "loading" ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading saved alert settings…</p> : <AlertForm eventId={eventId} label={label} target={target} now={now} controller={controller} />}
  </section>;
}

function AlertForm({ eventId, label, target, now, controller: c }: { eventId: string; label: string; target?: AionNotificationTarget; now: number; controller: AionNotificationsController }) {
  const canonical = c.settings[eventId] ?? DEFAULT_AION_NOTIFICATION_SETTING;
  const [baseline, setBaseline] = useState(canonical);
  const [draft, setDraft] = useState<AionEventNotificationSetting>({ ...canonical });
  const [lead, setLead] = useState(String(canonical.leadMinutes));
  const [custom, setCustom] = useState(![5, 10, 15].includes(canonical.leadMinutes));
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = !!target?.verified && !!target.startsAt && Date.parse(target.startsAt) > now && Date.parse(target.verifiedUntil) > now;
  const warningPassed = available && !!target?.startsAt && /^\d{1,3}$/.test(lead) && Date.parse(target.startsAt) - Number(lead) * 60_000 <= now;
  const storageReady = c.storageStatus === "ready" && !c.storageError;
  const changedExternally = JSON.stringify(canonical) !== JSON.stringify(baseline) && JSON.stringify(canonical) !== JSON.stringify(draft);
  const blocked = saving || !storageReady || changedExternally;
  const canEnable = available && c.coordination !== "unavailable";
  function change(patch: Partial<AionEventNotificationSetting>) { setDraft(value => ({ ...value, ...patch })); setSaved(false); setError(null); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    if (!/^\d{1,3}$/.test(lead) || Number(lead) > 180) { setError("Enter a whole number from 0 to 180 minutes."); return; }
    const next = { ...draft, leadMinutes: Number(lead) };
    if (next.enabled && !canEnable) { setError("A verified future event time is required to enable this alert."); return; }
    setSaving(true); setSaved(false); setError(null);
    try {
      if (await c.setEventSetting(eventId, next)) { setBaseline(next); setDraft(next); setSaved(true); }
      else setError("Alert preferences could not be saved. Reload the settings before retrying.");
    } catch { setError("Alert preferences could not be saved. Reload the settings before retrying."); }
    finally { setSaving(false); }
  }
  async function preview() {
    if (previewing || draft.sound === "silent") return;
    setPreviewing(true); setError(null);
    try { await c.testSound(draft.sound, draft.volume); } catch { setError("The sound could not play. Check this browser’s audio settings."); }
    finally { setPreviewing(false); }
  }
  return <form onSubmit={save} aria-label={`${label} alert preferences`}>
    <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex cursor-pointer items-center gap-2 text-sm font-medium"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} disabled={blocked || (!canEnable && !draft.enabled)} className="size-4 accent-[var(--chart-2)] disabled:opacity-50" />Enable this alert</label><span className={cn("rounded-full border px-2 py-0.5 text-[10px]", canonical.enabled ? "border-[var(--chart-4)]/25 bg-[var(--chart-4)]/10 text-foreground" : "border-border/60 bg-muted/25 text-muted-foreground")}>Saved preference: {canonical.enabled ? "enabled" : "off"}</span></div>
    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{available && target?.startsAt ? `${target.estimate ? "Community-estimated spawn" : "Next scheduled start"}: ${new Date(target.startsAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : "The next start is unverified. You can turn an existing alert off; enabling waits for a fresh event time."}</p>
    {warningPassed && <p className="mt-2 rounded-lg border border-[var(--chart-5)]/30 bg-[var(--chart-5)]/10 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">The {lead}-minute warning for this start has already passed. This preference applies to a later occurrence.</p>}
    <div className="mt-4 grid gap-4 sm:grid-cols-2"><fieldset disabled={blocked}><legend className="mb-2 text-xs font-medium">Warn me before the start</legend><div className="flex flex-wrap gap-1.5">{[5, 10, 15].map(value => <button type="button" key={value} aria-pressed={!custom && Number(lead) === value} onClick={() => { setCustom(false); setLead(String(value)); change({ leadMinutes: value }); }} className={cn("rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50", !custom && Number(lead) === value ? "border-[var(--chart-2)]/35 bg-[var(--chart-2)]/14 text-foreground shadow-sm" : "border-border bg-background/65 text-muted-foreground hover:border-[var(--chart-2)]/25")}>{value} min</button>)}<button type="button" aria-pressed={custom} onClick={() => { setCustom(true); setSaved(false); }} className={cn("rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50", custom ? "border-[var(--chart-2)]/35 bg-[var(--chart-2)]/14 text-foreground shadow-sm" : "border-border bg-background/65 text-muted-foreground hover:border-[var(--chart-2)]/25")}>Custom</button></div>{custom && <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Input type="number" aria-label="Minutes before event" min={0} max={180} step={1} value={lead} onChange={event => { setLead(event.target.value); setSaved(false); setError(null); if (/^\d{1,3}$/.test(event.target.value)) change({ leadMinutes: Number(event.target.value) }); }} className="h-9 w-24 bg-background" />minutes (0–180)</label>}</fieldset>
      <div><label className="block text-xs font-medium">Alert sound<select aria-label="Alert sound" value={draft.sound} disabled={blocked} onChange={event => change({ sound: event.target.value as AionEventNotificationSetting["sound"] })} className={cn(selectClass, "mt-2")}>{sounds.map(sound => <option key={sound.id} value={sound.id}>{sound.name}</option>)}</select></label><div className="mt-2 flex items-center gap-3"><label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted-foreground"><Volume2 className="size-3.5 shrink-0" aria-hidden /><input type="range" aria-label="Alert volume" min={0} max={100} step={1} value={draft.volume} disabled={blocked || draft.sound === "silent"} onChange={event => change({ volume: Number(event.target.value) })} className="min-w-0 flex-1 accent-[var(--primary)]" /><span className="w-8 text-right tabular-nums">{draft.volume}%</span></label><Button type="button" variant="outline" size="xs" disabled={previewing || draft.sound === "silent" || c.audioStatus === "unsupported"} onClick={() => void preview()}>{previewing ? <Loader2 className="size-3 animate-spin" /> : draft.sound === "silent" ? <BellOff className="size-3" /> : <Play className="size-3" />}Preview sound</Button></div></div>
    </div>
    {changedExternally && <p role="alert" className="mt-3 text-xs text-destructive">Preferences changed in another tab. Close and reopen these settings before editing.</p>}
    {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" size="sm" disabled={blocked || (draft.enabled && !canEnable)}>{saving && <Loader2 className="size-3.5 animate-spin" />}Save alerts</Button>{saved && <span role="status" className="flex items-center gap-1 rounded-full border border-[var(--chart-4)]/25 bg-[var(--chart-4)]/10 px-2 py-1 text-xs text-foreground"><Check className="size-3.5 text-[var(--chart-4)]" />Preferences saved in this browser</span>}<span className="text-[10px] text-muted-foreground">Sound activation is for this session only.</span></div>
    <details className="mt-3 text-[10px] text-muted-foreground"><summary className="cursor-pointer">How alerts work</summary><p className="mt-2 leading-relaxed">Alerts use the event’s start or a community spawn estimate, not the entry deadline. If the warning time has already passed, the preference applies to a later occurrence. Unverified times pause alerts. Preview sound activates browser audio; desktop permission is separate. Keep the page open. A sleeping device can miss a reminder.</p></details>
  </form>;
}
