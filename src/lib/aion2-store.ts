import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { aionSnapshot, parseAionSnapshot, AionApiError } from "@/lib/aion2-api";
import { aionRecommendations } from "@/lib/aion2-recommendations";
import { aionKnowledgeStatus, refreshAionKnowledgeStatus } from "@/lib/aion2-knowledge";
import { aionBoardPlan } from "@/lib/aion2-board-plan";
import { aionGearPriorities } from "@/lib/aion2-gear-priorities";
import { aionChecklist, aionChecklistPeriod, aionChecklistProgress, aionChecklistScope, type AionChecklistChange } from "@/lib/aion2-checklist";
import { isAionRegion, type AionCharacterList, type AionCharacterRef, type AionSnapshot, type AionTrackedCharacter } from "@/lib/aion2-types";
import type { Aion2Character, Aion2Snapshot } from "@/generated/prisma/client";

export const AION_POLL_INTERVAL_MS = 15 * 60_000;
export const AION_MANUAL_COOLDOWN_MS = 60_000;
const LEASE_MS = 30_000;
const HISTORY_LIMIT = 200;
const HISTORY_DAYS = 30;
const USER_LIMIT = 12;
const TOTAL_LIMIT = 100;

export class AionStoreError extends Error {
  constructor(message: string, public status = 503, public retryAfter?: number) { super(message); }
}

type CachedSnapshot = { value: AionSnapshot; until: number };
type TrackerState = {
  inflight: Map<string, Promise<AionSnapshot>>;
  cache: Map<string, CachedSnapshot>;
  mutationTail: Promise<void>;
  ticking: boolean;
};
const globals = globalThis as typeof globalThis & { __aion2Tracker?: TrackerState };
const state = (globals.__aion2Tracker ??= { inflight: new Map(), cache: new Map(), mutationTail: Promise.resolve(), ticking: false });

/** Serialize collection mutations across Next's route and instrumentation module graphs. */
async function collectionWrite<T>(work: () => Promise<T>): Promise<T> {
  const previous = state.mutationTail;
  let unlock!: () => void;
  state.mutationTail = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  try { return await work(); } finally { unlock(); }
}

function sameRef(a: AionCharacterRef, b: AionCharacterRef) {
  return a.region === b.region && a.serverId === b.serverId && a.characterId === b.characterId;
}

async function observe(ref: AionCharacterRef): Promise<AionSnapshot> {
  const key = `${ref.region}:${ref.serverId}:${ref.characterId}`;
  const now = Date.now();
  for (const [cachedKey, cached] of state.cache) if (cached.until <= now) state.cache.delete(cachedKey);
  const cached = state.cache.get(key);
  if (cached) return cached.value;
  const underway = state.inflight.get(key);
  if (underway) return underway;
  const task = (async () => {
    const snapshot = parseAionSnapshot(await aionSnapshot(ref));
    if (!sameRef(snapshot.ref, ref)) throw new AionStoreError("The armory returned a different character; no snapshot was saved", 502);
    if (state.cache.size >= TOTAL_LIMIT) state.cache.delete(state.cache.keys().next().value!);
    state.cache.set(key, { value: snapshot, until: Date.now() + AION_MANUAL_COOLDOWN_MS });
    return snapshot;
  })();
  state.inflight.set(key, task);
  try { return await task; } finally { state.inflight.delete(key); }
}

function fingerprint(snapshot: AionSnapshot): string {
  // Timestamps describe checking, not character progress. Identical observations do not
  // consume history slots, and lastSuccessAt still advances after a successful check.
  const characterState = { ...snapshot, observedAt: undefined };
  return createHash("sha256").update(JSON.stringify(characterState)).digest("hex");
}

const includeLatestSnapshot = { snapshots: { orderBy: { observedAt: "desc" as const }, take: 1 } };
const historySelection = { observedAt: true, combatPower: true, gearScore: true } as const;
type HistoryPoint = Pick<Aion2Snapshot, "observedAt" | "combatPower" | "gearScore">;
type StoredCharacter = Aion2Character & { snapshots: Aion2Snapshot[]; history?: HistoryPoint[] };

async function project(row: StoredCharacter): Promise<AionTrackedCharacter> {
  if (!isAionRegion(row.region)) throw new AionStoreError("The saved character has an unsupported region");
  const ref: AionCharacterRef = { region: row.region, serverId: row.serverId, characterId: row.characterId };
  let snapshot: AionSnapshot | null = null;
  if (row.snapshots[0]) {
    try { snapshot = parseAionSnapshot(JSON.parse(row.snapshots[0].payloadJson)); }
    catch { throw new AionStoreError("The saved character snapshot could not be verified; refresh it before using recommendations"); }
    if (!sameRef(snapshot.ref, ref)) throw new AionStoreError("The saved snapshot belongs to a different character");
    // An unchanged profile retains its historical checkpoint, but is displayed with the
    // time it was actually last observed rather than the time its values first changed.
    if (row.lastSuccessAt) snapshot = { ...snapshot, observedAt: row.lastSuccessAt.toISOString() };
  }
  const now = new Date();
  const reports = await db.aion2ChecklistCompletion.findMany({ where: { ownerId: row.ownerId, scopeKey: { in: [aionChecklistScope(ref, "server"), aionChecklistScope(ref, "character")] }, periodKey: { in: [aionChecklistPeriod("daily", now).periodKey, aionChecklistPeriod("weekly", now).periodKey] } } });
  const checklist = aionChecklist(ref, reports, now, aionKnowledgeStatus(now).status === "current", snapshot?.profile);
  return {
    id: row.id, ...ref, name: row.name, serverName: row.serverName, tracking: row.tracking,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    nextRefreshAt: row.nextRefreshAt.toISOString(), lastError: row.lastError,
    resources: { odyleEnergy: row.odyleEnergy, updatedAt: row.resourcesUpdatedAt?.toISOString() ?? null },
    snapshot,
    gearPriorities: aionGearPriorities(row.lastError ? null : snapshot),
    checklist,
    boardPlans: snapshot && !row.lastError ? aionBoardPlan(snapshot) : [],
    history: [...(row.history ?? row.snapshots)].reverse().map((point) => ({ observedAt: point.observedAt.toISOString(), combatPower: point.combatPower, gearScore: point.gearScore })),
    recommendations: snapshot && !row.lastError ? aionChecklistProgress(aionRecommendations(snapshot, { odyleEnergy: row.odyleEnergy, resourcesUpdatedAt: row.resourcesUpdatedAt?.toISOString() ?? null }), checklist) : [],
  };
}

async function owned(ownerId: string, id: string) {
  const row = await db.aion2Character.findFirst({ where: { id, ownerId }, include: includeLatestSnapshot });
  if (!row) throw new AionStoreError("This character is not in your tracked list", 404);
  const history = await db.aion2Snapshot.findMany({ where: { characterId: id }, orderBy: { observedAt: "desc" }, take: HISTORY_LIMIT, select: historySelection });
  return { ...row, history };
}

export async function listAionCharacters(ownerId: string): Promise<AionCharacterList> {
  const rows = await db.aion2Character.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" }, take: USER_LIMIT, include: includeLatestSnapshot });
  const history = await db.aion2Snapshot.findMany({ where: { characterId: { in: rows.map((row) => row.id) } }, orderBy: { observedAt: "desc" }, take: USER_LIMIT * HISTORY_LIMIT, select: { ...historySelection, characterId: true } });
  return { characters: await Promise.all(rows.map((row) => project({ ...row, history: history.filter((point) => point.characterId === row.id).slice(0, HISTORY_LIMIT) }))), pollIntervalMs: AION_POLL_INTERVAL_MS, checkedAt: new Date().toISOString() };
}

export async function setAionChecklist(ownerId: string, id: string, change: AionChecklistChange): Promise<AionTrackedCharacter> {
  if (!change || typeof change.activityId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(change.activityId)
    || typeof change.completed !== "boolean" || typeof change.periodKey !== "string" || change.periodKey.length > 64
    || typeof change.revision !== "string" || !/^[a-f0-9]{64}$/.test(change.revision)) throw new AionStoreError("Send the activity and current reset revision shown by the helper", 400);
  await owned(ownerId, id);
  await refreshAionKnowledgeStatus();
  return collectionWrite(async () => {
    await db.$transaction(async (tx) => {
      const row = await tx.aion2Character.findFirst({ where: { id, ownerId }, include: includeLatestSnapshot });
      if (!row) throw new AionStoreError("This character is not in your tracked list", 404);
      if (!isAionRegion(row.region)) throw new AionStoreError("The saved character has an unsupported region", 409);
      const ref = { region: row.region, serverId: row.serverId, characterId: row.characterId };
      const now = new Date();
      const scopes = [aionChecklistScope(ref, "server"), aionChecklistScope(ref, "character")];
      const reports = await tx.aion2ChecklistCompletion.findMany({ where: { ownerId, scopeKey: { in: scopes }, periodKey: { in: [aionChecklistPeriod("daily", now).periodKey, aionChecklistPeriod("weekly", now).periodKey] } } });
      let profile: AionSnapshot["profile"] | undefined;
      try { if (row.snapshots[0]) profile = parseAionSnapshot(JSON.parse(row.snapshots[0].payloadJson)).profile; } catch {}
      const current = aionChecklist(ref, reports, now, aionKnowledgeStatus(now).status === "current", profile);
      if (current.status !== "current") throw new AionStoreError("The activity review is not current; reload before changing reset progress", 409);
      const activity = current.items.find((item) => item.id === change.activityId);
      if (!activity) throw new AionStoreError("This activity is not available in the reviewed character checklist", 400);
      if (change.periodKey !== activity.periodKey) throw new AionStoreError("This activity has reset; reload its current period before changing progress", 409);
      if (change.revision !== current.revision) throw new AionStoreError("Reset progress changed in another view; reload before trying again", 409);
      const scopeKey = aionChecklistScope(ref, activity.scope);
      const identity = { ownerId, scopeKey, activityId: activity.id, periodKey: activity.periodKey };
      const previous = reports.find((report) => report.scopeKey === scopeKey && report.activityId === activity.id && report.periodKey === activity.periodKey);
      const completedAt = change.completed ? (previous?.completedAt ?? now) : null;
      const saved = await tx.aion2ChecklistCompletion.upsert({
        where: { ownerId_scopeKey_activityId_periodKey: identity },
        create: { ...identity, completedAt },
        update: previous?.completedAt?.getTime() === completedAt?.getTime() ? {} : { completedAt, revision: { increment: 1 } },
      });
      if (saved.completedAt?.getTime() !== completedAt?.getTime()) throw new AionStoreError("The activity report could not be verified after saving");
      const readback = await tx.aion2ChecklistCompletion.findUnique({ where: { ownerId_scopeKey_activityId_periodKey: identity } });
      if (!readback || readback.revision !== saved.revision || readback.completedAt?.getTime() !== completedAt?.getTime()) throw new AionStoreError("The saved reset progress could not be read back");
      // Old reports have no effect on the current period; retain a bounded recent history.
      await tx.aion2ChecklistCompletion.deleteMany({ where: { ownerId, updatedAt: { lt: new Date(now.getTime() - 35 * 86_400_000) } } });
    });
    const result = await project(await owned(ownerId, id));
    const confirmed = result.checklist?.items.find((item) => item.id === change.activityId);
    if (!confirmed || confirmed.periodKey !== change.periodKey || confirmed.completed !== change.completed) throw new AionStoreError("The activity period changed while saving; reload current progress", 409);
    return result;
  });
}

export async function addAionCharacter(ownerId: string, ref: AionCharacterRef): Promise<AionTrackedCharacter> {
  const previous = await db.aion2Character.findFirst({ where: { ownerId, ...ref }, select: { id: true } });
  if (previous) return project(await owned(ownerId, previous.id));
  // Do not leave an unverified placeholder after a failed public lookup.
  const snapshot = await observe(ref);
  return collectionWrite(async () => {
    const existing = await db.aion2Character.findFirst({ where: { ownerId, ...ref }, select: { id: true } });
    if (existing) return project(await owned(ownerId, existing.id));
    const observedAt = new Date(snapshot.observedAt);
    const id = await db.$transaction(async (tx) => {
      const personalCount = await tx.aion2Character.count({ where: { ownerId } });
      const totalCount = await tx.aion2Character.count();
      if (personalCount >= USER_LIMIT) throw new AionStoreError(`You can track up to ${USER_LIMIT} characters`, 409);
      if (totalCount >= TOTAL_LIMIT) throw new AionStoreError("The tracker has reached its character capacity", 409);
      const row = await tx.aion2Character.create({
        data: {
          ownerId, ...ref, name: snapshot.profile.name, serverName: snapshot.profile.serverName,
          lastAttemptAt: observedAt, lastSuccessAt: observedAt, nextRefreshAt: new Date(Date.now() + AION_POLL_INTERVAL_MS),
          snapshots: { create: { observedAt, fingerprint: fingerprint(snapshot), payloadJson: JSON.stringify(snapshot), combatPower: snapshot.profile.combatPower, gearScore: snapshot.profile.gearScore } },
        },
      });
      return row.id;
    });
    const saved = await owned(ownerId, id);
    if (!saved.snapshots[0] || saved.snapshots[0].fingerprint !== fingerprint(snapshot)) throw new AionStoreError("The new character could not be verified after saving");
    return project(saved);
  });
}

export async function setAionTracking(ownerId: string, id: string, tracking: boolean): Promise<AionTrackedCharacter> {
  await owned(ownerId, id);
  await db.aion2Character.updateMany({ where: { id, ownerId }, data: { tracking } });
  const saved = await owned(ownerId, id);
  if (saved.tracking !== tracking) throw new AionStoreError("The tracking preference could not be verified");
  return project(saved);
}

export async function setAionResources(ownerId: string, id: string, odyleEnergy: unknown): Promise<AionTrackedCharacter> {
  if (odyleEnergy !== null && (typeof odyleEnergy !== "number" || !Number.isInteger(odyleEnergy) || odyleEnergy < 0 || odyleEnergy > 10_000)) {
    throw new AionStoreError("Enter a whole-number Odyle balance from 0 to 10000, or clear it", 400);
  }
  await owned(ownerId, id);
  const resourcesUpdatedAt = odyleEnergy === null ? null : new Date();
  await db.aion2Character.updateMany({ where: { id, ownerId }, data: { odyleEnergy, resourcesUpdatedAt } });
  const saved = await owned(ownerId, id);
  if (saved.odyleEnergy !== odyleEnergy || saved.resourcesUpdatedAt?.getTime() !== resourcesUpdatedAt?.getTime()) {
    throw new AionStoreError("The manually entered resource balance could not be verified after saving");
  }
  return project(saved);
}

export async function removeAionCharacter(ownerId: string, id: string): Promise<string> {
  await owned(ownerId, id);
  await db.aion2Character.deleteMany({ where: { id, ownerId } });
  if (await db.aion2Character.findFirst({ where: { id, ownerId }, select: { id: true } })) throw new AionStoreError("Removing this character could not be verified");
  return id;
}

export async function refreshAionCharacter(ownerId: string, id: string, manual = true): Promise<AionTrackedCharacter> {
  const row = await owned(ownerId, id);
  const now = new Date();
  if (manual && row.failureCount > 0 && row.nextRefreshAt > now) {
    const seconds = Math.ceil((row.nextRefreshAt.getTime() - now.getTime()) / 1000);
    throw new AionStoreError("The armory refresh is backing off after a failed check; try again at the next refresh time", 429, seconds);
  }
  if (manual && row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < AION_MANUAL_COOLDOWN_MS) {
    const seconds = Math.ceil((AION_MANUAL_COOLDOWN_MS - (now.getTime() - row.lastAttemptAt.getTime())) / 1000);
    throw new AionStoreError(`Please wait ${seconds} seconds before refreshing again`, 429, seconds);
  }
  if (!manual && (!row.tracking || row.nextRefreshAt > now)) return project(row);
  const token = randomUUID();
  const claimed = await db.aion2Character.updateMany({
    where: {
      id, ownerId,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ...(manual ? [{ OR: [{ failureCount: 0 }, { nextRefreshAt: { lte: now } }] }] : []),
        ...(manual ? [{ OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now.getTime() - AION_MANUAL_COOLDOWN_MS) } }] }] : [{ tracking: true, nextRefreshAt: { lte: now } }]),
      ],
    },
    data: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now },
  });
  if (claimed.count !== 1) throw new AionStoreError("This character is already refreshing; try again shortly", 409);
  try {
    if (!isAionRegion(row.region)) throw new AionStoreError("The saved character has an unsupported region");
    const snapshot = await observe({ region: row.region, serverId: row.serverId, characterId: row.characterId });
    const observedAt = new Date(snapshot.observedAt);
    const hash = fingerprint(snapshot);
    await db.$transaction(async (tx) => {
      const current = await tx.aion2Character.findFirst({ where: { id, ownerId, leaseToken: token }, include: { snapshots: { orderBy: { observedAt: "desc" }, take: 1 } } });
      if (!current) throw new AionStoreError("The character changed while refreshing; reload your list", 409);
      if (current.snapshots[0]?.fingerprint !== hash) {
        await tx.aion2Snapshot.create({ data: { characterId: id, observedAt, fingerprint: hash, payloadJson: JSON.stringify(snapshot), combatPower: snapshot.profile.combatPower, gearScore: snapshot.profile.gearScore } });
      }
      const retained = await tx.aion2Snapshot.findMany({ where: { characterId: id }, orderBy: { observedAt: "desc" }, take: HISTORY_LIMIT, select: { id: true } });
      await tx.aion2Snapshot.deleteMany({ where: { characterId: id, OR: [
        { id: { notIn: retained.map((point) => point.id) } },
        { observedAt: { lt: new Date(Date.now() - HISTORY_DAYS * 86_400_000) }, id: { not: retained[0]?.id } },
      ] } });
      const saved = await tx.aion2Character.updateMany({ where: { id, ownerId, leaseToken: token }, data: {
        name: snapshot.profile.name, serverName: snapshot.profile.serverName, lastSuccessAt: observedAt,
        nextRefreshAt: new Date(Date.now() + AION_POLL_INTERVAL_MS), lastError: null, failureCount: 0, leaseToken: null, leaseUntil: null,
      } });
      if (saved.count !== 1) throw new AionStoreError("The refreshed observation could not be published", 409);
    });
    const saved = await owned(ownerId, id);
    if (saved.snapshots[0]?.fingerprint !== hash || saved.lastSuccessAt?.getTime() !== observedAt.getTime()) throw new AionStoreError("The refreshed observation could not be verified after saving");
    return project(saved);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "The public armory could not be checked";
    const failures = Math.min(row.failureCount + 1, 8);
    const upstreamDelay = error instanceof AionApiError ? (error.retryAfter ?? 0) * 1000 : 0;
    const delay = Math.min(2 * 60 * 60_000, Math.max(upstreamDelay, AION_POLL_INTERVAL_MS * 2 ** (failures - 1)));
    await db.aion2Character.updateMany({ where: { id, ownerId, leaseToken: token }, data: {
      lastError: message, failureCount: failures, nextRefreshAt: new Date(Date.now() + delay), leaseToken: null, leaseUntil: null,
    } });
    throw error;
  }
}

/** At most three due public profiles per tick. Never controls a hosted game. */
export async function tickAionTracking(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const due = await db.aion2Character.findMany({
      where: { tracking: true, nextRefreshAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
      orderBy: { nextRefreshAt: "asc" }, take: 3, select: { id: true, ownerId: true },
    });
    if (due.length) await refreshAionKnowledgeStatus();
    for (const character of due) {
      try { await refreshAionCharacter(character.ownerId, character.id, false); }
      catch (error) {
        // The saved error and backoff remain visible on the character card.
        if (!(error instanceof AionStoreError && error.status === 409)) console.warn("[aion2] profile refresh failed");
      }
    }
  } finally { state.ticking = false; }
}
