import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client, type InValue } from "@libsql/client";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Token = Record<string, unknown>;
interface DbUser { id: string; discordId: string; username: string; avatar: string | null; role: string; games: string }
interface AuthConfig {
  callbacks: {
    signIn(input: { user: { name?: string | null; image?: string | null }; profile?: Record<string, unknown> }): Promise<boolean>;
    jwt(input: { token: Token; profile?: Record<string, unknown> }): Promise<Token | null>;
    session(input: { session: { user: Record<string, unknown> }; token?: Token | null }): Promise<{ user: Record<string, unknown> }>;
  };
  session: { strategy: string };
}
interface Query { where: { id?: string; discordId?: string; username?: string } }
const capture = vi.hoisted(() => ({ config: null as AuthConfig | null }));
vi.mock("next-auth", () => ({ default: (config: AuthConfig) => { capture.config = config; return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() }; } }));
vi.mock("next-auth/providers/discord", () => ({ default: () => ({ id: "discord", type: "oauth" }) }));

const ALICE = "9007199254740992";
const BOB = "9007199254740993";
const CAROL = "18446744073709551615";
const OUTSIDER = "100000000000000001";
let clients: Client[] = [];
let rawIndex = 0;
let root = "";
let policyFile = "";
let rawBarrier: (() => Promise<void>) | null = null;
let skipSql = false;
let wrongReadback: "missing" | "id" | "name" | "avatar" | null = null;
const queries: Query[] = [];

function mapped(row: Record<string, unknown>): DbUser {
  return { id: String(row.id), discordId: String(row.discordId), username: String(row.username), avatar: row.avatar === null ? null : String(row.avatar), role: String(row.role), games: String(row.games) };
}
async function lookup(query: Query): Promise<DbUser | null> {
  queries.push(query);
  const key = query.where.discordId !== undefined ? "discordId" : query.where.id !== undefined ? "id" : "username";
  const value = query.where[key];
  if (typeof value !== "string") throw new Error("Fixture lookup has no identity");
  const result = await clients[0].execute({ sql: `SELECT * FROM "User" WHERE "${key}" = ? LIMIT 1`, args: [value] });
  let user = result.rows.length ? mapped(result.rows[0]) : null;
  if (wrongReadback === "missing") user = null;
  else if (user && wrongReadback === "id") user.discordId = OUTSIDER;
  else if (user && wrongReadback === "name") user.username = "Wrong readback";
  else if (user && wrongReadback === "avatar") user.avatar = "wrong-avatar-fixture";
  return user;
}
vi.mock("@/lib/db", () => ({ db: {
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    await rawBarrier?.();
    if (skipSql) return 0;
    const args: InValue[] = values.map(value => {
      if (typeof value === "string" || typeof value === "number" || value === null) return value;
      throw new Error("Fixture SQL received an unsupported argument");
    });
    const client = clients[rawIndex++ % clients.length];
    const sql = strings.join("?");
    const result = await client.execute({ sql, args });
    return result.rowsAffected;
  },
  user: { findUnique: lookup, findFirst: lookup },
} }));

beforeEach(async () => {
  vi.resetModules();
  capture.config = null;
  rawIndex = 0;
  rawBarrier = null;
  skipSql = false;
  wrongReadback = null;
  queries.length = 0;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "yoshling-auth-sql-")));
  policyFile = path.join(root, "whitelist.json");
  await writeFile(policyFile, JSON.stringify([ALICE, BOB, CAROL]));
  vi.stubEnv("WHITELIST_FILE", policyFile);
  vi.stubEnv("ALLOWED_DISCORD_IDS", "");
  vi.stubEnv("ALLOWED_DISCORD_USERS", "");
  vi.stubEnv("DISCORD_CLIENT_ID", "fixture-client");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "fixture-client-secret");
  const url = `file:${path.join(root, "identity.db")}`;
  clients = [createClient({ url }), createClient({ url })];
  await clients[0].execute('PRAGMA journal_mode = WAL');
  for (const client of clients) await client.execute('PRAGMA busy_timeout = 5000');
  await clients[0].execute('CREATE TABLE "User" ("id" TEXT PRIMARY KEY NOT NULL, "discordId" TEXT NOT NULL UNIQUE, "username" TEXT NOT NULL, "avatar" TEXT, "role" TEXT NOT NULL DEFAULT \'MEMBER\', "games" TEXT NOT NULL DEFAULT \'\', "createdAt" INTEGER NOT NULL)');
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("@/lib/auth");
});
afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const callbacks = () => capture.config!.callbacks;
function signIn(id: unknown, username = "Mutable display label") {
  return callbacks().signIn({ user: { name: username, image: "avatar-fixture" }, profile: { id, username, global_name: username } });
}
async function user(id: string) {
  const result = await clients[0].execute({ sql: 'SELECT * FROM "User" WHERE "discordId" = ?', args: [id] });
  return result.rows.length ? mapped(result.rows[0]) : null;
}

describe("Discord callbacks use immutable identity and current policy", () => {
  it("refuses username/global-name spoofing and numeric profile IDs without touching the DB", async () => {
    expect(await signIn(OUTSIDER, "Invited Administrator")).toBe(false);
    expect(await signIn(OUTSIDER, ALICE)).toBe(false);
    expect(await callbacks().signIn({ user: { name: ALICE }, profile: { id: OUTSIDER, username: "Outsider", global_name: ALICE } })).toBe(false);
    expect(await callbacks().signIn({ user: { name: ALICE }, profile: { username: ALICE, global_name: ALICE } })).toBe(false);
    expect(await signIn(Number(BOB), ALICE)).toBe(false);
    expect((await clients[0].execute('SELECT * FROM "User"')).rows).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("stores exact adjacent snowflakes and allows mutable labels to collide without merging accounts", async () => {
    expect(await signIn(ALICE, "Same display label")).toBe(true);
    expect(await signIn(BOB, "Same display label")).toBe(true);
    const alice = await user(ALICE);
    const bob = await user(BOB);
    expect(alice?.discordId).toBe(ALICE);
    expect(bob?.discordId).toBe(BOB);
    expect(alice?.id).not.toBe(bob?.id);
    expect(alice?.role).toBe("ADMIN");
    expect(bob).toMatchObject({ role: "MEMBER", games: "" });
  });

  it("refreshes role, grants and display label from the canonical DB row", async () => {
    await signIn(ALICE, "Current label");
    const existing = (await user(ALICE))!;
    await clients[0].execute({ sql: 'UPDATE "User" SET "role" = ?, "games" = ? WHERE "discordId" = ?', args: ["MOD", "zomboid,minecraft,unknown,minecraft", ALICE] });
    const refreshed = await callbacks().jwt({ token: { id: "wrong old id", discordId: ALICE, role: "ADMIN", games: "minecraft,7dtd,zomboid", name: "stale label" } });
    expect(refreshed).toMatchObject({ id: existing.id, discordId: ALICE, role: "MOD", games: "zomboid,minecraft,unknown,minecraft", name: "Current label" });
    const session = await callbacks().session({ session: { user: {} }, token: refreshed });
    expect(session.user).toMatchObject({ id: existing.id, role: "MOD", discordId: ALICE, games: ["minecraft", "zomboid"] });
    await clients[0].execute({ sql: 'UPDATE "User" SET "role" = ?, "games" = ? WHERE "discordId" = ?', args: ["MEMBER", "", ALICE] });
    const revokedGrants = await callbacks().jwt({ token: refreshed! });
    expect(revokedGrants).toMatchObject({ role: "MEMBER", games: "" });
    expect((await callbacks().session({ session: { user: {} }, token: revokedGrants })).user.games).toEqual([]);
  });

  it("returns null for revoked invitations and deleted accounts rather than retaining ADMIN claims", async () => {
    await signIn(ALICE);
    const existing = (await user(ALICE))!;
    const stale = { id: existing.id, discordId: ALICE, role: "ADMIN", games: "minecraft,7dtd,zomboid" };
    await writeFile(policyFile, JSON.stringify([BOB]));
    expect(await callbacks().jwt({ token: { ...stale } })).toBeNull();
    await writeFile(policyFile, JSON.stringify([ALICE]));
    await clients[0].execute({ sql: 'DELETE FROM "User" WHERE "discordId" = ?', args: [ALICE] });
    expect(await callbacks().jwt({ token: { ...stale } })).toBeNull();
  });

  it("fails closed when an existing session's policy becomes invalid or unreadable", async () => {
    await signIn(ALICE);
    await writeFile(policyFile, '["Invited Administrator"]');
    expect(await callbacks().jwt({ token: { discordId: ALICE, role: "ADMIN" } })).toBeNull();
    await rm(policyFile);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(policyFile);
    expect(await callbacks().jwt({ token: { discordId: ALICE, role: "ADMIN" } })).toBeNull();
  });

  it("accepts verified legacy local id or Discord sub while refusing name-only claims", async () => {
    await signIn(ALICE, "Invited Administrator");
    const existing = (await user(ALICE))!;
    expect(await callbacks().jwt({ token: { id: existing.id, name: "old label" } })).toMatchObject({ id: existing.id, discordId: ALICE });
    expect(await callbacks().jwt({ token: { sub: ALICE, name: "old label" } })).toMatchObject({ id: existing.id, discordId: ALICE });
    queries.length = 0;
    expect(await callbacks().jwt({ token: { name: "Invited Administrator", role: "ADMIN", games: "minecraft,7dtd,zomboid" } })).toBeNull();
    expect(queries).toEqual([]);
  });

  it("uses the fresh OAuth immutable identity rather than a mismatching stale token", async () => {
    await signIn(ALICE, "First");
    await signIn(BOB, "Second");
    const current = await callbacks().jwt({ token: { discordId: ALICE, role: "ADMIN" }, profile: { id: BOB } });
    expect(current).toMatchObject({ discordId: BOB, role: "MEMBER", games: "", name: "Second" });
    expect(await callbacks().jwt({ token: { discordId: ALICE, role: "ADMIN" }, profile: { id: Number(BOB) } })).toBeNull();
  });

  it("refuses a stale invalid explicit identity even when its local id would otherwise resolve", async () => {
    await signIn(ALICE);
    const existing = (await user(ALICE))!;
    expect(await callbacks().jwt({ token: { id: existing.id, discordId: "Invited Administrator", role: "ADMIN" } })).toBeNull();
  });

  it.each(["OWNER", "admin", "", null])("refuses unknown stored role %j and unverifiable session claims", async role => {
    await signIn(ALICE);
    if (role !== null) await clients[0].execute({ sql: 'UPDATE "User" SET "role" = ? WHERE "discordId" = ?', args: [role, ALICE] });
    if (role !== null) expect(await callbacks().jwt({ token: { discordId: ALICE, role: "ADMIN" } })).toBeNull();
    await expect(callbacks().session({ session: { user: {} }, token: { id: "local", discordId: ALICE, role } })).rejects.toThrow(/could not be verified/);
  });
});

describe("registration executes atomic SQL against actual temporary SQLite", () => {
  it("admits exactly one first ADMIN across concurrent sign-ins on independent connections", async () => {
    let entered = 0;
    let release!: () => void;
    const allArrived = new Promise<void>(resolve => { release = resolve; });
    rawBarrier = async () => { if (++entered === 3) release(); await allArrived; };
    expect(await Promise.all([signIn(ALICE, "First label"), signIn(BOB, "Second label"), signIn(CAROL, "Third label")])).toEqual([true, true, true]);
    rawBarrier = null;
    const rows = (await clients[0].execute('SELECT * FROM "User"')).rows.map(mapped);
    expect(rows).toHaveLength(3);
    const admins = rows.filter(row => row.role === "ADMIN");
    expect(admins).toHaveLength(1);
    expect(admins[0].games).toBe("minecraft,7dtd,zomboid");
    expect(rows.filter(row => row.role === "MEMBER").map(row => row.games)).toEqual(["", ""]);
    expect(new Set(rows.map(row => row.discordId))).toEqual(new Set([ALICE, BOB, CAROL]));
  });

  it("updates labels/avatar for the same ID while preserving local identity, role and grants", async () => {
    const { registerDiscordUser } = await import("@/lib/discord-user");
    await registerDiscordUser({ discordId: ALICE, username: "Original", avatar: "original-avatar" });
    const existing = (await user(ALICE))!;
    await clients[0].execute({ sql: 'UPDATE "User" SET "role" = ?, "games" = ? WHERE "discordId" = ?', args: ["MOD", "zomboid", ALICE] });
    const literal = "Renamed'; UPDATE User SET role='ADMIN'; --";
    await registerDiscordUser({ discordId: ALICE, username: literal, avatar: "new-avatar" });
    expect(await user(ALICE)).toEqual({ ...existing, username: literal, avatar: "new-avatar", role: "MOD", games: "zomboid" });
    await registerDiscordUser({ discordId: ALICE, username: "Newest label", avatar: null });
    expect(await user(ALICE)).toEqual({ ...existing, username: "Newest label", avatar: "new-avatar", role: "MOD", games: "zomboid" });
    expect((await clients[0].execute('SELECT * FROM "User"')).rows).toHaveLength(1);
  });

  it("does not report registration when the database write did nothing", async () => {
    const { registerDiscordUser } = await import("@/lib/discord-user");
    skipSql = true;
    await expect(registerDiscordUser({ discordId: ALICE, username: "Fixture", avatar: "avatar" })).rejects.toThrow(/could not be verified/);
    await expect(signIn(ALICE)).rejects.toThrow(/could not be verified/);
    expect((await clients[0].execute('SELECT * FROM "User"')).rows).toEqual([]);
  });

  it.each(["missing", "id", "name", "avatar"] as const)("does not report success after %s readback", async mismatch => {
    const { registerDiscordUser } = await import("@/lib/discord-user");
    wrongReadback = mismatch;
    await expect(registerDiscordUser({ discordId: ALICE, username: "Fixture", avatar: "avatar" })).rejects.toThrow(/could not be verified/);
    wrongReadback = null;
    expect(await user(ALICE)).toMatchObject({ discordId: ALICE, username: "Fixture", avatar: "avatar" });
  });
});
