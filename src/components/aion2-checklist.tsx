"use client";

import { useState } from "react";
import { CalendarDays, Check, Clock3, ExternalLink, ListChecks, Loader2, RotateCcw, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AION_REGIONS, type AionChecklistItem, type AionKnowledgeStatus, type AionTrackedCharacter } from "@/lib/aion2-types";

function resetLabel(reset: string | null, now: number) {
  if (!reset) return "Reset unconfirmed";
  const remaining = Date.parse(reset) - now;
  if (remaining <= 0) return "Period ended · refresh checklist";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return `Resets in ${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${mins || (!days && !hours) ? `${mins}m` : ""}`.trim();
}

export function AionChecklistPanel({ character, knowledge, now, readFailed, disabled, busy, onToggle }: {
  character: AionTrackedCharacter; knowledge?: AionKnowledgeStatus; now: number; readFailed: boolean;
  disabled: boolean; busy: boolean; onToggle: (item: AionChecklistItem, completed: boolean) => void;
}) {
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const checklist = character.checklist;
  const checkedAge = knowledge?.checkedAt ? now - Date.parse(knowledge.checkedAt) : Infinity;
  const currentSources = knowledge?.status === "current" && Date.parse(knowledge.expiresAt) > now && checkedAge >= -5 * 60_000 && checkedAge <= 30 * 60_000;
  const held = readFailed ? "Saved checklist could not be checked. Reload your characters before making changes."
    : !currentSources ? "Checklist changes need a fresh, current source review. Your last reported checks are shown."
    : !checklist ? "The recurring checklist is not available for this character yet."
    : checklist.status !== "current" ? checklist.notice || "The activity checklist needs a source review."
    : null;
  const items = checklist?.items.filter(item => item.cadence === cadence) ?? [];
  const periodKnown = (item: AionChecklistItem) => !!item.nextResetAt && Date.parse(item.nextResetAt) > now;
  const completed = (item: AionChecklistItem) => !held && item.completed && periodKnown(item);
  const periodVerified = !held && items.every(periodKnown);
  const done = items.filter(completed).length;
  const reset = items.map(item => item.nextResetAt).filter((value): value is string => !!value).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const accent = cadence === "daily" ? "var(--chart-3)" : "var(--chart-5)";
  const region = AION_REGIONS.find(r => r.id === character.region)?.name ?? character.region;

  return <section aria-labelledby="aion-checklist-title" className="overflow-hidden rounded-2xl border bg-card/80 shadow-sm" style={{ borderColor: `color-mix(in oklab, ${accent} 25%, var(--border))` }}>
    <div className="border-b border-border/30 p-5 pb-4 sm:px-6" style={{ background: `radial-gradient(ellipse at 0% 0%, color-mix(in oklab, ${accent} 22%, transparent), transparent 80%), linear-gradient(120deg, color-mix(in oklab, var(--primary) 5%, transparent), transparent)` }}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="rounded-xl border p-2.5 text-foreground shadow-sm" style={{ borderColor: `color-mix(in oklab, ${accent} 30%, transparent)`, background: `color-mix(in oklab, ${accent} 20%, var(--background))` }}><ListChecks className="size-5" aria-hidden /></span><div><h3 id="aion-checklist-title" className="font-display text-lg font-semibold">Daily & weekly checklist</h3><p className="mt-1 text-xs text-muted-foreground">{character.name} · {character.serverName} · {region}</p></div></div>{busy && <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Saving your report…</span>}</div>
      <div role="group" aria-label="Checklist period" className="mt-5 grid grid-cols-2 gap-2">{(["daily", "weekly"] as const).map(value => {
        const tasks = checklist?.items.filter(item => item.cadence === value) ?? [];
        const count = tasks.filter(completed).length;
        const verified = !held && tasks.every(periodKnown);
        const tone = value === "daily" ? "var(--chart-3)" : "var(--chart-5)";
        return <button key={value} aria-pressed={cadence === value} onClick={() => setCadence(value)} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring", cadence === value ? "font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:brightness-105")} style={{ borderColor: `color-mix(in oklab, ${tone} ${cadence === value ? 45 : 16}%, transparent)`, background: `linear-gradient(110deg, color-mix(in oklab, ${tone} ${cadence === value ? 16 : 6}%, transparent), var(--background))` }}><span className="flex items-center gap-2">{value === "daily" ? <RotateCcw className="size-3.5" /> : <CalendarDays className="size-3.5" />}{value === "daily" ? "Today" : "This week"}</span><span className="rounded-md px-1.5 py-0.5 font-mono text-xs text-foreground" style={{ background: `color-mix(in oklab, ${tone} 15%, transparent)` }}>{verified ? count : "—"}/{tasks.length}</span></button>;
      })}</div>
      {items.length > 0 && <>{periodVerified && <div role="progressbar" aria-label={`${cadence === "daily" ? "Today" : "This week"} reported completion`} aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted/70"><div className="h-full rounded-full bg-gradient-to-r from-[var(--chart-3)] to-[var(--chart-4)] transition-[width]" style={{ width: `${done / items.length * 100}%` }} /></div>}<p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 className="size-3" /><span title={periodVerified && reset ? new Date(reset).toLocaleString() : undefined}>{periodVerified ? resetLabel(reset, now) : reset && Date.parse(reset) <= now ? "Period ended · refresh checklist" : "Current period unverified"}</span><span className="ml-auto">{periodVerified ? `${done} reported done` : `${items.filter(item => item.completed).length} saved reports`}</span></p></>}
    </div>
    <div className="px-5 pb-5 sm:px-6">
      {held && <p role="status" className="mb-3 mt-3 rounded-lg border border-[var(--chart-5)]/30 bg-[var(--chart-5)]/8 p-3 text-xs leading-relaxed text-muted-foreground">{held}</p>}
      <ul aria-label={`${cadence === "daily" ? "Today" : "This week"} activities`} className="mt-4 space-y-2">{items.map(item => {
        const periodCurrent = periodKnown(item);
        const isDone = completed(item);
        const lastReported = item.completed && !isDone && (!item.nextResetAt || (!!held && periodCurrent));
        const blocked = disabled || busy || !!held || !periodCurrent;
        return <li key={item.id} className={cn("rounded-xl border border-l-2 p-3 transition-colors", isDone ? "border-[var(--chart-4)]/30 bg-gradient-to-r from-[var(--chart-4)]/10 to-background/60" : "border-border/60 bg-background/60 hover:border-[var(--chart-3)]/25")}>
          <div className="flex items-start gap-3"><input type="checkbox" checked={isDone || lastReported} aria-label={lastReported ? `${item.name}: last reported done (current period unverified)` : `Mark ${item.name} ${isDone ? "incomplete" : "complete"}`} disabled={blocked} onChange={event => { if (!blocked) onToggle(item, event.target.checked); }} className="mt-0.5 size-5 shrink-0 cursor-pointer rounded border-border accent-[var(--chart-4)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className={cn("text-sm font-semibold", isDone && "text-muted-foreground")}>{item.name}</h4>{isDone && <Check className="size-3.5 text-[var(--chart-4)]" aria-label="Reported done" />}</div><div className="mt-1.5 flex flex-wrap gap-1.5"><span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-medium", item.scope === "server" ? "bg-primary/12 text-foreground" : "bg-[var(--chart-2)]/10 text-foreground")}>{item.scope === "server" && <Users className="size-2.5" />}{item.scope === "server" ? `${character.serverName} · your account` : character.name}</span>{item.rewardTags.map(tag => <span key={tag} className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{tag}</span>)}</div>{lastReported && <p className="mt-2 text-[10px] text-muted-foreground">Last reported done{item.completedAt && <> · <time dateTime={item.completedAt}>{new Date(item.completedAt).toLocaleString()}</time></>}</p>}<details className="mt-2 text-xs"><summary className="cursor-pointer text-primary">How & source</summary><p className="mt-2 whitespace-pre-line leading-relaxed text-muted-foreground">{item.instruction}</p><p className="mt-2 text-[10px] text-muted-foreground">{held ? "Reset unconfirmed" : resetLabel(item.nextResetAt, now)}{!held && item.nextResetAt && ` · ${new Date(item.nextResetAt).toLocaleString()}`}</p>{item.completed && item.completedAt && !lastReported && <p className="mt-1 text-[10px] text-muted-foreground">{isDone ? "Reported done" : "Previous report"} {new Date(item.completedAt).toLocaleString()}</p>}<a href={item.source} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Activity source<ExternalLink className="size-2.5" /></a></details></div></div>
        </li>;
      })}</ul>
      {!items.length && <p className="py-3 text-sm text-muted-foreground">No reviewed {cadence} activities are available for this character.</p>}
      <details className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">How this checklist works</summary><p className="mt-2 leading-relaxed">Checks are your saved reports for the displayed reset period. They do not prove an item was equipped, a skill improved, or energy was spent. Server activities share a check across your saved characters on this server; other Yoshling accounts have their own checks.</p>{checklist?.notice && <p className="mt-2 leading-relaxed">{checklist.notice}</p>}{knowledge && <p className="mt-2 text-[10px]">Source review {knowledge.reviewedAt.slice(0, 10)} · {knowledge.version}</p>}</details>
    </div>
  </section>;
}
