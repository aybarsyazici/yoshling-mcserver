"use client";

import { Check, ChevronDown, CircleAlert, ExternalLink, LockKeyhole, Sparkles } from "lucide-react";
import { AionAsset } from "@/components/aion2-asset";
import { cn } from "@/lib/utils";
import type { AionEquipment, AionSnapshot, AionGearPriorityReport } from "@/lib/aion2-types";

type GearReport = AionGearPriorityReport;
type ItemPlan = GearReport["items"][number];
export type AionClericFocus = "group" | "solo" | "all" | null;
function gradeAccent(grade: string) {
  return grade === "Unique" ? "var(--chart-5)" : grade === "Legend" || grade === "Epic" ? "var(--chart-2)" : grade === "Rare" ? "var(--chart-4)" : grade === "Heroic" ? "var(--primary)" : "var(--muted-foreground)";
}

export function AionGearPriorities({ snapshot, report, holdReason, focus }: { snapshot: AionSnapshot; report?: GearReport; holdReason?: string | null; focus?: AionClericFocus }) {
  const held = holdReason || (report && report.status !== "current" ? report.notice || "Substat guidance needs a current review." : null);
  const missingReport = !report ? "The gear priority report was not returned. Use Check saved characters to request it." : null;
  const cleric = snapshot.profile.className === "Cleric";
  const selectedFocus = cleric ? focus ?? null : "all";
  return <section aria-label="Equipped items from the latest public snapshot">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold">Equipped gear</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Open an item to compare its reported lines with the reviewed substat order.</p></div><span className="rounded-full border border-[var(--chart-2)]/20 bg-[var(--chart-2)]/8 px-2 py-1 text-[10px] text-muted-foreground">Public armory snapshot</span></div>
    {(held || missingReport) && <div role="status" className="mb-4 space-y-1 rounded-lg border border-[var(--chart-5)]/25 bg-[var(--chart-5)]/8 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{held && <p>{held}</p>}{missingReport && <p>{missingReport}</p>}<p>Observed item stats remain visible.</p></div>}
    {!held && report?.notice && <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{report.notice}</p>}
    {cleric && selectedFocus === null && <p className="mb-4 text-xs text-muted-foreground">Choose a Cleric focus above to compare role-specific skill bonuses. Common stat references and observed lines remain visible.</p>}
    <div className="grid items-start gap-3 sm:grid-cols-2">{snapshot.equipment.slice().sort((a,b) => a.slot - b.slot).map(item => <GearItem key={`${item.slot}:${item.id}`} item={item} plan={report?.items.find(plan => plan.slot === item.slot && plan.itemId === item.id)} reportCurrent={report?.status === "current" && !held} statusReason={held || missingReport} focus={selectedFocus} cleric={cleric} />)}</div>
    {snapshot.equipment.length === 0 && <p className="py-5 text-sm text-muted-foreground">No equipped items were returned.</p>}
    <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 text-xs sm:grid-cols-2"><p><span className="text-muted-foreground">Wings</span><span className="mt-1 block font-medium">{snapshot.wing?.name ?? "Not reported"}</span></p><p><span className="text-muted-foreground">Equipped pet</span><span className="mt-1 block font-medium">{snapshot.pet ? `${snapshot.pet.name} · Level ${snapshot.pet.level}` : "Not reported"}</span></p></div>
  </section>;
}

function GearItem({ item, plan, reportCurrent, statusReason, focus, cleric }: { item: AionEquipment; plan?: ItemPlan; reportCurrent: boolean; statusReason: string | null; focus: AionClericFocus; cleric: boolean }) {
  const accent = gradeAccent(item.grade);
  const fixed = item.details?.randomStats === false || plan?.status === "fixed";
  const priorities = plan?.priorities.filter(priority => !(cleric && focus === null && priority.kind === "skill") && (!priority.focus || focus === "all" || priority.focus === focus)) ?? [];
  const focusReason = cleric && !!plan?.priorities.length && !priorities.length ? focus === null ? "Choose a Cleric focus above to compare this item’s skill bonuses." : "No reviewed priorities for this focus. Choose Both to compare the other role." : null;
  const canRank = reportCurrent && !fixed && item.details?.randomStats === true && plan?.status === "item-pool-verified" && !!priorities.length;
  const referenceOnly = reportCurrent && !fixed && plan?.status === "item-pool-reference" && !!priorities.length;
  const priorityGroups = [...new Set(priorities.map(priority => priority.rank))].sort((a,b) => a-b).map(rank => ({ rank, rows: priorities.filter(priority => priority.rank === rank) }));
  const observedLines = item.details ? [
    ...(item.details.stats.map(line => ({ label: line.name, value: line.value, kind: "stat" as const, skillId: null })) ?? []),
    ...(item.details.skills.map(line => ({ label: line.name, value: `+${line.level}`, kind: "skill" as const, skillId: String(line.id) })) ?? []),
  ] : [];
  const lines = observedLines.map(line => {
    const rank = plan?.currentLines.find(reported => reported.label === line.label && reported.value === line.value && reported.kind === line.kind)?.priorityRank ?? null;
    const allowed = !cleric || line.kind !== "skill" || priorities.some(priority => priority.kind === "skill" && priority.id === line.skillId && priority.rank === rank);
    return { ...line, priorityRank: allowed ? rank : null };
  });
  return <details className="group overflow-hidden rounded-xl border bg-background/60 shadow-sm sm:open:col-span-2" style={{ borderColor: `color-mix(in oklab, ${accent} 25%, var(--border))` }}>
    <summary aria-label={`${item.name}: view stats and priorities`} className="cursor-pointer list-none p-3.5 focus-visible:outline-2 focus-visible:outline-ring" style={{ background: `radial-gradient(ellipse at 0% 0%, color-mix(in oklab, ${accent} 10%, transparent), transparent 80%)` }}>
      <span className="flex items-start gap-3"><AionAsset src={item.icon} alt={`${item.name} icon`} size={44} /><span className="min-w-0 flex-1"><span className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground"><span>{item.slotName.replace(/([a-z])([A-Z0-9])/g, "$1 $2")}</span><span className="rounded-md px-1.5 py-0.5 text-foreground" style={{ background: `color-mix(in oklab, ${accent} 14%, transparent)` }}>{item.grade}</span><span className="ml-auto font-mono text-xs text-foreground">+{item.enchantLevel}{item.ampLevel > 0 && ` / Amp ${item.ampLevel}`}</span></span><span className="block text-sm font-semibold leading-snug">{item.name}</span></span></span>
      <span className="mt-3 flex items-center justify-between gap-2 border-t border-border/40 pt-2 text-[11px] text-primary"><span>{fixed ? <span className="inline-flex items-center gap-1 text-muted-foreground"><LockKeyhole className="size-3" />Fixed stats</span> : "View stats & priorities"}</span><ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden /></span>
    </summary>
    <div className="grid gap-5 border-t border-border/60 p-4 sm:grid-cols-2">
      <div><h4 className="mb-3 text-xs font-semibold">Observed stats</h4>{lines.length ? <ul aria-label={`${item.name} observed stats`} className="space-y-2">{lines.map((line,index) => <li key={index} className="flex items-start justify-between gap-3 rounded-lg border border-border/40 bg-card/50 px-2.5 py-2 text-xs"><span className="min-w-0"><span className="block">{line.label}</span>{canRank && line.priorityRank !== null && <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Check className="size-2.5 text-[var(--chart-4)]" />Reviewed priority {line.priorityRank}</span>}</span><span className="shrink-0 font-mono text-foreground">{line.value}</span></li>)}</ul> : <p className="text-xs leading-relaxed text-muted-foreground">Item detail stats were not reported in this snapshot.</p>}
      {item.details && <div className="mt-3 space-y-1 text-[10px] text-muted-foreground">{item.details.bindRate !== null && <p>Bind {item.details.bindRate}%</p>}{item.details.maxEnchantLevel !== null && <p>Enhancement limit +{item.details.maxEnchantLevel}{item.details.maxAmpLevel !== null && ` / Amp ${item.details.maxAmpLevel}`}</p>}</div>}</div>
      <div>{fixed ? <div className="rounded-xl border border-border/60 bg-muted/20 p-3"><h4 className="flex items-center gap-2 text-xs font-semibold"><LockKeyhole className="size-3.5" />Fixed stats — not rerollable</h4><p className="mt-2 text-xs leading-relaxed text-muted-foreground">These fixed lines cannot be changed with Sync.</p></div> : (canRank || referenceOnly) && plan ? <><h4 className="mb-1 flex items-center gap-2 text-xs font-semibold"><Sparkles className="size-3.5 text-primary" />{referenceOnly ? "Reference substat order" : "Reviewed substat order"}</h4>{referenceOnly && <p role="note" className="mb-3 rounded-lg border border-[var(--chart-2)]/25 bg-[var(--chart-2)]/8 px-3 py-2 text-xs leading-relaxed">Exact item pool reviewed; current capability or lines were not returned. Compare only; this does not establish Sync capability. Confirm the item’s current options in game before spending.</p>}<p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{plan.basis}</p><ol aria-label={`${item.name} substat priorities`} className="space-y-2">{priorityGroups.map(group => {
        const matches = canRank ? lines.filter(line => line.priorityRank === group.rank) : [];
        return <li key={group.rank} value={group.rank} className="flex gap-2.5 rounded-lg border border-border/50 bg-card/40 p-2.5"><span className={cn("flex size-6 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold", group.rank === 1 ? "bg-[var(--chart-5)]/20 text-foreground" : "bg-[var(--chart-2)]/12 text-foreground")}>{group.rank}</span><div className="min-w-0 flex-1"><h5 className="text-xs font-semibold">{group.rows.map(priority => priority.label).join(" / ")}</h5>{[...new Set(group.rows.map(priority => priority.reason))].map((reason,index) => <p key={index} className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{reason}</p>)}{matches.length > 0 ? <p className="mt-1.5 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">Reported on item:</span> {matches.map(line => `${line.label} ${line.value}`).join(" · ")}</p> : <p className="mt-1.5 text-[10px] text-muted-foreground">{referenceOnly ? "Current line match not verified" : "Not matched in the public item lines"}</p>}</div></li>;
      })}</ol></> : <div className="rounded-xl border border-border/60 bg-card/40 p-3"><h4 className="flex items-center gap-2 text-xs font-semibold"><CircleAlert className="size-3.5 text-muted-foreground" />No verified priority for this item</h4><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{statusReason || (reportCurrent && focusReason) || (!reportCurrent ? "The gear report did not establish current guidance for this item." : plan?.status === "unsupported" ? "This class or slot has not been curated." : item.details?.randomStats == null ? "The armory did not establish whether these lines can be rerolled." : "The exact item pool has not been verified; no generic reroll list is substituted.")}</p></div>}
      {reportCurrent && plan?.notices.map((notice,index) => <p key={index} className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{notice}</p>)}
      {!!plan?.sources.length && <details className="mt-3 border-t border-border/50 pt-3 text-xs"><summary className="cursor-pointer text-primary">Priority sources ({plan.sources.length})</summary><ul className="mt-2 space-y-2">{plan.sources.map((source,index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">{source.title}<ExternalLink className="size-2.5" /></a><p className="mt-0.5 text-[10px] text-muted-foreground">{source.kind.replace(/[-_]/g," ")} · Reviewed {source.reviewedAt.slice(0,10)}</p></li>)}</ul></details>}
      </div>
    </div>
  </details>;
}
