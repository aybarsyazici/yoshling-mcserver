import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const SELF = "9007199254740993";
const FRIEND = "9007199254740995";
const OTHER = "18446744073709551615";
const state = vi.hoisted(() => ({ file: "", root: "", session: null as null | { user: { id: string; role: string; discordId: string; games: string[] } },
  readbackMismatch: false, renamed: false, pauseWrite: null as (() => Promise<void>) | null,
  known: [] as { discordId: string; username: string }[],
}));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/db", () => ({ db: { user: { findMany: async ({ where }: { where: { discordId: { in: string[] } } }) => state.known.filter((u) => where.discordId.in.includes(u.discordId)) } } }));
vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return { ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).includes(".whitelist-") && state.pauseWrite) await state.pauseWrite();
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => { await actual.rename(...args); if (String(args[1]) === state.file) state.renamed = true; },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === state.file && state.renamed && state.readbackMismatch) return "[]";
      return actual.readFile(...args);
    },
  };
});
let API: typeof import("@/app/api/whitelist/route");
beforeEach(async () => {
  vi.resetModules();
  state.root = await mkdtemp(path.join(os.tmpdir(), "yoshling-sign-in-policy-")); state.file = path.join(state.root, "whitelist.json");
  state.session = { user: { id: "fixture-admin", role: "ADMIN", discordId: SELF, games: [] } };
  state.readbackMismatch = false; state.renamed = false; state.pauseWrite = null;
  state.known = [{ discordId: SELF, username: "Same display label" }, { discordId: FRIEND, username: "Same display label" }];
  vi.stubEnv("WHITELIST_FILE", state.file); vi.stubEnv("ALLOWED_DISCORD_IDS", ""); vi.stubEnv("ALLOWED_DISCORD_USERS", "");
  await writeFile(state.file, JSON.stringify([SELF, FRIEND]));
  API = await import("@/app/api/whitelist/route");
});
afterEach(async () => { state.pauseWrite = null; await rm(state.root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const params = (body: unknown, revision?: string, raw = false) => new NextRequest("http://localhost/api/whitelist", {
  method: "PUT", headers: { "Content-Type": "application/json", ...(revision ? { "If-Match": revision } : {}) }, body: raw ? String(body) : JSON.stringify(body),
});
const onDisk = () => JSON.parse(readFileSync(state.file, "utf8")) as string[];
async function loaded() { const res = await API.GET(); expect(res.status).toBe(200); const revision = res.headers.get("ETag"); expect(revision).toMatch(/^"[^"\r\n]+"$/); return { revision: revision!, body: await res.json() }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe("sign-in policy API authority", () => {
  it.each(["anonymous", "MOD", "MEMBER", "unknown"])("refuses %s reads and writes without touching the list", async (role) => {
    state.session = role === "anonymous" ? null : { user: { id: "fixture-user", role, discordId: SELF, games: ["minecraft"] } };
    const expected = role === "anonymous" ? 401 : 403;
    expect((await API.GET()).status).toBe(expected); expect((await API.PUT(params({ users: [] , confirmEmpty: true }))).status).toBe(expected);
    expect(onDisk()).toEqual([SELF, FRIEND]);
  });
  it("returns exact IDs, display-only labels, self identity and a source revision", async () => {
    expect((await loaded()).body).toEqual({ users: [SELF, FRIEND], labels: { [SELF]: "Same display label", [FRIEND]: "Same display label" }, source: "file", selfId: SELF });
  });
  it.each(["Same display label", "@friend", Number(SELF), "18446744073709551616", "001234", {}, null])("rejects invalid ID %j without replacing policy", async (entry) => {
    const { revision } = await loaded(); const res = await API.PUT(params({ users: [SELF, entry] }, revision));
    expect(res.status).toBe(400); expect(onDisk()).toEqual([SELF, FRIEND]);
  });
  it("preserves IDs beyond Number precision and deduplicates exact strings", async () => {
    const { revision } = await loaded(); const res = await API.PUT(params({ users: [SELF, FRIEND, OTHER, FRIEND] }, revision));
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ success: true, users: [SELF, FRIEND, OTHER] });
    expect(onDisk()).toEqual([SELF, FRIEND, OTHER]); expect(res.headers.get("ETag")).not.toBe(revision);
    expect(statSync(state.file).mode & 0o777).toBe(0o600); expect(readdirSync(state.root)).toEqual(["whitelist.json"]);
  });
  it("rejects invalid JSON before any replacement", async () => {
    const res = await API.PUT(params("{not-json", undefined, true)); expect(res.status).toBe(400); expect(onDisk()).toEqual([SELF, FRIEND]);
  });
});

describe("explicit changes and conditional publication", () => {
  it("refuses clearing a populated list without explicit confirmation, then stores a deliberate empty policy", async () => {
    const { revision } = await loaded();
    const refused = await API.PUT(params({ users: [] }, revision)); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "confirm_empty" });
    expect(onDisk()).toEqual([SELF, FRIEND]);
    const saved = await API.PUT(params({ users: [], confirmEmpty: true }, revision)); expect(saved.status).toBe(200); expect(onDisk()).toEqual([]);
    const { isWhitelisted } = await import("@/lib/whitelist"); vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isWhitelisted(OTHER)).toBe(true);
  });
  it("refuses self removal without its separate confirmation, then preserves the intended restricted list", async () => {
    const { revision } = await loaded();
    const refused = await API.PUT(params({ users: [FRIEND] }, revision)); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "confirm_self_removal" });
    expect(onDisk()).toEqual([SELF, FRIEND]);
    const saved = await API.PUT(params({ users: [FRIEND], confirmSelfRemoval: true }, revision)); expect(saved.status).toBe(200); expect(onDisk()).toEqual([FRIEND]);
    const { isWhitelisted } = await import("@/lib/whitelist"); expect(await isWhitelisted(SELF)).toBe(false); expect(await isWhitelisted(FRIEND)).toBe(true);
  });
  it("does not confuse empty confirmation with self-removal permission", async () => {
    const { revision } = await loaded(); const res = await API.PUT(params({ users: [FRIEND], confirmEmpty: true }, revision));
    expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ code: "confirm_self_removal" }); expect(onDisk()).toEqual([SELF, FRIEND]);
  });
  it("refuses a stale editor and preserves the newer list", async () => {
    const { revision } = await loaded(); await writeFile(state.file, JSON.stringify([SELF, OTHER]));
    const res = await API.PUT(params({ users: [SELF, FRIEND] }, revision)); expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ stale: true });
    expect(onDisk()).toEqual([SELF, OTHER]);
  });
  it("holds the quiet whitelist resource across awaited file preparation", async () => {
    const { revision } = await loaded(); const entered = deferred<void>(); const resume = deferred<void>(); let paused = false;
    state.pauseWrite = async () => { if (!paused) { paused = true; entered.resolve(); await resume.promise; } };
    const first = API.PUT(params({ users: [SELF, OTHER] }, revision));
    try {
      await entered.promise;
      const second = await API.PUT(params({ users: [SELF, FRIEND, OTHER] }, revision));
      expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ resource: "auth:whitelist" }); expect(onDisk()).toEqual([SELF, FRIEND]);
    } finally { resume.resolve(); await first; }
    expect((await first).status).toBe(200); expect(onDisk()).toEqual([SELF, OTHER]);
  });
  it("does not claim success after a post-publication readback mismatch", async () => {
    const { revision } = await loaded(); state.readbackMismatch = true;
    const res = await API.PUT(params({ users: [SELF, OTHER] }, revision));
    expect(res.status).toBe(500); expect(await res.json()).not.toHaveProperty("success", true); expect(res.headers.get("ETag")).toBeNull(); expect(res.headers.get("X-File-Revision")).toBeNull();
    // Publication did happen; an error here must not imply the old policy remains.
    expect(onDisk()).toEqual([SELF, OTHER]); expect(readdirSync(state.root)).toEqual(["whitelist.json"]);
  });
});

describe("source policy failures", () => {
  it("does not convert a malformed legacy name file into an empty or env-seeded list", async () => {
    await writeFile(state.file, JSON.stringify(["Old display name"])); vi.stubEnv("ALLOWED_DISCORD_IDS", SELF); vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await API.GET(); expect(res.status).toBe(500); expect(await res.json()).not.toHaveProperty("users");
    expect(onDisk()).toEqual(["Old display name"]);
  });
  it("does not echo malformed file contents in its refusal", async () => {
    const marker = "synthetic-policy-canary"; await writeFile(state.file, `${marker}{broken`); vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await API.GET(); expect(res.status).toBe(500); expect(JSON.stringify(await res.json())).not.toContain(marker);
  });
  it("only falls back to the ID env seed when the file is absent", async () => {
    await rm(state.file); vi.stubEnv("ALLOWED_DISCORD_IDS", `${SELF},${OTHER}`);
    const { body } = await loaded(); expect(body.users).toEqual([SELF, OTHER]); expect(body.source).toBe("env");
  });
});

it("prefers the source revision header over a rewritten proxy If-Match", async () => {
  const { revision } = await loaded();
  const request = params({ users: [SELF, OTHER] }, '"proxy-mismatch"'); request.headers.set("X-Expected-File-Revision", revision);
  const saved = await API.PUT(request); expect(saved.status).toBe(200); expect(onDisk()).toEqual([SELF, OTHER]);
  expect(saved.headers.get("X-File-Revision")).toBe(saved.headers.get("ETag"));
});
it("does not fall back to matching If-Match when the preferred source revision is stale", async () => {
  const { revision } = await loaded();
  const request = params({ users: [SELF, OTHER] }, revision); request.headers.set("X-Expected-File-Revision", '"old-source"');
  const refused = await API.PUT(request); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ stale: true }); expect(onDisk()).toEqual([SELF, FRIEND]);
});
it("recognizes a weakened legacy validator for the same source token", async () => {
  const { revision } = await loaded(); const saved = await API.PUT(params({ users: [SELF, OTHER] }, `W/${revision}`));
  expect(saved.status).toBe(200); expect(onDisk()).toEqual([SELF, OTHER]);
});
