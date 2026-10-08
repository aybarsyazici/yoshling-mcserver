import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink, lstat, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Session } from "next-auth";
import type { MinecraftProfileRuntimeDTO } from "@/lib/minecraft-profile-types";

const state = vi.hoisted(() => ({ client: null as import("@/generated/prisma/client").PrismaClient | null, session: null as Session | null,
  runtime: {} as MinecraftProfileRuntimeDTO, nextRuntime: null as MinecraftProfileRuntimeDTO | null, invited: true, root: "", image: Buffer.alloc(0), renders: 0,
  renderer: null as (() => Promise<void>) | null, defer: false, corruptWrite: false, regionReads: 0 }));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/whitelist", () => ({ isWhitelisted: async () => state.invited }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get(_target, key) { const value = Reflect.get(state.client!, key); return typeof value === "function" ? value.bind(state.client) : value; } }) }));
vi.mock("@/lib/minecraft-profile-activation", () => ({ getMinecraftProfileRuntimeStatus: async () => { const before = state.runtime; if (state.nextRuntime) { state.runtime = state.nextRuntime; state.nextRuntime = null; } return before; } }));
vi.mock("@/lib/minecraft-overview-renderer", () => ({
  minecraftOverviewTargetSupport: (target: { mcVersion: string }) => ({ supported: ["26.1.2", "1.21.1"].includes(target.mcVersion), reason: "This target has no packaged renderer assets" }),
  renderMinecraftProfileOverview: async (input: { jobRelativePath: string }) => {
    state.renders++;
    if (state.renderer) await state.renderer();
    if (state.defer) throw Object.assign(new Error("Host resources are busy"), { code: "overview_deferred" });
    await writeFile(path.join(state.root, "overviews", input.jobRelativePath, "output", "overview.png"), state.image, { mode: 0o600 });
    return { renderer: { name: "bluemap", version: "5.28" }, width: 4, height: 3 };
  },
}));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: (async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]).endsWith(".mca") && typeof args[1] === "number") state.regionReads++;
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, key) {
      if (key === "writeFile" && state.corruptWrite && String(args[0]).includes(".png.write-")) return async () => handle.writeFile(Buffer.from("ordinary wrong bytes"));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof actual.open };
});
const profiles = await import("@/lib/minecraft-profile-store");
const store = await import("@/lib/minecraft-profile-overview-store");
const queue = await import("@/lib/minecraft-profile-overview-queue");
const source = await import("@/lib/minecraft-profile-overview-source");
const route = await import("@/app/api/minecraft/profiles/[id]/overview/route");
const images = await import("@/app/api/minecraft/profiles/[id]/overview/image/route");
const { runFileWrite, listOperations } = await import("@/lib/operations");
const { minecraftProfileDTO } = await import("@/lib/minecraft-profile-http");
const actor = "overview-manager";
let root: string, client: PrismaClient, id: string;
const context = () => ({ params: Promise.resolve({ id }) });
const request = (body: unknown = { expectedRevision: 1, expectedOverviewRevision: null }) => new Request("http://fixture/overview", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
function named(type: number, name: string, value: Buffer) { const text = Buffer.from(name), header = Buffer.alloc(3); header[0] = type; header.writeUInt16BE(text.length, 1); return Buffer.concat([header, text, value]); }
function integer(value: number) { const result = Buffer.alloc(4); result.writeInt32BE(value); return result; }
function level(modern = true, x = 0, z = 0) {
  const last = Buffer.alloc(8); last.writeBigInt64BE(BigInt(1_791_445_200_000));
  const spawn = modern ? named(10, "spawn", Buffer.concat([named(8, "dimension", Buffer.concat([Buffer.from([0, 19]), Buffer.from("minecraft:overworld")])), named(11, "pos", Buffer.concat([integer(3), integer(x), integer(64), integer(z)])), Buffer.from([0])])) : Buffer.concat([named(3, "SpawnX", integer(x)), named(3, "SpawnZ", integer(z))]);
  return gzipSync(Buffer.concat([Buffer.from([10, 0, 0]), named(10, "Data", Buffer.concat([spawn, named(4, "LastPlayed", last), Buffer.from([0])])), Buffer.from([0])]));
}
async function world(modern = true) {
  const base = path.join(root, "game", "profiles", id, "server", "world"), region = path.join(base, modern ? "dimensions/minecraft/overworld/region" : "region");
  await mkdir(region, { recursive: true }); await writeFile(path.join(base, "level.dat"), level(modern));
  await writeFile(path.join(region, "r.0.0.mca"), Buffer.from("ordinary saved region fixture"));
  await writeFile(path.join(region, "r.100.100.mca"), Buffer.from("unrelated distant region"));
  await mkdir(path.join(base, "playerdata"), { recursive: true }); await writeFile(path.join(base, "playerdata", "private-player.txt"), "non-sensitive excluded fixture");
  return { base, region };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "profile-overview-"))); state.root = root; await mkdir(path.join(root, "game"));
  vi.stubEnv("MC_SERVER_DIR", path.join(root, "game")); vi.stubEnv("MC_PROFILE_OVERVIEWS_DIR", path.join(root, "overviews")); vi.stubEnv("MC_OVERVIEW_BACKUPS_DIR", path.join(root, "backups"));
  client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${root}/fixture.db` }) }); state.client = client;
  for (const migration of ["20260519104842_init", "20260913144054_add_game_access_and_zomboid_mods", "20261002143000_add_installed_mod_provenance", "20261007180000_add_minecraft_profiles"]) {
    const sql = await readFile(path.resolve(__dirname, `../../../prisma/migrations/${migration}/migration.sql`), "utf8");
    for (const part of sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(text => text.trim()).filter(Boolean)) await client.$executeRawUnsafe(part);
  }
  await client.user.create({ data: { id: actor, discordId: "9007199254740993", username: "Fixture", role: "MOD", games: "minecraft" } });
  id = (await profiles.createProfileRecord({ name: "Saved world", status: "ready", mcVersion: "26.1.2", loader: "vanilla", javaVariant: "java25", sourceKind: "vanilla", createdBy: actor })).id;
  await mkdir(path.join(root, "game", "profiles", id, "server", "mods"), { recursive: true });
  state.session = { expires: "2030-01-01", user: { id: actor, name: "Fixture", discordId: "9007199254740993", role: "MOD", games: ["minecraft"] } };
  state.runtime = { selectedProfileId: id, appliedProfileId: id, state: "stopped", verified: true, containerState: "exited", revision: "r1" }; state.nextRuntime = null;
  state.invited = true; state.renders = 0; state.renderer = null; state.defer = false; state.corruptWrite = false; state.regionReads = 0;
  state.image = await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 40, g: 100, b: 30, alpha: 1 } } }).png().toBuffer();
});
afterEach(async () => { await client.$disconnect(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function queued() { await world(); const response = await route.POST(request(), context()); expect(response.status).toBe(202); const receipt = await response.json(); expect(receipt.overview.state).toBe("queued"); return receipt as { jobId: string; operationId: string }; }
async function rendered() { const receipt = await queued(); await queue.runMinecraftProfileOverviewQueue(); return { ...receipt, overview: await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!) }; }

describe("generated world overview storage and jobs", () => {
  it("keeps GET read-only and exposes missing status honestly without changing gameplay DTO", async () => {
    const response = await route.GET(new Request("http://fixture"), context()); expect(response.status).toBe(200); expect((await response.json()).overview).toMatchObject({ state: "waiting", imageUrl: null, reason: "Waiting for overview generation" });
    await expect(lstat(path.join(root, "overviews"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await minecraftProfileDTO((await profiles.getMinecraftProfile(id))!)).revision).toBe(1);
  });
  it("parses exact old/new saved spawn and never invents a spawn for malformed NBT", () => {
    expect(source.parseOverviewLevel(level(false, -513, 510))).toMatchObject({ center: { x: -513, z: 510 }, sourceSavedAt: "2026-10-08T07:40:00.000Z" });
    expect(source.parseOverviewLevel(level(true, 511, 64)).center).toEqual({ x: 511, z: 64 });
    expect(() => source.parseOverviewLevel(gzipSync(Buffer.alloc(17 * 1024 * 1024)))).toThrow();
    expect(() => source.parseOverviewLevel(Buffer.from("ordinary invalid metadata"))).toThrow();
  });
  it("bounds decompression of otherwise valid compressed world metadata", () => {
    const payload = Buffer.concat([Buffer.from([0x10, 0]), Buffer.alloc(4096, 65)]);
    const tags = Array.from({ length: 5000 }, (_, index) => named(8, `fixture-${index}`, payload));
    const base = source.parseOverviewLevel(level(true)); expect(base.center).toEqual({ x: 0, z: 0 });
    const spawn = named(10, "spawn", Buffer.concat([named(8, "dimension", Buffer.concat([Buffer.from([0, 19]), Buffer.from("minecraft:overworld")])), named(11, "pos", Buffer.concat([integer(3), integer(0), integer(64), integer(0)])), Buffer.from([0])]));
    const compressed = gzipSync(Buffer.concat([Buffer.from([10, 0, 0]), named(10, "Data", Buffer.concat([spawn, ...tags, Buffer.from([0])])), Buffer.from([0])]));
    expect(compressed.length).toBeLessThan(1024 * 1024); expect(() => source.parseOverviewLevel(compressed)).toThrow("decoded safely");
  });
  it("gates anonymous/read-only/wrong-world and rereads current invitation and role", async () => {
    state.session = null; expect((await route.POST(request(), context())).status).toBe(401);
    state.session = { expires: "2030", user: { id: actor, name: "Fixture", discordId: "9007199254740993", role: "MEMBER", games: ["minecraft"] } }; expect((await route.POST(request(), context())).status).toBe(403);
    state.session.user.role = "MOD"; state.session.user.games = ["zomboid"]; expect((await route.POST(request(), context())).status).toBe(403);
    state.session.user.games = ["minecraft"]; state.invited = false; expect((await route.POST(request(), context())).status).toBe(403);
    state.invited = true; await client.user.update({ where: { id: actor }, data: { role: "MEMBER" } }); expect((await route.POST(request(), context())).status).toBe(403);
  });
  it("waits for saved terrain without invoking a renderer or game lifecycle", async () => {
    const response = await route.POST(request(), context()); expect(response.status).toBe(202); expect((await response.json()).overview).toMatchObject({ state: "waiting", imageUrl: null });
    expect(state.renders).toBe(0); expect((await profiles.getMinecraftProfile(id))?.revision).toBe(1);
  });
  it("pins only nearby Overworld files and proves an owned normalized artifact without bumping DB revision", async () => {
    const result = await rendered(); expect(result.overview).toMatchObject({ state: "ready", dimension: "overworld", renderer: { name: "bluemap", version: "5.28" }, source: { kind: "saved-copy" } });
    expect(result.overview.imageUrl).toBe(`/api/minecraft/profiles/${id}/overview/image?revision=${result.overview.revision}`);
    const job = await store.readOverviewJob(id, result.jobId); expect(job.source.files.map(file => file.path)).toEqual(["level.dat", "dimensions/minecraft/overworld/region/r.0.0.mca"]);
    expect((await profiles.getMinecraftProfile(id))!).toMatchObject({ revision: 1, coverKey: null });
    expect((await lstat(path.join(root, "overviews"))).mode & 0o777).toBe(0o700);
    const response = await images.GET(new Request(`http://fixture?revision=${result.overview.revision}`), context()); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(state.image); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(lstat(path.join(root, "overviews", id, "jobs", result.jobId, "input"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "overviews", id, "jobs", result.jobId, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("manual/companion cover changes during rendering win and do not stale independent overview publication", async () => {
    await queued(); const key = `${randomUUID()}.png`;
    state.renderer = () => runFileWrite("minecraft", async () => { await profiles.updateProfileRecord(id, 1, { name: "Changed display name", coverKey: key, coverMime: "image/png" }); });
    await queue.runMinecraftProfileOverviewQueue(); const profile = (await profiles.getMinecraftProfile(id))!;
    expect(profile).toMatchObject({ revision: 2, name: "Changed display name", coverKey: key }); expect((await queue.readMinecraftProfileOverview(profile)).state).toBe("ready");
    expect((await minecraftProfileDTO(profile)).coverUrl).toBe(`/api/minecraft/profiles/${id}/cover?v=2`);
  });
  it("requires reviewed numeric and independent overview revisions before another job", async () => {
    await world(); expect((await route.POST(request({ expectedRevision: 2, expectedOverviewRevision: null }), context())).status).toBe(409);
    expect((await route.POST(request({ expectedRevision: 1 }), context())).status).toBe(400);
    const result = await rendered(); expect((await route.POST(request(), context())).status).toBe(409);
    expect((await route.POST(request({ expectedRevision: 1, expectedOverviewRevision: result.overview.revision }), context())).status).toBe(202);
  });
  it("keeps unsupported targets readable and refuses rendering unsupported offline assets", async () => {
    await profiles.updateProfileRecord(id, 1, { mcVersion: "1.20.1" });
    expect((await route.GET(new Request("http://fixture"), context())).status).toBe(200);
    expect((await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!)).state).toBe("unsupported");
    expect((await route.POST(request({ expectedRevision: 2, expectedOverviewRevision: null }), context())).status).toBe(422);
  });
  it("refuses raw running snapshots and state changes during a stopped snapshot", async () => {
    await world(); state.runtime.state = "running"; state.runtime.containerState = "running";
    expect((await route.POST(request(), context())).status).toBe(409); expect(state.renders).toBe(0);
    state.runtime.state = "stopped"; state.runtime.containerState = "exited"; state.nextRuntime = { ...state.runtime, state: "running", containerState: "running", revision: "r2" };
    expect((await route.POST(request(), context())).status).toBe(409); expect(await store.readOverviewRecord(id)).toBeNull();
  });
  it.each(["world", "region", "file", "hardlink"])("refuses %s source aliases before a renderer", async kind => {
    const saved = await world(); const outside = path.join(root, "ordinary-outside"); await mkdir(outside); await writeFile(path.join(outside, "region.txt"), "non-sensitive external fixture");
    if (kind === "world") { await rm(saved.base, { recursive: true }); await symlink(outside, saved.base); }
    else if (kind === "region") { await rm(saved.region, { recursive: true }); await symlink(outside, saved.region); }
    else if (kind === "file") { await rm(path.join(saved.region, "r.0.0.mca")); await symlink(path.join(outside, "region.txt"), path.join(saved.region, "r.0.0.mca")); }
    else { const { link } = await import("node:fs/promises"); await link(path.join(saved.region, "r.0.0.mca"), path.join(outside, "same-inode.txt")); }
    expect((await route.POST(request(), context())).status).toBe(422); expect(state.renders).toBe(0);
  });
  it("refuses oversized individual region metadata before reading or copying it", async () => {
    const saved = await world(), file = await open(path.join(saved.region, "r.0.0.mca"), "w"); await file.truncate(128 * 1024 * 1024 + 1); await file.close();
    expect((await route.POST(request(), context())).status).toBe(422); expect(state.renders).toBe(0);
  });
  it("admits the combined disk budget before hashing any sparse oversized selection", async () => {
    const saved = await world();
    for (const name of ["r.0.0.mca", "r.-1.0.mca"]) { const file = await open(path.join(saved.region, name), "w"); await file.truncate(128 * 1024 * 1024); await file.close(); }
    expect((await route.POST(request(), context())).status).toBe(413); expect(state.regionReads).toBe(0);
  });
  it("materializes a verified running-profile checkpoint rather than reading its changing live world", async () => {
    const saved = await world(), checkpointId = `${Date.now()}-${randomUUID()}`, checkpoint = path.join(root, "game", "profiles", id, "checkpoints", checkpointId, "server");
    const { cp } = await import("node:fs/promises"); await mkdir(checkpoint, { recursive: true }); await cp(saved.base, path.join(checkpoint, "world"), { recursive: true });
    const files = await Promise.all(["level.dat", "dimensions/minecraft/overworld/region/r.0.0.mca"].map(async relative => ({ path: `world/${relative}`, ...await source.hashOverviewSourceFile(path.join(saved.base, relative), 128 * 1024 * 1024) })));
    await writeFile(path.join(checkpoint, "../checkpoint.json"), JSON.stringify({ formatVersion: 1, profileId: id, files }));
    await writeFile(path.join(saved.base, "level.dat"), level(true, 1200, 1200)); state.runtime.state = "running"; state.runtime.containerState = "running";
    const response = await route.POST(request(), context()); expect(response.status).toBe(202); const receipt = await response.json();
    const job = await store.readOverviewJob(id, receipt.jobId); expect(job.source.kind).toBe("checkpoint"); expect(job.source.center).toEqual({ x: 0, z: 0 });
    const wrong = { formatVersion: 1, profileId: randomUUID(), files }; await writeFile(path.join(checkpoint, "../checkpoint.json"), JSON.stringify(wrong));
    await expect(source.copyMinecraftOverviewSource(id, randomUUID())).rejects.toThrow("checkpoint metadata");
  });
  it("pins a real profile-bound flushed tar for a running world, refusing bad hashes, links and foreign archives", async () => {
    const saved = await world(), directory = path.join(root, "backups", "profiles", id); await mkdir(directory, { recursive: true });
    const name = "mc-fixture.tar.gz", archivePath = path.join(directory, name); await promisify(execFile)("tar", ["-czf", archivePath, "-C", path.dirname(saved.base), "world"]);
    const bytes = await readFile(archivePath), descriptor = { profileId: id, archivePath, name, bytes: bytes.length, sha256: store.overviewHash(bytes), flushed: true, snapshotAt: new Date().toISOString() };
    await writeFile(`${archivePath}.manifest.json`, JSON.stringify({ minecraftProfileId: id, archiveBytes: bytes.length, sha256: descriptor.sha256, flushed: true, members: ["world"], createdAt: descriptor.snapshotAt }));
    state.runtime.state = "running"; state.runtime.containerState = "running";
    const response = await route.POST(request(), context()); expect(response.status, JSON.stringify(await response.clone().json())).toBe(202); const receipt = await response.json(); expect((await store.readOverviewJob(id, receipt.jobId)).source.kind).toBe("backup");
    const { copyMinecraftOverviewArchive } = await import("@/lib/minecraft-profile-overview-archive");
    await expect(copyMinecraftOverviewArchive(id, randomUUID(), { ...descriptor, sha256: "0".repeat(64) })).rejects.toThrow("checksum");
    await expect(copyMinecraftOverviewArchive(id, randomUUID(), { ...descriptor, profileId: randomUUID() })).rejects.toThrow("another profile");
    await expect(copyMinecraftOverviewArchive(id, randomUUID(), { ...descriptor, flushed: false })).rejects.toThrow("not flushed");
    await symlink("dimensions/minecraft/overworld/region/r.0.0.mca", path.join(saved.base, "ordinary-link"));
    await promisify(execFile)("tar", ["--format=ustar", "-czf", archivePath, "-C", path.dirname(saved.base), "world"]); const changed = await readFile(archivePath);
    await expect(copyMinecraftOverviewArchive(id, randomUUID(), { ...descriptor, bytes: changed.length, sha256: store.overviewHash(changed) })).rejects.toThrow("refuse links");
  });
  it("rejects changed pinned input, renderer permission revocation and failed image readback", async () => {
    const first = await queued(); state.renderer = async () => { await writeFile(path.join(root, "overviews", id, "jobs", first.jobId, "input/world/level.dat"), level(false, 1, 1)); };
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("pinned source changed"); expect((await store.readOverviewRecord(id))?.state).toBe("unverified");
  });
  it("rechecks account access after renderer work before image publication", async () => {
    await queued(); state.renderer = async () => { await client.user.update({ where: { id: actor }, data: { games: "zomboid" } }); };
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toMatchObject({ status: 403 }); expect((await store.readOverviewRecord(id))?.artifact).toBeNull();
  });
  it("fails corrupted atomic publication readback instead of claiming generated success", async () => {
    await queued(); state.corruptWrite = true; await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("byte readback"); expect((await store.readOverviewRecord(id))?.state).toBe("unverified");
  });
  it("reports rendering only for its live owner, serializes workers and marks persisted orphan ownership unverified", async () => {
    await queued(); let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; }); state.renderer = () => pending;
    const work = queue.runMinecraftProfileOverviewQueue(); await vi.waitFor(() => expect(state.renders).toBe(1));
    expect((await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!)).state).toBe("rendering");
    const operation = listOperations(["minecraft"]).find(op => op.kind === "profile.overview" && op.resources.includes("render:minecraft-overview")); expect(operation?.holdsPower).toBe(false); expect(operation?.resources).toEqual(["render:minecraft-overview"]);
    await queue.runMinecraftProfileOverviewQueue(); expect(state.renders).toBe(1); resolve(); await work;
    const row = (await store.readOverviewRecord(id))!; row.state = "rendering"; row.operationId = "missing-owner"; await store.writeOverviewRecord(row);
    const orphan = await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!); expect(orphan.state).toBe("unverified"); expect(orphan.imageUrl).not.toBeNull();
    expect((await route.POST(request({ expectedRevision: 1, expectedOverviewRevision: orphan.revision }), context())).status).toBe(409);
  });
  it("defers safe resource refusal rather than marking it a renderer failure", async () => {
    await queued(); state.defer = true; await queue.runMinecraftProfileOverviewQueue(); expect(await store.readOverviewRecord(id)).toMatchObject({ state: "queued", reason: "Host resources are busy", artifact: null });
    const row = (await store.readOverviewRecord(id))!; row.retryAt = 0; await store.writeOverviewRecord(row); state.defer = false;
    await queue.runMinecraftProfileOverviewQueue(); expect((await store.readOverviewRecord(id))?.state).toBe("ready");
  });
  it("retains unknown worker cleanup as unverified and never implicitly reruns it", async () => {
    await queued(); state.renderer = async () => { throw Object.assign(new Error("Fixture worker ownership could not be verified"), { code: "overview_unverified" }); };
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("ownership"); expect((await store.readOverviewRecord(id))?.state).toBe("unverified");
    await queue.tickMinecraftProfileOverviews(); expect(state.renders).toBe(1);
    expect((await route.POST(request(), context())).status).toBe(409);
  });
  it("refuses queued identity changes and publication into a deleted profile", async () => {
    const receipt = await queued(), job = await store.readOverviewJob(id, receipt.jobId);
    await store.writeOverviewJSON(`${id}/jobs/${receipt.jobId}/job.json`, { ...job, profileId: randomUUID() });
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("job is malformed"); expect(state.renders).toBe(0);
    expect((await store.readOverviewRecord(id))?.state).toBe("unverified"); await queue.tickMinecraftProfileOverviews(); expect(state.renders).toBe(0);
  });
  it("rejects altered manifest target or center before rendering and refuses altered provenance after rendering", async () => {
    const receipt = await queued(), manifestPath = `${id}/jobs/${receipt.jobId}/input/manifest.json`, manifest = await store.readOverviewJSON(manifestPath) as Record<string, unknown>;
    await store.writeOverviewJSON(manifestPath, { ...manifest, target: { ...(manifest.target as object), mcVersion: "1.21.1" }, center: { x: 900, z: 900 } });
    expect((await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!)).state).toBe("unverified");
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("manifest does not match"); expect(state.renders).toBe(0); expect((await store.readOverviewRecord(id))?.state).toBe("unverified");
  });
  it("rechecks the source manifest after renderer completion before claiming a generated cover", async () => {
    const receipt = await queued(), manifestPath = `${id}/jobs/${receipt.jobId}/input/manifest.json`;
    state.renderer = async () => { const manifest = await store.readOverviewJSON(manifestPath) as Record<string, unknown>; await store.writeOverviewJSON(manifestPath, { ...manifest, center: { x: 1, z: 1 } }); };
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("manifest does not match"); expect((await store.readOverviewRecord(id))?.artifact).toBeNull();
  });
  it("does not resurrect metadata or a generated pointer after deletion during renderer work", async () => {
    await queued(); state.renderer = async () => { await client.minecraftProfile.delete({ where: { id } }); };
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("changed before overview publication"); expect(await profiles.getMinecraftProfile(id)).toBeNull(); expect((await store.readOverviewRecord(id))?.artifact).toBeNull();
  });
  it("marks an orphan queued sidecar unverified and lets a different queued profile run on the next tick", async () => {
    await queued();
    id = (await profiles.createProfileRecord({ name: "Another saved world", status: "ready", mcVersion: "26.1.2", loader: "vanilla", javaVariant: "java25", sourceKind: "vanilla", createdBy: actor })).id;
    await mkdir(path.join(root, "game", "profiles", id, "server", "mods"), { recursive: true }); await queued();
    const ids = await store.listOverviewProfiles(), first = ids[0]; id = ids.find(value => value !== first)!;
    await client.minecraftProfile.delete({ where: { id: first } });
    await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("changed or was deleted"); expect((await store.readOverviewRecord(first))?.state).toBe("unverified"); expect(await profiles.getMinecraftProfile(first)).toBeNull();
    await queue.runMinecraftProfileOverviewQueue(); expect((await store.readOverviewRecord(id))?.state).toBe("ready"); expect(state.renders).toBe(1);
  });
  it("refuses same-profile deletion while a real render owner holds the job", async () => {
    await queued(); let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; }); state.renderer = () => pending;
    const work = queue.runMinecraftProfileOverviewQueue(); await vi.waitFor(() => expect(state.renders).toBe(1));
    await expect(runFileWrite("minecraft", () => queue.assertMinecraftProfileOverviewDeletable(id))).rejects.toMatchObject({ code: "overview_busy" }); resolve(); await work;
  });
  it("refuses an image alias or oversized private metadata without invalidating ordinary profile capabilities", async () => {
    const result = await rendered(), file = path.join(root, "overviews", id, "images", `${result.overview.revision}.png`), outside = path.join(root, "ordinary-image.png");
    await writeFile(outside, state.image, { mode: 0o600 }); await rm(file); await symlink(outside, file);
    expect((await images.GET(new Request(`http://fixture?revision=${result.overview.revision}`), context())).status).toBe(503);
    const raw = await route.GET(new Request("http://fixture"), context()); expect(raw.status).toBe(200); expect((await raw.json()).overview.state).toBe("unverified");
    await writeFile(path.join(root, "overviews", id, "overview.json"), Buffer.alloc(1024 * 1024 + 1, 32));
    expect((await minecraftProfileDTO((await profiles.getMinecraftProfile(id))!)).overview?.state).toBe("unverified");
  });
  it("retains the previous verified image on a refused regeneration and refuses malformed output", async () => {
    const result = await rendered(); const receipt = await route.POST(request({ expectedRevision: 1, expectedOverviewRevision: result.overview.revision }), context()); expect(receipt.status).toBe(202);
    state.image = Buffer.from("ordinary invalid PNG fixture"); await expect(queue.runMinecraftProfileOverviewQueue()).rejects.toThrow("PNG");
    const status = await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!); expect(status.state).toBe("failed"); expect(status.revision).toBe(result.overview.revision); expect(status.imageUrl).toBe(result.overview.imageUrl);
  });
  it("a successful backup notification does no renderer work or archive body reads", async () => {
    await world(); const archivePath = path.join(root, "nonexistent-archive.tar.gz");
    const handle = { id: "already-sealed-backup", preempted: false, step: vi.fn(), settle: vi.fn(), fact: vi.fn(), progress: vi.fn(), detail: vi.fn(), reject: vi.fn() };
    await queue.notifyMinecraftProfileOverviewBackup({ profileId: id, archivePath, name: "mc-fixture.tar.gz", bytes: 100, sha256: "0".repeat(64), flushed: true, snapshotAt: new Date().toISOString() }, handle);
    expect(state.renders).toBe(0); expect(handle.step).not.toHaveBeenCalled(); expect((await store.readOverviewRecord(id))?.state).toBe("waiting");
  });
  it("refuses corrupt metadata, private aliases, image mismatch and foreign identity without breaking gameplay DTO", async () => {
    const result = await rendered(), row = (await store.readOverviewRecord(id))!;
    row.profileId = randomUUID(); await store.writeOverviewJSON(`${id}/overview.json`, row);
    expect((await queue.readMinecraftProfileOverview((await profiles.getMinecraftProfile(id))!)).state).toBe("unverified");
    row.profileId = id; await store.writeOverviewRecord(row);
    await writeFile(path.join(root, "overviews", id, "images", `${result.overview.revision}.png`), "ordinary changed bytes");
    expect((await images.GET(new Request(`http://fixture?revision=${result.overview.revision}`), context())).status).toBe(503);
    expect((await minecraftProfileDTO((await profiles.getMinecraftProfile(id))!)).revision).toBe(1);
  });
  it("queues existing stopped profiles automatically and does not seed from GET", async () => {
    await world(); await queue.tickMinecraftProfileOverviews(); expect(state.renders).toBe(1); expect((await store.readOverviewRecord(id))?.state).toBe("ready");
    await queue.tickMinecraftProfileOverviews(); expect(state.renders).toBe(1);
  });
});
