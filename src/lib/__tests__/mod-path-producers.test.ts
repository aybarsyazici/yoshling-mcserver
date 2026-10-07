import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestsOf } from "@/lib/mod-admission";
import { reconcileMods } from "@/lib/mod-inventory";
import { verifyRequiredDependencies } from "@/lib/mod-dependencies";
import type { ModrinthProject, ModrinthVersion } from "@/lib/modrinth";

const context = vi.hoisted(() => ({
  mods: "", row: null as { id: string; name: string; fileName: string; version: string; mcVersion: string; loader: string } | null,
  creates: [] as Record<string, unknown>[], deletes: [] as string[], updates: [] as Record<string, unknown>[], activities: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/server-manager", () => ({ getModsDir: () => context.mods }));
vi.mock("@/lib/db", () => ({ db: {
  installedMod: {
    findUnique: async () => context.row,
    create: async ({ data }: { data: Record<string, unknown> }) => { context.creates.push(data); },
    delete: async ({ where }: { where: { id: string } }) => { context.deletes.push(where.id); },
    update: async ({ data }: { data: Record<string, unknown> }) => { context.updates.push(data); },
  },
  activity: { create: async ({ data }: { data: Record<string, unknown> }) => { context.activities.push(data); } },
} }));
const { installMod, removeMod, updateMod } = await import("@/lib/mod-manager");
const JAR = Buffer.from("PK\x03\x04 ordinary fabricated jar bytes");
const HASHES = digestsOf(JAR);
let root: string;
let game: string;
let outside: string;
function version(fileName = "thing.jar"): ModrinthVersion {
  return {
    id: "build-1", project_id: "dependency", name: "Dependency", version_number: "1.0.0", game_versions: ["26.1.2"],
    loaders: ["fabric"], downloads: 1, date_published: "2026-10-01", dependencies: [], environment: "client_and_server",
    files: [{ filename: fileName, primary: true, size: JAR.length, hashes: HASHES, url: "https://cdn.modrinth.test/fixture.jar" }],
  };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mod-path-producers-"));
  game = path.join(root, "game");
  outside = path.join(root, "outside");
  context.mods = path.join(game, "mods");
  await mkdir(context.mods, { recursive: true });
  await mkdir(outside);
  context.creates = []; context.deletes = []; context.updates = []; context.activities = [];
  context.row = { id: "row-1", name: "Thing", fileName: "thing.jar", version: "0.9.0", mcVersion: "26.1.2", loader: "fabric" };
  vi.stubEnv("MC_SERVER_DIR", game);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})).mockImplementation(async () => new Response(JAR)));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const install = (selected = version()) => installMod({ modrinthId: "dependency", slug: "thing", name: "Thing", version: selected, userId: "actor", source: "manual" });
async function escapedDirectory() {
  await rm(context.mods, { recursive: true });
  await symlink(outside, context.mods);
}
async function dependencyReading() {
  return verifyRequiredDependencies({
    version: { ...version("selected.jar"), id: "selected-build", project_id: "selected", dependencies: [{ project_id: "dependency", version_id: "build-1", dependency_type: "required" }] },
    mcVersion: "26.1.2", loader: "fabric", modsDir: context.mods, boundaryRoot: game,
    installed: [{ modrinthId: "dependency", name: "Dependency", fileName: "thing.jar", versionId: "build-1" }],
  }, {
    getProject: async () => ({ id: "dependency", title: "Dependency" }) as ModrinthProject,
    getVersion: async () => version(), getProjectVersions: async () => [version()],
  });
}

describe("mod writers use real physical admission before file/database effects", () => {
  it("writes the verified jar inside the game root and keeps provenance", async () => {
    const check = await install();
    expect(check.checked).toBe("sha512");
    expect(await readFile(path.join(context.mods, "thing.jar"))).toEqual(JAR);
    expect(context.creates[0]).toMatchObject({ source: "manual", versionId: "build-1", fileName: "thing.jar" });
  });

  it("removes the contained file and its row", async () => {
    await writeFile(path.join(context.mods, "thing.jar"), JAR);
    await removeMod("row-1", "actor");
    await expect(readFile(path.join(context.mods, "thing.jar"))).rejects.toThrow();
    expect(context.deletes).toEqual(["row-1"]);
  });

  it("removes only an internal final link, preserving its target", async () => {
    await writeFile(path.join(context.mods, "target.jar"), JAR);
    await symlink("target.jar", path.join(context.mods, "thing.jar"));
    await removeMod("row-1", "actor");
    expect(await readFile(path.join(context.mods, "target.jar"))).toEqual(JAR);
    await expect(readFile(path.join(context.mods, "thing.jar"))).rejects.toThrow();
  });

  it("still removes a missing inventory file without needing a mods directory", async () => {
    await rm(context.mods, { recursive: true });
    await removeMod("row-1", "actor");
    expect(context.deletes).toEqual(["row-1"]);
  });

  it.each(["install", "remove", "update"])("refuses %s through a mods-root link outside the game volume", async (action) => {
    await writeFile(path.join(outside, "thing.jar"), "preserve outside fixture");
    await escapedDirectory();
    const attempt = action === "install" ? install() : action === "remove" ? removeMod("row-1", "actor") : updateMod("row-1", version(), "actor");
    await expect(attempt).rejects.toThrow(/outside/);
    expect(await readFile(path.join(outside, "thing.jar"), "utf8")).toBe("preserve outside fixture");
    expect(context.creates).toEqual([]); expect(context.deletes).toEqual([]); expect(context.updates).toEqual([]); expect(context.activities).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an install through an escaped final jar link", async () => {
    await writeFile(path.join(outside, "fixture"), "preserve outside fixture");
    await symlink(path.join(outside, "fixture"), path.join(context.mods, "thing.jar"));
    await expect(install()).rejects.toThrow(/outside/);
    expect(await readFile(path.join(outside, "fixture"), "utf8")).toBe("preserve outside fixture");
    expect(context.creates).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates an update destination before removing the previous jar", async () => {
    await writeFile(path.join(context.mods, "thing.jar"), JAR);
    await writeFile(path.join(outside, "fixture"), "preserve outside fixture");
    await symlink(path.join(outside, "fixture"), path.join(context.mods, "new.jar"));
    await expect(updateMod("row-1", version("new.jar"), "actor")).rejects.toThrow(/outside/);
    expect(await readFile(path.join(context.mods, "thing.jar"))).toEqual(JAR);
    expect(await readFile(path.join(outside, "fixture"), "utf8")).toBe("preserve outside fixture");
    expect(context.updates).toEqual([]); expect(context.activities).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["../outside.jar", "/outside.jar", "nested/thing.jar", "nested\\thing.jar"])("refuses non-basename metadata %s", async (fileName) => {
    await mkdir(path.join(context.mods, "nested"));
    await expect(install(version(fileName))).rejects.toThrow(/filename/);
    expect(context.creates).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("inventory and dependency verification cannot fingerprint outside the game volume", () => {
  it("refuses an inventory root linked outside the game volume", async () => {
    await writeFile(path.join(outside, "thing.jar"), JAR);
    await escapedDirectory();
    await expect(reconcileMods([], context.mods, { hash: true, boundaryRoot: game })).rejects.toThrow(/outside/);
  });

  it("keeps an outside jar link's presence but never reads its size or hash", async () => {
    await writeFile(path.join(outside, "thing.jar"), JAR);
    await symlink(path.join(outside, "thing.jar"), path.join(context.mods, "thing.jar"));
    const reading = await reconcileMods([], context.mods, { hash: true, boundaryRoot: game });
    expect(reading.untracked).toEqual(["thing.jar"]);
    expect(reading.mods[0]).toMatchObject({ sizeBytes: null, sha512: null });
    expect(reading.totalBytes).toBe(0);
  });

  it("refuses a dependency whose mods root leaves the game volume even when its bytes match", async () => {
    await writeFile(path.join(outside, "thing.jar"), JAR);
    await escapedDirectory();
    expect((await dependencyReading()).issues).toHaveLength(1);
  });

  it("refuses a dependency's outside jar link even when the registry digest matches", async () => {
    await writeFile(path.join(outside, "thing.jar"), JAR);
    await symlink(path.join(outside, "thing.jar"), path.join(context.mods, "thing.jar"));
    expect((await dependencyReading()).issues).toHaveLength(1);
  });

  it("accepts an internal jar link for inventory and dependency reads", async () => {
    await writeFile(path.join(context.mods, "target.jar"), JAR);
    await symlink("target.jar", path.join(context.mods, "thing.jar"));
    expect((await reconcileMods([], context.mods, { hash: true, boundaryRoot: game })).mods[0].sha512).toBe(HASHES.sha512);
    expect((await dependencyReading()).issues).toEqual([]);
  });
});
