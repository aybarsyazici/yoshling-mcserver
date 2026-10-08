import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { BaseManifest } from "@/lib/backup-store";

const f = vi.hoisted(() => ({ root: `${process.env.TMPDIR || "/tmp"}/yoshling-inventory-rollback-${process.pid}-${Date.now()}`,
  stops: 0, corruptReadback: false, currentVersion: "26.1.2",
  client: null as import("@/generated/prisma/client").PrismaClient | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "restorer", name: "Fixture", role: "MOD", games: "minecraft" } }) }));
vi.mock("@/lib/backup-create", () => ({ MC_DIR: `${f.root}/game`, createBackup: vi.fn() }));
vi.mock("@/lib/backup-log", () => ({ readJournal: async () => [], recordBackupEvent: async () => {} }));
vi.mock("@/lib/backup-store", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/backup-store")>(),
  BACKUP_DIRS: { minecraft: `${f.root}/backups`, "7dtd": `${f.root}/sdtd`, zomboid: `${f.root}/pz` },
}));
vi.mock("@/lib/game-manager", () => ({ getMinecraftTarget: async () => ({ mcVersion: f.currentVersion, loader: "fabric" }), withGameStopped: async (_game: string, _action: string, fn: (op: unknown) => Promise<void>) => {
  f.stops++;
  await fn({ step: vi.fn(), detail: vi.fn(), settle: vi.fn(), fact: vi.fn() });
  return { restarted: false };
} }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { PrismaLibSql } = await import("@prisma/adapter-libsql");
  const client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${f.root}/inventory.db` }) });
  f.client = client;
  return { db: {
    installedMod: {
      deleteMany: client.installedMod.deleteMany.bind(client.installedMod),
      create: client.installedMod.create.bind(client.installedMod),
      createMany: client.installedMod.createMany.bind(client.installedMod),
      findMany: async () => f.corruptReadback ? [] : client.installedMod.findMany(),
    },
    serverConfig: { findUnique: async () => ({ mcVersion: f.currentVersion, modLoader: "fabric" }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => client.$transaction(async tx => {
      if (!f.corruptReadback) return fn(tx);
      return fn({ installedMod: { deleteMany: tx.installedMod.deleteMany.bind(tx.installedMod),
        createMany: tx.installedMod.createMany.bind(tx.installedMod), findMany: async () => [] } });
    }),
  } };
});
const { db } = await import("@/lib/db");
const fixtureClient = f.client!;
const { POST } = await import("@/app/api/server/backups/route");
const run = promisify(execFile);
const row = { modrinthId: "old-project", slug: "old", name: "Old fixture", version: "1", fileName: "old.jar",
  mcVersion: "26.1.2", loader: "fabric", installedBy: "original-owner", installedAt: "2026-01-02T03:04:05.000Z", source: "manual", versionId: "old-pin" };
beforeEach(async () => {
  f.stops = 0; f.corruptReadback = false; f.currentVersion = "26.1.2";
  await mkdir(f.root, { recursive: true });
  await fixtureClient.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "InstalledMod" ("id" TEXT PRIMARY KEY, "modrinthId" TEXT NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL, "version" TEXT NOT NULL, "fileName" TEXT NOT NULL, "mcVersion" TEXT NOT NULL, "loader" TEXT NOT NULL, "installedBy" TEXT NOT NULL, "installedAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL, "source" TEXT, "versionId" TEXT, "profileId" TEXT)');
  await db.installedMod.deleteMany();
  await db.installedMod.create({ data: { ...row, modrinthId: "new-project", fileName: "new.jar", versionId: "new-pin", source: "pack", installedAt: new Date(row.installedAt) } });
  await rm(path.join(f.root, "game"), { recursive: true, force: true });
  await rm(path.join(f.root, "backups"), { recursive: true, force: true });
  await mkdir(path.join(f.root, "game", "mods"), { recursive: true });
  await mkdir(path.join(f.root, "backups"));
  await writeFile(path.join(f.root, "game", "mods", "new.jar"), "new jar fixture");
});
afterAll(async () => { await fixtureClient.$disconnect(); await rm(f.root, { recursive: true, force: true }); });
async function archive(metadata: Partial<BaseManifest>) {
  const source = path.join(f.root, "source");
  await rm(source, { recursive: true, force: true });
  await mkdir(path.join(source, "mods"), { recursive: true });
  await writeFile(path.join(source, "mods", "old.jar"), "old jar fixture");
  const data = { createdAt: "2026-01-02T03:04:05Z", members: ["mods"], ...metadata };
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(data));
  const name = "portable.tar.gz";
  await run("tar", ["-czf", path.join(f.root, "backups", name), "-C", source, "."]);
  return name;
}
async function restore(name: string) {
  const response = await POST(new Request("http://local.invalid/restore", { method: "POST", body: JSON.stringify({ action: "restore", backupName: name }) }) as never);
  return { status: response.status, body: await response.json() };
}

describe("portable rollback inventory and target", () => {
  it("restores recorded provenance/pins/history using only metadata inside the downloaded tar", async () => {
    const result = await restore(await archive({ installedMods: [row], minecraftTarget: { mcVersion: "26.1.2", loader: "fabric" } }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ inventoryKnown: true, restoredMods: 1 });
    expect((await fixtureClient.installedMod.findMany())[0]).toMatchObject({ source: "manual", versionId: "old-pin", installedBy: "original-owner", installedAt: new Date(row.installedAt) });
    expect(await readFile(path.join(f.root, "game", "mods", "old.jar"), "utf-8")).toBe("old jar fixture");
  });
  it("clears all new inventory rows when the recorded pre-apply inventory was explicitly empty", async () => {
    expect((await restore(await archive({ installedMods: [] }))).status).toBe(200);
    expect(await fixtureClient.installedMod.findMany()).toEqual([]);
  });
  it("marks legacy absent inventory/target unknown and preserves existing DB rows", async () => {
    const result = await restore(await archive({}));
    expect(result.body).toMatchObject({ inventoryKnown: false, restoredMods: null, recordedTarget: null });
    expect((await fixtureClient.installedMod.findMany())[0].versionId).toBe("new-pin");
  });
  it("refuses an explicit target mismatch before downtime or file/database replacement", async () => {
    const result = await restore(await archive({ installedMods: [row], minecraftTarget: { mcVersion: "1.21.4", loader: "fabric" } }));
    expect(result.status).toBe(409);
    expect(f.stops).toBe(0);
    expect(await readFile(path.join(f.root, "game", "mods", "new.jar"), "utf-8")).toBe("new jar fixture");
    expect((await fixtureClient.installedMod.findMany())[0].versionId).toBe("new-pin");
  });
  it("refuses malformed recorded provenance before stopping or replacing files", async () => {
    const result = await restore(await archive({ installedMods: [{ ...row, versionId: 42 }] as never }));
    expect(result.status).toBe(400);
    expect(f.stops).toBe(0);
    expect(await readFile(path.join(f.root, "game", "mods", "new.jar"), "utf-8")).toBe("new jar fixture");
  });
  it("rolls the actual SQLite transaction back when inventory readback cannot confirm replacement", async () => {
    f.corruptReadback = true;
    const result = await restore(await archive({ installedMods: [row] }));
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("inventory readback failed");
    expect((await fixtureClient.installedMod.findMany())[0].versionId).toBe("new-pin");
  });
});

vi.mock("@/lib/minecraft-active-profile", async () => {
  const { legacyMinecraftContextMock } = await import("./fixtures/legacy-minecraft-context");
  return legacyMinecraftContextMock(() => `${f.root}/game`);
});
