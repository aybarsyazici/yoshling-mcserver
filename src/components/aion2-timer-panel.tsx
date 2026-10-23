"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, Bell, Clock3, Flag, Orbit, RotateCcw, Sparkles, Swords } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AionNotificationSettings, AionNotificationStatus } from "@/components/aion2-notification-settings";
import { useAionNotifications } from "@/hooks/use-aion2-notifications";
import { aionGartuaEstimate, aionNotificationTargets, aionTimerSourcesCurrent } from "@/lib/aion2-notification-targets";
import { AION_REGIONS, type AionKnowledgeStatus, type AionRegion } from "@/lib/aion2-types";
import { aionTimers, type AionEventTimer } from "@/lib/aion2-timers";
import type { AionBossReport } from "@/lib/aion2-boss-report";

function validTime(value: string | null) { return value !== null && Number.isFinite(Date.parse(value)); }
function clock(value: string, timeZone?: string | null) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}
function remaining(value: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(value) - now) / 1_000));
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds / 3_600), minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function age(value: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago` : minutes > 0 ? `${minutes}m ago` : "just now";
}
function sourceUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
type BossRead = { key: string; report: AionBossReport | null; failed: boolean; error: string | null };
function bossReport(value: unknown, region: AionRegion, serverId: number): value is AionBossReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const nullableDate = (v: unknown) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  let host = ""; try { host = new URL(String(r.source)).hostname; } catch { return false; }
  return r.region === region && r.serverId === serverId && typeof r.serverName === "string" && typeof r.name === "string" && r.provider === "aion2timers.com" && ["reported-dead", "reported-alive", "unknown"].includes(String(r.status)) && typeof r.fetchedAt === "string" && Number.isFinite(Date.parse(r.fetchedAt)) && nullableDate(r.estimatedSpawnAt) && nullableDate(r.lastKilledAt) && nullableDate(r.reportedAt) && typeof r.source === "string" && sourceUrl(r.source) && ["aion2timers.com", "www.aion2timers.com"].includes(host) && (r.status !== "reported-alive" || r.estimatedSpawnAt === null);
}
function useBossReport(region: AionRegion, serverId: number | undefined, enabled: boolean, background = false) {
  const key = `${region}:${serverId ?? "none"}`;
  const [result, setResult] = useState<BossRead | null>(null);
  useEffect(() => {
    if (!serverId || !enabled) return;
    let active = true, running = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (running || (!background && document.visibilityState !== "visible")) return;
      running = true; controller = new AbortController();
      const current = controller;
      const deadline = setTimeout(() => current.abort(), 10_000);
      try {
        const response = await fetch(`/api/aion2/timers?region=${region}&serverId=${serverId}`, { cache: "no-store", signal: current.signal });
        const value: unknown = await response.json();
        if (!active) return;
        if (current.signal.aborted) throw new Error("Community feed timed out.");
        if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Community feed could not be checked.");
        const data = value as Record<string, unknown>;
        if (typeof data.checkedAt !== "string" || !Number.isFinite(Date.parse(data.checkedAt)) || (data.error !== undefined && typeof data.error !== "string") || (data.report !== null && !bossReport(data.report, region, serverId))) throw new Error("Community report could not be verified.");
        setResult({ key, report: data.report as AionBossReport | null, failed: !!data.error, error: typeof data.error === "string" ? data.error : null });
      } catch {
        if (active) setResult(previous => ({ key, report: previous?.key === key ? previous.report : null, failed: true, error: "Community feed could not be refreshed." }));
      } finally { clearTimeout(deadline); running = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [region, serverId, enabled, key, background]);
  return result?.key === key ? result : null;
}

function validKnowledge(value: unknown): value is AionKnowledgeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const k = value as Record<string, unknown>;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  return typeof k.version === "string" && date(k.reviewedAt) && date(k.expiresAt) && (k.checkedAt === undefined || k.checkedAt === null || date(k.checkedAt)) && ["current", "expired", "review-required", "unverified"].includes(String(k.status)) && Array.isArray(k.supportedClasses) && k.supportedClasses.every(v => typeof v === "string") && Array.isArray(k.notices) && k.notices.every(v => typeof v === "string");
}

function useAlertKnowledge(contextKey: string, enabled: boolean) {
  const [read, setRead] = useState<{ key: string; knowledge: AionKnowledgeStatus | undefined; failed: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true, running = false;
    let controller: AbortController | null = null;
    async function check() {
      if (running) return;
      running = true; controller = new AbortController();
      const current = controller, deadline = setTimeout(() => current.abort(), 10_000);
      try {
        const response = await fetch("/api/aion2/knowledge", { cache: "no-store", signal: current.signal });
        const value: unknown = await response.json();
        if (!response.ok || current.signal.aborted || !value || typeof value !== "object" || !validKnowledge((value as Record<string, unknown>).knowledge)) throw new Error("Event sources could not be checked.");
        if (active) setRead({ key: contextKey, knowledge: (value as { knowledge: AionKnowledgeStatus }).knowledge, failed: false });
      } catch { if (active) setRead({ key: contextKey, knowledge: undefined, failed: true }); }
      finally { clearTimeout(deadline); running = false; }
    }
    void check();
    const timer = setInterval(() => { void check(); }, 5 * 60_000);
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [contextKey, enabled]);
  return read?.key === contextKey ? read : null;
}

export function AionTimerPanel({ region = "eu", serverId, serverName, characterName, knowledge, readFailed = false }: { region?: AionRegion; serverId?: number; serverName?: string; characterName?: string; knowledge?: AionKnowledgeStatus; readFailed?: boolean }) {
  const contextKey = `${region}:${serverId ?? "none"}`;
  const alerts = useAionNotifications({ contextKey });
  const alertsEnabled = alerts.storageStatus === "ready" && Object.values(alerts.settings).some(setting => setting.enabled);
  const backgroundKnowledge = useAlertKnowledge(contextKey, alertsEnabled);
  const effectiveKnowledge = alertsEnabled ? backgroundKnowledge?.knowledge : knowledge;
  const sourceFailed = readFailed || (alertsEnabled && !!backgroundKnowledge?.failed);
  const [activeSettings, setActiveSettings] = useState<{ key: string; event: string } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setNow(Date.now()); });
    const update = () => setNow(Date.now());
    const timer = setInterval(() => { if (alertsEnabled || document.visibilityState === "visible") update(); }, 1_000);
    const visible = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [alertsEnabled]);
  const current = now !== null && aionTimerSourcesCurrent(effectiveKnowledge, now, sourceFailed);
  const timers = now === null ? [] : aionTimers(region, new Date(now), current).slice().sort((a,b) => (a.id === "gartua" ? -1 : a.priority === "high" ? 0 : 1) - (b.id === "gartua" ? -1 : b.priority === "high" ? 0 : 1));
  const bossEnabled = current && region === "eu" && timers.some(timer => timer.id === "gartua" && timer.state !== "review-required");
  const boss = useBossReport(region, serverId, bossEnabled, alertsEnabled && !!alerts.settings.gartua?.enabled);
  const targets = useMemo(() => now === null ? [] : aionNotificationTargets({ region, serverId, serverName, contextKey, now, knowledge: effectiveKnowledge, failed: sourceFailed, report: boss?.report, reportFailed: boss?.failed }), [region, serverId, serverName, contextKey, now, effectiveKnowledge, sourceFailed, boss]);
  const { updateTargets } = alerts;
  useEffect(() => { updateTargets(targets); }, [targets, updateTargets]);
  const selectedTimer = activeSettings?.key === contextKey ? timers.find(timer => timer.id === activeSettings.event) : undefined;
  const nextTarget = (id: string) => targets.filter(target => target.id === id && target.verified && target.startsAt && now !== null && Date.parse(target.startsAt) > now).sort((a,b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))[0];
  const alertButton = (timer: AionEventTimer) => <Button id={`aion-alert-${timer.id}`} type="button" variant="ghost" size="xs" aria-label={`Alerts for ${timer.id === "gartua" ? boss?.report?.name ?? timer.name : timer.name}`} aria-expanded={selectedTimer?.id === timer.id} aria-controls="aion-event-alert-settings" className={cn("ml-auto rounded-lg border", alerts.settings[timer.id]?.enabled ? "border-primary/25 bg-primary/10 text-primary" : "border-border/60 bg-background/55 text-muted-foreground hover:bg-primary/8")} onClick={() => setActiveSettings({ key: contextKey, event: timer.id })}><Bell className="size-3" />Alerts{alerts.settings[timer.id]?.enabled && <span className="size-1.5 rounded-full bg-primary" aria-label="Preference enabled" />}</Button>;
  const primary = timers.slice(0,6), extra = timers.slice(6);
  const schedulesAvailable = current && timers.some(timer => timer.kind !== "manual" && timer.state !== "unknown" && timer.state !== "review-required");
  const name = AION_REGIONS.find(r => r.id === region)?.name ?? region;
  const contextLabel = `${name}${serverName ? ` · ${serverName}` : " · no server selected"}`;
  return <section className="rounded-2xl border border-[var(--chart-2)]/20 bg-gradient-to-br from-[var(--chart-2)]/7 via-card/75 to-primary/5 p-4 shadow-[0_12px_36px_-24px_color-mix(in_oklab,var(--chart-2)_35%,transparent)] backdrop-blur sm:p-5" aria-labelledby="aion-timers-title">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 id="aion-timers-title" className="flex items-center gap-2 font-display text-base font-semibold"><span className="rounded-lg border border-[var(--chart-2)]/20 bg-[var(--chart-2)]/12 p-1.5"><Clock3 className="size-4 text-[var(--chart-2)]" /></span>Event timers</h2><p className="text-xs text-muted-foreground">{name} · {characterName ?? "default region"}</p></div>
    {now === null ? <p className="py-5 text-sm text-muted-foreground">Loading event times…</p> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Priority event timers">{primary.map(timer => timer.id === "gartua" ? <GartuaCard key={timer.id} timer={timer} now={now} read={boss} enabled={bossEnabled} serverName={serverName} hasServer={!!serverId} alerts={alertButton(timer)} /> : <EventCard key={timer.id} timer={timer} now={now} alerts={alertButton(timer)} />)}</div>
      {selectedTimer && <AionNotificationSettings key={`${contextKey}:${selectedTimer.id}`} eventId={selectedTimer.id} label={selectedTimer.id === "gartua" ? boss?.report?.name ?? selectedTimer.name : selectedTimer.name} target={nextTarget(selectedTimer.id)} now={now} contextLabel={contextLabel} controller={alerts} onClose={() => { setActiveSettings(null); document.getElementById(`aion-alert-${selectedTimer.id}`)?.focus(); }} />}
      {extra.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-primary">More events and resets ({extra.length})</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{extra.map(timer => <EventCard key={timer.id} timer={timer} now={now} alerts={alertButton(timer)} />)}</div></details>}
      {alertsEnabled && backgroundKnowledge?.failed && <p role="status" className="mt-3 text-xs text-muted-foreground">Event source check failed. Alerts are paused until a successful check.</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{schedulesAvailable ? "Calculated from reviewed schedules. Timers show expected windows, not whether a boss is alive. Local times use your device clock." : "Schedule countdowns are withheld until this region’s current source status can be verified. In-game spawn and entry information remain the final check."}</p>
    </>}
    <AionNotificationStatus controller={alerts} verifiedEvents={new Set(targets.filter(target => target.verified).map(target => target.id)).size} />
  </section>;
}

function GartuaCard({ timer, now, read, enabled, hasServer, serverName, alerts }: { timer: AionEventTimer; now: number; read: BossRead | null; enabled: boolean; hasServer: boolean; serverName?: string; alerts: ReactNode }) {
  const report = read?.report;
  const { fresh, estimate, countdown, elapsed } = aionGartuaEstimate(report, !!read?.failed, enabled, now);
  const badge = countdown ? "Community estimate" : report && !fresh ? "Last report · stale" : fresh && report?.status === "reported-alive" ? "Community report" : "Spawn status check";
  const name = report?.name ?? timer.name;
  const accent = fresh ? "var(--chart-5)" : "var(--muted-foreground)";
  return <article style={{ borderColor: `color-mix(in oklab, ${accent} 30%, var(--border))`, background: `radial-gradient(ellipse at 100% 0%, color-mix(in oklab, ${accent} 16%, transparent), transparent 80%), var(--background)`, boxShadow: `inset 0 2px 0 color-mix(in oklab, ${accent} 55%, transparent)` }} className="rounded-xl border p-3.5 shadow-sm transition-shadow hover:shadow-md" data-community-state={report ? fresh ? report.status : "stale" : "unknown"}>
    <div className="flex items-start gap-2.5"><span className="rounded-lg border p-2" style={{ background: `color-mix(in oklab, ${accent} 16%, transparent)`, borderColor: `color-mix(in oklab, ${accent} 20%, transparent)`, color: `color-mix(in oklab, ${accent} 35%, var(--foreground))` }}><Swords className="size-4" aria-hidden /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold leading-snug">{name}</h3><p className="mt-1 inline-flex rounded-full border px-2 py-0.5 text-[9px] font-medium" style={{ background: `color-mix(in oklab, ${accent} 12%, transparent)`, borderColor: `color-mix(in oklab, ${accent} 22%, transparent)`, color: `color-mix(in oklab, ${accent} 30%, var(--foreground))` }}>{badge}{serverName ? ` · ${serverName}` : ""}</p></div></div>
    <div className="mt-3">{countdown && estimate ? <><p className="mb-0.5 text-[10px] text-muted-foreground">Estimated spawn in</p><time role="timer" aria-label={`${name} community estimated spawn`} aria-live="off" dateTime={estimate} className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{remaining(estimate, now)}</time></> : <p className="py-1 text-sm font-medium text-muted-foreground">{elapsed ? "Estimate elapsed — check in game" : fresh && report?.status === "reported-alive" ? "Community reported alive" : hasServer ? "Check in game" : "Select a character for reports"}</p>}</div>
    <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">{estimate && <p>{fresh ? "Estimated local spawn" : "Last estimated spawn"}: {clock(estimate)}</p>}{report?.lastKilledAt && <p>Last reported kill: {clock(report.lastKilledAt)} ({age(report.lastKilledAt, now)})</p>}{report?.reportedAt && <p>Report: {clock(report.reportedAt)} ({age(report.reportedAt, now)})</p>}{!report && <p>Map → Exploration → Field Boss</p>}{read?.failed && <p>Feed check failed; verify in game.</p>}</div>
    <details className="mt-3 border-t border-border/50 pt-2"><summary className="flex cursor-pointer list-none items-center justify-between gap-2"><span className="rounded border border-border/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{report ? "aion2timers.com · Community" : "Community / manual"}</span><span className="text-[10px] font-medium text-primary">Details</span></summary><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{timer.description} A community estimate is based on player reports. It does not verify that the boss is alive, and an elapsed estimate never starts a new automatic cycle.</p>{report && <p className="mt-2 text-[10px] text-muted-foreground">Feed checked: {clock(report.fetchedAt)} ({age(report.fetchedAt, now)}). {fresh ? "Recent feed response." : "Retained report; refresh or check the game before travelling."}</p>}{read?.error && <p className="mt-2 text-[10px] text-muted-foreground">{read.error}</p>}{sourceUrl(report?.source ?? timer.source) && <a href={report?.source ?? timer.source} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:underline">Open report source<ArrowUpRight className="size-2.5" /></a>}</details>
    <div className="mt-2 flex justify-end">{alerts}</div>
  </article>;
}

function timerAccent(timer: AionEventTimer) {
  if (timer.state === "unknown" || timer.state === "review-required") return "var(--muted-foreground)";
  if (timer.state === "entry-open") return "var(--chart-4)";
  if (timer.state === "active") return "var(--chart-3)";
  if (timer.kind === "reset" || timer.id === "spacetime-rift") return "var(--chart-2)";
  if (timer.id === "shugo-festival") return "var(--chart-5)";
  if (timer.id === "artifact-siege" || timer.id === "siege-executors") return "var(--chart-3)";
  return "var(--primary)";
}

function EventCard({ timer, now, alerts }: { timer: AionEventTimer; now: number; alerts: ReactNode }) {
  const phase = timer.state === "entry-open" || timer.state === "active";
  const target = phase ? timer.windowEndsAt : timer.nextStartAt;
  const countdown = timer.kind !== "manual" && timer.state !== "unknown" && timer.state !== "review-required" && validTime(target);
  const label = timer.state === "entry-open" ? "Entry closes in" : timer.state === "active" ? "Window ends in" : timer.kind === "reset" ? "Resets in" : "Starts in";
  const badge = timer.state === "entry-open" ? "Entry window" : timer.state === "active" ? "Scheduled window" : timer.state === "review-required" ? "Review required" : timer.state === "unknown" ? "Time unconfirmed" : "Next scheduled";
  const accent = timerAccent(timer);
  const Icon = timer.kind === "manual" ? Swords : timer.kind === "reset" ? RotateCcw : /shugo/i.test(timer.name) ? Sparkles : /rift|invasion/i.test(timer.name) ? Orbit : /siege|nahma|executor/i.test(timer.name) ? Flag : Clock3;
  return <article className="rounded-xl border p-3.5 shadow-sm transition-shadow hover:shadow-md" style={{ borderColor: `color-mix(in oklab, ${accent} ${phase ? 45 : 28}%, var(--border))`, background: `radial-gradient(ellipse at 100% 0%, color-mix(in oklab, ${accent} ${phase ? 18 : 12}%, transparent), transparent 80%), var(--background)`, boxShadow: `inset 0 2px 0 color-mix(in oklab, ${accent} 55%, transparent)` }} data-event-state={timer.state}>
    <div className="flex items-start gap-2.5"><span className="rounded-lg border p-2" style={{ background: `color-mix(in oklab, ${accent} 16%, transparent)`, borderColor: `color-mix(in oklab, ${accent} 20%, transparent)`, color: `color-mix(in oklab, ${accent} 35%, var(--foreground))` }}><Icon className="size-4" aria-hidden /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold leading-snug">{timer.name}</h3><p className="mt-1 inline-flex rounded-full border px-2 py-0.5 text-[9px] font-medium" style={{ background: `color-mix(in oklab, ${accent} 12%, transparent)`, borderColor: `color-mix(in oklab, ${accent} 22%, transparent)`, color: `color-mix(in oklab, ${accent} 30%, var(--foreground))` }}>{timer.kind === "manual" ? "Spawn status check" : badge}</p></div></div>
    <div className="mt-3">{countdown && target ? <><p className="mb-0.5 text-[10px] text-muted-foreground">{label}</p><time role="timer" aria-label={`${timer.name} ${label.toLowerCase()}`} aria-live="off" dateTime={target} className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{remaining(target, now)}</time></> : <p className="py-1 text-sm font-medium text-muted-foreground">{timer.kind === "manual" ? "Check in game" : timer.state === "review-required" ? "Awaiting source review" : "Time not confirmed"}</p>}</div>
    {timer.kind === "manual" ? <p className="mt-2 text-[10px] text-muted-foreground">Map → Exploration → Field Boss</p> : countdown && timer.nextStartAt && <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground"><p>{phase ? "Scheduled start" : "Your local time"}: {clock(timer.nextStartAt)}</p>{timer.timeZone && <p>Server ({timer.timeZone}): {clock(timer.nextStartAt, timer.timeZone)}</p>}</div>}
    <details className="mt-3 border-t border-border/50 pt-2"><summary className="flex cursor-pointer list-none items-center justify-between gap-2"><span className="max-w-32 truncate rounded border border-border/60 px-1.5 py-0.5 text-[9px] text-muted-foreground" title={timer.sourceLabel}>{timer.sourceLabel}</span><span className="text-[10px] font-medium text-primary">{timer.kind === "manual" ? "Where to check" : "Details"}</span></summary><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{timer.description}</p>{sourceUrl(timer.source) && <a href={timer.source} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:underline">Review source<ArrowUpRight className="size-2.5" /></a>}</details>
    <div className="mt-2 flex justify-end">{alerts}</div>
  </article>;
}
