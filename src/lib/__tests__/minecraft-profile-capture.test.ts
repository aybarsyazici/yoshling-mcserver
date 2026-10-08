import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Session } from "next-auth";
import type { MinecraftProfileRuntimeDTO } from "@/lib/minecraft-profile-types";
const state = vi.hoisted(() => ({ client: null as import("@/generated/prisma/client").PrismaClient | null, session: null as Session | null,
  runtime: {} as MinecraftProfileRuntimeDTO, root: "", profileId: "", invited: true, corruptImage: false, corruptRecord: false, failComplete: false, failRemoval: "",
  beforeNormalize: null as (() => Promise<void>) | null, beforeImageRead: null as (() => Promise<void>) | null,
  publication: null as { promise: Promise<void>; resolve(): void } | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/whitelist", () => ({ isWhitelisted: async () => state.invited }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get(_target, key) { const value = Reflect.get(state.client!, key); return typeof value === "function" ? value.bind(state.client) : value; } }) }));
vi.mock("@/lib/minecraft-profile-activation", () => ({ getMinecraftProfileRuntimeStatus: async () => state.runtime }));
vi.mock("@/lib/minecraft-active-profile", () => ({ minecraftActiveContext: async () => ({ profileId: state.runtime.selectedProfileId, revision: state.runtime.revision, token: `${state.runtime.selectedProfileId}@${state.runtime.revision}`, root: state.root }), assertMinecraftProfileCurrent: async () => {} }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  const read = (async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).endsWith(".png") && state.beforeImageRead) { const work = state.beforeImageRead; state.beforeImageRead = null; await work(); }
    if (String(args[0]).endsWith(".png") && state.corruptImage) return Buffer.from("ordinary incorrect image readback");
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "writeFile") return async (...params: Parameters<typeof handle.writeFile>) => {
        if (state.corruptRecord && typeof params[0] === "string" && params[0].includes('"phase":"waiting"')) return handle.writeFile(params[0].replace('"userId":"fixture-manager"', '"userId":"changed-fixture"'), "utf8");
        if (state.failComplete && typeof params[0] === "string" && params[0].includes('"phase":"complete"')) throw new Error("Fixture receipt write failed");
        if (String(args[0]).endsWith(".png") && state.publication) await state.publication.promise;
        return handle.writeFile(...params);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof actual.open;
  return { ...actual, readFile: read, open, rm: async (...args: Parameters<typeof actual.rm>) => { if (state.failRemoval && String(args[0]).endsWith(state.failRemoval)) throw new Error("Fixture old-file cleanup failed"); return actual.rm(...args); } };
});
vi.mock("@/lib/minecraft-profile-cover", async original => {
  const actual = await original<typeof import("@/lib/minecraft-profile-cover")>();
  return { ...actual, normalizeMinecraftProfileCover: async (...args: Parameters<typeof actual.normalizeMinecraftProfileCover>) => { const output = await actual.normalizeMinecraftProfileCover(...args); if (state.beforeNormalize) { const work = state.beforeNormalize; state.beforeNormalize = null; await work(); } return output; } };
});
const mint = await import("@/app/api/minecraft/profiles/[id]/capture/route");
const sessions = await import("@/app/api/minecraft/profiles/[id]/capture/[sessionId]/route");
const pairing = await import("@/app/api/minecraft/capture/context/route");
const uploads = await import("@/app/api/minecraft/capture/route");
const companion = await import("@/app/api/minecraft/capture/companion/route");
const store = await import("@/lib/minecraft-profile-capture-store");
const profiles = await import("@/lib/minecraft-profile-store");
const service = await import("@/lib/minecraft-profile-capture");
const actor = "fixture-manager";
let root: string, client: PrismaClient, profileId: string, image: Buffer;
const req = (body: unknown, headers: Record<string, string> = {}) => new Request("http://fixture", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
const context = () => ({ params: Promise.resolve({ id: profileId }) });
const sessionContext = (id: string, profile = profileId) => ({ params: Promise.resolve({ id: profile, sessionId: id }) });
const validClient = { protocol: 1, minecraftVersion: "26.1.2", serverAddress: "mc.yoshling.xyz:25565" };
const session = (role: "MOD" | "MEMBER" = "MOD"): Session => ({ expires: "2030-01-01", user: { id: actor, name: "Fixture", role, games: ["minecraft"], discordId: "9007199254740993" } });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "capture-api-"))); state.root = root;
  for (const name of ["game", "companions"]) await mkdir(path.join(root, name));
  vi.stubEnv("MC_SERVER_DIR", path.join(root, "game")); vi.stubEnv("MC_PROFILE_COVER_DIR", path.join(root, "covers")); vi.stubEnv("MC_PROFILE_CAPTURES_DIR", path.join(root, "captures")); vi.stubEnv("MC_CAPTURE_COMPANION_DIR", path.join(root, "companions"));
  client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${root}/fixture.db` }) }); state.client = client;
  for (const migration of ["20260519104842_init", "20260913144054_add_game_access_and_zomboid_mods", "20261002143000_add_installed_mod_provenance", "20261007180000_add_minecraft_profiles"]) {
    const sql = await readFile(path.resolve(__dirname, `../../../prisma/migrations/${migration}/migration.sql`), "utf8");
    for (const part of sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(text => text.trim()).filter(Boolean)) await client.$executeRawUnsafe(part);
  }
  await client.user.create({ data: { id: actor, discordId: "9007199254740993", username: "Fixture", role: "MOD", games: "minecraft" } });
  const profile = await profiles.createProfileRecord({ name: "Fixture world", status: "ready", mcVersion: "26.1.2", loader: "fabric", loaderVersion: "0.19.5", javaVariant: "java25", sourceKind: "vanilla", createdBy: actor });
  profileId = profile.id; state.profileId = profileId;
  await mkdir(path.join(root, "game", "profiles", profileId, "server", "mods"), { recursive: true });
  state.runtime = { selectedProfileId: profileId, appliedProfileId: profileId, verified: true, state: "running", revision: "runtime-r1" };
  state.session = session(); state.invited = true; state.corruptImage = false; state.corruptRecord = false; state.failComplete = false; state.failRemoval = ""; state.beforeNormalize = null; state.beforeImageRead = null; state.publication = null;
  image = await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } } }).png().toBuffer();
});
afterEach(async () => { state.publication?.resolve(); await client.$disconnect(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
async function grant(replaceExisting = false, expectedRevision = 1) {
  const response = await mint.POST(req({ expectedRevision, replaceExisting }), context()); expect(response.status).toBe(200);
  const body = await response.json(); const code = body.session.command.split(" ").at(-1) as string;
  return { id: body.session.id as string, code, header: { Authorization: `Bearer ${code}` } };
}
async function paired() { const value = await grant(); const response = await pairing.POST(req(validClient, value.header)); expect(response.status).toBe(200); return { ...value, ctx: await response.json() }; }
function upload(value: Awaited<ReturnType<typeof paired>>, bytes: Buffer = image, headers: Record<string, string> = {}) {
  return new Request("http://fixture/api/minecraft/capture", { method: "POST", body: new Uint8Array(bytes), headers: { ...value.header, "Content-Type": "image/png", "X-Minecraft-Context": value.ctx.contextToken, "X-Minecraft-Profile": value.ctx.profileId, "X-Profile-Revision": String(value.ctx.profileRevision), ...headers } });
}

describe("capture authorization and session identity", () => {
  it("mints only a hashed secret and a15minute single-profile private session", async () => {
    const value = await grant(); expect(value.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = await readFile(path.join(root, "captures", `${value.id}.json`), "utf8"); expect(bytes).not.toContain(value.code); expect(bytes).not.toContain("/yoshling");
    const row = await store.readCapture(value.id); expect(row.expiresAt - row.createdAt).toBe(15 * 60_000); expect(row.expectedRevision).toBe(1);
    expect((await lstat(path.join(root, "captures"))).mode & 0o777).toBe(0o700); expect((await lstat(path.join(root, "captures", `${value.id}.json`))).mode & 0o777).toBe(0o600);
  });
  it.each(["anonymous", "member", "wrong-world", "policy"])("refuses %s mint before capture storage exists", async kind => {
    if (kind === "anonymous") state.session = null; if (kind === "member") state.session = session("MEMBER"); if (kind === "wrong-world") state.session!.user.games = ["zomboid"]; if (kind === "policy") state.invited = false;
    expect((await mint.POST(req({ expectedRevision: 1, replaceExisting: false }), context())).status).toBe(kind === "anonymous" ? 401 : 403);
    await expect(lstat(path.join(root, "captures"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires a current ready/running supported profile and exact metadata revision", async () => {
    state.runtime.state = "stopped"; expect((await mint.POST(req({ expectedRevision: 1, replaceExisting: false }), context())).status).toBe(409);
    state.runtime.state = "running"; expect((await mint.POST(req({ expectedRevision: 2, replaceExisting: false }), context())).status).toBe(409);
    await profiles.updateProfileRecord(profileId, 1, { mcVersion: "1.21.1" }); expect((await mint.POST(req({ expectedRevision: 2, replaceExisting: false }), context())).status).toBe(422);
  });
  it("invalidates prior live pairings when a newer grant is minted", async () => {
    const old = await grant(); await grant(); expect((await pairing.POST(req(validClient, old.header))).status).toBe(409);
  });
  it.each([{ protocol: 2 }, { minecraftVersion: "1.21.1" }, { serverAddress: "other.example" }, { serverAddress: "mc.yoshling.xyz:25575" }])("refuses wrong client target %j", async patch => {
    const value = await grant(); expect((await pairing.POST(req({ ...validClient, ...patch }, value.header))).status).toBe(422);
  });
  it("requires explicit cover replacement and refuses a cancelled or expired bearer", async () => {
    const first = await paired(); expect((await uploads.POST(upload(first))).status).toBe(200);
    expect((await mint.POST(req({ expectedRevision: 2, replaceExisting: false }), context())).status).toBe(409);
    const replacement = await grant(true, 2); expect((await sessions.DELETE(new Request("http://fixture", { method: "DELETE" }), sessionContext(replacement.id))).status).toBe(200);
    expect((await pairing.POST(req(validClient, replacement.header))).status).toBe(410);
    const expired = await grant(true, 2); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 16 * 60_000); expect((await pairing.POST(req(validClient, expired.header))).status).toBe(410);
  });
  it("refuses expired completed bearer receipts while keeping cookie-owned completion history", async () => {
    const value = await paired(); expect((await uploads.POST(upload(value))).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await pairing.POST(req(validClient, value.header))).status).toBe(410);
    expect(await (await sessions.GET(new Request("http://fixture"), sessionContext(value.id))).json()).toMatchObject({ verified: true, session: { state: "complete" } });
  });
  it("refuses wrong secret, wrong cookie owner and wrong profile binding", async () => {
    const value = await grant(); const bytes = Buffer.from(value.code, "base64url"); bytes[31] ^= 1;
    expect((await pairing.POST(req(validClient, { Authorization: `Bearer ${bytes.toString("base64url")}` }))).status).toBe(401);
    expect((await sessions.GET(new Request("http://fixture"), sessionContext(value.id, randomUUID()))).status).toBe(404);
    state.session!.user.id = "another-manager"; expect((await sessions.GET(new Request("http://fixture"), sessionContext(value.id))).status).toBe(404);
  });
});

describe("verified capture publication and replay", () => {
  it("pairs protocol context, writes normalized bytes and returns the same verified receipt on replay", async () => {
    const value = await paired(); expect(value.ctx).toMatchObject({ protocol: 1, state: "waiting", profileId, profileRevision: 1, maxBytes: 5242880, maxPixels: 16000000, uploadUrl: "https://yoshling.xyz/api/minecraft/capture" });
    const response = await uploads.POST(upload(value)); expect(response.status).toBe(200); const body = await response.json(); expect(body).toMatchObject({ protocol: 1, state: "complete", verified: true, profile: { id: profileId, revision: 2, coverUrl: `/api/minecraft/profiles/${profileId}/cover?v=2` } });
    expect((await uploads.POST(upload(value))).status).toBe(200); expect((await profiles.getMinecraftProfile(profileId))?.revision).toBe(2);
    expect((await store.readCapture(value.id)).phase).toBe("complete");
    const contextResponse = await pairing.POST(req(validClient, value.header)); expect(await contextResponse.json()).toMatchObject({ state: "complete", verified: true, profileRevision: 1, profile: { revision: 2 } });
    const row = await profiles.getMinecraftProfile(profileId); expect((await sharp(await readFile(path.join(root, "covers", profileId, row!.coverKey!))).metadata()).format).toBe("png");
  });
  it("refuses a different replay and a later manual metadata or cover edit", async () => {
    const value = await paired(); expect((await uploads.POST(upload(value))).status).toBe(200);
    const other = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer(); expect((await uploads.POST(upload(value, other))).status).toBe(409);
    await profiles.updateProfileRecord(profileId, 2, { name: "Manual edit wins" }); expect((await uploads.POST(upload(value))).status).toBe(409);
    expect((await profiles.getMinecraftProfile(profileId))?.name).toBe("Manual edit wins");
  });
  it.each(["role", "grant", "policy", "runtime", "revision"])("revalidates %s after normalization and before publication", async kind => {
    const value = await paired(); state.beforeNormalize = async () => {
      if (kind === "role") await client.user.update({ where: { id: actor }, data: { role: "MEMBER" } });
      if (kind === "grant") await client.user.update({ where: { id: actor }, data: { games: "zomboid" } });
      if (kind === "policy") state.invited = false;
      if (kind === "runtime") state.runtime.revision = "runtime-new";
      if (kind === "revision") await profiles.updateProfileRecord(profileId, 1, { name: "Changed during decode" });
    };
    expect((await uploads.POST(upload(value))).status).toBe(["role", "grant", "policy"].includes(kind) ? 403 : 409);
    expect((await profiles.getMinecraftProfile(profileId))?.coverKey).toBeNull();
  });
  it("requires exact headers and rejects oversized or non-PNG content", async () => {
    const value = await paired(); expect((await uploads.POST(upload(value, image, { "X-Minecraft-Profile": randomUUID() }))).status).toBe(409);
    expect((await uploads.POST(upload(value, Buffer.alloc(5 * 1024 * 1024 + 1)))).status).toBe(413);
    expect((await uploads.POST(upload(value, Buffer.from("<svg>ordinary fixture</svg>")))).status).toBe(400);
    expect((await uploads.POST(upload(value, image, { "Content-Type": "image/jpeg" }))).status).toBe(415);
    expect((await profiles.getMinecraftProfile(profileId))?.coverKey).toBeNull();
  });
  it("refuses revoked authorization before reading or decoding an upload body", async () => {
    const value = await paired(); await client.user.update({ where: { id: actor }, data: { role: "MEMBER" } });
    const request = upload(value), reads = vi.spyOn(request.body!, "getReader");
    expect((await uploads.POST(request)).status).toBe(403); expect(reads).not.toHaveBeenCalled();
  });
  it("rejects pixel overflow and strips source metadata while resizing a valid PNG", async () => {
    const value = await paired();
    const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "blue" } }).png().toBuffer();
    expect((await uploads.POST(upload(value, oversized))).status).toBe(400);
    const source = await sharp({ create: { width: 2400, height: 1500, channels: 3, background: "green" } }).withExif({ IFD0: { Artist: "Ordinary fixture author" } }).png().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined(); expect((await uploads.POST(upload(value, source))).status).toBe(200);
    const profile = await profiles.getMinecraftProfile(profileId), meta = await sharp(await readFile(path.join(root, "covers", profileId, profile!.coverKey!))).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1000]); expect(meta.exif).toBeUndefined();
  });
  it("keeps failed byte readback unverified and refuses overwrite retry", async () => {
    const value = await paired(); state.corruptImage = true; expect((await uploads.POST(upload(value))).status).toBe(503); state.corruptImage = false;
    expect((await profiles.getMinecraftProfile(profileId))?.revision).toBe(1);
    const status = await sessions.GET(new Request("http://fixture"), sessionContext(value.id)); expect(await status.json()).toMatchObject({ verified: false, session: { state: "unverified" } });
    expect((await uploads.POST(upload(value))).status).toBe(409);
  });
  it("resolves durable intent after a lost completion-record write without publishing twice", async () => {
    const value = await paired(); state.failComplete = true; expect((await uploads.POST(upload(value))).status).toBe(503); state.failComplete = false;
    expect((await store.readCapture(value.id)).phase).toBe("uploading");
    const status = await sessions.GET(new Request("http://fixture"), sessionContext(value.id)); expect(await status.json()).toMatchObject({ verified: true, session: { state: "complete" }, profile: { revision: 2 } });
    expect((await uploads.POST(upload(value))).status).toBe(200); expect((await profiles.getMinecraftProfile(profileId))?.revision).toBe(2);
    expect((await store.readCapture(value.id)).phase).toBe("complete");
  });
  it("rejects completion if a manual edit arrives during image readback", async () => {
    const value = await paired(); expect((await uploads.POST(upload(value))).status).toBe(200);
    state.beforeImageRead = () => profiles.updateProfileRecord(profileId, 2, { name: "Newer manual revision" }).then(() => {});
    const response = await sessions.GET(new Request("http://fixture"), sessionContext(value.id)); expect(await response.json()).toMatchObject({ verified: false, session: { state: "stale" } });
  });
  it("refuses a capture-image alias even when it points to identical contained bytes", async () => {
    const value = await paired(); expect((await uploads.POST(upload(value))).status).toBe(200);
    const profile = await profiles.getMinecraftProfile(profileId), file = path.join(root, "covers", profileId, profile!.coverKey!), sibling = path.join(root, "covers", profileId, `${randomUUID()}.png`);
    await writeFile(sibling, await readFile(file), { mode: 0o600 }); await rm(file); await symlink(sibling, file);
    await expect(service.captureCompletion(await store.readCapture(value.id))).rejects.toMatchObject({ code: "capture_unverified" });
  });
  it("retains cleanup limitations when durable intent recovers a lost final receipt", async () => {
    const first = await paired(); expect((await uploads.POST(upload(first))).status).toBe(200);
    state.failRemoval = (await profiles.getMinecraftProfile(profileId))!.coverKey!;
    const next = await grant(true, 2), pairedResponse = await pairing.POST(req(validClient, next.header)); const value = { ...next, ctx: await pairedResponse.json() };
    state.failComplete = true; expect((await uploads.POST(upload(value))).status).toBe(503); state.failComplete = false;
    const receipt = await (await sessions.GET(new Request("http://fixture"), sessionContext(value.id))).json();
    expect(receipt).toMatchObject({ verified: true, session: { state: "complete", reason: expect.stringContaining("cleanup") }, profile: { revision: 3 } });
    state.failRemoval = "";
  });
  it("keeps live publication nonterminal then confirms its completed receipt", async () => {
    const value = await paired(); let resolve!: () => void; state.publication = { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
    const pending = uploads.POST(upload(value)); await vi.waitFor(async () => expect((await store.readCapture(value.id)).phase).toBe("uploading"));
    const response = await sessions.GET(new Request("http://fixture"), sessionContext(value.id)); expect(await response.json()).toMatchObject({ verified: false, session: { state: "uploading" } });
    state.publication.resolve(); expect((await pending).status).toBe(200); state.publication = null;
    expect(await (await sessions.GET(new Request("http://fixture"), sessionContext(value.id))).json()).toMatchObject({ verified: true, session: { state: "complete" } });
  });
});

describe("private capture storage and ingress", () => {
  it("refuses a mismatching private grant write before activating or returning a code", async () => {
    state.corruptRecord = true;
    const response = await mint.POST(req({ expectedRevision: 1, replaceExisting: false }), context());
    expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("session");
    expect(await store.activeCapture(profileId)).toBeNull();
  });
  it("refuses grant aliases, mismatched identities and oversized owned JSON", async () => {
    const value = await grant(), file = path.join(root, "captures", `${value.id}.json`), original = await readFile(file);
    await mkdir(path.join(root, "external")); await writeFile(path.join(root, "external", "fixture.json"), original, { mode: 0o600 });
    await rm(file); await symlink(path.join(root, "external", "fixture.json"), file); await expect(store.readCapture(value.id)).rejects.toMatchObject({ code: "capture_unverified" });
    await rm(file); const row = JSON.parse(original.toString()); await writeFile(file, JSON.stringify({ ...row, id: randomUUID() }), { mode: 0o600 }); await expect(store.readCapture(value.id)).rejects.toMatchObject({ code: "capture_unverified" });
    await writeFile(file, " ".repeat(16_385), { mode: 0o600 }); await expect(store.readCapture(value.id)).rejects.toMatchObject({ code: "capture_unverified" });
  });
  it("reserves ingress before a deferred body and refuses concurrent decoders", async () => {
    const value = await paired(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const first = new Request("http://fixture", { method: "POST", body, duplex: "half", headers: upload(value).headers } as RequestInit);
    const pending = uploads.POST(first); await vi.waitFor(() => expect((globalThis as unknown as { yoshlingCaptureIngress?: { id: string } }).yoshlingCaptureIngress?.id).toBe(value.id));
    expect((await uploads.POST(upload(value))).status).toBe(409); expect((await profiles.getMinecraftProfile(profileId))?.coverKey).toBeNull();
    controller.enqueue(new Uint8Array(image)); controller.close(); expect((await pending).status).toBe(200);
  });
  it("cancels a slow body at the ingress deadline and releases its reservation", async () => {
    const value = await paired(); vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date());
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = new Request("http://fixture", { method: "POST", body, duplex: "half", headers: upload(value).headers } as RequestInit);
    const pending = uploads.POST(request); await vi.waitFor(() => expect((globalThis as unknown as { yoshlingCaptureIngress?: { id: string } }).yoshlingCaptureIngress?.id).toBe(value.id));
    await vi.advanceTimersByTimeAsync(30_000); expect(cancelled).toBe(true); expect((await pending).status).toBe(408);
    vi.useRealTimers(); expect((await uploads.POST(upload(value))).status).toBe(200);
  });
  it("bounds grant storage and cleans expired records while keeping uncertain intents", async () => {
    const value = await grant(), original = await store.readCapture(value.id), dir = path.join(root, "captures");
    for (let i = 0; i < 255; i++) { const id = randomUUID(); await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...original, id }), { mode: 0o600 }); }
    expect((await mint.POST(req({ expectedRevision: 1, replaceExisting: false }), context())).status).toBe(429);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 26 * 60 * 60_000);
    expect((await mint.POST(req({ expectedRevision: 1, replaceExisting: false }), context())).status).toBe(200);
    expect((await readdir(dir)).filter(name => !name.startsWith("active-")).length).toBe(1);
  });
});

describe("companion artifact verification", () => {
  it("serves only gated current matching artifact metadata and rejects aliases/corruption", async () => {
    const bytes = Buffer.from("ordinary companion fixture"), name = "yoshling-screenshots-0.1.0+mc26.1.2.jar", dir = path.join(root, "companions");
    await writeFile(path.join(dir, name), bytes); await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ version: "0.1.0", loader: "fabric", minecraftVersions: ["26.1.2"], fileName: name, sha256: store.captureHash(bytes), bytes: bytes.length }));
    expect(await (await companion.GET()).json()).toMatchObject({ downloadUrl: `/companions/${encodeURIComponent(name)}`, sha256: store.captureHash(bytes) });
    state.session = null; expect((await companion.GET()).status).toBe(401); state.session = session();
    await writeFile(path.join(dir, name), Buffer.alloc(bytes.length, 97)); expect((await companion.GET()).status).toBe(503);
    await rm(path.join(dir, name)); await writeFile(path.join(root, "external.jar"), bytes); await symlink(path.join(root, "external.jar"), path.join(dir, name)); expect((await companion.GET()).status).toBe(503);
  });
});
