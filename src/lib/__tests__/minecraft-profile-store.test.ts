import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { CreateProfileRecordInput } from "@/lib/minecraft-profile-store";

const fixture = vi.hoisted(() => ({ client: null as import("@/generated/prisma/client").PrismaClient | null, corrupt: false }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get(_target, property) {
  const client = fixture.client!;
  if (property === "$transaction") return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => client.$transaction(tx => work(new Proxy(tx, { get(target, key) {
    const delegate = Reflect.get(target, key);
    if (key !== "minecraftProfile" || !fixture.corrupt) return delegate;
    return new Proxy(delegate, { get(model, method) {
      if (method !== "findUnique") return Reflect.get(model, method);
      return async (args: Prisma.MinecraftProfileFindUniqueArgs) => {
        const row = await tx.minecraftProfile.findUnique(args);
        return row ? { ...row, name: "Corrupted readback" } : row;
      };
    } });
  } })));
  return Reflect.get(client, property);
} }) }));

const store = await import("@/lib/minecraft-profile-store");
let root: string;
let client: PrismaClient;
async function executeFile(file: string) {
  const sql = await readFile(path.resolve(__dirname, "../../../", file), "utf8");
  for (const statement of sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(text => text.trim()).filter(Boolean)) await client.$executeRawUnsafe(statement);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "yoshling-profile-store-")));
  await mkdir(path.join(root, "game"));
  vi.stubEnv("MC_SERVER_DIR", path.join(root, "game"));
  client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${root}/fixture.db` }) });
  fixture.client = client; fixture.corrupt = false;
  await executeFile("prisma/migrations/20260519104842_init/migration.sql");
  await executeFile("prisma/migrations/20261002143000_add_installed_mod_provenance/migration.sql");
});
afterEach(async () => { fixture.corrupt = false; await client.$disconnect(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const migration = () => executeFile("prisma/migrations/20261007180000_add_minecraft_profiles/migration.sql");
const input = (name = "Fixture profile"): CreateProfileRecordInput => ({ name, mcVersion: "1.21.4", loader: "fabric", loaderVersion: "0.16.10", javaVariant: "java21", sourceKind: "vanilla", createdBy: "fixture-owner" });

async function legacyMod() {
  await client.$executeRawUnsafe('INSERT INTO "InstalledMod" (id,modrinthId,slug,name,version,fileName,mcVersion,loader,installedBy,installedAt,updatedAt,source,versionId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', "old-mod", "old-project", "old", "Old fixture", "1", "old.jar", "1.21.4", "fabric", "original-owner", 1735787045000, 1735787045000, "manual", "old-pin");
}

describe("profile schema is manual and read-only until applied", () => {
  it("recognizes the actual SQLite adapter's known missing profile table without creating rows or tables", async () => {
    await legacyMod();
    expect(await store.readMinecraftRuntime()).toEqual({ schemaReady: false, runtime: null });
    await expect(store.listMinecraftProfiles()).rejects.toMatchObject({ status: 503, code: "profile_migration_required" });
    expect(await client.$queryRawUnsafe<{ name: string }[]>('SELECT name FROM sqlite_master WHERE name LIKE ?', 'Minecraft%')).toEqual([]);
    await expect(store.getMinecraftDataRoot()).resolves.toBe(path.join(root, "game"));
  });
  it("does not seed a profile or pointer or alter legacy inventory when the migration runs", async () => {
    await legacyMod(); await migration();
    expect(await store.listMinecraftProfiles()).toEqual([]);
    expect(await store.getMinecraftRuntime()).toBeNull();
    expect((await client.installedMod.findUnique({ where: { id: "old-mod" } }))?.profileId).toBeNull();
    await expect(client.minecraftRuntime.create({ data: { id: "another-slot", revision: "1" } })).rejects.toBeTruthy();
  });
  it("propagates unrelated database failure rather than pretending it is legacy", async () => {
    await migration();
    const spy = vi.spyOn(client.minecraftProfile, "count").mockRejectedValueOnce(Object.assign(new Error("storage unavailable"), { name: "DriverAdapterError" }));
    await expect(store.readMinecraftRuntime()).rejects.toThrow("storage unavailable"); spy.mockRestore();
  });
});

describe("profile metadata publication", () => {
  it("keeps a display name separate from its stable identity and reads created values back", async () => {
    await migration();
    const profile = await store.createProfileRecord(input(" ../A named world "));
    expect(profile.name).toBe("../A named world");
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(profile.revision).toBe(1);
    expect((await store.getMinecraftProfile(profile.id))?.id).toBe(profile.id);
    expect(store.toMinecraftProfileDTO(profile).target).toEqual({ mcVersion: "1.21.4", loader: "fabric", loaderVersion: "0.16.10", javaVariant: "java21" });
  });
  it("rolls back a created row whose actual readback disagrees", async () => {
    await migration(); fixture.corrupt = true;
    await expect(store.createProfileRecord(input())).rejects.toThrow("readback failed");
    expect(await client.minecraftProfile.count()).toBe(0);
  });
  it("uses a conditional revision and canonical readback for metadata changes", async () => {
    await migration(); const first = await store.createProfileRecord(input());
    const updated = await store.updateProfileRecord(first.id, 1, { name: "New title", description: "Fixture description" });
    expect(updated.revision).toBe(2); expect(updated.name).toBe("New title");
    await expect(store.updateProfileRecord(first.id, 1, { name: "Stale title" })).rejects.toMatchObject({ code: "profile_stale" });
    expect((await client.minecraftProfile.findUnique({ where: { id: first.id } }))?.name).toBe("New title");
  });
  it("rolls back an update after a mismatching readback", async () => {
    await migration(); const first = await store.createProfileRecord(input()); fixture.corrupt = true;
    await expect(store.updateProfileRecord(first.id, 1, { name: "New title" })).rejects.toThrow("readback failed");
    const row = await client.minecraftProfile.findUnique({ where: { id: first.id } });
    expect(row?.name).toBe(first.name); expect(row?.revision).toBe(1);
  });
});

describe("selected profile and legacy inventory", () => {
  it("keeps unrelated legacy profiles-folder data readable and refuses namespace adoption without changing it", async () => {
    const directory = path.join(root, "game", "profiles", "mod-config");
    await mkdir(directory, { recursive: true, mode: 0o750 }); await writeFile(path.join(directory, "fixture.txt"), "ordinary legacy mod data");
    const before = await lstat(directory);
    await expect(store.getMinecraftDataRoot()).resolves.toBe(path.join(root, "game"));
    await migration();
    await expect(store.getMinecraftDataRoot()).resolves.toBe(path.join(root, "game"));
    expect(await store.requiresMinecraftAdoption()).toBe(true);
    await expect(store.assertMinecraftReservedProfileStorage()).rejects.toMatchObject({ status: 409, code: "profile_storage_collision" });
    expect(await readFile(path.join(directory, "fixture.txt"), "utf8")).toBe("ordinary legacy mod data");
    const after = await lstat(directory); expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
    expect(await client.minecraftProfile.count()).toBe(0); expect(await client.minecraftRuntime.count()).toBe(0);
  });
  it("admits only backed profile identities and exact real staging directories", async () => {
    await migration(); const profile = await store.createProfileRecord(input());
    const profiles = path.join(root, "game", "profiles");
    const suffix = "00000000-0000-0000-0000-000000000002";
    for (const name of [profile.id, `.source-${suffix}`, `.prepare-${suffix}`, `.delete-${profile.id}-${suffix}`]) await mkdir(path.join(profiles, name), { recursive: true });
    await expect(store.assertMinecraftReservedProfileStorage()).resolves.toBeUndefined();
    await mkdir(path.join(profiles, `.source-${suffix}\n`));
    await expect(store.assertMinecraftReservedProfileStorage()).rejects.toMatchObject({ code: "profile_storage_collision" });
    await rm(path.join(profiles, `.source-${suffix}\n`), { recursive: true });
    await mkdir(path.join(profiles, "not-managed"));
    await expect(store.assertMinecraftReservedProfileStorage()).rejects.toMatchObject({ code: "profile_storage_collision" });
    await rm(path.join(profiles, "not-managed"), { recursive: true });
    await mkdir(path.join(profiles, suffix));
    await expect(store.assertMinecraftReservedProfileStorage()).rejects.toMatchObject({ code: "profile_storage_collision" });
  });
  it("refuses backed identity aliases before any adoption exclusion or ownership change", async () => {
    await migration(); const profile = await store.createProfileRecord(input());
    await mkdir(path.join(root, "external")); await writeFile(path.join(root, "external", "fixture.txt"), "ordinary external fixture");
    await mkdir(path.join(root, "game", "profiles")); await symlink(path.join(root, "external"), path.join(root, "game", "profiles", profile.id));
    await expect(store.assertMinecraftReservedProfileStorage()).rejects.toMatchObject({ code: "profile_storage_collision" });
    expect(await readFile(path.join(root, "external", "fixture.txt"), "utf8")).toBe("ordinary external fixture");
  });
  it("does not expose legacy paths once profile data exists without a selected identity", async () => {
    await migration(); await store.createProfileRecord(input());
    await expect(store.getMinecraftDataRoot()).rejects.toMatchObject({ code: "profile_selection_required" });
  });
  it("refuses filesystem-managed profiles after metadata loss even if the schema is absent", async () => {
    await mkdir(path.join(root, "game", "profiles", "00000000-0000-0000-0000-000000000001", "server"), { recursive: true });
    await expect(store.getMinecraftDataRoot()).rejects.toMatchObject({ code: "profile_selection_required" });
  });
  it("requires explicit adoption when unmanaged legacy data is present", async () => {
    await migration(); await mkdir(path.join(root, "game", "world")); await writeFile(path.join(root, "game", "world", "fixture.txt"), "ordinary save fixture");
    expect(await store.requiresMinecraftAdoption()).toBe(true);
  });
  it("hands off null inventory once, preserves provenance/history and updates the verified target mirror atomically", async () => {
    await legacyMod(); await migration();
    const original = await client.installedMod.findUnique({ where: { id: "old-mod" } });
    const other = await store.createProfileRecord({ ...input("Separate inventory"), status: "ready" });
    const otherRow = await client.installedMod.create({ data: { ...original!, id: "other-mod", profileId: other.id } });
    const adopted = await store.createProfileRecord({ ...input("Original world"), status: "ready", sourceKind: "legacy" });
    await mkdir(path.join(root, "game", "profiles", adopted.id, "server"), { recursive: true });
    const selected = await store.selectMinecraftProfile(adopted.id, "0", { adoptLegacyInventory: true });
    expect(selected.selectedProfileId).toBe(adopted.id);
    expect(await client.installedMod.findUnique({ where: { id: "old-mod" } })).toEqual({ ...original, profileId: adopted.id });
    expect(await client.installedMod.findUnique({ where: { id: "other-mod" } })).toEqual(otherRow);
    expect((await client.serverConfig.findUnique({ where: { id: "main" } }))?.mcVersion).toBe("1.21.4");
    expect(await store.getMinecraftDataRoot()).toBe(path.join(root, "game", "profiles", adopted.id, "server"));
    const second = await store.createProfileRecord({ ...input("Another world"), status: "ready" });
    await store.selectMinecraftProfile(second.id, selected.revision);
    expect((await client.installedMod.findUnique({ where: { id: "old-mod" } }))?.profileId).toBe(adopted.id);
    await expect(store.selectMinecraftProfile(adopted.id, selected.revision)).rejects.toMatchObject({ code: "profile_stale" });
  });
  it("refuses selecting an incomplete profile and deleting the selected one", async () => {
    await migration(); const first = await store.createProfileRecord(input());
    await expect(store.selectMinecraftProfile(first.id, "0")).rejects.toThrow("ready profile");
    const ready = await store.updateProfileRecord(first.id, first.revision, { status: "ready" });
    await store.selectMinecraftProfile(first.id, "0");
    await expect(store.deleteProfileRecord(first.id, ready.revision)).rejects.toThrow("selected profile");
  });
});
