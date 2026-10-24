import {
  isAionRegion, type AionRegion, type AionServer, type AionSearchCharacter,
  type AionCharacterRef, type AionSnapshot,
} from "./aion2-types";
import { aionWhiteBoardIds } from "./aion2-knowledge-validation";

export class AionApiError extends Error {
  constructor(message: string, public status = 502, public retryAfter?: number) { super(message); }
}

const SITE = "https://aion2.plaync.com";
const SEARCH = "https://api-search.plaync.com";
type CacheEntry = { expires: number; value: unknown };
const globalAion = globalThis as typeof globalThis & {
  __aionHttp?: { active: number; cache: Map<string, CacheEntry>; pending: Map<string, Promise<unknown>> };
};
const state = globalAion.__aionHttp ??= { active: 0, cache: new Map(), pending: new Map() };
const MAX_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value.slice(0, 500) : [];
const clean = (value: unknown, limit = 200): string => typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f]/g, "").slice(0, limit).trim() : "";
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
}
function integer(value: unknown): number | null { const number = numeric(value); return number !== null && Number.isInteger(number) ? number : null; }
function requiredInt(value: unknown, name: string): number { const result = integer(value); if (result === null) throw new AionApiError(`The official armory returned an invalid ${name}`); return result; }
function requiredText(value: unknown, name: string): string { const result = clean(value); if (!result) throw new AionApiError(`The official armory returned an invalid ${name}`); return result; }
function icon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["assets.playnccdn.com", "profileimg.plaync.com"].includes(url.hostname) ? url.href : null; } catch { return null; }
}
export function aionCharacterId(value: unknown): string {
  if (typeof value !== "string" || value.length > 768) throw new AionApiError("Select a character from the search results", 400);
  let id = value;
  for (let attempt = 0; attempt < 2 && id.includes("%"); attempt++) {
    try { id = decodeURIComponent(id); } catch { throw new AionApiError("Invalid character identifier", 400); }
  }
  if (!/^[A-Za-z0-9_-]{8,254}={0,2}$/.test(id)) throw new AionApiError("Invalid character identifier", 400);
  return id;
}
function refValid(ref: AionCharacterRef): AionCharacterRef {
  if (!isAionRegion(ref.region) || !Number.isSafeInteger(ref.serverId) || ref.serverId < 1 || ref.serverId > 99999) throw new AionApiError("Select a valid region and server", 400);
  return { ...ref, characterId: aionCharacterId(ref.characterId) };
}

async function json(url: URL, signal: AbortSignal): Promise<unknown> {
  if (state.active >= 4) throw new AionApiError("Character service is busy. Try again shortly.", 503, 30);
  state.active++;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Yoshling-Aion2/1.0", Referer: `${SITE}/en-us/characters/index` },
      signal, cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      const retry = integer(response.headers.get("retry-after"));
      throw new AionApiError(response.status === 429 ? "The official armory is limiting requests. A later refresh will retry." : response.status === 404 ? "This character is unavailable in the official armory." : "The official armory is temporarily unavailable.", response.status === 404 ? 404 : response.status === 429 ? 429 : 502, response.status === 429 ? Math.min(7200, Math.max(60, retry ?? 300)) : undefined);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw new AionApiError("The official armory returned a page instead of character data.");
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new AionApiError("The official armory response is too large.");
    const reader = response.body?.getReader();
    if (!reader) throw new AionApiError("The official armory returned an empty response.");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw new AionApiError("The official armory response is too large.");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AionApiError("The official armory returned invalid character data."); }
  } catch (error) {
    if (error instanceof AionApiError) throw error;
    throw new AionApiError(signal.aborted ? "The official armory took too long to respond. Try again later." : "The official armory could not be reached.", 503, 60);
  } finally { state.active--; }
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const previous = state.cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.value as T;
  const pending = state.pending.get(key); if (pending) return pending as Promise<T>;
  const promise = load().then((value) => {
    if (state.cache.size >= 100) state.cache.delete(state.cache.keys().next().value!);
    state.cache.set(key, { expires: Date.now() + ttl, value }); return value;
  }).finally(() => { state.pending.delete(key); });
  state.pending.set(key, promise); return promise;
}

export async function aionServers(region: AionRegion): Promise<AionServer[]> {
  if (!isAionRegion(region)) throw new AionApiError("Select a supported region", 400);
  return cached(`servers:${region}`, 24 * 60 * 60 * 1000, async () => {
    const url = new URL("/en-us/api/gameinfo/servers", SITE); url.search = new URLSearchParams({ lang: "en-US", region }).toString();
    const raw = await json(url, AbortSignal.timeout(8000));
    // NC's catalog is grouped by faction; flatten only the documented server records.
    const result: AionServer[] = [];
    function visit(value: unknown, inheritedRace: number | null = null): void {
      if (Array.isArray(value)) { for (const item of value) visit(item, inheritedRace); return; }
      const row = record(value); const id = integer(row.serverId), name = clean(row.serverName);
      const race = integer(row.raceId ?? row.race) ?? inheritedRace;
      if (id && name) { result.push({ id, name, race }); return; }
      for (const [key, child] of Object.entries(row)) if (["list", "serverList", "servers", "raceList"].includes(key)) visit(child, race);
    }
    visit(raw);
    if (!result.length) throw new AionApiError("The official server list is currently unavailable.");
    return [...new Map(result.map((server) => [server.id, server])).values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

export async function aionSearch(region: AionRegion, name: string, serverId?: number): Promise<AionSearchCharacter[]> {
  if (!isAionRegion(region) || typeof name !== "string" || !name.trim() || name.trim().length > 40 || /[\u0000-\u001f]/.test(name)) throw new AionApiError("Enter a character name of up to 40 characters", 400);
  if (serverId !== undefined && (!Number.isSafeInteger(serverId) || serverId < 1 || serverId > 99999)) throw new AionApiError("Select a valid server", 400);
  const query = name.trim();
  return cached(`search:${region}:${serverId ?? "all"}:${query.toLocaleLowerCase()}`, 60_000, async () => {
    const url = new URL("/aion2global/search/v2/character", SEARCH);
    const params = new URLSearchParams({ keyword: query, region, localeInfo: "en-US", page: "1", size: "40" });
    if (serverId !== undefined) params.set("serverId", String(serverId));
    url.search = params.toString();
    const data = record(await json(url, AbortSignal.timeout(8000)));
    if (!Array.isArray(data.list)) throw new AionApiError("The official search returned an invalid result.");
    return data.list.slice(0, 40).map((value) => {
      const row = record(value);
      if (row.region !== undefined && row.region !== region) throw new AionApiError("The official search returned a different region.");
      return { region, serverId: requiredInt(row.serverId, "server"), characterId: aionCharacterId(row.characterId), name: requiredText(row.name, "name"), serverName: requiredText(row.serverName, "server name"), className: clean(row.className) || null, level: integer(row.level) };
    }).filter((row) => serverId === undefined || row.serverId === serverId);
  });
}

export function normalizeAionSnapshot(refInput: AionCharacterRef, infoInput: unknown, equipmentInput: unknown, now = new Date()): AionSnapshot {
  const ref = refValid(refInput), info = record(infoInput), profile = record(info.profile), equip = record(equipmentInput);
  if (aionCharacterId(profile.characterId) !== ref.characterId || integer(profile.serverId) !== ref.serverId) throw new AionApiError("The official armory returned a different character.");
  const gear = record(equip.equipment), skills = record(equip.skill), stats = record(info.stat), boards = record(info.daevanion), petwing = record(equip.petwing);
  if (!Array.isArray(gear.equipmentList) || !Array.isArray(skills.skillList) || !Array.isArray(stats.statList)) throw new AionApiError("The official armory returned an incomplete character profile.");
  const normalizedStats = array(stats.statList).map((v) => { const row = record(v); return { type: clean(row.type), name: clean(row.name), value: numeric(row.value) }; }).filter((row): row is { type: string; name: string; value: number } => !!row.type && row.value !== null);
  const wing = record(petwing.wing), pet = record(petwing.pet);
  return {
    version: 1, ref, observedAt: now.toISOString(),
    profile: { name: requiredText(profile.characterName, "name"), serverName: requiredText(profile.serverName, "server name"), className: requiredText(profile.className, "class"), level: requiredInt(profile.characterLevel, "level"), combatPower: integer(profile.combatPower), gearScore: normalizedStats.find((stat) => stat.type === "ItemLevel")?.value ?? null, portrait: icon(profile.profileImage) },
    equipment: array(gear.equipmentList).map((v) => { const row = record(v); return { id: requiredInt(row.id, "item"), slot: requiredInt(row.slotPos, "equipment slot"), slotName: requiredText(row.slotPosName, "slot name"), name: requiredText(row.name, "item name"), grade: requiredText(row.grade, "item grade"), enchantLevel: requiredInt(row.enchantLevel, "enhancement level"), ampLevel: requiredInt(row.exceedLevel ?? 0, "amplification level"), icon: icon(row.icon) }; }),
    skills: array(skills.skillList).map((v) => { const row = record(v); return { id: requiredInt(row.id, "skill"), name: requiredText(row.name, "skill name"), category: requiredText(row.category, "skill category"), level: requiredInt(row.skillLevel, "skill level"), equipped: row.equip === 1 || row.equip === true, acquired: row.acquired === 1 || row.acquired === true, icon: icon(row.icon) }; }),
    boards: array(boards.boardList).map((v) => { const row = record(v); return { id: requiredInt(row.id, "board"), name: requiredText(row.name, "board name"), openNodes: requiredInt(row.openNodeCount, "board progress"), totalNodes: requiredInt(row.totalNodeCount, "board size") }; }),
    stats: normalizedStats,
    wing: clean(wing.name) ? { name: clean(wing.name), grade: clean(wing.grade), level: integer(wing.enchantLevel) ?? 0 } : null,
    pet: clean(pet.name) ? { name: clean(pet.name), level: integer(pet.level) ?? 0 } : null,
    coverage: { equipment: true, skills: true, boards: Array.isArray(boards.boardList) },
  };
}

export async function aionSnapshot(refInput: AionCharacterRef): Promise<AionSnapshot> {
  const ref = refValid(refInput), signal = AbortSignal.timeout(8000);
  const params = new URLSearchParams({ lang: "en-US", region: ref.region, serverId: String(ref.serverId), characterId: ref.characterId });
  const [info, equipment] = await Promise.all(["info", "equipment"].map((part) => { const url = new URL(`/api/character/${part}`, SITE); url.search = params.toString(); return json(url, signal); }));
  const snapshot = normalizeAionSnapshot(ref, info, equipment);
  // Preserve the critical item and white-board reads before spending the remaining
  // shared deadline on the rest of the equipped gear. Optional failures stay unknown.
  const selected = snapshot.equipment.filter((item) => [1, 2, 13, 14].includes(item.slot));
  const loadItemDetails = async (items: AionSnapshot["equipment"]) => {
    for (let index = 0; index < items.length && !signal.aborted; index += 2) {
      await Promise.all(items.slice(index, index + 2).map(async (item) => {
        try {
          const url = new URL("/api/character/equipment/item", SITE); url.search = params.toString();
          url.searchParams.set("id", String(item.id)); url.searchParams.set("enchantLevel", String(item.enchantLevel)); url.searchParams.set("slotPos", String(item.slot));
          const detail = record(await json(url, signal));
          if (integer(detail.id) !== item.id) return;
          item.details = normalizeItemDetails(detail);
        } catch { /* Optional detail is unknown. Preserve the complete base profile. */ }
      }));
    }
  };
  await loadItemDetails(selected);
  const whiteBoards = snapshot.boards.filter((board) => aionWhiteBoardIds(snapshot.profile.className).includes(board.id));
  for (let index = 0; index < whiteBoards.length && !signal.aborted; index += 2) {
    await Promise.all(whiteBoards.slice(index, index + 2).map(async (board) => {
      try {
        const url = new URL("/api/character/daevanion/detail", SITE); url.search = params.toString(); url.searchParams.set("boardId", String(board.id));
        const detail = record(await json(url, signal));
        if (!Array.isArray(detail.openSkillEffectList)) return;
        if (Array.isArray(detail.nodeList) && detail.nodeList.some(value => integer(record(value).boardId) !== board.id)) return;
        if (Array.isArray(detail.nodeList)) board.nodes = detail.nodeList.slice(0, 250).map((value) => {
          const node = record(value);
          return { id: requiredInt(node.nodeId, "board node"), row: requiredInt(node.row, "node row"), col: requiredInt(node.col, "node column"), name: clean(node.name), kind: clean(node.type), grade: clean(node.grade), unlocked: node.open === 1, effects: array(node.effectList).map((effect) => clean(record(effect).desc)).filter(Boolean), icon: icon(node.icon) };
        }).filter((node) => node.kind !== "None");
        board.skillBonuses = detail.openSkillEffectList.flatMap((value) => {
          const match = clean(record(value).desc).match(/^(.*?)\s*\+(\d+)$/);
          const skill = match && snapshot.skills.find((skill) => skill.name === match[1].trim());
          return skill && match ? [{ id: skill.id, name: skill.name, levels: Number(match[2]) }] : [];
        });
      } catch { /* Never infer missing board detail as zero unlocked skill levels. */ }
    }));
  }
  await loadItemDetails(snapshot.equipment.filter((item) => !selected.includes(item) &&
    (item.slot >= 1 && item.slot <= 24 || item.slot >= 41 && item.slot <= 45)));
  return snapshot;
}

/** Stored JSON is validated at the boundary; never cast malformed persistence into a live card. */
export function parseAionSnapshot(input: unknown): AionSnapshot {
  const data = record(input), ref = record(data.ref), profile = record(data.profile), coverage = record(data.coverage);
  if (data.version !== 1 || typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt)) || !isAionRegion(ref.region) || !Array.isArray(data.equipment) || !Array.isArray(data.skills) || !Array.isArray(data.boards) || !Array.isArray(data.stats) || typeof coverage.equipment !== "boolean" || typeof coverage.skills !== "boolean" || typeof coverage.boards !== "boolean") throw new AionApiError("Saved character data could not be verified", 503);
  const validRef = refValid({ region: ref.region, serverId: requiredInt(ref.serverId, "saved server"), characterId: aionCharacterId(ref.characterId) });
  const snapshot = normalizeAionSnapshot(validRef, {
    profile: { ...profile, characterId: validRef.characterId, serverId: validRef.serverId, characterName: profile.name, characterLevel: profile.level, profileImage: profile.portrait },
    stat: { statList: data.stats },
    daevanion: { boardList: data.boards.map((v) => { const b = record(v); return { ...b, openNodeCount: b.openNodes, totalNodeCount: b.totalNodes }; }) },
  }, {
    equipment: { equipmentList: data.equipment.map((v) => { const e = record(v); return { ...e, slotPos: e.slot, slotPosName: e.slotName, exceedLevel: e.ampLevel }; }) },
    skill: { skillList: data.skills.map((v) => { const s = record(v); return { ...s, skillLevel: s.level, equip: s.equipped }; }) },
    petwing: { wing: data.wing ? { ...record(data.wing), enchantLevel: record(data.wing).level } : null, pet: data.pet },
  }, new Date(data.observedAt));
  if (profile.gearScore !== null && numeric(profile.gearScore) === null || profile.combatPower !== null && numeric(profile.combatPower) === null) throw new AionApiError("Saved character stats could not be verified", 503);
  if (profile.gearScore !== snapshot.profile.gearScore || profile.combatPower !== snapshot.profile.combatPower) throw new AionApiError("Saved character stats disagree with their source values", 503);
  for (const [index, item] of data.equipment.entries()) {
    const details = record(record(item).details);
    if (Object.keys(details).length) snapshot.equipment[index].details = normalizeItemDetails(details, true);
  }
  for (const [index, board] of data.boards.entries()) {
    const bonuses = record(board).skillBonuses;
    if (bonuses !== undefined) {
      if (!Array.isArray(bonuses)) throw new AionApiError("Saved board skill data could not be verified", 503);
      snapshot.boards[index].skillBonuses = bonuses.map((value) => {
        const bonus = record(value);
        return { id: requiredInt(bonus.id, "board skill"), name: requiredText(bonus.name, "board skill name"), levels: requiredInt(bonus.levels, "board skill levels") };
      });
    }
    const nodes = record(board).nodes;
    if (nodes !== undefined) {
      if (!Array.isArray(nodes) || nodes.length > 250) throw new AionApiError("Saved board nodes could not be verified", 503);
      snapshot.boards[index].nodes = nodes.map((value) => {
        const node = record(value);
        if (typeof node.unlocked !== "boolean" || !Array.isArray(node.effects) || node.effects.some((effect) => typeof effect !== "string")) throw new AionApiError("Saved board node effects could not be verified", 503);
        return { id: requiredInt(node.id, "node ID"), row: requiredInt(node.row, "node row"), col: requiredInt(node.col, "node column"), name: clean(node.name), kind: requiredText(node.kind, "node kind"), grade: requiredText(node.grade, "node grade"), unlocked: node.unlocked, effects: node.effects as string[], icon: icon(node.icon) };
      });
    }
  }
  return { ...snapshot, coverage: coverage as AionSnapshot["coverage"] };
}

function normalizeItemDetails(input: unknown, stored = false): NonNullable<AionSnapshot["equipment"][number]["details"]> {
  const detail = record(input);
  return {
    maxEnchantLevel: integer(detail.maxEnchantLevel), maxAmpLevel: integer(stored ? detail.maxAmpLevel : detail.maxExceedEnchantLevel),
    randomStats: typeof (stored ? detail.randomStats : detail.subStatRandom) === "boolean" ? (stored ? detail.randomStats : detail.subStatRandom) as boolean : null,
    bindRate: numeric(stored ? detail.bindRate : detail.soulBindRate),
    stats: array(stored ? detail.stats : detail.subStats).map((value) => {
      const row = record(value);
      const id = typeof row.id === "string" || typeof row.id === "number" ? clean(String(row.id), 128) : "";
      return { ...(id ? { id } : {}), name: clean(row.name), value: clean(String(row.value ?? "")) };
    }).filter((value) => value.name),
    skills: array(stored ? detail.skills : detail.subSkills).map((value) => { const row = record(value); return { id: requiredInt(row.id, "item skill"), name: requiredText(row.name, "item skill name"), level: requiredInt(row.level, "item skill level") }; }),
  };
}
