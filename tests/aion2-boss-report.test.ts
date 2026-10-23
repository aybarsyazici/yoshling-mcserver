import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AionBossReportResult } from "@/lib/aion2-boss-report";

const fixture = vi.hoisted(() => ({ session: null as unknown, servers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: () => fixture.session }));
vi.mock("@/lib/aion2-api", async (original) => ({ ...await original<typeof import("@/lib/aion2-api")>(), aionServers: fixture.servers }));
vi.mock("@/lib/aion2-store", () => ({ AionStoreError: class extends Error {
  constructor(message: string, public status = 503, public retryAfter?: number) { super(message); }
} }));

const NOW = new Date("2026-10-23T13:20:22Z");
const SECOND = Math.floor(NOW.getTime() / 1000);
const fetchMock = vi.fn<typeof fetch>();
type ProviderFixture = {
  servers: { regions: { id: string; servers: { id: string; sid: number; native: string; en: string; race: number }[] }[] };
  bosses: { field: { id: string; faction: string; en: string; cycle: number }[] };
  cycles: { ok: boolean; regions: Record<string, Record<string, { s: number; npcs: string[] }>> };
  feed: { ok: boolean; now: number; kills: Record<string, { t?: number; u?: number; st?: string; ns?: number }> };
};
let provider: ProviderFixture;
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function response(input: string): Response {
  const url = new URL(input);
  if (url.origin !== "https://www.aion2timers.com") throw new Error("Unapproved upstream origin");
  if (url.pathname === "/servers.json") return json(provider.servers);
  if (url.pathname === "/bosses.json") return json(provider.bosses);
  if (url.pathname === "/api/fieldboss.php" && url.searchParams.get("action") === "cycles") return json(provider.cycles);
  if (url.pathname === "/api/fieldboss.php" && url.searchParams.get("action") === "feed") return json(provider.feed);
  throw new Error(`Unexpected path: ${url.pathname}`);
}
function feeds() { return fetchMock.mock.calls.filter(([url]) => new URL(String(url)).searchParams.get("action") === "feed"); }
async function report() { return (await import("@/lib/aion2-boss-report")).aionBossReport("eu", 2322); }
async function route(params = "region=eu&serverId=2322") {
  return (await import("@/app/api/aion2/timers/route")).GET(new Request(`https://yoshling.test/api/aion2/timers?${params}`));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const globals = globalThis as typeof globalThis & { __aion2BossReports?: unknown; __aion2HttpRates?: Map<unknown, unknown> };
  delete globals.__aion2BossReports;
  globals.__aion2HttpRates?.clear();
  fixture.session = { user: { id: "boss-report-reader" } };
  fixture.servers.mockReset().mockResolvedValue([{ id: 2322, name: "Atiel", race: 2 }]);
  // Bounded fields preserve the provider's observed server alias and report shape.
  provider = {
    servers: { regions: [{ id: "EU", servers: [{ id: "eu-altgard", sid: 2322, native: "Atiel", en: "Atiel", race: 2 }] }] },
    bosses: { field: [{ id: "asmo24", faction: "asmo", en: "Immortal Gartua", cycle: 1440 }] },
    cycles: { ok: true, regions: { eu: { asmo24: { s: 43204, npcs: ["2400800"] } } } },
    feed: { ok: true, now: SECOND, kills: { asmo24: { t: SECOND - 3600, u: SECOND - 180, st: "dead", ns: SECOND + 39604 } } },
  };
  fetchMock.mockReset().mockImplementation(async (input) => response(String(input)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("optional community Gartua reports", () => {
  it("matches official Atiel id/name/race before using its opaque eu-altgard alias", async () => {
    const result = await report();
    expect(result.error).toBeUndefined();
    expect(result.report).toMatchObject({
      name: "Immortal Gartua", serverName: "Atiel", serverId: 2322, region: "eu",
      provider: "aion2timers.com", source: "https://www.aion2timers.com/", status: "reported-dead",
      lastKilledAt: new Date((SECOND - 3600) * 1000).toISOString(),
      reportedAt: new Date((SECOND - 180) * 1000).toISOString(),
      estimatedSpawnAt: new Date((SECOND + 39604) * 1000).toISOString(), fetchedAt: NOW.toISOString(),
    });
    expect(fixture.servers).toHaveBeenCalledWith("eu");
    expect(feeds()).toHaveLength(1);
    expect(new URL(String(feeds()[0][0])).searchParams.get("server")).toBe("eu-altgard");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
      expect(options?.headers).not.toHaveProperty("Cookie");
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it.each(["sid", "name", "race", "duplicate"])("withholds a mismatched %s mapping without requesting a feed", async (field) => {
    const mapping = provider.servers.regions[0].servers[0];
    if (field === "sid") mapping.sid = 2321;
    if (field === "name") mapping.en = "Another server";
    if (field === "race") mapping.race = 1;
    if (field === "duplicate") provider.servers.regions[0].servers.push({ ...mapping, id: "eu-other" });
    const result = await report();
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/no verified.*mapping/i);
    expect(feeds()).toHaveLength(0);
  });

  it("never falls back to EU metadata for another region", async () => {
    const result = await (await import("@/lib/aion2-boss-report")).aionBossReport("nae", 2322);
    expect(result.report).toBeNull();
    expect(feeds()).toHaveLength(0);
    expect(fixture.servers).toHaveBeenCalledWith("nae");
  });

  it("discovers a renamed provider boss key from names and cycle NPC metadata", async () => {
    provider.bosses.field[0].id = "gartua-current";
    provider.cycles.regions.eu["gartua-current"] = provider.cycles.regions.eu.asmo24;
    delete provider.cycles.regions.eu.asmo24;
    provider.feed.kills["gartua-current"] = provider.feed.kills.asmo24;
    delete provider.feed.kills.asmo24;
    expect((await report()).report?.name).toBe("Immortal Gartua");
  });

  it("withholds an unverified boss NPC rather than guessing a boss key", async () => {
    provider.cycles.regions.eu.asmo24.npcs = ["different-npc"];
    expect((await report()).report).toBeNull();
    expect(feeds()).toHaveLength(0);
  });

  it("deduplicates concurrent reads, caches feed for60s and metadata/official mapping for24h", async () => {
    const results = await Promise.all([report(), report(), report()]);
    expect(results.every((value) => value.report?.serverId === 2322)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fixture.servers).toHaveBeenCalledTimes(1);
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    provider.feed.now += 61;
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(feeds()).toHaveLength(2);
    expect(fixture.servers).toHaveBeenCalledTimes(1);
  });

  it("revalidates an expired mapping and discards a formerly valid report when catalog identity changes", async () => {
    await report();
    vi.setSystemTime(new Date(NOW.getTime() + 24 * 60 * 60_000 + 1));
    fixture.servers.mockResolvedValue([{ id: 2322, name: "Changed server", race: 2 }]);
    const result = await report();
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/no verified.*mapping/i);
    expect(fixture.servers).toHaveBeenCalledTimes(2);
    expect(feeds()).toHaveLength(1);
  });

  it("backs off metadata failures across different server requests", async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    expect((await report()).report).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await (await import("@/lib/aion2-boss-report")).aionBossReport("eu", 2321);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(feeds()).toHaveLength(0);
  });

  it.each(["official catalog", "community feed"])("bounds the whole %s request by one6s deadline", async (target) => {
    const api = await import("@/lib/aion2-boss-report");
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    if (target === "official catalog") fixture.servers.mockReturnValue(new Promise(() => {}));
    else fetchMock.mockImplementation(async (input) => new URL(String(input)).searchParams.get("action") === "feed" ? new Promise(() => {}) : response(String(input)));
    const pending = api.aionBossReport("eu", 2322);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/too long/);
  });

  it("uses an8h-old kill/report only as a timestamped community estimate", async () => {
    provider.feed.kills.asmo24 = { t: SECOND - 8 * 3600, u: SECOND - 8 * 3600, st: "dead", ns: SECOND + 4 * 3600 };
    const result = await report();
    expect(result.report?.status).toBe("reported-dead");
    expect(result.report?.estimatedSpawnAt).toBe(new Date((SECOND + 4 * 3600) * 1000).toISOString());
    expect(result.report?.reportedAt).toBe(new Date((SECOND - 8 * 3600) * 1000).toISOString());
  });

  it.each(["kill", "report"])("marks a %s older than24h unknown", async (field) => {
    provider.feed.kills.asmo24[field === "kill" ? "t" : "u"] = SECOND - 86401;
    const result = await report();
    expect(result.report?.status).toBe("unknown");
    expect(result.report?.estimatedSpawnAt).toBeNull();
  });

  it("never treats a reported-alive observation as official liveness or a spawn prediction", async () => {
    provider.feed.kills.asmo24.st = "up";
    const result = await report();
    expect(result.report?.status).toBe("reported-alive");
    expect(result.report?.estimatedSpawnAt).toBeNull();
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    provider.feed.now += 31 * 60;
    expect((await report()).report?.status).toBe("unknown");
  });

  it("does not roll an elapsed prediction forward by any cycle", async () => {
    provider.feed.kills.asmo24.ns = SECOND - 1;
    const result = await report();
    expect(result.report?.status).toBe("unknown");
    expect(result.report?.estimatedSpawnAt).toBeNull();
  });

  it.each(["kill", "report", "spawn", "clock"])("rejects an unverified future %s timestamp", async (field) => {
    if (field === "kill") provider.feed.kills.asmo24.t = SECOND + 301;
    if (field === "report") provider.feed.kills.asmo24.u = SECOND + 301;
    if (field === "spawn") provider.feed.kills.asmo24.ns = SECOND + 86401;
    if (field === "clock") provider.feed.now = SECOND + 301;
    const result = await report();
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/future/);
  });

  it.each(["html", "json", "429", "oversized"])("fails closed for malformed or unavailable %s responses", async (failure) => {
    fetchMock.mockImplementation(async (input) => {
      if (new URL(String(input)).searchParams.get("action") !== "feed") return response(String(input));
      if (failure === "html") return new Response("<html>Blocked</html>", { headers: { "Content-Type": "text/html" } });
      if (failure === "json") return new Response("{broken", { headers: { "Content-Type": "application/json" } });
      if (failure === "429") return json({}, 429);
      return new Response(" ".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } });
    });
    const first = await report();
    expect(first.report).toBeNull();
    expect(first.error).toBeTruthy();
    await report();
    expect(feeds()).toHaveLength(1);
  });

  it("preserves the original fetchedAt and absolute estimate during outage/backoff", async () => {
    const first = await report();
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    fetchMock.mockRejectedValue(new Error("offline"));
    const failed = await report();
    expect(failed.report?.fetchedAt).toBe(first.report?.fetchedAt);
    expect(failed.report?.estimatedSpawnAt).toBe(first.report?.estimatedSpawnAt);
    expect(failed.error).toMatch(/could not be reached/i);
    const calls = fetchMock.mock.calls.length;
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("uses manual fallback for a missing404 report instead of retaining old status", async () => {
    await report();
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    fetchMock.mockResolvedValue(json({}, 404));
    const result = await report();
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/manual kill time/i);
  });

  it("returns manual fallback when the mapped Gartua record is absent", async () => {
    provider.feed.kills = {};
    const result = await report();
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/No community Gartua report/i);
  });
});

describe("authenticated optional timer route", () => {
  it("returns401 before any provider or official request", async () => {
    fixture.session = null;
    const result = await route();
    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.servers).not.toHaveBeenCalled();
  });

  it("returns a private no-store typed response", async () => {
    const result = await route();
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await result.json() as AionBossReportResult;
    expect(body.checkedAt).toBe(NOW.toISOString());
    expect(body.report?.serverId).toBe(2322);
  });

  it.each(["region=kr&serverId=2322", "region=eu&serverId=https%3A%2F%2Fother.test", "region=eu&serverId=0"])("rejects invalid parameters %s without upstream requests", async (params) => {
    expect((await route(params)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits the timer bucket to30 reads per account/minute", async () => {
    for (let count = 0; count < 30; count++) expect((await route()).status).toBe(200);
    const refused = await route();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(feeds()).toHaveLength(1);
  });
});
