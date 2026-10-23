import { aionServers } from "@/lib/aion2-api";
import { isAionRegion, type AionRegion } from "@/lib/aion2-types";

/** Community observations are not official boss liveness or a guaranteed spawn. */
export type AionBossReport = {
  name: string;
  estimatedSpawnAt: string | null;
  lastKilledAt: string | null;
  reportedAt: string | null;
  fetchedAt: string;
  source: string;
  provider: "aion2timers.com";
  status: "reported-dead" | "reported-alive" | "unknown";
  serverId: number;
  serverName: string;
  region: AionRegion;
};
export type AionBossReportResult = { report: AionBossReport | null; checkedAt: string; error?: string };

const ORIGIN = "https://www.aion2timers.com";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_BYTES = 1024 * 1024;
const PROVIDER_REGION: Record<AionRegion, string> = { eu: "EU", nae: "NAE", naw: "NAW", la: "SA", as: "JP" };
const CYCLE_REGION: Record<AionRegion, string> = { eu: "eu", nae: "na", naw: "na", la: "sa", as: "asia" };
type JsonObject = Record<string, unknown>;
type Metadata = { servers: JsonObject; bosses: JsonObject; cycles: JsonObject };
type Mapping = { alias: string; name: string; bossId: string; bossName: string };
type Entry = {
  mapping?: Mapping | null; mappingUntil?: number;
  report: AionBossReport | null; error?: string; until: number;
  pending?: Promise<AionBossReportResult>;
};
type ReportState = {
  entries: Map<string, Entry>;
  metadata?: Metadata; metadataUntil: number; metadataRetryAt: number;
  metadataPending?: Promise<Metadata>;
};
const globals = globalThis as typeof globalThis & { __aion2BossReports?: ReportState };
const state: ReportState = globals.__aion2BossReports ??= { entries: new Map(), metadataUntil: 0, metadataRetryAt: 0 };

class ReportError extends Error {
  constructor(message: string, public discardReport = false) { super(message); }
}
function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function object(value: unknown): JsonObject {
  const result = record(value);
  if (!result) throw new ReportError("The community boss service returned invalid data.");
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 5000) throw new ReportError("The community boss service returned invalid metadata.");
  return value;
}
function normalizedName(value: unknown): string {
  return typeof value === "string" && value.length <= 100 ? value.trim().normalize("NFKC").toLowerCase() : "";
}
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ReportError("The community boss service took too long to respond."));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ReportError("The community boss service took too long to respond."));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function publicJson(path: "/servers.json" | "/bosses.json" | "/api/fieldboss.php", signal: AbortSignal, params?: Record<string, string>): Promise<JsonObject> {
  const url = new URL(path, ORIGIN);
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
  const response = await withDeadline(fetch(url.href, {
    signal, redirect: "error", cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  }), signal);
  if (!response.ok) {
    throw new ReportError(response.status === 404 ? "No community boss report is available for this server. Use a manual kill time." : "The community boss service is temporarily unavailable.", response.status === 404);
  }
  if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "")) throw new ReportError("The community boss service returned a page instead of data.");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new ReportError("The community boss response is too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new ReportError("The community boss service returned an empty response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await withDeadline(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new ReportError("The community boss response is too large.");
      chunks.push(part.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ReportError("The community boss service returned invalid JSON."); }
    return object(parsed);
  } finally { void reader.cancel().catch(() => {}); }
}

async function metadata(signal: AbortSignal): Promise<Metadata> {
  if (state.metadata && state.metadataUntil > Date.now()) return state.metadata;
  if (state.metadataPending) return withDeadline(state.metadataPending, signal);
  if (state.metadataRetryAt > Date.now()) throw new ReportError("The community server mapping is temporarily unavailable. Use a manual kill time.");
  const pending = (async () => {
    const [servers, bosses, cycles] = await Promise.all([
      publicJson("/servers.json", signal), publicJson("/bosses.json", signal),
      publicJson("/api/fieldboss.php", signal, { action: "cycles" }),
    ]);
    list(servers.regions); list(bosses.field);
    if (cycles.ok !== true) throw new ReportError("The community boss metadata could not be verified.");
    object(cycles.regions);
    const value = { servers, bosses, cycles };
    state.metadata = value;
    state.metadataUntil = Date.now() + DAY;
    return value;
  })();
  state.metadataPending = pending;
  try { return await pending; }
  catch (error) { state.metadataRetryAt = Date.now() + MINUTE; throw error; }
  finally { state.metadataPending = undefined; }
}

async function mapping(region: AionRegion, serverId: number, signal: AbortSignal): Promise<Mapping | null> {
  const [official, data] = await Promise.all([withDeadline(aionServers(region), signal), metadata(signal)]);
  const server = official.find((value) => value.id === serverId);
  if (!server || (server.race !== 1 && server.race !== 2)) return null;
  const providerRegions = list(data.servers.regions).map(record).filter((value) => value?.id === PROVIDER_REGION[region]);
  if (providerRegions.length !== 1) return null;
  const candidates = list(providerRegions[0]!.servers).map(record).filter((value) => value?.sid === serverId);
  if (candidates.length !== 1) return null;
  const provider = candidates[0]!;
  if (provider.race !== server.race || normalizedName(provider.en) !== normalizedName(server.name) || typeof provider.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(provider.id)) return null;
  const faction = server.race === 2 ? "asmo" : "elyos";
  const bossName = server.race === 2 ? "Immortal Gartua" : "Eternal Gartua";
  // Resolve the opaque provider key through its boss names and NPC metadata.
  // No alias or twelve-hour period is manufactured from a character/server ID.
  const bosses = list(data.bosses.field).map(record).filter((value) => value?.faction === faction && value.en === bossName);
  if (bosses.length !== 1 || typeof bosses[0]!.id !== "string" || !/^[a-z0-9_-]{1,50}$/.test(bosses[0]!.id)) return null;
  const bossId = bosses[0]!.id;
  const cycles = record(record(data.cycles.regions)?.[CYCLE_REGION[region]]);
  const cycle = record(cycles?.[bossId]);
  const npc = server.race === 2 ? "2400800" : "2101074";
  if (!cycle || !Array.isArray(cycle.npcs) || !cycle.npcs.includes(npc)) return null;
  return { alias: provider.id, name: server.name, bossId, bossName };
}

function epoch(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000) throw new ReportError("The community boss report has an invalid timestamp.");
  return value * 1000;
}
function timestamp(value: number | null) { return value === null ? null : new Date(value).toISOString(); }
function ageSafe(report: AionBossReport, now: number): AionBossReport {
  const reported = report.reportedAt === null ? null : Date.parse(report.reportedAt);
  const killed = report.lastKilledAt === null ? null : Date.parse(report.lastKilledAt);
  const spawn = report.estimatedSpawnAt === null ? null : Date.parse(report.estimatedSpawnAt);
  const tooOld = reported === null || now - reported > DAY || (report.status === "reported-dead" && (killed === null || now - killed > DAY));
  const elapsed = spawn !== null && spawn <= now;
  return { ...report,
    status: tooOld || elapsed || (report.status === "reported-alive" && now - reported! > 30 * MINUTE) ? "unknown" : report.status,
    estimatedSpawnAt: tooOld || elapsed ? null : report.estimatedSpawnAt,
  };
}

function normalizeFeed(feed: JsonObject, chosen: Mapping, region: AionRegion, serverId: number): AionBossReport | null {
  const now = Date.now();
  if (feed.ok !== true) throw new ReportError("The community boss report could not be verified.");
  const feedNow = epoch(feed.now);
  if (feedNow === null || Math.abs(feedNow - now) > 5 * MINUTE) throw new ReportError("The community boss service returned an outdated or future response.");
  const kills = object(feed.kills);
  if (kills[chosen.bossId] === undefined) return null;
  const report = object(kills[chosen.bossId]);
  const killed = epoch(report.t), reported = epoch(report.u), spawn = epoch(report.ns);
  if ((killed !== null && killed > now + 5 * MINUTE) || (reported !== null && reported > now + 5 * MINUTE) || (spawn !== null && (spawn > now + DAY || (killed !== null && spawn <= killed)))) throw new ReportError("The community boss report has an unverified future timestamp.");
  const status = report.st === "dead" ? "reported-dead" : report.st === "up" ? "reported-alive" : "unknown";
  return ageSafe({
    name: chosen.bossName, estimatedSpawnAt: status === "reported-dead" ? timestamp(spawn) : null,
    lastKilledAt: timestamp(killed), reportedAt: timestamp(reported), fetchedAt: new Date(now).toISOString(),
    source: `${ORIGIN}/`, provider: "aion2timers.com", status,
    serverId, serverName: chosen.name, region,
  }, now);
}

/** Fixed public GETs only. Shared cache avoids polling upstream per browser/account. */
export async function aionBossReport(region: AionRegion, serverId: number): Promise<AionBossReportResult> {
  const checkedAt = () => new Date().toISOString();
  if (!isAionRegion(region) || !Number.isSafeInteger(serverId) || serverId < 1 || serverId > 99999) return { report: null, checkedAt: checkedAt(), error: "Choose a supported region and server." };
  const key = `${region}:${serverId}`;
  let entry = state.entries.get(key);
  if (entry?.pending) return entry.pending;
  if (entry && entry.until > Date.now()) return { report: entry.report && ageSafe(entry.report, Date.now()), checkedAt: checkedAt(), ...(entry.error ? { error: entry.error } : {}) };
  if (!entry) {
    if (state.entries.size >= 500) {
      const removable = [...state.entries].find(([, value]) => !value.pending);
      if (!removable) return { report: null, checkedAt: checkedAt(), error: "The community boss service is busy. Try again in a minute." };
      state.entries.delete(removable[0]);
    }
    entry = { report: null, until: 0 };
    state.entries.set(key, entry);
  }
  const current = entry;
  const task = (async (): Promise<AionBossReportResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      if ((current.mappingUntil ?? 0) <= Date.now()) {
        current.mapping = await mapping(region, serverId, controller.signal);
        current.mappingUntil = Date.now() + DAY;
      }
      if (!current.mapping) throw new ReportError("This server has no verified community boss mapping. Use a manual kill time.", true);
      const feed = await publicJson("/api/fieldboss.php", controller.signal, { action: "feed", server: current.mapping.alias });
      current.report = normalizeFeed(feed, current.mapping, region, serverId);
      current.error = current.report ? undefined : "No community Gartua report is available for this server. Use a manual kill time.";
    } catch (error) {
      if (error instanceof ReportError && error.discardReport) current.report = null;
      current.error = error instanceof ReportError ? error.message : "The community boss service could not be reached. Use a manual kill time.";
    } finally {
      clearTimeout(timeout);
      controller.abort();
      current.until = Date.now() + MINUTE;
    }
    return { report: current.report && ageSafe(current.report, Date.now()), checkedAt: checkedAt(), ...(current.error ? { error: current.error } : {}) };
  })();
  current.pending = task;
  try { return await task; } finally { current.pending = undefined; }
}
