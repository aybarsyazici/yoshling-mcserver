import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "fixture", role: "ADMIN", games: "minecraft,zomboid,7dtd" } }) }));
vi.mock("@/lib/db", () => ({ db: {
  activity: { create: async () => ({}) },
  serverConfig: { findUnique: async () => ({ mcVersion: "1.21.4" }) },
  zomboidMod: { upsert: async () => ({}) },
} }));

let pauseRead: { file: string; entered: () => void; release: Promise<void> } | null = null;
vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    if (pauseRead?.file === String(args[0])) {
      const held = pauseRead;
      pauseRead = null;
      held.entered();
      await held.release;
    }
    return value;
  } };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root = "";
beforeEach(async () => {
  vi.resetModules();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "yoshling-short-write-")));
  vi.stubEnv("MC_SERVER_DIR", root);
  vi.stubEnv("PZ_SERVER_DIR", root);
  vi.stubEnv("PZ_SERVER_NAME", "fixture");
  vi.stubEnv("PZ_WORKSHOP_DIR", path.join(root, "workshop"));
  vi.stubEnv("STEAM_API_KEY", "");
  await writeFile(path.join(root, "server.properties"), "motd=before\nmax-players=8\n");
  await mkdir(path.join(root, "Server"));
});
afterEach(async () => {
  pauseRead = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
function put(body: object) {
  return new Request("http://fixture.invalid/config", { method: "PUT", body: JSON.stringify(body) }) as NextRequest;
}

describe("short file writes reserve the complete interval", () => {
  it("reserves app whitelist changes independently of game power and releases failures", async () => {
    const operations = await import("@/lib/operations");
    const entered = deferred();
    const release = deferred();
    const target = path.join(root, "sign-in-whitelist.txt");
    const held = operations.runWhitelistWrite(async () => {
      entered.resolve();
      await release.promise;
      operations.assertFileWriteActive();
      await writeFile(target, "FixtureUser");
    });
    await entered.promise;
    try {
      await expect(operations.runWhitelistWrite(async () => "wrong")).rejects.toBeInstanceOf(operations.OperationConflictError);
      await operations.runOperation({ kind: "power", game: "minecraft", action: "stop", title: "Stopping Minecraft" }, async () => ({ value: undefined }));
    } finally { release.resolve(); await held; }
    expect(await readFile(target, "utf-8")).toBe("FixtureUser");
    await expect(operations.runWhitelistWrite(async () => { throw new Error("fixture failed"); })).rejects.toThrow("fixture failed");
    expect(await operations.runWhitelistWrite(async () => "retry")).toBe("retry");
  });

  it("prevents disjoint sandbox rewrites from erasing each other", async () => {
    const file = path.join(root, "Server", "fixture_SandboxVars.lua");
    await writeFile(file, "SandboxVars = {\n  FoodLootNew = 1.0,\n" + Array.from({ length: 200 }, (_, n) => `  Fixture${n} = false,`).join("\n") + "\n}\n");
    const route = await import("@/app/api/zomboid/sandbox/route");
    const entered = deferred();
    const release = deferred();
    pauseRead = { file, entered: () => entered.resolve(), release: release.promise };
    const first = route.PUT(put({ updates: { FoodLootNew: "2.0" } }));
    await entered.promise;
    try {
      expect((await route.PUT(put({ updates: { Fixture0: "true" } }))).status).toBe(409);
    } finally { release.resolve(); await first; }
    expect((await first).status).toBe(200);
    expect((await route.PUT(put({ updates: { Fixture0: "true" } }))).status).toBe(200);
    const { parseSandboxLua } = await import("@/lib/sandbox-lua");
    const values = new Map(parseSandboxLua(await readFile(file, "utf-8")).map(option => [option.name, option.value]));
    expect(values.get("FoodLootNew")).toBe("2.0");
    expect(values.get("Fixture0")).toBe("true");
  });

  it("holds the PZ config lane while a mod install awaits Steam after reading existing lists", async () => {
    const file = path.join(root, "Server", "fixture.ini");
    await writeFile(file, "WorkshopItems=1234\nMods=Existing\n");
    const entered = deferred();
    const release = deferred();
    vi.stubGlobal("fetch", vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ response: { publishedfiledetails: [{ publishedfileid: "5678", result: 1, title: "FixtureMod", description: "Mod ID: Added" }] } });
    }));
    const mods = await import("@/app/api/zomboid/mods/route");
    const files = await import("@/app/api/zomboid/files/route");
    const install = mods.POST(new Request("http://fixture.invalid/mods", { method: "POST", body: JSON.stringify({ workshopId: "5678" }) }) as NextRequest);
    await entered.promise;
    try {
      const rewrite = await files.PUT(new Request("http://fixture.invalid/files", { method: "PUT", body: JSON.stringify({ root: "all", path: "Server/fixture.ini", content: "WorkshopItems=9999\nMods=Lost\n" }) }) as NextRequest);
      expect(rewrite.status).toBe(409);
    } finally { release.resolve(); await install; }
    expect((await install).status).toBe(200);
    expect(await readFile(file, "utf-8")).toBe("WorkshopItems=1234;5678\nMods=Existing;Added\n");
  });

  it("refuses another read-modify-write and a backup until readback, then a retry preserves both edits", async () => {
    const route = await import("@/app/api/server/properties/route");
    const operations = await import("@/lib/operations");
    const entered = deferred();
    const release = deferred();
    pauseRead = { file: path.join(root, "server.properties"), entered: () => entered.resolve(), release: release.promise };
    const first = route.PUT(put({ motd: "first" }));
    await entered.promise;
    try {
      const second = await route.PUT(put({ "max-players": "12" }));
      expect(second.status).toBe(409);
      const copy = vi.fn(async () => ({ value: undefined }));
      await expect(operations.runOperation({ kind: "backup.create", game: "minecraft", title: "Creating a backup" }, copy)).rejects.toBeInstanceOf(operations.OperationConflictError);
      expect(copy).not.toHaveBeenCalled();
      expect(operations.listOperations()).toEqual([]);
      expect(operations.listFinished()).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Saving game files" })]));
      expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=before");
    } finally { release.resolve(); await first; }
    expect((await first).status).toBe(200);
    expect((await route.PUT(put({ "max-players": "12" }))).status).toBe(200);
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toBe("motd=first\nmax-players=12\n");
  });

  it("urgent power preempts a paused write before publication and the response cannot claim success", async () => {
    const route = await import("@/app/api/server/properties/route");
    const operations = await import("@/lib/operations");
    const entered = deferred();
    const release = deferred();
    pauseRead = { file: path.join(root, "server.properties"), entered: () => entered.resolve(), release: release.promise };
    const first = route.PUT(put({ motd: "interrupted" }));
    await entered.promise;
    await operations.runOperation({ kind: "power", game: "minecraft", action: "stop", title: "Stopping Minecraft" }, async () => ({ value: undefined }));
    release.resolve();
    const response = await first;
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.interrupted).toBe(true);
    expect(result.error).toMatch(/Changes may already have occurred/);
    expect(result.error).not.toMatch(/nothing was changed/i);
    expect(await readFile(path.join(root, "server.properties"), "utf-8")).toContain("motd=before");
  });

  it("also rejects a preempted response after publication without pretending the write was undone", async () => {
    const operations = await import("@/lib/operations");
    const published = deferred();
    const release = deferred();
    const target = path.join(root, "published.txt");
    const write = operations.runFileWrite("minecraft", async () => {
      operations.assertFileWriteActive();
      await writeFile(target, "already written");
      published.resolve();
      await release.promise;
      return { success: true };
    });
    await published.promise;
    await operations.runOperation({ kind: "power", game: "minecraft", action: "stop", title: "Stopping Minecraft" }, async () => ({ value: undefined }));
    release.resolve();
    await expect(write).rejects.toBeInstanceOf(operations.FileWriteInterruptedError);
    expect(await readFile(target, "utf-8")).toBe("already written");
  });

  it("releases failed reservations and permits separate games", async () => {
    const operations = await import("@/lib/operations");
    const entered = deferred();
    const release = deferred();
    const first = operations.runFileWrite("minecraft", async () => { entered.resolve(); await release.promise; throw new Error("fixture failed"); });
    await entered.promise;
    expect(await operations.runFileWrite("zomboid", async () => "other world")).toBe("other world");
    release.resolve();
    await expect(first).rejects.toThrow("fixture failed");
    expect(await operations.runFileWrite("minecraft", async () => "retry")).toBe("retry");
  });

  it("shares reservation admission and checkpoints across separate module graphs", async () => {
    const firstGraph = await import("@/lib/operations");
    vi.resetModules();
    const secondGraph = await import("@/lib/operations");
    const entered = deferred();
    const release = deferred();
    const held = firstGraph.runFileWrite("zomboid", async () => { entered.resolve(); await release.promise; secondGraph.assertFileWriteActive(); });
    await entered.promise;
    await expect(secondGraph.runFileWrite("zomboid", async () => "wrong")).rejects.toThrow(/Saving game files/i);
    await secondGraph.runOperation({ kind: "power", game: "zomboid", action: "stop", title: "Stopping Project Zomboid" }, async () => ({ value: undefined }));
    release.resolve();
    await expect(held).rejects.toBeInstanceOf(secondGraph.FileWriteInterruptedError);
  });
});
