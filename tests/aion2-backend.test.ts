import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";
import type { AionSnapshot } from "@/lib/aion2-types";

const fixture = vi.hoisted(() => ({ db: null as unknown, session: null as unknown, observe: vi.fn(), knowledge: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_target, property) => {
  const value = (fixture.db as Record<PropertyKey, unknown>)[property];
  return typeof value === "function" ? value.bind(fixture.db) : value;
} }) }));
vi.mock("@/lib/auth", () => ({ auth: () => fixture.session }));
vi.mock("@/lib/aion2-api", async (original) => ({ ...await original<typeof import("@/lib/aion2-api")>(), aionSnapshot: fixture.observe }));
vi.mock("@/lib/aion2-knowledge", async (original) => ({ ...await original<typeof import("@/lib/aion2-knowledge")>(), refreshAionKnowledgeStatus: fixture.knowledge }));

import { addAionCharacter, listAionCharacters, refreshAionCharacter, removeAionCharacter, setAionTracking, setAionResources, tickAionTracking, AION_POLL_INTERVAL_MS } from "@/lib/aion2-store";
import { GET as listRoute, POST as addRoute } from "@/app/api/aion2/characters/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/aion2/characters/[id]/route";
import { POST as refreshRoute } from "@/app/api/aion2/characters/[id]/refresh/route";
import { GET as knowledgeRoute } from "@/app/api/aion2/knowledge/route";

let folder: string;
let database: PrismaClient;
let observedTime = new Date("2026-10-23T12:00:00Z");
const ref = { region: "eu" as const, serverId: 2322, characterId: "NGez0OkmLm4ARHzxujw-i-NiYEi4TvbDkLZ24tLvva8=" };
function snapshot(extra: Partial<AionSnapshot["profile"]> = {}): AionSnapshot {
  return {
    version: 1, ref, observedAt: observedTime.toISOString(),
    profile: { name: "Yoshiane", serverName: "Atiel", className: "Gladiator", level: 45, combatPower: 73881, gearScore: 1638, ...extra },
    equipment: [], skills: [], boards: [], stats: [{ type: "ItemLevel", name: "Item Level", value: extra.gearScore ?? 1638 }], wing: null, pet: null,
    coverage: { equipment: true, skills: true, boards: true },
  };
}
function session(id = "owner-a") { return { user: { id, role: "MEMBER", games: [] } }; }
function req(method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("https://yoshling.test/api/aion2/characters", { method, headers: { "Content-Type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function context(id: string) { return { params: Promise.resolve({ id }) }; }
async function makeDue(id: string) {
  await database.aion2Character.update({ where: { id }, data: { lastAttemptAt: new Date(Date.now() - 120_000), nextRefreshAt: new Date(Date.now() - 1000) } });
}

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "yoshling-aion2-"));
  const url = `file:${path.join(folder, "test.db")}`;
  const sql = createClient({ url });
  await sql.execute('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "discordId" TEXT UNIQUE NOT NULL, "username" TEXT NOT NULL, "avatar" TEXT, "role" TEXT NOT NULL DEFAULT \'MEMBER\', "games" TEXT NOT NULL DEFAULT \'\', "minecraftTourDone" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const migration = await readFile(path.join(process.cwd(), "prisma/migrations/20261023150000_add_aion2_tracking/migration.sql"), "utf8");
  await sql.executeMultiple(migration);
  sql.close();
  database = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  fixture.db = database;
});

beforeEach(async () => {
  await database.aion2Snapshot.deleteMany();
  await database.aion2Character.deleteMany();
  await database.user.deleteMany();
  await database.user.createMany({ data: [{ id: "owner-a", discordId: "111111111111111111", username: "a" }, { id: "owner-b", discordId: "222222222222222222", username: "b" }] });
  const state = (globalThis as typeof globalThis & { __aion2Tracker?: { cache: Map<unknown, unknown>; inflight: Map<unknown, unknown> }; __aion2HttpRates?: Map<unknown, unknown> });
  state.__aion2Tracker?.cache.clear(); state.__aion2Tracker?.inflight.clear(); state.__aion2HttpRates?.clear();
  observedTime = new Date("2026-10-23T12:00:00Z");
  fixture.session = session();
  fixture.observe.mockReset().mockImplementation(async () => snapshot());
  fixture.knowledge.mockReset().mockResolvedValue({ version: "fixture", reviewedAt: "2026-10-23", expiresAt: "2026-11-01", status: "current", supportedClasses: ["Gladiator"], notices: [] });
});

afterAll(async () => { await database?.$disconnect(); if (folder) await rm(folder, { recursive: true, force: true }); });

describe("Aion2 persistent tracking", () => {
  it("stores a verified initial observation and reads it back with owner isolation", async () => {
    const character = await addAionCharacter("owner-a", ref);
    expect(character.snapshot?.profile.combatPower).toBe(73881);
    expect(character.history).toHaveLength(1);
    expect((await listAionCharacters("owner-a")).characters[0].id).toBe(character.id);
    expect((await listAionCharacters("owner-b")).characters).toEqual([]);
    expect((await listAionCharacters("owner-a")).pollIntervalMs).toBe(AION_POLL_INTERVAL_MS);
  });

  it("does not add an unverified placeholder when the armory fails", async () => {
    fixture.observe.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(addAionCharacter("owner-a", ref)).rejects.toThrow("Unavailable");
    expect(await database.aion2Character.count()).toBe(0);
  });

  it("refuses a different character returned by upstream", async () => {
    fixture.observe.mockResolvedValueOnce({ ...snapshot(), ref: { ...ref, serverId: 2321 } });
    await expect(addAionCharacter("owner-a", ref)).rejects.toThrow("different character");
    expect(await database.aion2Character.count()).toBe(0);
  });

  it("deduplicates an account's character while allowing another account's own tracking", async () => {
    const first = await addAionCharacter("owner-a", ref);
    expect((await addAionCharacter("owner-a", ref)).id).toBe(first.id);
    const other = await addAionCharacter("owner-b", ref);
    expect(other.id).not.toBe(first.id);
    expect(fixture.observe).toHaveBeenCalledTimes(1);
    expect(await database.aion2Character.count()).toBe(2);
  });

  it("rejects a thirteenth character inside the collection transaction", async () => {
    for (let i = 0; i < 12; i++) {
      const otherRef = { ...ref, characterId: `character${i}identifier` };
      fixture.observe.mockResolvedValueOnce({ ...snapshot(), ref: otherRef });
      await addAionCharacter("owner-a", otherRef);
    }
    await expect(addAionCharacter("owner-a", ref)).rejects.toThrow("up to 12");
    expect(await database.aion2Character.count({ where: { ownerId: "owner-a" } })).toBe(12);
  });

  it("does not let a different owner change tracking, refresh, or remove a character", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await expect(setAionTracking("owner-b", character.id, false)).rejects.toThrow("not in your tracked list");
    await expect(refreshAionCharacter("owner-b", character.id)).rejects.toThrow("not in your tracked list");
    await expect(removeAionCharacter("owner-b", character.id)).rejects.toThrow("not in your tracked list");
    expect((await listAionCharacters("owner-a")).characters[0].tracking).toBe(true);
  });

  it("keeps last good data and records backoff after a failed refresh", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    fixture.observe.mockRejectedValueOnce(new Error("Public armory unavailable"));
    await expect(refreshAionCharacter("owner-a", character.id)).rejects.toThrow("unavailable");
    const current = (await listAionCharacters("owner-a")).characters[0];
    expect(current.snapshot?.profile.combatPower).toBe(73881);
    expect(current.history).toHaveLength(1);
    expect(current.lastError).toBe("Public armory unavailable");
    expect(new Date(current.nextRefreshAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await database.aion2Character.findUniqueOrThrow({ where: { id: character.id } })).leaseToken).toBeNull();
  });

  it("retains changed observations while advancing successful check time for unchanged state", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    observedTime = new Date("2026-10-23T12:05:00Z");
    const unchanged = await refreshAionCharacter("owner-a", character.id);
    expect(unchanged.history).toHaveLength(1);
    expect(unchanged.snapshot?.observedAt).toBe(observedTime.toISOString());
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    observedTime = new Date("2026-10-23T12:10:00Z");
    fixture.observe.mockResolvedValueOnce(snapshot({ combatPower: 75000 }));
    const changed = await refreshAionCharacter("owner-a", character.id);
    expect(changed.history).toHaveLength(2);
    expect(changed.history.map((point) => point.combatPower)).toEqual([73881, 75000]);
  });

  it("prevents overlapping refresh publication through the database lease", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    let release!: (value: AionSnapshot) => void;
    fixture.observe.mockImplementationOnce(() => new Promise<AionSnapshot>((resolve) => { release = resolve; }));
    const first = refreshAionCharacter("owner-a", character.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(refreshAionCharacter("owner-a", character.id)).rejects.toThrow(/wait|already refreshing/);
    release(snapshot()); await first;
  });

  it("paused tracking is skipped in the unattended tick", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    await setAionTracking("owner-a", character.id, false);
    fixture.observe.mockClear();
    await tickAionTracking();
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("removes only the owner's character and its snapshot history", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const b = await addAionCharacter("owner-b", ref);
    expect(await removeAionCharacter("owner-a", a.id)).toBe(a.id);
    expect(await database.aion2Snapshot.count({ where: { characterId: a.id } })).toBe(0);
    expect((await listAionCharacters("owner-b")).characters[0].id).toBe(b.id);
  });

  it("deleting an account cascades its tracked characters and history", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const b = await addAionCharacter("owner-b", ref);
    await database.user.delete({ where: { id: "owner-a" } });
    expect(await database.aion2Character.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await database.aion2Snapshot.count({ where: { characterId: a.id } })).toBe(0);
    expect((await listAionCharacters("owner-b")).characters[0].id).toBe(b.id);
  });

  it("a pause during an in-flight observation is preserved when the observation finishes", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    let release!: (value: AionSnapshot) => void;
    fixture.observe.mockImplementationOnce(() => new Promise<AionSnapshot>((resolve) => { release = resolve; }));
    const pending = refreshAionCharacter("owner-a", character.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await setAionTracking("owner-a", character.id, false)).tracking).toBe(false);
    release(snapshot());
    expect((await pending).tracking).toBe(false);
    expect((await listAionCharacters("owner-a")).characters[0].tracking).toBe(false);
  });

  it("removal during an in-flight observation cannot recreate the character or its history", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    let release!: (value: AionSnapshot) => void;
    fixture.observe.mockImplementationOnce(() => new Promise<AionSnapshot>((resolve) => { release = resolve; }));
    const pending = refreshAionCharacter("owner-a", character.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await removeAionCharacter("owner-a", character.id);
    release(snapshot());
    await expect(pending).rejects.toThrow("changed while refreshing");
    expect(await database.aion2Character.count()).toBe(0);
    expect(await database.aion2Snapshot.count()).toBe(0);
  });

  it("keeps manual resources unknown until entered, timestamps the entry, and distinguishes zero from clearing", async () => {
    const character = await addAionCharacter("owner-a", ref);
    expect(character.resources).toEqual({ odyleEnergy: null, updatedAt: null });
    const before = Date.now();
    const entered = await setAionResources("owner-a", character.id, 120);
    expect(entered.resources?.odyleEnergy).toBe(120);
    expect(new Date(entered.resources!.updatedAt!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(entered.resources!.updatedAt!).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await listAionCharacters("owner-a")).characters[0].resources).toEqual(entered.resources);
    const zero = await setAionResources("owner-a", character.id, 0);
    expect(zero.resources?.odyleEnergy).toBe(0);
    expect(zero.resources?.updatedAt).toEqual(expect.any(String));
    expect((await setAionResources("owner-a", character.id, null)).resources).toEqual({ odyleEnergy: null, updatedAt: null });
  });

  it("does not replace a manual balance or its freshness timestamp during a public refresh", async () => {
    const character = await addAionCharacter("owner-a", ref);
    const entered = await setAionResources("owner-a", character.id, 80);
    await makeDue(character.id);
    (globalThis as typeof globalThis & { __aion2Tracker: { cache: Map<unknown, unknown> } }).__aion2Tracker.cache.clear();
    observedTime = new Date("2026-10-23T12:15:00Z");
    const refreshed = await refreshAionCharacter("owner-a", character.id);
    expect(refreshed.resources).toEqual(entered.resources);
    expect(refreshed.lastSuccessAt).toBe(observedTime.toISOString());
  });

  it("refuses another account's manual resource update without changing its balance", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await setAionResources("owner-a", character.id, 80);
    await expect(setAionResources("owner-b", character.id, 40)).rejects.toThrow("not in your tracked list");
    expect((await listAionCharacters("owner-a")).characters[0].resources?.odyleEnergy).toBe(80);
  });
});

describe("Aion2 authenticated routes", () => {
  it("refreshes reviewed source status without a character or armory read", async () => {
    const response = await knowledgeRoute(req());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Object.keys(await response.json())).toEqual(["knowledge"]);
    expect(fixture.knowledge).toHaveBeenCalledOnce();
    expect(fixture.knowledge).toHaveBeenCalledWith({ maximumCheckAgeMs: 15 * 60_000 });
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("requires authentication before refreshing alert source status", async () => {
    fixture.session = null;
    expect((await knowledgeRoute(req())).status).toBe(401);
    expect(fixture.knowledge).not.toHaveBeenCalled();
  });

  it("bounds source refresh requests per account", async () => {
    for (let index = 0; index < 12; index++) expect((await knowledgeRoute(req())).status).toBe(200);
    expect((await knowledgeRoute(req())).status).toBe(429);
    expect(fixture.knowledge).toHaveBeenCalledTimes(12);
  });

  it("returns the checked knowledge status alongside the account's character list", async () => {
    await addAionCharacter("owner-a", ref);
    const response = await listRoute(req());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.characters).toHaveLength(1);
    expect(data.knowledge.status).toBe("current");
    expect(fixture.knowledge).toHaveBeenCalledOnce();
  });

  it("denies unauthenticated reads and writes before touching upstream", async () => {
    fixture.session = null;
    expect((await listRoute(req())).status).toBe(401);
    expect((await addRoute(req("POST", ref))).status).toBe(401);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("allows an invited member without hosted-world grants to track a public character", async () => {
    const response = await addRoute(req("POST", { ...ref, ownerId: "owner-b" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await listAionCharacters("owner-a")).characters).toHaveLength(1);
    expect((await listAionCharacters("owner-b")).characters).toHaveLength(0);
  });

  it("rejects foreign-origin and cross-site mutations", async () => {
    expect((await addRoute(req("POST", ref, { Origin: "https://foreign.test" }))).status).toBe(403);
    expect((await addRoute(req("POST", ref, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it.each([
    { ...ref, region: "unknown" }, { ...ref, serverId: -1 }, { ...ref, characterId: "bad%GG" },
  ])("rejects an invalid character selection before upstream: %j", async (body) => {
    expect((await addRoute(req("POST", body))).status).toBe(400);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("bounds request bytes even without a content-length header", async () => {
    const response = await addRoute(req("POST", { ...ref, padding: "x".repeat(5000) }));
    expect(response.status).toBe(413);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("cannot use another owner's ID even when the session role is ADMIN", async () => {
    const character = await addAionCharacter("owner-a", ref);
    fixture.session = { user: { id: "owner-b", role: "ADMIN", games: [] } };
    expect((await patchRoute(req("PATCH", { tracking: false }), context(character.id))).status).toBe(404);
    expect((await refreshRoute(req("POST"), context(character.id))).status).toBe(404);
    expect((await deleteRoute(req("DELETE"), context(character.id))).status).toBe(404);
    expect(await database.aion2Character.count()).toBe(1);
  });

  it("returns a retry-after rather than calling the armory on rapid refresh", async () => {
    const character = await addAionCharacter("owner-a", ref);
    await database.aion2Character.update({ where: { id: character.id }, data: { lastAttemptAt: new Date() } });
    fixture.observe.mockClear();
    const response = await refreshRoute(req("POST"), context(character.id));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("saves a manual Odyle entry on the signed-in account and ignores supplied freshness or owner metadata", async () => {
    const character = await addAionCharacter("owner-a", ref);
    const response = await patchRoute(req("PATCH", { odyleEnergy: 200, ownerId: "owner-b", resourcesUpdatedAt: "2099-01-01T00:00:00Z" }), context(character.id));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.character.resources.odyleEnergy).toBe(200);
    expect(new Date(data.character.resources.updatedAt).getTime()).toBeLessThanOrEqual(Date.now());
    fixture.session = { user: { id: "owner-b", role: "ADMIN", games: [] } };
    expect((await patchRoute(req("PATCH", { odyleEnergy: 1 }), context(character.id))).status).toBe(404);
    expect((await listAionCharacters("owner-a")).characters[0].resources?.odyleEnergy).toBe(200);
  });

  it.each([-1, 10001, 1.5, "60", {}, true])("rejects an invalid manual balance without modifying the saved entry: %j", async (value) => {
    const character = await addAionCharacter("owner-a", ref);
    await setAionResources("owner-a", character.id, 100);
    const response = await patchRoute(req("PATCH", { odyleEnergy: value }), context(character.id));
    expect(response.status).toBe(400);
    expect((await listAionCharacters("owner-a")).characters[0].resources?.odyleEnergy).toBe(100);
  });

  it("refuses mixed tracking/resource updates and does not silently modify either preference", async () => {
    const character = await addAionCharacter("owner-a", ref);
    expect((await patchRoute(req("PATCH", { tracking: false, odyleEnergy: 200 }), context(character.id))).status).toBe(400);
    const current = (await listAionCharacters("owner-a")).characters[0];
    expect(current.tracking).toBe(true);
    expect(current.resources).toEqual({ odyleEnergy: null, updatedAt: null });
  });
});
