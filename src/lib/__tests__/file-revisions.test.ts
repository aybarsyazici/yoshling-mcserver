import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

let configRead: (() => Promise<void>) | null = null;
let activityPause: (() => Promise<void>) | null = null;
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "fixture", role: "ADMIN", games: "minecraft,zomboid,7dtd" } }) }));
vi.mock("@/lib/db", () => ({ db: {
  activity: { create: async () => { await activityPause?.(); return {}; } },
  serverConfig: { findUnique: async () => { await configRead?.(); return { mcVersion: "1.21.4" }; } },
  sevenDaysConfig: { findUnique: async () => null, upsert: async () => ({}) },
  zomboidMod: { findMany: async () => [], upsert: async () => ({}), findUnique: async () => null, delete: async () => ({}) },
} }));
vi.mock("@/lib/mc-identity", () => ({ resolveEntryUuids: async (entries: object[]) => ({ ok: true, entries }) }));
vi.mock("@/lib/rcon", () => ({ rconCommand: async () => { throw new Error("Offline fixture"); } }));

let root = "";
beforeEach(async () => {
  vi.resetModules();
  configRead = null;
  activityPause = null;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "yoshling-file-revision-")));
  vi.stubEnv("MC_SERVER_DIR", root);
  vi.stubEnv("PZ_SERVER_DIR", root);
  vi.stubEnv("PZ_SERVER_NAME", "fixture");
  vi.stubEnv("PZ_WORKSHOP_DIR", path.join(root, "workshop"));
  vi.stubEnv("SDTD_CONFIG_DIR", root);
  vi.stubEnv("SDTD_SERVER_DIR", root);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ response: { publishedfiledetails: [] } })));
  await mkdir(path.join(root, "Server"));
  await writeFile(path.join(root, "server.properties"), "motd=before\nmax-players=8\nrcon.password=fabricated-secret\n");
  await writeFile(path.join(root, "ops.json"), "[]");
  await writeFile(path.join(root, "whitelist.json"), "[]");
  await writeFile(path.join(root, "sdtdserver.xml"), '<ServerSettings><property name="ServerName" value="Fixture"/><property name="ServerMaxPlayerCount" value="8"/><property name="ServerPassword" value=""/><property name="SandboxCode" value="ABEABTBBWADFP"/></ServerSettings>');
  await writeFile(path.join(root, "Server", "fixture.ini"), "PVP=false\nWorkshopItems=\nMods=\nMap=Muldraugh, KY\n");
  await writeFile(path.join(root, "Server", "fixture_SandboxVars.lua"), "SandboxVars = {\n FoodLootNew = 1.0,\n" + Array.from({ length: 200 }, (_, n) => ` Fixture${n} = false,`).join("\n") + "\n}\n");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
function request(method: string, body?: unknown, match?: string, url = "http://fixture.invalid/config") {
  return new NextRequest(url, { method, headers: match ? { "If-Match": match } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("opaque editable snapshot revisions", () => {
  it("retains opaque revision transport when a proxy removes the ETag", async () => {
    const route = await import("@/app/api/server/properties/route");
    const loaded = await route.GET();
    const revision = loaded.headers.get("X-File-Revision")!;
    expect(revision).toBe(loaded.headers.get("ETag"));
    expect(revision).toMatch(/^"[a-f\d]{64}"$/);
    loaded.headers.delete("ETag");
    expect(loaded.headers.get("ETag")).toBeNull();
    const save = request("PUT", { motd: "custom header save" });
    save.headers.set("X-Expected-File-Revision", loaded.headers.get("X-File-Revision")!);
    const written = await route.PUT(save);
    expect(written.status).toBe(200);
    expect(written.headers.get("X-File-Revision")).toBe(written.headers.get("ETag"));
    expect(written.headers.get("X-File-Revision")).not.toBe(revision);
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=custom header save");
    const stale = request("PUT", { motd: "stale opaque header" });
    stale.headers.set("X-Expected-File-Revision", revision);
    expect((await route.PUT(stale)).status).toBe(409);
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=custom header save");
  });

  it("accepts a weakened ETag carrying the same keyed edit token", async () => {
    const route = await import("@/app/api/server/properties/route");
    const loaded = await route.GET();
    const tag = loaded.headers.get("ETag")!;
    loaded.headers.set("ETag", `W/${tag}`);
    const response = await route.PUT(request("PUT", { motd: "weak proxy tag" }, loaded.headers.get("ETag")!));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-File-Revision")).toBe(response.headers.get("ETag"));
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=weak proxy tag");
  });

  it("prefers the explicit opaque token over conflicting representation validators", async () => {
    const route = await import("@/app/api/server/properties/route");
    const revision = (await route.GET()).headers.get("X-File-Revision")!;
    const rejected = request("PUT", { motd: "must not write" }, revision);
    rejected.headers.set("X-Expected-File-Revision", '"incorrect-opaque-token"');
    expect((await route.PUT(rejected)).status).toBe(409);
    const accepted = request("PUT", { motd: "correct opaque token" }, 'W/"incorrect-representation-tag"');
    accepted.headers.set("X-Expected-File-Revision", revision);
    expect((await route.PUT(accepted)).status).toBe(200);
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=correct opaque token");
  });

  it("preserves JSON shapes and rejects a stale properties snapshot without changing bytes", async () => {
    const route = await import("@/app/api/server/properties/route");
    const response = await route.GET();
    expect(await response.json()).toEqual({ motd: "before", "max-players": "8" });
    const tag = response.headers.get("ETag")!;
    expect(tag).toMatch(/^"[a-f\d]{64}"$/);
    const update = await route.PUT(request("PUT", { motd: "first" }, tag));
    expect(update.status).toBe(200);
    expect(update.headers.get("ETag")).not.toBe(tag);
    const before = await readFile(path.join(root, "server.properties"), "utf-8");
    const stale = await route.PUT(request("PUT", { "max-players": "12" }, tag));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ stale: true, error: expect.stringMatching(/changed since you loaded/) });
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toBe(before);
    expect((await route.PUT(request("PUT", { "max-players": "12" }))).status).toBe(200);
  });

  it("does not expose a guessable hash of hidden credential bytes and binds revisions to file identity", async () => {
    const { fileRevision } = await import("@/lib/file-revision");
    const file = path.join(root, "server.properties");
    const before = await readFile(file);
    const guess = createHash("sha256").update(file).update("\0present\0").update(before).digest("hex");
    expect(await fileRevision(file)).not.toBe(`"${guess}"`);
    const other = path.join(root, "other.properties");
    await writeFile(other, before);
    expect(await fileRevision(other)).not.toBe(await fileRevision(file));
    const route = await import("@/app/api/server/properties/route");
    const response = await route.GET();
    await writeFile(file, before.toString().replace("fabricated-secret", "rotated-fixture-secret"));
    const next = await route.GET();
    expect(await next.json()).toEqual(await response.json());
    expect(next.headers.get("ETag")).not.toBe(response.headers.get("ETag"));
  });

  it("rechecks after slow preparation so an out-of-band rewrite cannot be overwritten", async () => {
    const route = await import("@/app/api/server/properties/route");
    const tag = (await route.GET()).headers.get("ETag")!;
    const entered = deferred();
    const release = deferred();
    configRead = async () => { entered.resolve(); await release.promise; };
    const pending = route.PUT(request("PUT", { motd: "stale operator" }, tag));
    await entered.promise;
    const file = path.join(root, "server.properties");
    await writeFile(file, "motd=external current\nmax-players=8\n");
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).stale).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("motd=external current\nmax-players=8\n");
  });

  it("returns the published revision rather than adopting a later rewrite as the saved snapshot", async () => {
    const route = await import("@/app/api/server/properties/route");
    const { fileRevision } = await import("@/lib/file-revision");
    const initial = (await route.GET()).headers.get("ETag")!;
    const entered = deferred();
    const release = deferred();
    activityPause = async () => { entered.resolve(); await release.promise; };
    const pending = route.PUT(request("PUT", { motd: "published first" }, initial));
    await entered.promise;
    const file = path.join(root, "server.properties");
    const published = await fileRevision(file);
    await writeFile(file, "motd=external current\nmax-players=8\n");
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(published);
    expect(response.headers.get("ETag")).not.toBe(await fileRevision(file));
    activityPause = null;
    expect((await route.PUT(request("PUT", { motd: "stale draft" }, response.headers.get("ETag")!))).status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe("motd=external current\nmax-players=8\n");
  });

  it("keeps missing-file revisions distinct and shares the random key across module graphs", async () => {
    const first = await import("@/lib/file-revision");
    const file = path.join(root, "absent.txt");
    const missing = await first.fileRevision(file);
    await writeFile(file, "missing");
    expect(await first.fileRevision(file)).not.toBe(missing);
    vi.resetModules();
    const second = await import("@/lib/file-revision");
    expect(await second.fileRevision(file)).toBe(await first.fileRevision(file));
  });

  it("refuses a changed read projection instead of pairing old data with a current revision", async () => {
    const { revisionRead } = await import("@/lib/operation-response");
    const { readFileSnapshot } = await import("@/lib/file-revision");
    const file = path.join(root, "server.properties");
    const response = await revisionRead(async () => file, async () => {
      await readFileSnapshot(file);
      await writeFile(file, "motd=changed while reading\n");
      return NextResponse.json({ motd: "before" });
    });
    expect(response.status).toBe(409);
    expect((await response.json()).stale).toBe(true);
    expect(response.headers.get("ETag")).toBeNull();
  });

  it("refuses an ABA rewrite when the parsed bytes differ from the terminal source", async () => {
    const { revisionRead } = await import("@/lib/operation-response");
    const { readFileSnapshot, fileRevision } = await import("@/lib/file-revision");
    const file = path.join(root, "server.properties");
    const initial = await readFile(file);
    const before = await fileRevision(file);
    const response = await revisionRead(async () => file, async () => {
      await writeFile(file, "motd=intermediate snapshot\n");
      const parsed = await readFileSnapshot(file, "utf-8");
      await writeFile(file, initial);
      return NextResponse.json({ content: parsed });
    });
    expect(await fileRevision(file)).toBe(before);
    expect(response.status).toBe(409);
    expect((await response.json()).stale).toBe(true);
    expect(response.headers.get("ETag")).toBeNull();
  });

  it.each(["ops", "mc-whitelist"])("protects stale %s array replacement and returns a new revision", async (kind) => {
    const route = kind === "ops" ? await import("@/app/api/server/ops/route") : await import("@/app/api/server/mc-whitelist/route");
    const loaded = await route.GET();
    expect(await loaded.json()).toEqual([]);
    const tag = loaded.headers.get("ETag")!;
    const body = [{ name: "Fixture", uuid: "fixture", ...(kind === "ops" ? { level: 4 } : {}) }];
    expect((await route.PUT(request("PUT", body, tag))).status).toBe(200);
    const stale = await route.PUT(request("PUT", [], tag));
    expect(stale.status).toBe(409);
    expect(await readFile(path.join(root, kind === "ops" ? "ops.json" : "whitelist.json"), "utf-8")).toContain("Fixture");
  });

  it.each(["server", "7dtd", "zomboid"])("protects an edited file snapshot through the actual %s browser route", async game => {
    const route = game === "server" ? await import("@/app/api/server/files/route") : game === "7dtd" ? await import("@/app/api/7dtd/files/route") : await import("@/app/api/zomboid/files/route");
    await writeFile(path.join(root, "editable.txt"), "before");
    const folder = game === "7dtd" ? "config" : "all";
    const response = await route.GET(request("GET", undefined, undefined, `http://fixture.invalid/files?root=${folder}&path=editable.txt&action=read`));
    const tag = response.headers.get("ETag")!;
    expect(tag).toBeTruthy();
    expect((await route.PUT(request("PUT", { root: folder, path: "editable.txt", content: "first" }, tag))).status).toBe(200);
    expect((await route.PUT(request("PUT", { root: folder, path: "editable.txt", content: "stale" }, tag))).status).toBe(409);
    expect(await readFile(path.join(root, "editable.txt"), "utf-8")).toBe("first");
  });

  it("shares XML revision across quick and all settings, refusing cross-panel stale writes", async () => {
    const quick = await import("@/app/api/7dtd/config/route");
    const all = await import("@/app/api/7dtd/config/all/route");
    const tag = (await quick.GET()).headers.get("ETag")!;
    expect((await all.GET()).headers.get("ETag")).toBe(tag);
    const file = path.join(root, "sdtdserver.xml");
    const updated = (await readFile(file, "utf-8")).replace('value="Fixture"', 'value="Current"');
    await writeFile(file, updated);
    expect((await quick.PUT(request("PUT", { serverName: "stale" }, tag))).status).toBe(409);
    expect((await all.PUT(request("PUT", { updates: { ServerName: "stale" } }, tag))).status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe(updated);
  });

  it("shares the PZ INI revision for settings, maps and all mod mutations", async () => {
    const config = await import("@/app/api/zomboid/config/route");
    const maps = await import("@/app/api/zomboid/maps/route");
    const mods = await import("@/app/api/zomboid/mods/route");
    const tag = (await config.GET()).headers.get("ETag")!;
    expect((await maps.GET()).headers.get("ETag")).toBe(tag);
    expect((await mods.GET()).headers.get("ETag")).toBe(tag);
    const file = path.join(root, "Server", "fixture.ini");
    const updated = "PVP=true\nWorkshopItems=\nMods=\nMap=Muldraugh, KY\n";
    await writeFile(file, updated);
    expect((await config.PUT(request("PUT", { updates: { PVP: "false" } }, tag))).status).toBe(409);
    expect((await maps.PUT(request("PUT", { order: ["Muldraugh, KY"] }, tag))).status).toBe(409);
    expect((await mods.POST(request("POST", { workshopId: "1234" }, tag))).status).toBe(409);
    expect((await mods.PATCH(request("PATCH", { workshopId: "1234", modIds: [] }, tag))).status).toBe(409);
    expect((await mods.DELETE(request("DELETE", undefined, tag, "http://fixture.invalid/mods?workshopId=1234"))).status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe(updated);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a stale sandbox snapshot before creating its backup or temporary file", async () => {
    const route = await import("@/app/api/zomboid/sandbox/route");
    const tag = (await route.GET(request("GET"))).headers.get("ETag")!;
    const file = path.join(root, "Server", "fixture_SandboxVars.lua");
    const updated = (await readFile(file, "utf-8")).replace("FoodLootNew = 1.0", "FoodLootNew = 2.0");
    await writeFile(file, updated);
    const response = await route.PUT(request("PUT", { updates: { FoodLootNew: "3.0" } }, tag));
    expect(response.status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe(updated);
    expect(await readFile(`${file}.bak`).catch(() => null)).toBeNull();
  });
});
