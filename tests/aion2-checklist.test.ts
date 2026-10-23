import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";
import manifest from "@/data/aion2/checklist.json";
import type { AionCharacterRef, AionChecklist, AionKnowledgeStatus, AionSnapshot } from "@/lib/aion2-types";

const fixture = vi.hoisted(() => ({ db: null as unknown, session: null as unknown, current: true, observe: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_target, property) => {
  const value = (fixture.db as Record<PropertyKey, unknown>)[property];
  return typeof value === "function" ? value.bind(fixture.db) : value;
} }) }));
vi.mock("@/lib/auth", () => ({ auth: () => fixture.session }));
vi.mock("@/lib/aion2-api", async (original) => ({ ...await original<typeof import("@/lib/aion2-api")>(), aionSnapshot: fixture.observe }));
vi.mock("@/lib/aion2-knowledge", () => {
  const status = (): AionKnowledgeStatus => ({ version: "fixture", reviewedAt: "2026-10-23", expiresAt: "2026-10-28", status: fixture.current ? "current" : "review-required", supportedClasses: ["Gladiator"], notices: [] });
  return { aionKnowledgeStatus: status, refreshAionKnowledgeStatus: async () => status() };
});
vi.mock("@/lib/aion2-recommendations", () => ({ aionRecommendations: () => [{ id: "materials", priority: "medium", title: "Review materials", evidence: "Fixture", action: "Check", source: "https://example.test/", steps: [{ id: "farm", title: "Daily Dungeon", instruction: "Check the remaining entries and actual rewards.", checklistActivityIds: ["daily-dungeon"] }, { id: "enhance", title: "Inspect upgrade", instruction: "Inspect actual costs in game." }] }] }));
vi.mock("@/lib/aion2-board-plan", () => ({ aionBoardPlan: () => [] }));

import { aionChecklist, aionChecklistPeriod, aionChecklistProgress, aionChecklistScope } from "@/lib/aion2-checklist";
import { validateAionChecklistManifest } from "@/lib/aion2-checklist-validation";
import { addAionCharacter, listAionCharacters, removeAionCharacter, setAionChecklist, setAionResources } from "@/lib/aion2-store";
import { PATCH as patchRoute } from "@/app/api/aion2/characters/[id]/checklist/route";

const now = new Date("2026-10-23T12:00:00Z");
const ref: AionCharacterRef = { region: "eu", serverId: 2322, characterId: "checklist-character-one" };
const profile = { level: 45 };
const checklist = (at = now, current = true, character = ref) => aionChecklist(character, [], at, current, profile);
const item = (list: AionChecklist, id = "duty-missions") => list.items.find((value) => value.id === id)!;

describe("reviewed reset activity catalog", () => {
  it("validates the reviewed catalog and distinguishes weekly entries from daily recharge banks", () => {
    expect(validateAionChecklistManifest(manifest)).toEqual([]);
    const list = checklist();
    expect(list.status).toBe("current");
    expect(item(list, "daily-dungeon")).toMatchObject({ cadence: "weekly", scope: "server" });
    expect(item(list, "duty-missions")).toMatchObject({ cadence: "daily", scope: "server" });
    expect(item(list, "nightmare")).toMatchObject({ cadence: "daily", scope: "character" });
    expect(item(list, "ascension-trial")).toMatchObject({ cadence: "weekly", scope: "character" });
    expect(item(list, "command-missions").instruction).toMatch(/buy|purchase/i);
    expect(item(list, "abyss-command-missions").instruction).toMatch(/not a quest-completion|not.*quest-completion/i);
    expect(item(list, "conquest-reward-pools").instruction).toMatch(/not a weekly entry/i);
    expect(list.items.some((value) => /Odyle Energy16|Kina Farm|Subscriber/i.test(value.name))).toBe(false);
  });

  it("keeps the two Shugo pools distinct, with different completion scopes", () => {
    const list = checklist();
    expect(item(list, "shugo-festival-server").scope).toBe("server");
    expect(item(list, "shugo-festival-character").scope).toBe("character");
    expect(item(list, "shugo-festival-server").instruction).toContain("3 keys");
    expect(item(list, "shugo-festival-character").instruction).toContain("4 keys");
  });

  it.each([
    ["2026-10-23T06:59:59.999Z", "daily:2026-10-22T07:00:00.000Z", "2026-10-23T07:00:00.000Z"],
    ["2026-10-23T07:00:00.000Z", "daily:2026-10-23T07:00:00.000Z", "2026-10-24T07:00:00.000Z"],
    ["2026-10-24T12:00:00.000Z", "daily:2026-10-24T07:00:00.000Z", "2026-10-25T07:00:00.000Z"],
    ["2026-10-25T06:59:59.999Z", "daily:2026-10-24T07:00:00.000Z", "2026-10-25T07:00:00.000Z"],
    ["2026-10-25T07:00:00.000Z", "daily:2026-10-25T07:00:00.000Z", "2026-10-26T07:00:00.000Z"],
  ])("daily period is fixed UTC through DST: %s", (instant, periodKey, nextResetAt) => {
    expect(aionChecklistPeriod("daily", new Date(instant))).toEqual({ periodKey, nextResetAt });
  });

  it.each([
    ["2026-10-21T06:59:59.999Z", "weekly:2026-10-14T07:00:00.000Z", "2026-10-21T07:00:00.000Z"],
    ["2026-10-21T07:00:00.000Z", "weekly:2026-10-21T07:00:00.000Z", "2026-10-28T07:00:00.000Z"],
    ["2026-10-25T01:30:00.000Z", "weekly:2026-10-21T07:00:00.000Z", "2026-10-28T07:00:00.000Z"],
    ["2026-10-28T07:00:00.000Z", "weekly:2026-10-28T07:00:00.000Z", "2026-11-04T07:00:00.000Z"],
  ])("weekly Wednesday reset has a single boundary: %s", (instant, periodKey, nextResetAt) => {
    expect(aionChecklistPeriod("weekly", new Date(instant))).toEqual({ periodKey, nextResetAt });
  });

  it("does not reuse an earlier period report or an unrelated canonical character", () => {
    const base = checklist();
    const task = item(base, "nightmare");
    const report = { scopeKey: aionChecklistScope(ref, "character"), activityId: task.id, periodKey: task.periodKey, revision: 1, completedAt: now };
    expect(item(aionChecklist(ref, [report], now, true, profile), task.id).completed).toBe(true);
    expect(item(aionChecklist(ref, [report], new Date("2026-10-24T07:00:00Z"), true, profile), task.id).completed).toBe(false);
    expect(item(aionChecklist({ ...ref, characterId: "different-character" }, [report], now, true, profile), task.id).completed).toBe(false);
  });

  it("uses an account-independent scope identity while store ownership remains separately required", () => {
    expect(aionChecklistScope(ref, "server")).toBe(aionChecklistScope({ ...ref, characterId: "other" }, "server"));
    expect(aionChecklistScope(ref, "server")).not.toBe(aionChecklistScope({ ...ref, serverId: 2323 }, "server"));
    expect(aionChecklistScope(ref, "server")).not.toBe(aionChecklistScope({ ...ref, region: "nae" }, "server"));
    expect(aionChecklistScope(ref, "character")).not.toBe(aionChecklistScope({ ...ref, characterId: "other" }, "character"));
  });

  it("withholds countdowns and edits on expired/future knowledge or unsupported regions", () => {
    expect(checklist(now, false).status).toBe("review-required");
    expect(checklist(now, false).items.every((value) => value.nextResetAt === null)).toBe(true);
    expect(checklist(new Date("2026-10-28T00:00:00Z")).status).toBe("review-required");
    expect(checklist(new Date("2026-10-22T23:59:59Z")).status).toBe("review-required");
    expect(checklist(now, true, { ...ref, region: "nae" })).toMatchObject({ status: "unverified", items: [] });
    expect(aionChecklist(ref, [], new Date(NaN), true, profile)).toMatchObject({ status: "review-required", items: [] });
  });

  it("does not recommend level-45 activities to low-level or unknown-level characters", () => {
    expect(aionChecklist(ref, [], now, true).items).toEqual([]);
    expect(aionChecklist(ref, [], now, true, { level: 30 }).items.map((value) => value.id)).toEqual(["daily-dungeon"]);
    expect(aionChecklist(ref, [], now, true, { level: 1 }).items).toEqual([]);
  });

  it("only annotates explicitly linked activity steps, never their downstream upgrade", () => {
    const list = checklist(); item(list, "daily-dungeon").completed = true;
    const recommendation = { id: "a", priority: "medium" as const, title: "A", evidence: "B", action: "C", source: "https://example.test", steps: [{ id: "farm", title: "Farm", instruction: "Check remaining entries", checklistActivityIds: ["daily-dungeon"] }, { id: "upgrade", title: "Upgrade", instruction: "Inspect cost" }] };
    const steps = aionChecklistProgress([recommendation], list)[0].steps!;
    expect(steps[0]).toMatchObject({ reportedDone: true, instruction: "Check remaining entries" });
    expect(steps[0].progressNote).toMatch(/reported|actual rewards/i);
    expect(steps[1].reportedDone).toBeUndefined();
    expect(aionChecklistProgress([recommendation], { ...list, status: "review-required" })[0].steps![0].reportedDone).toBeUndefined();
  });
});

describe("checklist manifest validation", () => {
  it.each([
    ["nonobject", () => null],
    ["missing version", () => ({ ...manifest, version: "" })],
    ["invalid dates", () => ({ ...manifest, expiresAt: manifest.reviewedAt })],
    ["duplicate source", () => ({ ...manifest, sources: [...manifest.sources, manifest.sources[0]] })],
    ["HTTP source", () => ({ ...manifest, sources: [{ ...manifest.sources[0], url: "http://example.test" }] })],
    ["credentialed source", () => ({ ...manifest, sources: [{ ...manifest.sources[0], url: "https://user:pass@example.test" }] })],
    ["HTTP fetch source", () => ({ ...manifest, sources: [{ ...manifest.sources[0], fetchUrl: "http://example.test" }] })],
    ["credentialed fetch source", () => ({ ...manifest, sources: [{ ...manifest.sources[0], fetchUrl: "https://user@example.test" }] })],
    ["missing source kind", () => ({ ...manifest, sources: [{ ...manifest.sources[0], kind: undefined }] })],
    ["bad pin", () => ({ ...manifest, sources: [{ ...manifest.sources[0], sha256: "not-a-hash" }] })],
    ["wrong reset hour", () => ({ ...manifest, resets: { eu: { ...manifest.resets.eu, dailyHourUTC: 8 } } })],
    ["wrong weekly day", () => ({ ...manifest, resets: { eu: { ...manifest.resets.eu, weeklyDayUTC: 0 } } })],
    ["unreviewed region", () => ({ ...manifest, resets: { ...manifest.resets, nae: manifest.resets.eu } })],
    ["duplicate activity", () => ({ ...manifest, activities: [...manifest.activities, manifest.activities[0]] })],
    ["bad scope", () => ({ ...manifest, activities: [{ ...manifest.activities[0], scope: "global" }] })],
    ["bad cadence", () => ({ ...manifest, activities: [{ ...manifest.activities[0], cadence: "hourly" }] })],
    ["unknown source", () => ({ ...manifest, activities: [{ ...manifest.activities[0], sourceIds: ["unknown"] }] })],
    ["invalid level", () => ({ ...manifest, activities: [{ ...manifest.activities[0], minimumLevel: -1 }] })],
  ])("rejects %s", (_label, make) => { expect(validateAionChecklistManifest(make()).length).toBeGreaterThan(0); });
});

let folder: string;
let database: PrismaClient;
function snapshot(character: AionCharacterRef): AionSnapshot {
  return { version: 1, ref: character, observedAt: new Date().toISOString(), profile: { name: "Character", serverName: "Atiel", className: "Gladiator", level: 45, gearScore: 1638, combatPower: 73000 }, equipment: [], skills: [], boards: [], stats: [{ type: "ItemLevel", name: "Item Level", value: 1638 }], pet: null, wing: null, coverage: { equipment: true, skills: true, boards: true } };
}
function change(list: AionChecklist, id = "duty-missions", completed = true) {
  return { activityId: id, completed, periodKey: item(list, id).periodKey, revision: list.revision };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://yoshling.test/api/aion2/characters/id/checklist", { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
async function current(id: string, owner = "owner-a") { return (await listAionCharacters(owner)).characters.find((character) => character.id === id)!; }

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "yoshling-aion2-checklist-"));
  const url = `file:${path.join(folder, "test.db")}`;
  const sql = createClient({ url });
  await sql.execute('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "discordId" TEXT UNIQUE NOT NULL, "username" TEXT NOT NULL, "avatar" TEXT, "role" TEXT NOT NULL DEFAULT \'MEMBER\', "games" TEXT NOT NULL DEFAULT \'\', "minecraftTourDone" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await sql.executeMultiple(await readFile(path.join(process.cwd(), "prisma/migrations/20261023150000_add_aion2_tracking/migration.sql"), "utf8"));
  sql.close();
  database = new PrismaClient({ adapter: new PrismaLibSql({ url }) }); fixture.db = database;
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  await database.aion2ChecklistCompletion.deleteMany(); await database.aion2Snapshot.deleteMany(); await database.aion2Character.deleteMany(); await database.user.deleteMany();
  await database.user.createMany({ data: [{ id: "owner-a", discordId: "111111111111111111", username: "a" }, { id: "owner-b", discordId: "222222222222222222", username: "b" }] });
  fixture.session = { user: { id: "owner-a", role: "ADMIN", games: [] } }; fixture.current = true;
  fixture.observe.mockReset().mockImplementation(async (character) => snapshot(character));
  const globals = globalThis as typeof globalThis & { __aion2Tracker?: { cache: Map<unknown, unknown>; inflight: Map<unknown, unknown> }; __aion2HttpRates?: Map<unknown, unknown> };
  globals.__aion2Tracker?.cache.clear(); globals.__aion2Tracker?.inflight.clear(); globals.__aion2HttpRates?.clear();
});
afterAll(async () => { vi.useRealTimers(); await database?.$disconnect(); if (folder) await rm(folder, { recursive: true, force: true }); });

describe("owned durable reset reports", () => {
  it("persists a server report and shares it only with the same owner's characters on that server", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const alt = await addAionCharacter("owner-a", { ...ref, characterId: "checklist-character-two" });
    const elsewhere = await addAionCharacter("owner-a", { ...ref, serverId: 2323 });
    const friend = await addAionCharacter("owner-b", ref);
    const saved = await setAionChecklist("owner-a", a.id, change(a.checklist!));
    expect(item(saved.checklist!).completed).toBe(true);
    expect(saved.checklist!.revision).not.toBe(a.checklist!.revision);
    expect(item((await current(alt.id)).checklist!).completed).toBe(true);
    expect(item((await current(elsewhere.id)).checklist!).completed).toBe(false);
    expect(item((await current(friend.id, "owner-b")).checklist!).completed).toBe(false);
    expect(await database.aion2ChecklistCompletion.count()).toBe(1);
  });

  it("keeps character reports separate, even when both characters belong to one owner", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const alt = await addAionCharacter("owner-a", { ...ref, characterId: "checklist-character-two" });
    await setAionChecklist("owner-a", a.id, change(a.checklist!, "nightmare"));
    expect(item((await current(a.id)).checklist!, "nightmare").completed).toBe(true);
    expect(item((await current(alt.id)).checklist!, "nightmare").completed).toBe(false);
  });

  it("refuses another owner including an administrator, without writing a report", async () => {
    const a = await addAionCharacter("owner-b", ref);
    await expect(setAionChecklist("owner-a", a.id, change(a.checklist!))).rejects.toThrow("not in your tracked list");
    const response = await patchRoute(request(change(a.checklist!)), context(a.id));
    expect(response.status).toBe(404); expect(await database.aion2ChecklistCompletion.count()).toBe(0);
  });

  it("rejects a stale aggregate revision after a shared-server change", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const alt = await addAionCharacter("owner-a", { ...ref, characterId: "checklist-character-two" });
    await setAionChecklist("owner-a", a.id, change(a.checklist!));
    await expect(setAionChecklist("owner-a", alt.id, change(alt.checklist!, "daily-dungeon"))).rejects.toThrow("another view");
    expect(item((await current(a.id)).checklist!, "daily-dungeon").completed).toBe(false);
  });

  it("rejects a stale daily period at the exact reset and starts the new period unchecked", async () => {
    const a = await addAionCharacter("owner-a", ref);
    await setAionChecklist("owner-a", a.id, change(a.checklist!));
    const old = (await current(a.id)).checklist!;
    vi.setSystemTime(new Date("2026-10-24T07:00:00Z"));
    await expect(setAionChecklist("owner-a", a.id, change(old))).rejects.toThrow("has reset");
    const reset = (await current(a.id)).checklist!;
    expect(item(reset).completed).toBe(false);
    expect(item(reset).periodKey).toBe("daily:2026-10-24T07:00:00.000Z");
  });

  it("keeps a weekly report over a daily reset and DST without changing the weekly UTC boundary", async () => {
    const a = await addAionCharacter("owner-a", ref);
    await setAionChecklist("owner-a", a.id, change(a.checklist!, "daily-dungeon"));
    vi.setSystemTime(new Date("2026-10-25T07:00:00Z"));
    const weekly = item((await current(a.id)).checklist!, "daily-dungeon");
    expect(weekly.completed).toBe(true); expect(weekly.nextResetAt).toBe("2026-10-28T07:00:00.000Z");
  });

  it("allows clearing a report, prevents replay, and does not change character stats or manual resources", async () => {
    const a = await addAionCharacter("owner-a", ref);
    await setAionResources("owner-a", a.id, 80);
    const first = await setAionChecklist("owner-a", a.id, change(a.checklist!, "daily-dungeon"));
    expect(first.recommendations[0].steps![0].reportedDone).toBe(true);
    expect(first.recommendations[0].steps![1].reportedDone).toBeUndefined();
    const cleared = await setAionChecklist("owner-a", a.id, change(first.checklist!, "daily-dungeon", false));
    expect(item(cleared.checklist!, "daily-dungeon")).toMatchObject({ completed: false, completedAt: null });
    expect(cleared.resources?.odyleEnergy).toBe(80); expect(cleared.snapshot).toEqual(a.snapshot);
    await expect(setAionChecklist("owner-a", a.id, change(a.checklist!, "daily-dungeon"))).rejects.toThrow("another view");
  });

  it("retains canonical character progress after removing and re-adding its tracking row", async () => {
    const a = await addAionCharacter("owner-a", ref);
    await setAionChecklist("owner-a", a.id, change(a.checklist!, "nightmare"));
    await removeAionCharacter("owner-a", a.id);
    const again = await addAionCharacter("owner-a", ref);
    expect(again.id).not.toBe(a.id); expect(item(again.checklist!, "nightmare").completed).toBe(true);
    await database.user.delete({ where: { id: "owner-a" } });
    expect(await database.aion2ChecklistCompletion.count()).toBe(0);
  });

  it("returns a canonical PATCH receipt and refuses absent sessions, cross-origin requests and extra fields", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const response = await patchRoute(request(change(a.checklist!), { Origin: "https://yoshling.test" }), context(a.id));
    expect(response.status).toBe(200);
    const result = await response.json(); expect(result.character.id).toBe(a.id);
    expect(item(result.character.checklist).completed).toBe(true);
    expect(result.character.checklist.revision).not.toBe(a.checklist!.revision);
    expect((await patchRoute(request(change(result.character.checklist), { Origin: "https://elsewhere.test" }), context(a.id))).status).toBe(403);
    expect((await patchRoute(request({ ...change(result.character.checklist), ownerId: "owner-b" }), context(a.id))).status).toBe(400);
    fixture.session = null;
    expect((await patchRoute(request(change(result.character.checklist)), context(a.id))).status).toBe(401);
  });

  it("refuses unknown tasks, malformed completion values and stale source reviews", async () => {
    const a = await addAionCharacter("owner-a", ref);
    const body = change(a.checklist!);
    expect((await patchRoute(request({ ...body, activityId: "invented-task" }), context(a.id))).status).toBe(400);
    expect((await patchRoute(request({ ...body, completed: "yes" }), context(a.id))).status).toBe(400);
    fixture.current = false;
    expect((await patchRoute(request(body), context(a.id))).status).toBe(409);
    expect(await database.aion2ChecklistCompletion.count()).toBe(0);
  });

  it("fails closed when the reviewed catalog expires, and never enables an unsupported region", async () => {
    const a = await addAionCharacter("owner-a", ref);
    vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
    await expect(setAionChecklist("owner-a", a.id, change(a.checklist!))).rejects.toThrow("review is not current");
    const other = await addAionCharacter("owner-a", { ...ref, region: "nae" });
    expect(other.checklist).toMatchObject({ status: "unverified", items: [] });
    await expect(setAionChecklist("owner-a", other.id, change(a.checklist!))).rejects.toThrow("review is not current");
  });
});
