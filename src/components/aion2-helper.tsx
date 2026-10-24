"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, CircleAlert, Clock3, ExternalLink, Loader2, Pause, Play, Plus, RefreshCw, Search, Shield, Sparkles, Swords, Trash2, TrendingUp, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AionAsset, aionImageSource } from "@/components/aion2-asset";
import { AionBoards } from "@/components/aion2-board-map";
import { AionGearPriorities } from "@/components/aion2-gear-priorities";
import { isAionGearPriorityReport } from "@/lib/aion2-gear-validation";
import { AionTimerPanel } from "@/components/aion2-timer-panel";
import { AionChecklistPanel } from "@/components/aion2-checklist";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AION_GUIDE_SOURCES, AION_REGIONS, isAionRegion, type AionCharacterList, type AionChecklistItem, type AionEvidenceSource, type AionHistoryPoint, type AionKnowledgeStatus, type AionRecommendation, type AionRegion, type AionSearchCharacter, type AionServer, type AionSnapshot, type AionTrackedCharacter } from "@/lib/aion2-types";

const POLL_MS = 30_000;
const selectClass = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableNumber = (v: unknown) => v === null || finite(v);
const nullableTime = (v: unknown) => v === null || time(v);
const sourceLink = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && ["docs.google.com", "aion2.plaync.com", "aion2.gg", "aion2data.com"].includes(url.hostname); } catch { return false; }
};
function ref(v: Record<string, unknown>) { return isAionRegion(v.region) && Number.isSafeInteger(v.serverId) && Number(v.serverId) > 0 && typeof v.characterId === "string" && v.characterId.length > 0; }
function itemDetails(v: unknown) {
  return v === undefined || (object(v) && nullableNumber(v.maxEnchantLevel) && nullableNumber(v.maxAmpLevel) && (v.randomStats === null || typeof v.randomStats === "boolean") && nullableNumber(v.bindRate)
    && Array.isArray(v.stats) && v.stats.every(s => object(s) && typeof s.name === "string" && typeof s.value === "string")
    && Array.isArray(v.skills) && v.skills.every(s => object(s) && finite(s.id) && typeof s.name === "string" && finite(s.level)));
}
function snapshot(v: unknown): v is AionSnapshot {
  if (!object(v) || v.version !== 1 || !object(v.ref) || !ref(v.ref) || !time(v.observedAt) || !object(v.profile) || !object(v.coverage)) return false;
  const p = v.profile;
  return typeof p.name === "string" && typeof p.serverName === "string" && typeof p.className === "string" && finite(p.level) && (p.portrait === undefined || p.portrait === null || aionImageSource(p.portrait)) && nullableNumber(p.combatPower) && nullableNumber(p.gearScore)
    && ["equipment", "skills", "boards"].every(k => typeof (v.coverage as Record<string, unknown>)[k] === "boolean")
    && Array.isArray(v.equipment) && v.equipment.length <= 100 && v.equipment.every(i => object(i) && finite(i.id) && finite(i.slot) && typeof i.slotName === "string" && typeof i.name === "string" && typeof i.grade === "string" && (i.icon === null || aionImageSource(i.icon)) && finite(i.enchantLevel) && finite(i.ampLevel) && itemDetails(i.details))
    && Array.isArray(v.skills) && v.skills.length <= 200 && v.skills.every(i => object(i) && finite(i.id) && typeof i.name === "string" && typeof i.category === "string" && finite(i.level) && (i.icon === undefined || i.icon === null || aionImageSource(i.icon)) && typeof i.acquired === "boolean" && typeof i.equipped === "boolean")
    && Array.isArray(v.boards) && v.boards.length <= 30 && v.boards.every(i => object(i) && finite(i.id) && typeof i.name === "string" && finite(i.openNodes) && finite(i.totalNodes) && (i.nodes === undefined || (Array.isArray(i.nodes) && i.nodes.length <= 1000 && i.nodes.every(n => object(n) && Number.isSafeInteger(n.id) && Number.isSafeInteger(n.row) && Number.isSafeInteger(n.col) && Math.abs(Number(n.row)) <= 100 && Math.abs(Number(n.col)) <= 100 && typeof n.name === "string" && typeof n.kind === "string" && typeof n.grade === "string" && typeof n.unlocked === "boolean" && Array.isArray(n.effects) && n.effects.every(e => typeof e === "string") && (n.icon === null || aionImageSource(n.icon))))))
    && Array.isArray(v.stats) && v.stats.every(i => object(i) && typeof i.name === "string" && typeof i.type === "string" && finite(i.value))
    && (v.wing === null || (object(v.wing) && typeof v.wing.name === "string" && typeof v.wing.grade === "string" && finite(v.wing.level)))
    && (v.pet === null || (object(v.pet) && typeof v.pet.name === "string" && finite(v.pet.level)));
}
function recommendation(v: unknown): v is AionRecommendation {
  if (!object(v) || typeof v.id !== "string" || !["high", "medium", "low"].includes(String(v.priority)) || typeof v.title !== "string" || typeof v.evidence !== "string" || typeof v.action !== "string" || !sourceLink(v.source)) return false;
  if (v.steps !== undefined && (!Array.isArray(v.steps) || v.steps.length > 30 || !v.steps.every(s => object(s) && typeof s.id === "string" && typeof s.title === "string" && typeof s.instruction === "string" && (s.reason === undefined || typeof s.reason === "string") && (s.source === undefined || sourceLink(s.source)) && (s.status === undefined || ["ready", "blocked", "manual-check"].includes(String(s.status))) && (s.cost === undefined || (object(s.cost) && s.cost.resource === "odyle" && Number.isSafeInteger(s.cost.amount) && Number(s.cost.amount) >= 0))))) return false;
  if (Array.isArray(v.steps) && !v.steps.every(s => object(s) && (s.checklistActivityIds === undefined || (Array.isArray(s.checklistActivityIds) && s.checklistActivityIds.length <= 30 && s.checklistActivityIds.every(id => typeof id === "string" && id.length > 0))) && (s.reportedDone === undefined || typeof s.reportedDone === "boolean") && (s.progressNote === undefined || typeof s.progressNote === "string"))) return false;
  if (v.budget !== undefined && (!object(v.budget) || !nullableNumber(v.budget.available) || !nullableNumber(v.budget.costPerRun) || !nullableNumber(v.budget.affordableRuns) || !nullableTime(v.budget.updatedAt))) return false;
  if (v.evidenceSources !== undefined && (!Array.isArray(v.evidenceSources) || v.evidenceSources.length > 30 || !v.evidenceSources.every(evidenceSource))) return false;
  if (v.relatedEvidence !== undefined && (!Array.isArray(v.relatedEvidence) || v.relatedEvidence.length > 10 || !v.relatedEvidence.every(e => object(e) && typeof e.id === "string" && typeof e.title === "string" && typeof e.text === "string" && Array.isArray(e.sources) && e.sources.length <= 30 && e.sources.every(evidenceSource)))) return false;
  return true;
}
function evidenceSource(value: unknown): value is AionEvidenceSource {
  return object(value) && typeof value.title === "string" && sourceLink(value.url) && typeof value.kind === "string" && time(value.reviewedAt);
}
export function isAionTrackedCharacter(v: unknown): v is AionTrackedCharacter {
  if (!object(v) || !ref(v) || typeof v.id !== "string" || typeof v.name !== "string" || typeof v.serverName !== "string" || typeof v.tracking !== "boolean" || !nullableTime(v.lastAttemptAt) || !nullableTime(v.lastSuccessAt) || !time(v.nextRefreshAt) || !(v.lastError === null || typeof v.lastError === "string")) return false;
  if (v.snapshot !== null && (!snapshot(v.snapshot) || v.snapshot.ref.characterId !== v.characterId || v.snapshot.ref.serverId !== v.serverId || v.snapshot.ref.region !== v.region)) return false;
  if (v.resources !== undefined && (!object(v.resources) || !(v.resources.odyleEnergy === null || (Number.isSafeInteger(v.resources.odyleEnergy) && Number(v.resources.odyleEnergy) >= 0 && Number(v.resources.odyleEnergy) <= 10_000)) || !nullableTime(v.resources.updatedAt))) return false;
  if (v.gearPriorities !== undefined && !isAionGearPriorityReport(v.gearPriorities, v.snapshot === null ? [] : (v.snapshot as AionSnapshot).equipment)) return false;
  if (v.checklist !== undefined) {
    const c = v.checklist;
    if (!object(c) || !["current", "review-required", "unverified"].includes(String(c.status)) || typeof c.notice !== "string" || typeof c.revision !== "string" || !c.revision || !Array.isArray(c.items) || c.items.length > 100 || !c.items.every(i => object(i) && typeof i.id === "string" && !!i.id && typeof i.name === "string" && ["daily", "weekly"].includes(String(i.cadence)) && ["character", "server"].includes(String(i.scope)) && typeof i.instruction === "string" && Array.isArray(i.rewardTags) && i.rewardTags.every(t => typeof t === "string") && sourceLink(i.source) && typeof i.completed === "boolean" && nullableTime(i.completedAt) && typeof i.periodKey === "string" && !!i.periodKey && nullableTime(i.nextResetAt)) || new Set(c.items.map(i => (i as Record<string, unknown>).id)).size !== c.items.length) return false;
  }
  if (v.boardPlans !== undefined && (!Array.isArray(v.boardPlans) || v.boardPlans.length > 30 || !v.boardPlans.every(p => object(p) && Number.isSafeInteger(p.boardId) && typeof p.label === "string" && sourceLink(p.source) && Array.isArray(p.targets) && p.targets.every(t => object(t) && Number.isSafeInteger(t.nodeId) && typeof t.reason === "string") && Array.isArray(p.pathNodeIds) && p.pathNodeIds.every(Number.isSafeInteger) && Array.isArray(p.missingNodeIds) && p.missingNodeIds.every(Number.isSafeInteger) && (p.cost === null || (finite(p.cost) && p.cost >= 0)) && Array.isArray(p.notices) && p.notices.every(n => typeof n === "string") && (p.nodeCosts === undefined || (Array.isArray(p.nodeCosts) && p.nodeCosts.every(c => object(c) && Number.isSafeInteger(c.nodeId) && finite(c.cost) && c.cost >= 0)))))) return false;
  return Array.isArray(v.history) && v.history.length <= 250 && v.history.every(i => object(i) && time(i.observedAt) && nullableNumber(i.combatPower) && nullableNumber(i.gearScore))
    && Array.isArray(v.recommendations) && v.recommendations.length <= 100 && v.recommendations.every(recommendation);
}
export function isAionCharacterList(v: unknown): v is AionCharacterList {
  if (!object(v) || !Array.isArray(v.characters) || v.characters.length > 12 || !v.characters.every(isAionTrackedCharacter) || new Set(v.characters.map(c => c.id)).size !== v.characters.length || !finite(v.pollIntervalMs) || v.pollIntervalMs < 60_000 || !time(v.checkedAt)) return false;
  if (v.knowledge === undefined) return true;
  const k = v.knowledge;
  return object(k) && typeof k.version === "string" && time(k.reviewedAt) && time(k.expiresAt) && (k.checkedAt === undefined || nullableTime(k.checkedAt)) && ["current", "expired", "review-required", "unverified"].includes(String(k.status)) && Array.isArray(k.supportedClasses) && k.supportedClasses.every(c => typeof c === "string") && Array.isArray(k.notices) && k.notices.every(n => typeof n === "string");
}
function searchCharacter(v: unknown): v is AionSearchCharacter {
  return object(v) && ref(v) && typeof v.name === "string" && typeof v.serverName === "string" && (v.className === null || typeof v.className === "string") && nullableNumber(v.level);
}
async function request(url: string, options?: RequestInit) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("The service returned an unreadable response. Try again."); }
    if (!response.ok) throw new Error(object(data) && typeof data.error === "string" ? data.error : "The request could not be completed.");
    return data;
  } finally { clearTimeout(timeout); options?.signal?.removeEventListener("abort", onAbort); }
}
function number(value: number | null | undefined) { return value == null ? "Unavailable" : value.toLocaleString(); }
function date(value: string | null) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not checked yet"; }
function regionName(region: AionRegion) { return AION_REGIONS.find(r => r.id === region)?.name ?? region; }

export function AionHelper() {
  const [data, setData] = useState<AionCharacterList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const listRead = useRef<AbortController | null>(null);
  const mutation = useRef(false);

  const load = useCallback(async () => {
    if (listRead.current) return false;
    const controller = new AbortController(); listRead.current = controller;
    setRefreshing(true);
    try {
      const next = await request("/api/aion2/characters", { signal: controller.signal });
      if (!isAionCharacterList(next)) throw new Error("Saved characters could not be verified. Please retry.");
      if (!alive.current || controller.signal.aborted) return false;
      setData(next); setLoadError(null);
      setSelectedId(current => next.characters.some(c => c.id === current) ? current : next.characters[0]?.id ?? null);
      return true;
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Characters could not be loaded.");
      return false;
    } finally {
      if (listRead.current === controller) {
        listRead.current = null;
        if (alive.current) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => { if (alive.current) void load(); });
    const timer = setInterval(() => { setNow(Date.now()); if (document.visibilityState === "visible" && !mutation.current) void load(); }, POLL_MS);
    const visible = () => { setNow(Date.now()); if (document.visibilityState === "visible" && !mutation.current) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; listRead.current?.abort(); listRead.current = null; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  async function mutate(key: string, url: string, options: RequestInit, confirm?: (character: AionTrackedCharacter) => boolean) {
    if (mutation.current || !data || loadError) return;
    mutation.current = true;
    listRead.current?.abort(); listRead.current = null;
    setBusy(key); setNotice(null);
    try {
      const result = await request(url, options);
      if (!object(result)) throw new Error("The change could not be confirmed.");
      if (options.method === "DELETE") {
        if (result.removedId !== key) throw new Error("Removal could not be confirmed.");
      } else {
        if (!isAionTrackedCharacter(result.character)) throw new Error("The saved character could not be verified.");
        if (options.method !== "POST" || url !== "/api/aion2/characters") {
          const expected = data.characters.find(c => c.id === key);
          if (result.character.id !== key || !expected || result.character.region !== expected.region || result.character.serverId !== expected.serverId || result.character.characterId !== expected.characterId) throw new Error("A different character was returned. Reload before trying again.");
        }
        if (confirm && !confirm(result.character)) throw new Error("The checklist report could not be confirmed.");
        if (key === "add") setSelectedId(result.character.id);
      }
      await load();
      if (alive.current) setRemoveId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The change could not be confirmed.";
      if (alive.current) setNotice(`${message} Rechecking saved characters.`);
      const reloaded = await load();
      if (alive.current) setNotice(`${message} ${reloaded ? "Current saved characters are shown; review before trying again." : "The change is unconfirmed until saved characters can be reloaded."}`);
    } finally { mutation.current = false; if (alive.current) setBusy(null); }
  }

  const selected = data?.characters.find(c => c.id === selectedId) ?? null;
  const canEdit = !!data && !loadError && !busy;
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="bg-gradient-to-r from-foreground via-foreground to-primary bg-clip-text font-display text-3xl font-bold tracking-tight text-transparent sm:text-4xl">Track your progress</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">Track characters, review upgrades and manage daily and weekly activities.</p></div>
        <Button variant="outline" onClick={() => void load()} disabled={refreshing || !!busy}><RefreshCw className={cn("size-4", refreshing && "animate-spin")} />{refreshing ? "Checking…" : "Check saved characters"}</Button>
      </div>
      <AionTimerPanel region={selected?.region ?? "eu"} serverId={selected?.serverId} serverName={selected?.serverName} characterName={selected?.name} knowledge={data?.knowledge} readFailed={!!loadError} />
      {loadError && <Alert><p>{data ? "Saved data is shown below. " : ""}{loadError}</p><Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>Retry</Button></Alert>}
      {notice && <Alert><p>{notice}</p></Alert>}
      <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-5" aria-label="Your characters">
          <section className="overflow-hidden rounded-2xl border border-primary/15 bg-card/80 shadow-[0_12px_36px_-24px_color-mix(in_oklab,var(--primary)_35%,transparent)] backdrop-blur">
            <div className="flex items-center justify-between border-b border-primary/15 bg-gradient-to-r from-primary/10 to-[var(--chart-2)]/5 px-4 py-4"><h2 className="text-sm font-semibold">Characters</h2><span className="font-mono text-xs text-muted-foreground">{data?.characters.length ?? "—"} / 12</span></div>
            {!data && !loadError && <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading your characters…</p>}
            {data?.characters.length === 0 && <p className="px-4 py-6 text-sm leading-relaxed text-muted-foreground">Add your first character below to start a progression history.</p>}
            <div className="p-2">{data?.characters.map(c => <button key={c.id} onClick={() => { setSelectedId(c.id); setRemoveId(null); }} aria-pressed={selectedId === c.id} className={cn("mb-1 flex w-full items-center gap-3 rounded-xl border border-l-2 px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring", selectedId === c.id ? "border-primary/35 bg-gradient-to-r from-primary/18 to-[var(--chart-2)]/8 shadow-sm" : "border-transparent hover:border-primary/15 hover:bg-primary/5")}>
              <span className={cn("rounded-xl p-2.5", selectedId === c.id ? "bg-gradient-to-br from-primary/25 to-[var(--chart-2)]/15 text-primary ring-1 ring-primary/15" : "bg-muted/60 text-muted-foreground")}><Swords className="size-4" aria-hidden /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{c.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.serverName} · {regionName(c.region)}</span><span className="mt-1 block text-[11px] text-muted-foreground">{c.snapshot ? `${number(c.snapshot.profile.combatPower)} CP` : "Awaiting first snapshot"}{!c.tracking && " · Paused"}{c.lastError && " · Check failed"}</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>)}</div>
          </section>
          <AddCharacter disabled={!canEdit || (data?.characters.length ?? 0) >= 12} busy={busy === "add"} onAdd={c => void mutate("add", "/api/aion2/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: c.region, serverId: c.serverId, characterId: c.characterId }) })} />
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">Your saved list belongs to your Yoshling account. Tracking checks the public armory about every {Math.round((data?.pollIntervalMs ?? 900_000) / 60_000)} minutes, including while this page is closed.</p>
        </aside>
        {selected ? <CharacterDetail key={selected.id} character={selected} now={now} knowledge={data?.knowledge} readFailed={!!loadError} disabled={!canEdit} busy={busy === selected.id} removeConfirm={removeId === selected.id} onRemoveConfirm={() => setRemoveId(selected.id)} onRemoveCancel={() => setRemoveId(null)} onRemove={() => void mutate(selected.id, `/api/aion2/characters/${selected.id}`, { method: "DELETE" })} onPause={() => void mutate(selected.id, `/api/aion2/characters/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracking: !selected.tracking }) })} onRefresh={() => void mutate(selected.id, `/api/aion2/characters/${selected.id}/refresh`, { method: "POST" })} onResources={odyleEnergy => void mutate(selected.id, `/api/aion2/characters/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ odyleEnergy }) })} onChecklist={(item, completed) => void mutate(selected.id, `/api/aion2/characters/${selected.id}/checklist`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activityId: item.id, completed, periodKey: item.periodKey, revision: selected.checklist?.revision }) }, saved => saved.checklist?.items.some(current => current.id === item.id && current.completed === completed && current.periodKey === item.periodKey) ?? false)} /> : <EmptyCharacter loading={!data && !loadError} />}
      </div>
      {data?.knowledge && <section className="rounded-2xl border border-border/60 bg-card/40 p-5 text-xs leading-relaxed text-muted-foreground" aria-label="Recommendation sources"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium text-foreground">Recommendation sources</h2><span className="font-mono">{data.knowledge.version}</span></div><p className="mt-2">Community guide review: {date(data.knowledge.reviewedAt)}. {data.knowledge.status === "current" && Date.parse(data.knowledge.expiresAt) > now ? "Reviewed rules are available for supported classes." : "Guide rules need review; recommendations may be limited."}</p><p className="mt-1">Last source check: {date(data.knowledge.checkedAt ?? null)}. Review expires: {date(data.knowledge.expiresAt)}.</p><p className="mt-1">Curated class guidance: {data.knowledge.supportedClasses.join(", ") || "None yet"}. Other classes can still be tracked.</p>{selected?.snapshot && !data.knowledge.supportedClasses.includes(selected.snapshot.profile.className) && <p className="mt-2 text-foreground">Specific upgrade rules for {selected.snapshot.profile.className} have not been curated yet.</p>}{data.knowledge.notices.map((n, i) => <p key={i} className="mt-2">{n}</p>)}<p className="mt-2">Public armory data may lag behind the game. Check times record when this helper received a response.</p></section>}
    </div>
  );
}

function AddCharacter({ disabled, busy, onAdd }: { disabled: boolean; busy: boolean; onAdd: (c: AionSearchCharacter) => void }) {
  const [region, setRegion] = useState<AionRegion>("eu");
  const [serverId, setServerId] = useState("");
  const [name, setName] = useState("Yoshiane");
  const [servers, setServers] = useState<AionServer[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverRetry, setServerRetry] = useState(0);
  const [results, setResults] = useState<AionSearchCharacter[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const searchRead = useRef<AbortController | null>(null);
  function invalidate() { generation.current++; searchRead.current?.abort(); setSearching(false); setResults(null); setError(null); }
  useEffect(() => {
    const controller = new AbortController();
    void request(`/api/aion2/servers?region=${region}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      if (!object(value) || !Array.isArray(value.servers) || !value.servers.every(s => object(s) && Number.isSafeInteger(s.id) && typeof s.name === "string")) throw new Error("The server list could not be verified.");
      const rows = value.servers as AionServer[];
      setServers(rows); setServerError(null); setServerId(region === "eu" && rows.some(s => s.id === 2322) ? "2322" : "");
    }).catch(e => { if (!controller.signal.aborted) setServerError(e instanceof Error ? e.message : "Servers could not be loaded."); });
    return () => { controller.abort(); searchRead.current?.abort(); };
  }, [region, serverRetry]);
  async function search(event: FormEvent) {
    event.preventDefault();
    if (disabled || searching || !servers || serverError || !name.trim()) return;
    const current = ++generation.current;
    const controller = new AbortController(); searchRead.current?.abort(); searchRead.current = controller;
    setSearching(true); setError(null); setResults(null);
    const params = new URLSearchParams({ region, name: name.trim(), ...(serverId ? { serverId } : {}) });
    try {
      const value = await request(`/api/aion2/search?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || generation.current !== current) return;
      if (!object(value) || !Array.isArray(value.characters) || value.characters.length > 100 || !value.characters.every(searchCharacter) || value.characters.some(c => c.region !== region || (serverId && c.serverId !== Number(serverId)))) throw new Error("Search results could not be verified. Try again.");
      setResults(value.characters);
    } catch (e) { if (!controller.signal.aborted && generation.current === current) setError(e instanceof Error ? e.message : "Search failed."); }
    finally { if (generation.current === current) setSearching(false); }
  }
  return (
    <section className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-sm backdrop-blur" aria-labelledby="aion-add-title">
      <h2 id="aion-add-title" className="mb-4 flex items-center gap-2 text-sm font-semibold"><Plus className="size-4 text-primary" />Add a character</h2>
      <form onSubmit={search} className="space-y-3">
        <label className="block space-y-1.5"><span className="text-xs text-muted-foreground">Region</span><select aria-label="Region" value={region} disabled={busy} onChange={e => { invalidate(); setRegion(e.target.value as AionRegion); setServers(null); setServerId(""); setServerError(null); }} className={selectClass}>{AION_REGIONS.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="block space-y-1.5"><span className="text-xs text-muted-foreground">Server</span><select aria-label="Server" value={serverId} disabled={!servers || !!serverError || busy} onChange={e => { invalidate(); setServerId(e.target.value); }} className={selectClass}><option value="">{servers ? "All servers" : "Loading servers…"}</option>{servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {serverError && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{serverError}</p><Button size="sm" variant="outline" type="button" onClick={() => { setServers(null); setServerError(null); setServerRetry(v => v + 1); }}>Retry servers</Button></div>}
        <label className="block space-y-1.5"><span className="text-xs text-muted-foreground">Character name</span><Input aria-label="Character name" value={name} maxLength={40} disabled={busy} onChange={e => { invalidate(); setName(e.target.value); }} className="h-10 bg-background" autoComplete="off" /></label>
        <Button type="submit" className="h-10 w-full" disabled={disabled || searching || !servers || !!serverError || !name.trim()}>{searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}{searching ? "Searching…" : "Find character"}</Button>
      </form>
      {error && <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">{error}</p>}
      {results?.length === 0 && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">No matching characters. Check the spelling, region and server.</p>}
      {!!results?.length && <div aria-label="Search results" className="mt-4 space-y-2 border-t border-border pt-3">{results.map(c => <div key={`${c.region}:${c.serverId}:${c.characterId}`} className="flex items-center gap-2 rounded-lg bg-background/60 p-2.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{c.name}</p><p className="text-[11px] text-muted-foreground">{c.serverName}{c.level !== null && ` · Lv. ${c.level}`}{c.className && ` · ${c.className}`}</p></div><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => onAdd(c)} aria-label={`Track ${c.name} on ${c.serverName}`}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}Track</Button></div>)}</div>}
    </section>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--chart-5)]/30 bg-[var(--chart-5)]/10 px-4 py-3 text-sm"><CircleAlert className="size-4 shrink-0" aria-hidden />{children}</div>;
}

function EmptyCharacter({ loading }: { loading: boolean }) {
  return <section className="flex min-h-[490px] flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/30 px-6 py-12 text-center"><div className="relative mb-7 rounded-full border border-primary/20 bg-primary/5 p-7"><Swords className="size-12 text-primary" strokeWidth={1.2} aria-hidden /><span className="absolute -right-1 top-1 rounded-full border border-border bg-background p-2"><Sparkles className="size-4 text-primary" aria-hidden /></span></div><h2 className="font-display text-xl font-semibold">{loading ? "Loading characters…" : "Add a character"}</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">Search for a character by name and server. Once tracked, its gear, skills and progression history will appear here.</p><div className="mt-8 flex flex-wrap justify-center gap-5 text-xs text-muted-foreground"><span className="flex items-center gap-2"><Shield className="size-4" />Public profile</span><span className="flex items-center gap-2"><TrendingUp className="size-4" />Saved history</span><span className="flex items-center gap-2"><Swords className="size-4" />PvE priorities</span></div></section>;
}

function recommendationHold(c: AionTrackedCharacter, knowledge: AionKnowledgeStatus | undefined, now: number, readFailed: boolean) {
  if (readFailed) return "Recommendations are withheld because saved characters could not be checked. Retry to verify the current state.";
  if (!c.snapshot) return "Recommendations are withheld until a successful public profile check.";
  if (c.lastError) return "Recommendations are withheld because the latest public profile check failed. Refresh the character before planning an upgrade.";
  if (!c.lastSuccessAt || now - Date.parse(c.lastSuccessAt) > 30 * 60_000 || now - Date.parse(c.lastSuccessAt) < -5 * 60_000 || now - Date.parse(c.snapshot.observedAt) > 30 * 60_000 || now - Date.parse(c.snapshot.observedAt) < -5 * 60_000) return "Recommendations are withheld because the snapshot needs a fresh check. Your last observed metrics and history are still shown.";
  if (!knowledge || knowledge.status === "unverified") return "Recommendations are withheld until current source status can be verified.";
  if (knowledge.status === "expired" || Date.parse(knowledge.expiresAt) <= now) return "Recommendations are withheld because the source review has expired.";
  if (knowledge.status === "review-required") return "Recommendations are withheld until updated patch or reference information has been reviewed.";
  return null;
}

function CharacterDetail({ character: c, now, knowledge, readFailed, disabled, busy, removeConfirm, onRemoveConfirm, onRemoveCancel, onRemove, onPause, onRefresh, onResources, onChecklist }: { character: AionTrackedCharacter; now: number; knowledge?: AionKnowledgeStatus; readFailed: boolean; disabled: boolean; busy: boolean; removeConfirm: boolean; onRemoveConfirm: () => void; onRemoveCancel: () => void; onRemove: () => void; onPause: () => void; onRefresh: () => void; onResources: (odyleEnergy: number | null) => void; onChecklist: (item: AionChecklistItem, completed: boolean) => void }) {
  const [view, setView] = useState("gear");
  const detailsPanel = useRef<HTMLElement | null>(null);
  const s = c.snapshot;
  const stale = readFailed || !!c.lastError || !c.lastSuccessAt || now - Date.parse(c.lastSuccessAt) > 30 * 60_000 || now - Date.parse(c.lastSuccessAt) < -5 * 60_000 || !s || now - Date.parse(s.observedAt) > 30 * 60_000 || now - Date.parse(s.observedAt) < -5 * 60_000;
  const held = recommendationHold(c, knowledge, now, readFailed);
  return <div className="min-w-0 space-y-5">
    <section className="overflow-hidden rounded-2xl border border-primary/15 bg-card/80 shadow-[0_12px_36px_-24px_color-mix(in_oklab,var(--primary)_35%,transparent)] backdrop-blur">
      <div className="bg-gradient-to-br from-primary/16 via-[var(--chart-2)]/6 to-[var(--chart-5)]/9 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-4"><AionAsset src={s?.profile.portrait} alt={`${c.name} portrait`} size={72} className="rounded-2xl border-primary/35 bg-primary/10 shadow-lg shadow-primary/10 ring-4 ring-background/60" /><div className="min-w-0"><div className="mb-2 flex flex-wrap items-center gap-2"><span className="rounded-full border border-border bg-background/70 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider">{s?.profile.className ?? "Character"}</span><span className={cn("rounded-full px-2.5 py-1 text-[10px] font-medium", !c.tracking || stale ? "bg-muted text-muted-foreground" : "bg-[var(--chart-4)]/15 text-foreground ring-1 ring-[var(--chart-4)]/25")}>{!c.tracking ? "Tracking paused" : stale ? "Snapshot needs a check" : "Tracking enabled"}</span></div><h2 className="font-display text-3xl font-bold tracking-tight">{c.name}</h2><p className="mt-1.5 text-sm text-muted-foreground">{c.serverName} · {regionName(c.region)}{s && ` · Level ${s.profile.level}`}</p></div></div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={onRefresh}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh now</Button><Button variant="outline" size="sm" disabled={disabled} onClick={onPause}>{c.tracking ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{c.tracking ? "Pause" : "Resume"}</Button><Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onRemoveConfirm} aria-label={`Remove ${c.name}`}><Trash2 className="size-3.5" /></Button></div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3"><Metric label="Combat Power" value={s?.profile.combatPower} tone="power" /><Metric label="Gear Score" value={s?.profile.gearScore} tone="gear" /><div className="rounded-xl border border-[var(--chart-3)]/25 bg-gradient-to-br from-[var(--chart-3)]/10 to-background/80 p-4 shadow-sm"><p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="size-3.5" />Last successful check</p><p className="text-xs font-medium leading-relaxed">{date(c.lastSuccessAt)}</p></div></div>
      </div>
      {c.lastError && <div role="alert" className="border-t border-border bg-[var(--chart-5)]/10 px-5 py-3 text-xs leading-relaxed">Latest check failed: {c.lastError}{s && " Your last successful snapshot is still shown."}</div>}
      {removeConfirm && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-destructive/5 px-5 py-4"><p className="text-sm">Remove {c.name} and its saved history?</p><div className="flex gap-2"><Button variant="outline" size="sm" onClick={onRemoveCancel}>Keep character</Button><Button variant="destructive" size="sm" disabled={disabled} onClick={onRemove}>Remove character</Button></div></div>}
    </section>
    <AionChecklistPanel character={c} knowledge={knowledge} now={now} readFailed={readFailed} disabled={disabled} busy={busy} onToggle={onChecklist} />
    <section className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/6 via-card/85 to-card/65 p-5 shadow-sm sm:p-6" aria-labelledby="aion-priority-title"><div className="mb-4 flex items-center gap-2"><Sparkles className="size-4 text-primary" /><h3 id="aion-priority-title" className="font-display text-base font-semibold">What to work on next</h3></div>
      {held && <p className="text-sm leading-relaxed text-muted-foreground">{held}</p>}
      {!held && c.recommendations.length === 0 && <p className="text-sm leading-relaxed text-muted-foreground">No applicable recommendations are available from the reviewed rules and this snapshot.</p>}
      {!held && <div className="space-y-3">{c.recommendations.map((r, i) => <RecommendationPlan key={r.id} recommendation={r} order={i} />)}</div>}
      {!held && !!c.boardPlans?.length && <Button variant="outline" size="sm" className="mt-4" onClick={() => { setView("boards"); detailsPanel.current?.scrollIntoView?.({ block: "start" }); }}>Compare Daevanion<ArrowRight className="size-3.5" /></Button>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Recommendations use the public snapshot and the linked guides. Quest completion, currencies, inventory and daily entries are not available from the armory.</p>
    </section>
    <OdyleResources key={`${c.id}:${c.resources?.updatedAt}:${c.resources?.odyleEnergy}`} value={c.resources?.odyleEnergy ?? null} updatedAt={c.resources?.updatedAt ?? null} now={now} disabled={disabled} busy={busy} onSave={onResources} />
    <Progress history={c.history} />
    {s && <section ref={detailsPanel} className="scroll-mt-24 overflow-hidden rounded-2xl border border-[var(--chart-2)]/20 bg-card/80 shadow-sm"><div className="flex flex-wrap items-center gap-1 border-b border-[var(--chart-2)]/15 bg-[var(--chart-2)]/5 p-2" role="group" aria-label="Character details">{["gear", "skills", "boards"].map(v => <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={cn("rounded-lg px-4 py-2 text-sm capitalize transition-colors focus-visible:outline-2 focus-visible:outline-ring", view === v ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted/40")}>{v}</button>)}</div><div className="p-4 sm:p-5">{view === "gear" ? <Gear snapshot={s} report={c.gearPriorities} holdReason={held} /> : view === "skills" ? <Skills snapshot={s} /> : s.coverage.boards ? <AionBoards boards={s.boards} characterClass={s.profile.className} plans={held ? undefined : c.boardPlans} planNotice={held} /> : <Unavailable subject="Daevanion boards" />}</div></section>}
    {!held && <Routine />}
  </div>;
}

function RecommendationPlan({ recommendation: r, order }: { recommendation: AionRecommendation; order: number }) {
  const linked = r.steps?.filter(step => step.reportedDone !== undefined) ?? [];
  const nextResource = linked.find(step => step.reportedDone === false);
  const accent = r.priority === "high" ? "var(--chart-5)" : r.priority === "medium" ? "var(--chart-2)" : "var(--chart-3)";
  return <article className="rounded-xl border border-l-[3px] p-4 shadow-sm sm:p-5" style={{ borderColor: `color-mix(in oklab, ${accent} 32%, var(--border))`, borderLeftColor: accent, background: `linear-gradient(120deg, color-mix(in oklab, ${accent} 7%, transparent), transparent 70%), var(--background)` }}>
    <div className="flex items-start gap-3"><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold text-foreground" style={{ background: `color-mix(in oklab, ${accent} 20%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accent} 25%, transparent)` }}>{order + 1}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{r.title}</h4><span className="rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground" style={{ background: `color-mix(in oklab, ${accent} 14%, transparent)` }}>{r.priority} priority</span></div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.evidence}</p><p className="mt-2 text-sm leading-relaxed">{r.action}</p></div></div>
    {linked.length > 0 && <p className="mt-3 rounded-lg border border-[var(--chart-2)]/20 bg-[var(--chart-2)]/5 px-3 py-2 text-xs leading-relaxed">{nextResource ? <><span className="font-semibold">Next resource check:</span> {nextResource.title}</> : "Linked activities reported done. Continue the upgrade steps and verify the actual result in game."}</p>}
    {!!r.steps?.length && <details open={order === 0} className="mt-4 border-t border-border/60 pt-3"><summary className="cursor-pointer text-xs font-semibold text-primary">Follow this plan <span className="font-normal text-muted-foreground">({r.steps.length} steps)</span></summary><ol aria-label={`${r.title} steps`} className="mt-4 space-y-4">{r.steps.map((step, index) => <li key={step.id} className="flex gap-3"><span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]", step.reportedDone ? "border-[var(--chart-4)]/30 bg-[var(--chart-4)]/12 text-foreground" : "border-border text-muted-foreground")}>{step.reportedDone ? <Check className="size-3" aria-hidden /> : index + 1}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h5 className="text-sm font-semibold">{step.title}</h5>{step.reportedDone && <span className="rounded-md border border-[var(--chart-4)]/20 bg-[var(--chart-4)]/10 px-1.5 py-0.5 text-[10px] text-foreground">Activity reported done</span>}{step.cost && <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{number(step.cost.amount)} Odyle</span>}{step.status && step.status !== "ready" && <span className="text-[10px] font-medium text-muted-foreground">{step.status === "blocked" ? "Prerequisite" : "Check in game"}</span>}</div><p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{step.instruction}</p>{step.progressNote && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.progressNote}</p>}{step.reason && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Why this step?</summary><p className="mt-1.5 leading-relaxed">{step.reason}</p></details>}{step.source && <a href={step.source} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Step source<ExternalLink className="size-2.5" /></a>}</div></li>)}</ol></details>}
    {r.budget && <div className="mt-4 rounded-lg border border-border/60 bg-card/50 px-3 py-2.5 text-xs leading-relaxed"><p className="flex items-center gap-1.5 font-medium"><Zap className="size-3" />Odyle planning</p>{r.budget.costPerRun === null ? <p className="mt-1 text-muted-foreground">The current reward cost is unconfirmed. Check it in game before claiming rewards.</p> : <p className="mt-1 text-muted-foreground">{number(r.budget.costPerRun)} Odyle per reward claim. {r.budget.available === null || r.budget.affordableRuns === null ? "Follow the plan’s in-game balance check; entering a balance here is optional." : `Based on your last entry of ${number(r.budget.available)}: ${number(r.budget.affordableRuns)} reward claims at this cost.`}</p>}{r.budget.updatedAt && <p className="mt-1 text-[10px] text-muted-foreground">Balance entered {date(r.budget.updatedAt)}; spending and recharge since then are not tracked.</p>}</div>}
    {r.evidenceSources?.length ? <details className="mt-3 border-t border-border/50 pt-3"><summary className="cursor-pointer text-xs font-medium text-primary">Sources for this plan ({r.evidenceSources.length})</summary><EvidenceLinks sources={r.evidenceSources} /></details> : <a href={r.source} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">Review source<ExternalLink className="size-3" /></a>}
    {!!r.relatedEvidence?.length && <details className="mt-3 border-t border-border/50 pt-3"><summary className="cursor-pointer text-xs font-medium text-primary">Related reviewed explanations ({r.relatedEvidence.length})</summary><div className="mt-3 space-y-3">{r.relatedEvidence.map(item => <article key={item.id} className="rounded-lg bg-card/50 p-3"><h5 className="text-xs font-semibold">{item.title}</h5><p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{item.text}</p><EvidenceLinks sources={item.sources} /></article>)}</div></details>}
  </article>;
}

function EvidenceLinks({ sources }: { sources: AionEvidenceSource[] }) {
  const kinds: Record<string, string> = { "official-api": "Official API", "community-guide": "Community guide", "client-data": "Game data reference", "client-data-reference": "Game data reference", "community-observation": "Community observation" };
  return <ul className="mt-3 space-y-2">{sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">{source.title}<ExternalLink className="size-2.5 shrink-0" /></a><p className="mt-0.5 text-[10px] text-muted-foreground">{kinds[source.kind] ?? source.kind.replace(/[-_]/g, " ")} · Reviewed <time dateTime={source.reviewedAt}>{source.reviewedAt.slice(0,10)}</time></p></li>)}</ul>;
}

function OdyleResources({ value, updatedAt, now, disabled, busy, onSave }: { value: number | null; updatedAt: string | null; now: number; disabled: boolean; busy: boolean; onSave: (value: number | null) => void }) {
  const [input, setInput] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  const old = !!updatedAt && (now - Date.parse(updatedAt) > 30 * 60_000 || now - Date.parse(updatedAt) < -5 * 60_000);
  function save(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const text = input.trim();
    if (text && (!/^\d{1,5}$/.test(text) || Number(text) > 10_000)) { setError("Enter a whole number between 0 and 10,000, or leave it blank to clear."); return; }
    setError(null); onSave(text === "" ? null : Number(text));
  }
  return <details className="rounded-2xl border border-border/70 bg-card/45 px-5 py-4 sm:px-6"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium"><span className="flex items-center gap-2"><Zap className="size-4 text-primary" />Optional Odyle budget</span><span className="text-xs font-normal text-muted-foreground">{value === null ? "No balance entered" : `Last entry: ${number(value)}`}</span></summary><div className="mt-4"><p className="text-xs leading-relaxed text-muted-foreground">The plans above work without entering a balance. Add the amount shown in game if you want a reward-claim estimate. The public armory cannot read your energy.</p>{updatedAt && <p className="mt-2 text-xs text-muted-foreground">Manually entered {date(updatedAt)}.{old ? " This entry is old; check your balance in game before using it." : " Spending and recharge since this entry are not tracked."}</p>}<form aria-label="Odyle budget" onSubmit={save} className="mt-4 flex flex-wrap items-end gap-3"><label className="block min-w-40 flex-1 space-y-1.5"><span className="text-xs text-muted-foreground">Odyle shown in game</span><Input type="number" inputMode="numeric" min={0} max={10_000} step={1} value={input} onChange={event => { setInput(event.target.value); setError(null); }} disabled={disabled} aria-label="Odyle shown in game" placeholder="Unknown" className="h-10 max-w-xs bg-background" /></label><Button type="submit" variant="outline" className="h-10" disabled={disabled}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Save balance</Button></form><p className="mt-2 text-[11px] text-muted-foreground">Leave blank and save to clear your entry.</p>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div></details>;
}

function Metric({ label, value, tone }: { label: string; value: number | null | undefined; tone: "power" | "gear" }) {
  const accent = tone === "power" ? "var(--chart-5)" : "var(--chart-2)";
  const Icon = tone === "power" ? Swords : Shield;
  return <div className="relative overflow-hidden rounded-xl border p-4 shadow-sm" style={{ borderColor: `color-mix(in oklab, ${accent} 30%, var(--border))`, background: `radial-gradient(ellipse at 100% 0%, color-mix(in oklab, ${accent} 22%, transparent), transparent 80%), var(--background)` }}><Icon aria-hidden className="absolute -right-2 -bottom-2 size-16 opacity-[0.08]" style={{ color: accent }} /><p className="relative mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="size-3.5" aria-hidden style={{ color: `color-mix(in oklab, ${accent} 35%, var(--foreground))` }} />{label}</p><p className={cn("relative font-display font-semibold tabular-nums tracking-tight", value == null ? "text-sm text-muted-foreground" : "text-3xl")}>{number(value)}</p><div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} /></div>;
}

function Progress({ history }: { history: AionHistoryPoint[] }) {
  const [metric, setMetric] = useState<"combatPower" | "gearScore">("combatPower");
  const points = history.filter(p => p[metric] !== null).slice().sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const values = points.map(p => p[metric] as number);
  const low = Math.min(...values), high = Math.max(...values);
  const start = points.length ? Date.parse(points[0].observedAt) : 0, end = points.length ? Date.parse(points[points.length - 1].observedAt) : 0;
  const xy = points.map(p => `${30 + ((Date.parse(p.observedAt) - start) / (end - start || 1)) * 640},${high === low ? 90 : 145 - (((p[metric] as number) - low) / (high - low)) * 110}`);
  const delta = values.length > 1 ? values[values.length - 1] - values[0] : null;
  return <section className="rounded-2xl border border-[var(--chart-2)]/20 bg-gradient-to-br from-[var(--chart-2)]/6 via-card/80 to-card/65 p-5 shadow-sm sm:p-6" aria-labelledby="aion-history-title"><div className="flex flex-wrap items-center justify-between gap-3"><h3 id="aion-history-title" className="flex items-center gap-2 font-display text-base font-semibold"><TrendingUp className="size-4 text-primary" />Progress history</h3><div className="flex rounded-lg border border-border p-0.5">{(["combatPower", "gearScore"] as const).map(v => <button key={v} onClick={() => setMetric(v)} aria-pressed={metric === v} className={cn("rounded-md px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring", metric === v ? "bg-primary/10 text-primary" : "text-muted-foreground")}>{v === "combatPower" ? "Combat Power" : "Gear Score"}</button>)}</div></div>
    {points.length < 2 ? <p className="py-8 text-center text-sm leading-relaxed text-muted-foreground">{points.length === 1 ? "First snapshot recorded. Your progression chart will appear after a later change." : "No history for this metric yet."}</p> : <><div className="mt-4 flex items-baseline gap-2"><span className="font-display text-2xl font-semibold tabular-nums">{number(values[values.length - 1])}</span><span className={cn("text-xs tabular-nums", (delta ?? 0) >= 0 ? "text-primary" : "text-muted-foreground")}>{(delta ?? 0) > 0 ? "+" : ""}{number(delta)} since first saved point</span></div><svg viewBox="0 0 700 170" role="img" aria-label={`${metric === "combatPower" ? "Combat Power" : "Gear Score"} history: ${number(values[0])} to ${number(values[values.length - 1])}`} className="mt-2 h-36 w-full overflow-visible"><path d="M30 35H670M30 90H670M30 145H670" stroke="var(--border)" strokeWidth="1" strokeDasharray="3 6" opacity="0.6" /><polyline fill="none" stroke={metric === "combatPower" ? "color-mix(in oklab, var(--chart-5) 70%, var(--foreground))" : "var(--chart-2)"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={xy.join(" ")} />{xy.map((p, i) => <circle key={`${p}-${i}`} cx={p.split(",")[0]} cy={p.split(",")[1]} r="3" fill={metric === "combatPower" ? "color-mix(in oklab, var(--chart-5) 70%, var(--foreground))" : "var(--chart-2)"}><title>{date(points[i].observedAt)}: {number(values[i])}</title></circle>)}</svg><div className="flex justify-between gap-4 font-mono text-[10px] text-muted-foreground"><span>{date(points[0].observedAt)}</span><span>{date(points[points.length - 1].observedAt)}</span></div><details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">View history values</summary><div className="mt-2 max-h-48 overflow-auto"><table className="w-full text-left"><thead><tr><th className="py-1 font-medium">Observed</th><th className="py-1 text-right font-medium">Value</th></tr></thead><tbody>{points.map(p => <tr key={p.observedAt}><td className="py-1">{date(p.observedAt)}</td><td className="text-right tabular-nums">{number(p[metric])}</td></tr>)}</tbody></table></div></details></>}
    <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">History starts when you add a character. Saved points reflect observed changes; they do not reconstruct earlier play sessions.</p>
  </section>;
}

function Gear({ snapshot: s, report, holdReason }: { snapshot: AionSnapshot; report?: AionTrackedCharacter["gearPriorities"]; holdReason?: string | null }) {
  if (!s.coverage.equipment) return <Unavailable subject="Equipment" />;
  return <AionGearPriorities snapshot={s} report={report} holdReason={holdReason} />;
}
function Skills({ snapshot: s }: { snapshot: AionSnapshot }) {
  if (!s.coverage.skills) return <Unavailable subject="Skills" />;
  return <div className="space-y-5">{[...new Set(s.skills.map(k => k.category))].map(category => <div key={category}><h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{category === "Dp" ? "Stigma" : category}</h4><div className="grid gap-2 sm:grid-cols-2">{s.skills.filter(k => k.category === category).map(k => <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2.5"><div className="flex min-w-0 items-center gap-2.5"><AionAsset src={k.icon} alt={`${k.name} icon`} size={32} className="rounded-lg" /><div><p className="text-sm font-medium">{k.name}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{!k.acquired ? "Not acquired" : k.equipped ? "Equipped" : category === "Passive" ? "Passive" : "Not equipped"}</p></div></div><span className="font-mono text-xs text-primary">Lv. {k.level}</span></div>)}</div></div>)}{s.skills.length === 0 && <p className="text-sm text-muted-foreground">No skills were returned.</p>}</div>;
}
function Unavailable({ subject }: { subject: string }) { return <p className="py-5 text-sm text-muted-foreground">{subject} could not be read from this public snapshot.</p>; }
function Routine() {
  return <details className="rounded-2xl border border-border/70 bg-card/65 p-5 sm:p-6"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-display text-base font-semibold"><span className="flex items-center gap-2"><BookOpen className="size-4 text-primary" />Activity guide</span><ChevronRight className="size-4 text-muted-foreground" /></summary><div className="mt-5 grid gap-5 text-sm sm:grid-cols-2"><div><h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Daily / recharging</h4><ul className="space-y-2 text-muted-foreground"><li>Check available Duty Missions</li><li>Use Nightmare and Shugo rewards before entries cap</li><li>Review your Odyle and available dungeon rewards</li></ul></div><div><h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Weekly</h4><ul className="space-y-2 text-muted-foreground"><li>Check remaining dungeon entries</li><li>Review Command Missions</li><li>Complete available Ascension Trials</li></ul></div></div><p className="mt-5 text-xs leading-relaxed text-muted-foreground">Check current entry limits and completion in game. These are reminders, not a record of what your character has finished.</p><div className="mt-4 flex flex-wrap gap-4">{[{ label: "Content guide", href: AION_GUIDE_SOURCES.content }, { label: "Character progression", href: AION_GUIDE_SOURCES.bible }].map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">{l.label}<ArrowRight className="size-3" /></a>)}</div></details>;
}
