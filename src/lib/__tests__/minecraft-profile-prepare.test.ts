import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, lstat, chmod } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
const fixture = vi.hoisted(() => ({ root: `${process.env.TMPDIR || "/tmp"}/profile-prepare-${process.pid}-${Date.now()}`, corrupt: false, bundledWorld: false, row: null as Record<string, unknown> | null, creates: 0, resolves: 0, modRows: [] as Record<string, unknown>[], targetFailure: false, legacyAppears: false, propertyReads: 0, markerNames: [] as string[], downloads: [] as string[], properties: "motd=Pack\nrcon.password=pack-secret\nserver-port=9\nlevel-name=elsewhere\nonline-mode=false\n", preempted: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    if (fixture.corrupt && String(args[0]).endsWith("server.properties")) return Readable.from([Buffer.from("corrupt")]);
    return actual.createReadStream(...args);
  } };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => { if (String(args[0]).endsWith("server.properties")) fixture.propertyReads++; return fixture.corrupt && String(args[0]).endsWith("server.properties") ? Buffer.from("corrupt") : actual.readFile(...args); } };
});
vi.mock("../operations", () => ({ assertFileWriteActive: () => {}, runOperation: async (_spec: unknown, fn: (op: unknown) => Promise<{ value: unknown }>) => (await fn({ id: "operation", get preempted() { return fixture.preempted; }, step: vi.fn(), fact: vi.fn(), progress: vi.fn(), detail: vi.fn(), settle: vi.fn() })).value }));
vi.mock("../minecraft-profile-store", () => {
  class MinecraftProfileError extends Error { constructor(message: string, public status = 409) { super(message); } }
  return { MinecraftProfileError, requireMinecraftProfileSchema: async () => {}, requiresMinecraftAdoption: async () => (await import("../minecraft-profile-path")).legacyMinecraftDataPresent(),
    assertMinecraftReservedProfileStorage: async () => {
      const storage = await import("../minecraft-profile-path").then(paths => paths.inspectMinecraftReservedProfileStorage(fixture.row ? [String(fixture.row.id)] : []));
      if (storage.unknown.length) throw new MinecraftProfileError("Owner review is required for the existing profiles folder");
    },
    createProfileRecord: async (data: Record<string, unknown>) => { fixture.creates++; return fixture.row = { ...data, revision: 1, preparationError: null }; },
    updateProfileRecord: async (_id: string, revision: number, data: Record<string, unknown>) => fixture.row = { ...fixture.row, ...data, revision: revision + 1 },
    getMinecraftProfile: async () => fixture.row,
    toMinecraftProfileDTO: (value: unknown) => value,
  };
});
vi.mock("../minecraft-profile-target", () => ({ resolveProfileTarget: async (input: Record<string, unknown>) => { fixture.resolves++; fixture.markerNames = await readdir(`${fixture.root}-operations`).catch(() => []); if (fixture.legacyAppears) await import("node:fs/promises").then(fs => fs.writeFile(path.join(fixture.root, "new-legacy.txt"), "new ordinary legacy fixture")); if (fixture.targetFailure) throw new Error("Exact target failed validation"); return { ...input, loaderVersion: input.loaderVersion ?? null, javaVariant: "java21" }; } }));
vi.mock("../db", () => ({ db: { modpack: { findUnique: async () => ({ id: "set", name: "Saved friends", targetMcVersion: "1.21.1", targetLoader: "fabric", mods: [{ modrinthId: "mod", slug: "mod", name: "Pinned mod", versionId: "pin" }] }) }, installedMod: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => { fixture.modRows = data; }, findMany: async () => fixture.modRows } } }));
vi.mock("../mod-manager", () => ({ serverSideFor: async () => ({ install: true, declared: "required", basis: "version" }) }));
vi.mock("../modrinth", () => ({ getProject: async () => ({ id: "pack", title: "Friends pack", project_type: "modpack" }), getProjectVersions: async () => [{ id: "build", project_id: "pack", files: [{ filename: "friends.mrpack", url: "https://cdn.modrinth.com/pack", primary: true, size: 4, hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) } }] }], getVersion: async (id: string) => ({ id, project_id: "mod", name: "Pinned mod", version_number: "exact1", game_versions: ["1.21.1"], loaders: ["fabric"], dependencies: [], files: [{ filename: "mod.jar", size: 4, url: "https://cdn.modrinth.com/pinned", hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) } }] }) }));
vi.mock("../minecraft-profile-pack", async original => {
  const actual = await original<typeof import("../minecraft-profile-pack")>();
  const descriptor = (member: string, size: number) => ({ member, size, compressedSize: size, compressionMethod: 0, generalPurposeBitFlag: 0, relativeOffsetOfLocalHeader: 0 });
  return { ...actual,
    downloadProfileFileToPath: async (url: string, destination: string) => { fixture.downloads.push(url); return actual.writeVerifiedProfileStream(destination, Readable.from([Buffer.from("file")]), actual.PROFILE_PACK_LIMITS.file); },
    inspectProfilePackArchiveFile: async () => ({ index: { name: "Friends", versionId: "1", target: { mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.9" }, files: [{ path: "mods/client.jar", fileSize: 4, hashes: {}, downloads: ["https://cdn.modrinth.com/client"], env: { server: "unsupported" } }, { path: "config/server.json", fileSize: 4, hashes: {}, downloads: ["https://cdn.modrinth.com/config"] }] }, overrides: new Map([["server.properties", descriptor("server.properties", Buffer.byteLength(fixture.properties))], ["config/override.json", descriptor("config/override.json", 8)], ...(fixture.bundledWorld ? [["world/level.dat", descriptor("world/level.dat", 10)] as const] : [])]) }),
    streamProfilePackOverride: async (_archive: string, entry: { member: string }, destination: string) => {
      const bytes = Buffer.from(entry.member === "server.properties" ? fixture.properties : entry.member === "world/level.dat" ? "pack-world" : "override");
      return actual.writeVerifiedProfileStream(destination, Readable.from([bytes]), actual.PROFILE_PACK_LIMITS.file);
    },
  };
});
vi.mock("../compose", () => ({ readEnvMap: async () => ({ RCON_PASSWORD: "fixture-control-password" }) }));
const { createPreparedMinecraftProfile, prepareMinecraftProfileControlSettings } = await import("../minecraft-profile-prepare");
beforeEach(async () => { vi.stubEnv("MC_SERVER_DIR", fixture.root); vi.stubEnv("MC_PROFILE_OPERATIONS_DIR", `${fixture.root}-operations`); fixture.corrupt = false; fixture.bundledWorld = false; fixture.preempted = false; fixture.properties = "motd=Pack\nrcon.password=pack-secret\nserver-port=9\nlevel-name=elsewhere\nonline-mode=false\n"; fixture.row = null; fixture.modRows = []; fixture.targetFailure = false; fixture.legacyAppears = false; fixture.propertyReads = 0; fixture.markerNames = []; fixture.creates = 0; fixture.resolves = 0; fixture.downloads = []; await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root, { recursive: true }); });
afterEach(async () => { await rm(`${fixture.root}-operations`, { recursive: true, force: true }); await rm(fixture.root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const actor = { userId: "fixture", name: "Fixture" };
const vanilla = { name: "Friend A", source: { kind: "vanilla" as const, mcVersion: "1.21.1" }, settings: { difficulty: "hard", "level-seed": "friend-a" } };
describe("Minecraft profile preparation", () => {
  it("refuses an ineffective seed override for a pack that supplies a world", async () => {
    fixture.bundledWorld = true;
    await expect(createPreparedMinecraftProfile({ name: "World pack", source: { kind: "modrinth", ref: "pack" }, settings: { "level-seed": "other" } }, actor)).rejects.toThrow(/supplies world data/);
    expect(fixture.creates).toBe(0);
  });
  it("publishes a separate fresh world configuration and marks ready only after readback", async () => {
    const result = await createPreparedMinecraftProfile(vanilla, actor);
    expect(fixture.row?.status).toBe("ready"); expect(result.operationId).toBe("operation");
    expect(fixture.markerNames).toEqual([expect.stringMatching(/^\.operation-prepare-/)]);
    expect(await readdir(`${fixture.root}-operations`)).toEqual([]);
    const root = path.join(fixture.root, "profiles", String(fixture.row!.id), "server");
    expect(await readFile(path.join(root, "server.properties"), "utf8")).toContain("level-seed=friend-a");
    await expect(lstat(path.join(root, "world"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(path.dirname(root), "preparation.json"), "utf8")).toContain('"mcVersion":"1.21.1"');
  });
  it("refuses an unrelated legacy profiles folder before source or game staging changes", async () => {
    const directory = path.join(fixture.root, "profiles", "mod-config"); await mkdir(directory, { recursive: true, mode: 0o750 });
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(directory, "fixture.txt"), "ordinary legacy data"));
    const before = await lstat(directory);
    await expect(createPreparedMinecraftProfile(vanilla, actor)).rejects.toThrow(/Owner review/);
    expect(fixture.creates).toBe(0); expect(fixture.resolves).toBe(0);
    expect(await readdir(path.join(fixture.root, "profiles"))).toEqual(["mod-config"]);
    const after = await lstat(directory); expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
    expect(await readFile(path.join(directory, "fixture.txt"), "utf8")).toBe("ordinary legacy data");
    expect(await readdir(`${fixture.root}-operations`)).toEqual([]);
  });
  it("refuses legacy adoption bypass before resolving or creating a profile", async () => {
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(fixture.root, "legacy.txt"), "live legacy data"));
    await expect(createPreparedMinecraftProfile(vanilla, actor)).rejects.toThrow(/Adopt/);
    expect(fixture.creates).toBe(0); expect(fixture.resolves).toBe(0);
  });
  it("refuses deployment settings before network or row creation", async () => {
    await expect(createPreparedMinecraftProfile({ ...vanilla, settings: { "rcon.password": "wrong" } }, actor)).rejects.toThrow(/editable/);
    expect(fixture.creates).toBe(0); expect(fixture.resolves).toBe(0);
  });
  it("records failed preparation and removes staging when file readback disagrees", async () => {
    fixture.corrupt = true;
    await expect(createPreparedMinecraftProfile(vanilla, actor)).rejects.toThrow(/readback/);
    expect(fixture.row?.status).toBe("failed");
    expect(await readdir(path.join(fixture.root, "profiles", String(fixture.row!.id)))).toEqual([]);
  });
  it("loads full pack configs, skips client jars and freezes exact source target", async () => {
    await createPreparedMinecraftProfile({ name: "Friends", source: { kind: "modrinth", ref: "pack" } }, actor);
    expect(fixture.row).toMatchObject({ status: "ready", mcVersion: "1.21.1", loaderVersion: "0.16.9", sourceVersionId: "build" });
    expect(fixture.downloads).toEqual(["https://cdn.modrinth.com/pack", "https://cdn.modrinth.com/config"]);
    const root = path.join(fixture.root, "profiles", String(fixture.row!.id), "server");
    expect(await readFile(path.join(root, "config", "override.json"), "utf8")).toBe("override");
    const props = await readFile(path.join(root, "server.properties"), "utf8");
    expect(props).not.toContain("pack-secret"); expect(props).not.toContain("server-port=9"); expect(props).toContain("level-name=world"); expect(props).toContain("online-mode=true");
  });
  it("validates the complete source target before creating a row and cleans private source staging", async () => {
    fixture.targetFailure = true;
    await expect(createPreparedMinecraftProfile({ name: "Invalid target", source: { kind: "modrinth", ref: "pack" } }, actor)).rejects.toThrow("Exact target failed validation");
    expect(fixture.creates).toBe(0); expect(await readdir(path.join(fixture.root, "profiles"))).toEqual([]);
  });
  it("rechecks unmanaged data that appears while source metadata is being resolved", async () => {
    fixture.legacyAppears = true;
    await expect(createPreparedMinecraftProfile(vanilla, actor)).rejects.toThrow(/Adopt/);
    expect(fixture.creates).toBe(0); expect(fixture.resolves).toBe(1);
    expect(await readFile(path.join(fixture.root, "new-legacy.txt"), "utf8")).toBe("new ordinary legacy fixture");
  });
  it("streams a saved set's exact pins and verifies its inventory before ready", async () => {
    await createPreparedMinecraftProfile({ name: "Saved", source: { kind: "saved-set", ref: "set", loaderVersion: "0.16.9" } }, actor);
    expect(fixture.downloads).toEqual(["https://cdn.modrinth.com/pinned"]);
    expect(fixture.row).toMatchObject({ status: "ready", loaderVersion: "0.16.9", sourceRef: "set" });
    expect(fixture.modRows).toEqual([expect.objectContaining({ profileId: fixture.row!.id, fileName: "mod.jar", versionId: "pin", source: "pack", installedBy: "fixture" })]);
    const dir = path.join(fixture.root, "profiles", String(fixture.row!.id));
    expect(await readFile(path.join(dir, "server", "mods", "mod.jar"), "utf8")).toBe("file");
    const receipt = JSON.parse(await readFile(path.join(dir, "preparation.json"), "utf8"));
    expect(receipt.files).toContainEqual(expect.objectContaining({ path: "mods/mod.jar", bytes: 4, sha512: expect.stringMatching(/^[a-f0-9]{128}$/), versionId: "pin" }));
    expect(await readdir(path.join(fixture.root, "profiles"))).toEqual([String(fixture.row!.id)]);
  });
  it("refuses oversized properties metadata before a row or properties read", async () => {
    fixture.properties = `motd=${"x".repeat(1024 ** 2)}`;
    await expect(createPreparedMinecraftProfile({ name: "Huge properties", source: { kind: "modrinth", ref: "pack" } }, actor)).rejects.toThrow(/1 MiB/);
    expect(fixture.creates).toBe(0); expect(fixture.propertyReads).toBe(0);
    expect(await readdir(path.join(fixture.root, "profiles"))).toEqual([]);
  });
  it.each(["lines", "keys"])("refuses excessive properties %s during normalization", async kind => {
    fixture.properties = kind === "lines" ? "x=1\n".repeat(4097) : Array.from({ length: 1025 }, (_, i) => `x${i}=1`).join("\n");
    await expect(createPreparedMinecraftProfile({ name: "Many properties", source: { kind: "modrinth", ref: "pack" } }, actor)).rejects.toThrow(/editor-safe/);
    expect(fixture.row?.status).toBe("failed");
    await expect(lstat(path.join(fixture.root, "profiles", String(fixture.row!.id), "server"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["bytes", "lines", "keys"])("refuses unsafe properties %s before control publication", async kind => {
    await createPreparedMinecraftProfile(vanilla, actor);
    const file = path.join(fixture.root, "profiles", String(fixture.row!.id), "server", "server.properties");
    const original = kind === "bytes" ? `motd=${"x".repeat(1024 ** 2)}` : kind === "lines" ? "x=1\n".repeat(4097) : Array.from({ length: 1025 }, (_, i) => `x${i}=1`).join("\n");
    await import("node:fs/promises").then(fs => fs.writeFile(file, original));
    await expect(prepareMinecraftProfileControlSettings(String(fixture.row!.id), { id: "op", preempted: false } as never)).rejects.toThrow(/editor-safe/);
    expect(await readFile(file, "utf8")).toBe(original);
    expect((await readdir(path.dirname(file))).filter(name => name.startsWith(".properties-"))).toEqual([]);
  });
  it("refreshes only deployment control keys with exact readback", async () => {
    await createPreparedMinecraftProfile(vanilla, actor);
    const file = path.join(fixture.root, "profiles", String(fixture.row!.id), "server", "server.properties");
    await chmod(file, 0o640); const before = await lstat(file); fixture.propertyReads = 0;
    await prepareMinecraftProfileControlSettings(String(fixture.row!.id), { id: "op", preempted: false } as never);
    expect(fixture.propertyReads).toBe(0);
    const after = await lstat(file); expect([after.uid, after.gid, after.mode & 0o777]).toEqual([before.uid, before.gid, 0o640]);
    const props = await readFile(file, "utf8");
    expect(props).toContain("difficulty=hard"); expect(props).toContain("rcon.password=fixture-control-password"); expect(props).toContain("server-port=25565"); expect(props).toContain("management-server-enabled=false");
  });
});
