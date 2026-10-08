import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Session } from "next-auth";
import type { MinecraftProfileRuntimeDTO } from "@/lib/minecraft-profile-types";

const state = vi.hoisted(() => ({ client: null as import("@/generated/prisma/client").PrismaClient | null,
  session: null as Session | null, runtime: {} as MinecraftProfileRuntimeDTO, runtimeCalls: 0,
  prepareError: null as Error | null, prepareCalls: 0, renameCalls: 0, markerNames: [] as string[],
  corruptCoverRead: false, corruptSettingsRead: false, settingsWritten: false, refuseQuarantineRemoval: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const read = (async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    if (state.corruptCoverRead && String(args[0]).endsWith(".png")) return Buffer.from("ordinary mismatching cover readback");
    if (state.corruptSettingsRead && state.settingsWritten && String(args[0]).endsWith("server.properties")) return "motd=Unexpected concurrent value\n";
    return value;
  }) as typeof actual.readFile;
  return { ...actual, readFile: read,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => { await actual.writeFile(...args); if (String(args[0]).endsWith("server.properties")) state.settingsWritten = true; },
    rm: async (...args: Parameters<typeof actual.rm>) => { if (state.refuseQuarantineRemoval && String(args[0]).includes(".delete-")) throw Object.assign(new Error("Fixture cleanup permission refused"), { code: "EACCES" }); return actual.rm(...args); },
    rename: async (...args: Parameters<typeof actual.rename>) => { state.renameCalls++; if (String(args[1]).includes(".delete-")) state.markerNames = await actual.readdir(process.env.MC_PROFILE_OPERATIONS_DIR!).catch(() => []); return actual.rename(...args); } };
});
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get(_target, key) { const value = Reflect.get(state.client!, key); return typeof value === "function" ? value.bind(state.client) : value; } }) }));
vi.mock("@/lib/minecraft-profile-activation", () => ({ getMinecraftProfileRuntimeStatus: async () => { state.runtimeCalls++; return state.runtime; } }));
vi.mock("@/lib/minecraft-profile-prepare", () => ({ createPreparedMinecraftProfile: async () => { state.prepareCalls++; if (state.prepareError) throw state.prepareError; return { profile: { id: "fixture" }, operationId: "fixture-op" }; } }));

const collection = await import("@/app/api/minecraft/profiles/route");
const detail = await import("@/app/api/minecraft/profiles/[id]/route");
const settings = await import("@/app/api/minecraft/profiles/[id]/world-settings/route");
const covers = await import("@/app/api/minecraft/profiles/[id]/cover/route");
const store = await import("@/lib/minecraft-profile-store");
let root: string;
let client: PrismaClient;
const session = (role: "ADMIN" | "MOD" | "MEMBER" = "MOD", grants: Session["user"]["games"] = ["minecraft"]): Session => ({ expires: "2030-01-01", user: { id: "fixture-moderator", name: "Fixture", role, games: grants, discordId: "9007199254740993" } });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request("http://fixture/api/minecraft/profiles", { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }) });
const responseJSON = (response: Response) => response.json() as Promise<Record<string, unknown>>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "yoshling-profile-api-")));
  await mkdir(path.join(root, "game"));
  vi.stubEnv("MC_SERVER_DIR", path.join(root, "game")); vi.stubEnv("MC_PROFILE_COVER_DIR", path.join(root, "covers")); vi.stubEnv("MC_PROFILE_OPERATIONS_DIR", path.join(root, "private-operations"));
  client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${root}/fixture.db` }) }); state.client = client;
  for (const migration of ["20260519104842_init", "20261002143000_add_installed_mod_provenance", "20261007180000_add_minecraft_profiles"]) {
    const sql = await readFile(path.resolve(__dirname, `../../../prisma/migrations/${migration}/migration.sql`), "utf8");
    for (const part of sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(text => text.trim()).filter(Boolean)) await client.$executeRawUnsafe(part);
  }
  state.session = session(); state.runtime = { selectedProfileId: null, appliedProfileId: null, verified: true, state: "legacy", revision: "0" };
  state.runtimeCalls = 0; state.prepareCalls = 0; state.prepareError = null; state.renameCalls = 0; state.markerNames = [];
  state.corruptCoverRead = false; state.corruptSettingsRead = false; state.settingsWritten = false;
  state.refuseQuarantineRemoval = false;
});
afterEach(async () => { await client.$disconnect(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function profile() {
  const row = await store.createProfileRecord({ name: "Fixture realm", status: "ready", mcVersion: "1.21.4", loader: "vanilla", javaVariant: "java21", sourceKind: "vanilla", createdBy: "fixture-owner" });
  const dir = path.join(root, "game", "profiles", row.id, "server");
  await mkdir(path.join(dir, "mods"), { recursive: true });
  await writeFile(path.join(dir, "server.properties"), "motd=Fixture world\nmax-players=12\nlevel-seed=old-seed\nonline-mode=true\nrcon.password=ordinary-fixture-placeholder\nserver-port=25565\n");
  return { row, dir };
}
async function coverRequest(id: string, revision = 1, bytes?: Buffer) {
  const image = bytes ?? await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } } }).png().toBuffer();
  const form = new FormData(); form.set("expectedRevision", String(revision)); form.set("cover", new File([new Uint8Array(image)], "fixture.png", { type: "image/png" }));
  return new Request(`http://fixture/api/minecraft/profiles/${id}/cover`, { method: "POST", body: form });
}

describe("profile APIs enforce game and role scope", () => {
  it.each(["guest", "wrong-world", "member-write"])("refuses %s before preparation or runtime inspection", async scenario => {
    state.session = scenario === "guest" ? null : scenario === "wrong-world" ? session("MEMBER", ["zomboid"]) : session("MEMBER");
    const response = await collection.POST(request("POST", { name: "New", source: { kind: "vanilla", mcVersion: "1.21.4" } }));
    expect(response.status).toBe(scenario === "guest" ? 401 : 403); expect(state.prepareCalls).toBe(0); expect(state.runtimeCalls).toBe(0);
  });
  it("lets a Minecraft member inspect metadata/counts without creating a profile or pointer", async () => {
    const { row, dir } = await profile(); await writeFile(path.join(dir, "mods", "fixture.jar"), "ordinary jar fixture"); state.session = session("MEMBER");
    const response = await collection.GET(); const body = await responseJSON(response);
    expect(response.status).toBe(200); expect((body.profiles as { id: string; modCount: number }[])[0]).toMatchObject({ id: row.id, modCount: 1 });
    expect(body.capabilities).toMatchObject({ manage: false, start: false, switch: false });
    expect(await client.minecraftProfile.count()).toBe(1); expect(await client.minecraftRuntime.count()).toBe(0);
  });
  it("returns migration-required instead of an empty ready gallery", async () => {
    await client.$executeRawUnsafe('DROP TABLE "MinecraftRuntime"'); await client.$executeRawUnsafe('DROP TABLE "MinecraftProfile"');
    const response = await collection.GET(); expect(response.status).toBe(503);
    expect(await responseJSON(response)).toMatchObject({ code: "profile_migration_required" });
  });
  it("rejects metadata target/path edits and stale numeric revisions", async () => {
    const { row } = await profile();
    expect((await detail.PATCH(request("PATCH", { expectedRevision: 1, mcVersion: "1.20" }), context(row.id))).status).toBe(400);
    expect((await detail.PATCH(request("PATCH", { expectedRevision: 1, name: "Partial unwanted edit", mcVersion: "1.20" }), context(row.id))).status).toBe(400);
    const saved = await detail.PATCH(request("PATCH", { expectedRevision: 1, name: "Named / display" }), context(row.id));
    expect(saved.status).toBe(200); expect((await responseJSON(saved)).profile).toMatchObject({ id: row.id, name: "Named / display", revision: 2 });
    expect((await detail.PATCH(request("PATCH", { expectedRevision: 1, name: "Stale" }), context(row.id))).status).toBe(409);
    expect((await store.getMinecraftProfile(row.id))?.name).toBe("Named / display");
  });
  it("preserves tracked preparation failures and their actual reason/identity", async () => {
    state.prepareError = Object.assign(new Error("Required jar checksum did not match"), { operationId: "fixture-op", profileId: "fixture-profile" });
    const response = await collection.POST(request("POST", { name: "New", source: { kind: "vanilla", mcVersion: "1.21.4" } }));
    expect(response.status).toBe(502); expect(await responseJSON(response)).toMatchObject({ error: "Required jar checksum did not match", operationId: "fixture-op", profileId: "fixture-profile" });
  });
  it("uses exact validated source input and refuses host-control settings before any tracked preparation", async () => {
    expect((await collection.POST(request("POST", { name: "New", source: { kind: "vanilla", mcVersion: "LATEST" } }))).status).toBe(400);
    expect((await collection.POST(request("POST", { name: "New\u0001", source: { kind: "vanilla", mcVersion: "1.21.4" } }))).status).toBe(400);
    expect((await collection.POST(request("POST", { name: "New", source: { kind: "vanilla", mcVersion: "1.21.4" }, settings: { "rcon.password": "fixture" } }))).status).toBe(400);
    expect((await collection.POST(request("POST", { name: "New", source: { kind: "vanilla", mcVersion: "1.21.4" } }))).status).toBe(200);
    expect(state.prepareCalls).toBe(1);
  });
});

describe("inactive world settings use profile-bound snapshots", () => {
  it("masks host-owned values and validates literal updates with canonical readback", async () => {
    const { row, dir } = await profile();
    const snapshot = await settings.GET(request("GET"), context(row.id)); const body = await responseJSON(snapshot);
    expect(body.properties).toEqual({ motd: "Fixture world", "max-players": "12", "level-seed": "old-seed" });
    const revision = snapshot.headers.get("X-File-Revision")!;
    const changed = await settings.PUT(request("PUT", { updates: { motd: "  A new world  ", difficulty: "hard" } }, { "X-Expected-File-Revision": revision }), context(row.id));
    expect(changed.status).toBe(200); expect(await responseJSON(changed)).toMatchObject({ applied: ["motd", "difficulty"], properties: { motd: "A new world", difficulty: "hard" } });
    expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("rcon.password=ordinary-fixture-placeholder");
  });
  it("requires a loaded revision and refuses stale snapshots without overwriting", async () => {
    const { row, dir } = await profile();
    expect((await settings.PUT(request("PUT", { updates: { motd: "No revision" } }), context(row.id))).status).toBe(428);
    const snapshot = await settings.GET(request("GET"), context(row.id));
    await writeFile(path.join(dir, "server.properties"), "motd=Concurrent edit\n");
    const response = await settings.PUT(request("PUT", { updates: { motd: "Stale" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(row.id));
    expect(response.status).toBe(409); expect(await readFile(path.join(dir, "server.properties"), "utf8")).toBe("motd=Concurrent edit\n");
  });
  it("binds the file revision to its profile, even when two files contain identical settings", async () => {
    const a = await profile(); const b = await profile();
    const snapshot = await settings.GET(request("GET"), context(a.row.id));
    const response = await settings.PUT(request("PUT", { updates: { motd: "Wrong profile" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(b.row.id));
    expect(response.status).toBe(409); expect(await readFile(path.join(b.dir, "server.properties"), "utf8")).toContain("motd=Fixture world");
  });
  it("does not confirm world settings when the actual post-write readback disagrees", async () => {
    const { row } = await profile();
    const snapshot = await settings.GET(request("GET"), context(row.id));
    state.settingsWritten = false; state.corruptSettingsRead = true;
    const response = await settings.PUT(request("PUT", { updates: { motd: "Requested value" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(row.id));
    state.corruptSettingsRead = false;
    expect(response.status).toBe(503); expect(await responseJSON(response)).not.toHaveProperty("applied");
  });
  it.each(["active", "unknown", "member"])("refuses %s edits", async scenario => {
    const { row, dir } = await profile();
    if (scenario === "active") state.runtime = { ...state.runtime, selectedProfileId: row.id, appliedProfileId: row.id, state: "stopped" };
    if (scenario === "unknown") state.runtime = { ...state.runtime, verified: false, state: "unknown" };
    if (scenario === "member") state.session = session("MEMBER");
    const snapshot = await settings.GET(request("GET"), context(row.id)); expect((await responseJSON(snapshot)).editable).toBe(false);
    const response = await settings.PUT(request("PUT", { updates: { motd: "Refused" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(row.id));
    expect(response.status).toBe(scenario === "member" ? 403 : 409); expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("motd=Fixture world");
  });
  it("locks creation-only settings after world data exists and preserves the file", async () => {
    const { row, dir } = await profile(); await mkdir(path.join(dir, "world")); await writeFile(path.join(dir, "world", "level.dat"), "ordinary save fixture");
    const snapshot = await settings.GET(request("GET"), context(row.id)); const body = await responseJSON(snapshot);
    expect(body.worldGenerated).toBe(true); expect(body.editableKeys as string[]).not.toContain("level-seed");
    const response = await settings.PUT(request("PUT", { updates: { "level-seed": "new-seed" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(row.id));
    expect(response.status).toBe(409); expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("level-seed=old-seed");
  });
  it("permits seed edits before generation when an initial datapack directory exists", async () => {
    const { row, dir } = await profile(); await mkdir(path.join(dir, "world", "datapacks"), { recursive: true }); await writeFile(path.join(dir, "world", "datapacks", "fixture.zip"), "ordinary datapack fixture");
    const snapshot = await settings.GET(request("GET"), context(row.id)); expect((await responseJSON(snapshot)).worldGenerated).toBe(false);
    const response = await settings.PUT(request("PUT", { updates: { "level-seed": "new-seed" } }, { "X-Expected-File-Revision": snapshot.headers.get("X-File-Revision")! }), context(row.id));
    expect(response.status).toBe(200); expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("level-seed=new-seed");
  });
});

describe("cover uploads are private verified raster images", () => {
  it("decodes a cover, publishes canonical metadata and serves only gated PNG bytes", async () => {
    const { row } = await profile();
    const upload = await covers.POST(await coverRequest(row.id), context(row.id)); const body = await responseJSON(upload);
    expect(upload.status).toBe(200); expect(body.profile).toMatchObject({ revision: 2, coverUrl: `/api/minecraft/profiles/${row.id}/cover?v=2` });
    const image = await covers.GET(request("GET"), context(row.id)); expect(image.status).toBe(200); expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Cache-Control")).toContain("private"); expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(4);
    state.session = null; expect((await covers.GET(request("GET"), context(row.id))).status).toBe(401);
  });
  it("refuses invalid/vector bytes and stale uploads without changing metadata", async () => {
    const { row } = await profile();
    const decoder = vi.spyOn(sharp.prototype, "metadata");
    expect((await covers.POST(await coverRequest(row.id, 1, Buffer.from("<svg>ordinary fixture</svg>")), context(row.id))).status).toBe(400);
    expect(decoder).not.toHaveBeenCalled(); decoder.mockRestore();
    expect((await covers.POST(await coverRequest(row.id, 99), context(row.id))).status).toBe(409);
    expect((await store.getMinecraftProfile(row.id))?.coverKey).toBeNull();
  });
  it("refuses member writes and oversized covers before publication", async () => {
    const { row } = await profile(); state.session = session("MEMBER");
    expect((await covers.POST(await coverRequest(row.id), context(row.id))).status).toBe(403);
    state.session = session();
    expect((await covers.POST(await coverRequest(row.id, 1, Buffer.alloc(5 * 1024 * 1024 + 1)), context(row.id))).status).toBe(413);
    expect((await store.getMinecraftProfile(row.id))?.coverKey).toBeNull();
  });
  it("strips source metadata and encodes JPEG uploads as safe PNG", async () => {
    const { row } = await profile();
    const source = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 40, g: 60, b: 80 } } }).withExif({ IFD0: { Artist: "Ordinary fixture author" } }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    expect((await covers.POST(await coverRequest(row.id, 1, source), context(row.id))).status).toBe(200);
    const response = await covers.GET(request("GET"), context(row.id)); const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(metadata.format).toBe("png"); expect(metadata.exif).toBeUndefined();
  });
  it("does not publish cover metadata when actual stored bytes disagree", async () => {
    const { row } = await profile(); state.corruptCoverRead = true;
    const response = await covers.POST(await coverRequest(row.id), context(row.id)); state.corruptCoverRead = false;
    expect(response.status).toBe(503); expect((await store.getMinecraftProfile(row.id))?.coverKey).toBeNull();
  });
  it("refuses a cover alias belonging to another profile", async () => {
    const a = await profile(); const b = await profile(); const key = "00000000-0000-0000-0000-000000000003.png";
    await mkdir(path.join(root, "covers", a.row.id), { recursive: true }); await mkdir(path.join(root, "covers", b.row.id));
    await writeFile(path.join(root, "covers", b.row.id, key), "ordinary other-profile fixture"); await symlink(path.join(root, "covers", b.row.id, key), path.join(root, "covers", a.row.id, key));
    await store.updateProfileRecord(a.row.id, 1, { coverKey: key, coverMime: "image/png" });
    expect((await covers.GET(request("GET"), context(a.row.id))).status).toBe(503);
    expect((await covers.DELETE(request("DELETE", { expectedRevision: 2 }), context(a.row.id))).status).toBe(503);
    expect((await store.getMinecraftProfile(a.row.id))?.coverKey).toBe(key);
    expect(await readFile(path.join(root, "covers", b.row.id, key), "utf8")).toBe("ordinary other-profile fixture");
  });
  it("removes a cover with canonical metadata and physical absence readback", async () => {
    const { row } = await profile();
    expect((await covers.POST(await coverRequest(row.id), context(row.id))).status).toBe(200);
    const uploaded = await store.getMinecraftProfile(row.id);
    const file = path.join(root, "covers", row.id, uploaded!.coverKey!);
    const response = await covers.DELETE(request("DELETE", { expectedRevision: 2 }), context(row.id));
    expect(response.status).toBe(200); expect((await responseJSON(response)).profile).toMatchObject({ coverUrl: null, revision: 3 });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("profile deletion is explicit and inactive", () => {
  it("refuses selected/unknown profiles and requires explicit confirmation", async () => {
    const { row, dir } = await profile();
    expect((await detail.DELETE(request("DELETE", { expectedRevision: 1 }), context(row.id))).status).toBe(400);
    state.runtime = { ...state.runtime, selectedProfileId: row.id, appliedProfileId: row.id };
    await client.minecraftRuntime.create({ data: { id: "main", selectedProfileId: row.id, revision: "selected-fixture" } });
    expect((await detail.DELETE(request("DELETE", { expectedRevision: 1, confirm: true }), context(row.id))).status).toBe(409);
    expect(state.renameCalls).toBe(0);
    state.runtime = { ...state.runtime, selectedProfileId: null, appliedProfileId: null, verified: false, state: "unknown" };
    expect((await detail.DELETE(request("DELETE", { expectedRevision: 1, confirm: true }), context(row.id))).status).toBe(409);
    expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("Fixture world");
  });
  it("removes an inactive profile's directory and metadata with actual readbacks", async () => {
    const { row, dir } = await profile();
    expect((await covers.POST(await coverRequest(row.id), context(row.id))).status).toBe(200);
    const stored = await store.getMinecraftProfile(row.id);
    const cover = path.join(root, "covers", row.id, stored!.coverKey!);
    const response = await detail.DELETE(request("DELETE", { expectedRevision: 2, confirm: true }), context(row.id));
    expect(response.status).toBe(200); expect(await responseJSON(response)).toMatchObject({ deleted: true, id: row.id });
    expect(state.markerNames).toEqual([expect.stringMatching(/^\.operation-delete-/)]);
    expect(await readdir(path.join(root, "private-operations"))).toEqual([]);
    expect(await store.getMinecraftProfile(row.id)).toBeNull(); await expect(readFile(path.join(dir, "server.properties"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(cover)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains the tracked receipt when its private operation marker cannot be created", async () => {
    const { row, dir } = await profile(); await writeFile(path.join(root, "private-operations"), "ordinary blocking fixture");
    const response = await detail.DELETE(request("DELETE", { expectedRevision: 1, confirm: true }), context(row.id));
    expect(response.status).toBe(502); expect(await responseJSON(response)).toMatchObject({ operationId: expect.any(String), profileId: row.id });
    expect(await store.getMinecraftProfile(row.id)).not.toBeNull(); expect(await readFile(path.join(dir, "server.properties"), "utf8")).toContain("Fixture world");
  });
  it("retains the tracked receipt and actual partial effects after file cleanup fails", async () => {
    const { row } = await profile(); state.refuseQuarantineRemoval = true;
    const response = await detail.DELETE(request("DELETE", { expectedRevision: 1, confirm: true }), context(row.id)); state.refuseQuarantineRemoval = false;
    const body = await responseJSON(response);
    expect(response.status).toBe(502); expect(body).toMatchObject({ error: "Fixture cleanup permission refused", profileId: row.id, operationId: expect.any(String) });
    expect(body).not.toHaveProperty("deleted"); expect(await store.getMinecraftProfile(row.id)).toBeNull();
    const staged = (await readdir(path.join(root, "game", "profiles"))).find(name => name.startsWith(`.delete-${row.id}-`));
    expect(staged).toBeDefined(); expect(await readFile(path.join(root, "game", "profiles", staged!, "server", "server.properties"), "utf8")).toContain("Fixture world");
  });
});
