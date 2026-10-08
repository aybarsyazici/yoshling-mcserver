import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyVerifiedMinecraftTree, inventoryMinecraftTree, requireMinecraftCopySpace } from "@/lib/minecraft-profile-copy";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), statfs: vi.fn(actual.statfs) };
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "minecraft-profile-copy-")); vi.clearAllMocks(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("complete profile preservation earns publication through readback", () => {
  it("preserves world, jars, overrides, player lists, empty directories and file modes", async () => {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "world/region"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(source, "config/empty"), { recursive: true });
    await mkdir(path.join(source, "mods"));
    const fixtures = { "world/region/r.0.0.mca": Buffer.from([0, 255, 7, 100]), "mods/one.jar": Buffer.from("jar"),
      "config/game.toml": Buffer.from("setting=123\n"), "server.properties": Buffer.from("difficulty=hard\n"),
      "ops.json": Buffer.from('[{"name":"friend"}]') };
    for (const [name, bytes] of Object.entries(fixtures)) await writeFile(path.join(source, name), bytes, { mode: 0o600 });
    const copy = await copyVerifiedMinecraftTree(source, path.join(root, "destination"), root);
    expect(copy.files).toBe(5);
    expect(copy.entries.find(entry => entry.path === "config/empty")).toMatchObject({ kind: "directory" });
    expect(copy.entries.find(entry => entry.path === "ops.json")).toMatchObject({ mode: 0o600 });
    for (const [name, bytes] of Object.entries(fixtures)) expect(await readFile(path.join(root, "destination", name))).toEqual(bytes);
    expect(await inventoryMinecraftTree(source, root)).toEqual(copy.entries);
  });

  it("excludes managed profile storage during adoption while preserving a nested folder of the same name", async () => {
    await mkdir(path.join(root, "profiles/old/server"), { recursive: true });
    await mkdir(path.join(root, "config/profiles"), { recursive: true });
    await writeFile(path.join(root, "profiles/old/server/not-legacy"), "private");
    await writeFile(path.join(root, "config/profiles/game-data"), "keep");
    await writeFile(path.join(root, "server.properties"), "level-name=world\n");
    const copy = await copyVerifiedMinecraftTree(root, path.join(root, "profiles/new/server"), root, { excludeTopLevel: ["profiles"] });
    expect(copy.files).toBe(2);
    expect(copy.entries.some(entry => entry.path.startsWith("profiles/"))).toBe(false);
    expect(await readFile(path.join(root, "profiles/new/server/config/profiles/game-data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(root, "profiles/old/server/not-legacy"), "utf8")).toBe("private");
  });

  it.each(["/tmp", "../outside-source"])("refuses links outside the server tree even within the same volume (%s)", async target => {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(root, "outside-source"), "keep");
    await writeFile(path.join(source, "inside"), "keep");
    await symlink(target, path.join(source, "alias"));
    await expect(copyVerifiedMinecraftTree(source, path.join(root, "destination"), root)).rejects.toThrow(/source link escaped/);
  });

  it("materializes the vanilla installer's contained minecraft_server.jar alias as verified independent bytes", async () => {
    const source = path.join(root, "source"); await mkdir(source);
    await writeFile(path.join(source, "minecraft_server.1.21.1.jar"), "server jar", { mode: 0o600 });
    await symlink("minecraft_server.1.21.1.jar", path.join(source, "minecraft_server.jar"));
    const copy = await copyVerifiedMinecraftTree(source, path.join(root, "destination"), root);
    expect(copy.files).toBe(2);
    expect((await lstat(path.join(root, "destination/minecraft_server.jar"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(root, "destination/minecraft_server.jar"), "utf8")).toBe("server jar");
    await writeFile(path.join(source, "minecraft_server.1.21.1.jar"), "later jar");
    expect(await readFile(path.join(root, "destination/minecraft_server.jar"), "utf8")).toBe("server jar");
  });

  it("refuses a legacy alias into the excluded managed profiles", async () => {
    await mkdir(path.join(root, "profiles/other/server"), { recursive: true });
    await writeFile(path.join(root, "profiles/other/server/foreign"), "foreign world");
    await symlink("profiles/other/server/foreign", path.join(root, "alias"));
    await expect(copyVerifiedMinecraftTree(root, path.join(root, "profiles/new/server"), root, { excludeTopLevel: ["profiles"] })).rejects.toThrow(/excluded profile storage/);
  });

  it("detects a successful copyFile that wrote different bytes", async () => {
    const source = path.join(root, "source"); await mkdir(source);
    await writeFile(path.join(source, "world.dat"), "precious progress");
    vi.mocked(fs.copyFile).mockImplementationOnce(async (_from, to) => { await writeFile(to, "torn bytes"); });
    await expect(copyVerifiedMinecraftTree(source, path.join(root, "destination"), root)).rejects.toThrow(/did not match/);
    expect(await readFile(path.join(source, "world.dat"), "utf8")).toBe("precious progress");
  });

  it("detects a source write during copying", async () => {
    const source = path.join(root, "source"); await mkdir(source);
    const sourceFile = path.join(source, "world.dat"); await writeFile(sourceFile, "old progress");
    vi.mocked(fs.copyFile).mockImplementationOnce(async (_from, to) => {
      await writeFile(to, "old progress"); await writeFile(sourceFile, "later progress");
    });
    await expect(copyVerifiedMinecraftTree(source, path.join(root, "destination"), root)).rejects.toThrow(/did not match/);
  });

  it("refuses a copy nested inside the data being preserved", async () => {
    const source = path.join(root, "source"); await mkdir(source); await writeFile(path.join(source, "world.dat"), "keep");
    await expect(copyVerifiedMinecraftTree(source, path.join(source, "checkpoint/server"), root)).rejects.toThrow(/inside the tree/);
  });

  it("refuses insufficient disk headroom instead of partially preserving a save", async () => {
    vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: 1, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>);
    await expect(requireMinecraftCopySpace(root, 10)).rejects.toThrow(/1 GiB/);
  });
});
