import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Session } from "next-auth";
const fixture = vi.hoisted(() => ({ client: null as import("@/generated/prisma/client").PrismaClient | null, session: null as Session | null, invited: true, updates: 0, corruptReadback: false, failedWrite: false, failRead: false }));
vi.mock("@/lib/auth", () => ({ auth: async () => fixture.session }));
vi.mock("@/lib/whitelist", () => ({ isWhitelisted: async () => fixture.invited }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get(_target, key) {
  if (key === "$transaction") return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => fixture.client!.$transaction(async tx => {
    let changed = false;
    const user = new Proxy(tx.user, { get(target, method) {
      if (method === "updateMany") return async (input: Prisma.UserUpdateManyArgs) => { fixture.updates++; if (fixture.failedWrite) return { count: 0 }; const result = await target.updateMany(input); changed = true; return result; };
      if (method === "findUnique") return async (input: Prisma.UserFindUniqueArgs) => { const row = await target.findUnique(input); return row && changed && fixture.corruptReadback ? { ...row, minecraftTourDone: false } : row; };
      const value = Reflect.get(target, method); return typeof value === "function" ? value.bind(target) : value;
    } });
    return work(new Proxy(tx, { get(target, method) { if (method === "user") return user; const value = Reflect.get(target, method); return typeof value === "function" ? value.bind(target) : value; } }));
  });
  if (key === "user" && fixture.failRead) return { findUnique: async () => { throw new Error("private fixture database detail"); } };
  const value = Reflect.get(fixture.client!, key); return typeof value === "function" ? value.bind(fixture.client) : value;
} }) }));
const route = await import("@/app/api/minecraft/tour/route");
const state = await import("@/lib/minecraft-tour-state");
const OWNER = "tour-owner", OTHER = "tour-other", DISCORD = "9007199254740993";
let root: string, client: PrismaClient;
const session = (role: "ADMIN" | "MOD" | "MEMBER" = "MEMBER", games: Session["user"]["games"] = ["minecraft"]): Session => ({ expires: "2030-01-01", user: { id: OWNER, discordId: DISCORD, name: "Fixture member", role, games } });
const getRequest = (headers: Record<string, string> = { "X-Minecraft-Tour-User": OWNER }) => new Request("http://fixture/api/minecraft/tour", { headers });
const request = (body: unknown = { version: 1, done: true }, headers: Record<string, string> = {}) => new Request("http://fixture/api/minecraft/tour", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Minecraft-Tour-User": OWNER, ...headers } });
async function migration(name: string) { const sql = await readFile(path.resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`), "utf8"); for (const statement of sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(value => value.trim()).filter(Boolean)) await client.$executeRawUnsafe(statement); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "minecraft-tour-state-"))); client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${root}/fixture.db` }) }); fixture.client = client;
  await migration("20260519104842_init"); await migration("20260913144054_add_game_access_and_zomboid_mods");
  // This is the existing client's insert shape: the additive default supplies the new field later.
  for (const [id, discordId, games] of [[OWNER, DISCORD, "minecraft"], [OTHER, "9007199254740994", "zomboid"]]) await client.$executeRawUnsafe('INSERT INTO "User" ("id","discordId","username","role","games","createdAt") VALUES (?,?,?,?,?,?)', id, discordId, "Same fixture label", "MEMBER", games, 1791460800000);
  fixture.session = session(); fixture.invited = true; fixture.updates = 0; fixture.corruptReadback = false; fixture.failedWrite = false; fixture.failRead = false;
});
afterEach(async () => { await client.$disconnect(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
const ready = () => migration("20261008170000_add_minecraft_tour_done");
const invalidActorHeaders: Record<string, string>[] = [{}, { "X-Minecraft-Tour-User": "" }, { "X-Minecraft-Tour-User": "bad/id" }, { "X-Minecraft-Tour-User": "a".repeat(257) }];

describe("additive own-user Minecraft tour preference", () => {
  it("preserves old user identity/role/grants and defaults both old and newly inserted users to false", async () => {
    const before = await client.$queryRawUnsafe('SELECT "id","discordId","username","avatar","role","games","createdAt" FROM "User" ORDER BY "id"');
    await ready(); expect(await client.$queryRawUnsafe('SELECT "id","discordId","username","avatar","role","games","createdAt" FROM "User" ORDER BY "id"')).toEqual(before);
    expect((await client.user.findMany()).map(user => user.minecraftTourDone)).toEqual([false, false]);
    await client.$executeRawUnsafe('INSERT INTO "User" ("id","discordId","username","createdAt") VALUES (?,?,?,?)', "old-client-new-user", "9007199254740995", "Existing insert shape", 1791460800000);
    expect((await client.user.findUnique({ where: { id: "old-client-new-user" } }))?.minecraftTourDone).toBe(false);
    expect(await client.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: "ok" }]); expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });
  it("does not guess false or seed data when the migration or read is unavailable", async () => {
    const absent = await route.GET(getRequest()); expect(absent.status).toBe(503); expect(await absent.json()).toEqual({ error: "Minecraft tour preference could not be verified" });
    expect((await route.POST(request())).status).toBe(503); expect(fixture.updates).toBe(0);
    await ready(); fixture.failRead = true; const failed = await route.GET(getRequest()); expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain("private fixture");
  });
  it("allows a Minecraft member's own GET without management permission", async () => {
    await ready(); const response = await route.GET(getRequest()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ userId: OWNER, version: 1, done: false }); expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(fixture.updates).toBe(0);
  });
  it.each(invalidActorHeaders)("requires a well-formed expected-actor precondition before reads or body consumption %j", async headers => {
    await ready(); expect((await route.GET(getRequest(headers))).status).toBe(400);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new TextEncoder().encode('{"version":1,"done":true}')); controller.close(); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }); expect((await route.POST(new Request("http://fixture", { method: "POST", headers, body, duplex: "half" } as RequestInit))).status).toBe(400);
    expect(pull).not.toHaveBeenCalled(); expect(fixture.updates).toBe(0);
  });
  it("refuses an old provider's actor pin after cookies switch to another granted account", async () => {
    await ready(); await client.user.update({ where: { id: OTHER }, data: { games: "minecraft" } });
    fixture.session = { ...session(), user: { ...session().user, id: OTHER, discordId: "9007199254740994" } };
    const response = await route.GET(getRequest()); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "The signed-in account changed; reload before using the tour" });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new TextEncoder().encode('{"version":1,"done":true}')); controller.close(); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }); expect((await route.POST(new Request("http://fixture", { method: "POST", headers: { "X-Minecraft-Tour-User": OWNER }, body, duplex: "half" } as RequestInit))).status).toBe(409);
    expect(pull).not.toHaveBeenCalled(); expect(fixture.updates).toBe(0); expect((await client.user.findMany()).every(user => user.minecraftTourDone === false)).toBe(true);
    expect(await (await route.GET(getRequest({ "X-Minecraft-Tour-User": OTHER }))).json()).toEqual({ userId: OTHER, version: 1, done: false });
  });
  it("finishes or skips only the current user, verifies storage, and does not update a replay", async () => {
    await ready(); const original = await client.user.findUnique({ where: { id: OWNER } });
    const response = await route.POST(request()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ userId: OWNER, version: 1, done: true });
    expect(await client.user.findUnique({ where: { id: OWNER } })).toEqual({ ...original, minecraftTourDone: true }); expect((await client.user.findUnique({ where: { id: OTHER } }))?.minecraftTourDone).toBe(false);
    expect((await route.POST(request())).status).toBe(200); expect(fixture.updates).toBe(1); expect(await (await route.GET(getRequest())).json()).toEqual({ userId: OWNER, version: 1, done: true });
  });
  it("keeps completed preference across the existing Discord registration update shape", async () => {
    await ready(); expect((await route.POST(request())).status).toBe(200);
    const { registerDiscordUser } = await import("@/lib/discord-user"); await registerDiscordUser({ discordId: DISCORD, username: "Renamed fixture label", avatar: null });
    expect((await client.user.findUnique({ where: { id: OWNER } }))!).toMatchObject({ username: "Renamed fixture label", role: "MEMBER", games: "minecraft", minecraftTourDone: true });
  });
  it.each([null, [], {}, { version: 1, done: false }, { version: 2, done: true }, { version: "1", done: true }, { version: 1, done: "true" }, { version: 1, done: true, userId: OTHER }, { version: 1, done: true, reset: true }])("refuses reset or malformed/cross-user completion %j", async body => {
    await ready(); expect((await route.POST(request(body))).status).toBe(400); expect(fixture.updates).toBe(0); expect((await client.user.findUnique({ where: { id: OWNER } }))?.minecraftTourDone).toBe(false);
  });
  it("refuses anonymous and ungranted sessions before any preference write", async () => {
    await ready(); fixture.session = null; expect((await route.GET(getRequest())).status).toBe(401); expect((await route.POST(request())).status).toBe(401);
    fixture.session = session("MEMBER", ["zomboid"]); expect((await route.GET(getRequest())).status).toBe(403); expect((await route.POST(request())).status).toBe(403); expect(fixture.updates).toBe(0);
  });
  it.each(["deleted", "grant", "role", "identity", "invitation"])("rechecks canonical authorization after a stale session (%s)", async kind => {
    await ready();
    if (kind === "deleted") await client.user.delete({ where: { id: OWNER } });
    if (kind === "grant") await client.user.update({ where: { id: OWNER }, data: { games: "zomboid" } });
    if (kind === "role") await client.user.update({ where: { id: OWNER }, data: { role: "unknown" } });
    if (kind === "identity") await client.user.update({ where: { id: OWNER }, data: { discordId: "9007199254740996" } });
    if (kind === "invitation") fixture.invited = false;
    expect((await route.GET(getRequest())).status).toBe(kind === "deleted" || kind === "identity" ? 401 : 403); expect((await route.POST(request())).status).toBe(kind === "deleted" || kind === "identity" ? 401 : 403); expect(fixture.updates).toBe(0);
  });
  it("rechecks Minecraft access inside the completion transaction after body consumption", async () => {
    await ready(); const body = new ReadableStream<Uint8Array>({ async pull(controller) { await client.user.update({ where: { id: OWNER }, data: { games: "zomboid" } }); controller.enqueue(new TextEncoder().encode('{"version":1,"done":true}')); controller.close(); } }, { highWaterMark: 0 });
    const response = await route.POST(new Request("http://fixture", { method: "POST", body, headers: { "X-Minecraft-Tour-User": OWNER }, duplex: "half" } as RequestInit)); expect(response.status).toBe(403); expect(fixture.updates).toBe(0); expect((await client.user.findUnique({ where: { id: OWNER } }))?.minecraftTourDone).toBe(false);
  });
  it.each(["write", "readback"])("returns unknown and rolls back an unverified %s", async kind => {
    await ready(); fixture.failedWrite = kind === "write"; fixture.corruptReadback = kind === "readback";
    expect((await route.POST(request())).status).toBe(503); expect((await client.user.findUnique({ where: { id: OWNER } }))?.minecraftTourDone).toBe(false);
  });
  it("bounds declared and streamed body size and rejects malformed JSON", async () => {
    await ready(); expect((await route.POST(request(undefined, { "Content-Length": "1025" }))).status).toBe(413);
    expect((await route.POST(new Request("http://fixture", { method: "POST", headers: { "X-Minecraft-Tour-User": OWNER }, body: '{"version":1,"done":true}' + " ".repeat(1025) }))).status).toBe(413); expect((await route.POST(new Request("http://fixture", { method: "POST", headers: { "X-Minecraft-Tour-User": OWNER }, body: "ordinary invalid JSON" }))).status).toBe(400); expect(fixture.updates).toBe(0);
  });
  it("checks current authorization before touching the request stream", async () => {
    await ready(); await client.user.update({ where: { id: OWNER }, data: { games: "zomboid" } });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new TextEncoder().encode('{"version":1,"done":true}')); controller.close(); }), body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await route.POST(new Request("http://fixture", { method: "POST", body, headers: { "X-Minecraft-Tour-User": OWNER }, duplex: "half" } as RequestInit)); expect(response.status).toBe(403); expect(pull).not.toHaveBeenCalled();
  });
  it("cancels a stalled body before any database completion transaction", async () => {
    await ready(); vi.useFakeTimers(); const cancelled = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 });
    const pending = route.POST(new Request("http://fixture", { method: "POST", body, headers: { "X-Minecraft-Tour-User": OWNER }, duplex: "half" } as RequestInit));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0)); await vi.advanceTimersByTimeAsync(5001);
    expect(cancelled).toHaveBeenCalled(); expect((await pending).status).toBe(408); expect(fixture.updates).toBe(0);
  });
  it("shares the strict one-way completion validator with no false-reset option", () => { expect(() => state.validateMinecraftTourCompletion({ version: 1, done: true })).not.toThrow(); expect(() => state.validateMinecraftTourCompletion({ version: 1, done: false })).toThrow(); });
});
