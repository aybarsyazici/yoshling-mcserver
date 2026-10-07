import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { spawn } from "node:child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import type { Role } from "@/lib/permissions";

// The real route, multipart reader, ZIP tools, filesystem, gates, token signer and
// operation registry run here. Only session/database edges are fabricated.
const state = vi.hoisted(() => ({
  signedIn: true,
  role: "MOD" as Role,
  games: "7dtd",
  user: { id: "u1", role: "MOD", games: "7dtd", discordId: "9007199254740993" } as { id: string; role: Role; games: string; discordId: string } | null,
  activity: vi.fn(async () => ({})),
  userRead: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => state.signedIn
    ? { user: { id: "u1", name: "Tester", role: state.role, games: state.games } }
    : null),
}));
vi.mock("@/lib/db", () => ({
  db: {
    activity: { create: state.activity },
    user: { findUnique: vi.fn(async (query: unknown) => {
      state.userRead(query);
      return state.user;
    }) },
  },
}));
vi.mock("@/app/api/7dtd/backups/route", () => ({ worldsUsedByBackups: async () => new Set<string>() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
// Exercise the real budget helper/route with small fabricated archives, not disk exhaustion.
vi.mock("@/lib/sdtd-upload-limits", async (original) => ({
  ...await original<typeof import("@/lib/sdtd-upload-limits")>(),
  MAX_WORLD_EXPANDED_BYTES: 1024,
  MAX_WORLD_EXPANDED_ENTRIES: 20,
  WORLD_UPLOAD_DISK_RESERVE_BYTES: 1024,
}));

const run = promisify(execFile);
let scratch: string;
let gameDir: string;
let tmpDir: string;
let upload: typeof import("@/app/api/7dtd/world/route").POST;
let mint: typeof import("@/lib/upload-token").createUploadToken;
let finished: typeof import("@/lib/operations").listFinished;

beforeEach(async () => {
  vi.clearAllMocks();
  state.signedIn = true;
  state.role = "MOD";
  state.games = "7dtd";
  state.user = { id: "u1", role: "MOD", games: "7dtd", discordId: "9007199254740993" };
  scratch = await mkdtemp(path.join(os.tmpdir(), "yoshling-upload-"));
  gameDir = path.join(scratch, "game");
  tmpDir = path.join(scratch, "uploads");
  const configDir = path.join(scratch, "config");
  await mkdir(gameDir);
  await mkdir(configDir);
  await writeFile(path.join(configDir, "sdtdserver.xml"), '<ServerSettings><property name="GameWorld" value="Live"/><property name="GameName" value="Current"/></ServerSettings>');
  vi.stubEnv("SDTD_SERVER_DIR", gameDir);
  vi.stubEnv("SDTD_CONFIG_DIR", configDir);
  vi.stubEnv("SDTD_UPLOAD_TMP_DIR", tmpDir);
  vi.stubEnv("SDTD_PUID", String(process.getuid!()));
  vi.stubEnv("SDTD_PGID", String(process.getgid!()));
  vi.stubEnv("AUTH_SECRET", "test-upload-secret");
  vi.stubEnv("WHITELIST_FILE", path.join(scratch, "whitelist.json"));
  vi.stubEnv("ALLOWED_DISCORD_IDS", "9007199254740993");
  await writeFile(path.join(scratch, "whitelist.json"), '["9007199254740993"]');
  vi.resetModules();
  ({ POST: upload } = await import("@/app/api/7dtd/world/route"));
  ({ createUploadToken: mint } = await import("@/lib/upload-token"));
  ({ listFinished: finished } = await import("@/lib/operations"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

async function archive(contents: Record<string, string>, links: Record<string, string> = {}) {
  const source = path.join(scratch, "source");
  await mkdir(source);
  for (const [name, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), content, { mode: 0o600 });
  }
  for (const [name, target] of Object.entries(links)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await symlink(target, path.join(source, name));
  }
  const zipPath = path.join(scratch, "World.zip");
  await run("zip", ["-q", "-y", "-r", zipPath, "."], { cwd: source });
  return readFile(zipPath);
}

function request(bytes: Buffer, token?: string) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)]), "World.zip");
  return new NextRequest("https://yoshling.test/api/7dtd/world", {
    method: "POST",
    headers: token ? { "x-upload-token": token } : {},
    body: form,
  });
}

async function existingWorld() {
  const dest = path.join(gameDir, "GeneratedWorlds", "World");
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, "dtm.raw"), "existing terrain");
  await writeFile(path.join(dest, "keep.txt"), "existing progress");
  return dest;
}

function latestUpload() {
  return finished().find((op) => op.kind === "world.upload")!;
}

describe("7DTD world list and deletion containment", () => {
  async function removeWorld() {
    const { DELETE } = await import("@/app/api/7dtd/world/route");
    return DELETE(new NextRequest("http://local.invalid/api/7dtd/world?name=World", { method: "DELETE" }));
  }

  it("refuses an escaping GeneratedWorlds parent during listing and deletion", async () => {
    const dest = await existingWorld();
    const external = path.join(scratch, "external-maps");
    await rename(path.join(gameDir, "GeneratedWorlds"), external);
    await symlink(external, path.join(gameDir, "GeneratedWorlds"));
    const { GET } = await import("@/app/api/7dtd/world/route");
    expect((await GET()).status).toBe(500);
    expect((await removeWorld()).status).toBe(500);
    expect(await readFile(path.join(dest, "keep.txt"), "utf-8")).toBe("existing progress");
  });

  it("refuses an escaping Saves parent before deleting the valid map", async () => {
    const dest = await existingWorld();
    const external = path.join(scratch, "external-saves");
    await mkdir(path.join(external, "World"), { recursive: true });
    await writeFile(path.join(external, "World", "fixture.txt"), "external progress");
    await symlink(external, path.join(gameDir, "Saves"));
    expect((await removeWorld()).status).toBe(500);
    expect(await readFile(path.join(dest, "keep.txt"), "utf-8")).toBe("existing progress");
    expect(await readFile(path.join(external, "World", "fixture.txt"), "utf-8")).toBe("external progress");
  });

  it("lists and deletes through contained parent aliases", async () => {
    await existingWorld();
    await rename(path.join(gameDir, "GeneratedWorlds"), path.join(gameDir, "contained-maps"));
    await symlink("contained-maps", path.join(gameDir, "GeneratedWorlds"));
    await mkdir(path.join(gameDir, "contained-saves", "World"), { recursive: true });
    await symlink("contained-saves", path.join(gameDir, "Saves"));
    const { GET } = await import("@/app/api/7dtd/world/route");
    expect(await (await GET()).json()).toMatchObject({ worlds: ["World"] });
    expect((await removeWorld()).status).toBe(200);
    expect(await lstat(path.join(gameDir, "contained-maps", "World")).catch(() => null)).toBeNull();
    expect(await lstat(path.join(gameDir, "contained-saves", "World")).catch(() => null)).toBeNull();
  });

  it("removes contained final aliases themselves and retains their targets", async () => {
    const contained = path.join(gameDir, "contained-map");
    await mkdir(contained);
    await writeFile(path.join(contained, "fixture.txt"), "contained fixture");
    await mkdir(path.join(gameDir, "GeneratedWorlds"));
    await mkdir(path.join(gameDir, "Saves"));
    await symlink("../contained-map", path.join(gameDir, "GeneratedWorlds", "World"));
    await symlink("../contained-map", path.join(gameDir, "Saves", "World"));
    expect((await removeWorld()).status).toBe(200);
    expect(await readFile(path.join(contained, "fixture.txt"), "utf-8")).toBe("contained fixture");
    expect(await lstat(path.join(gameDir, "GeneratedWorlds", "World")).catch(() => null)).toBeNull();
    expect(await lstat(path.join(gameDir, "Saves", "World")).catch(() => null)).toBeNull();
  });
});

describe("7DTD world upload admission", () => {
  it("refuses declared expansion before placing any files and cleans upload staging", async () => {
    const dest = await existingWorld();
    const response = await upload(request(await archive({ "dtm.raw": "x".repeat(1025) })));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/expanded size limit/);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(path.join(dest, "keep.txt"), "utf8")).toBe("existing progress");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(latestUpload().steps.some(step => /Unpacking|Placing/.test(step.label))).toBe(false);
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("refuses too many declared entries before extraction", async () => {
    const dest = await existingWorld();
    const contents = Object.fromEntries(Array.from({ length: 21 }, (_, n) => [n ? `file${n}.txt` : "dtm.raw", "x"]));
    const response = await upload(request(await archive(contents)));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/entry-count limit/);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(path.join(dest, "keep.txt"), "utf8")).toBe("existing progress");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(latestUpload().steps.some(step => /Unpacking|Placing/.test(step.label))).toBe(false);
  });

  it("cancels an admitted extraction when urgent power preempts it, then cleans staging", async () => {
    const dest = await existingWorld();
    const { spawn: actualSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const ready = path.join(scratch, "extract-started");
    const continued = path.join(scratch, "extract-continued");
    vi.mocked(spawn).mockImplementationOnce(((_command: string, args: string[], options: import("node:child_process").SpawnOptions) => actualSpawn(process.execPath, ["-e",
      `const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(${JSON.stringify(args[4])},'dtm.raw'),'fixture');fs.writeFileSync(${JSON.stringify(ready)},'started');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(continued)},'continued');process.exit(0)},500);`,
    ], options)) as typeof spawn);
    const result = upload(request(await archive({ "dtm.raw": "replacement terrain" })));
    for (let n = 0; n < 300 && !(await stat(ready).catch(() => null)); n++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(await readFile(ready, "utf-8")).toBe("started");
    const { runOperation } = await import("@/lib/operations");
    await runOperation({ kind: "power", game: "7dtd", action: "stop", title: "Stopping 7 Days to Die" }, async () => ({ value: undefined }));
    const response = await result;
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/interrupted by a power operation/);
    expect(await stat(continued).catch(() => null)).toBeNull();
    expect(await readFile(path.join(dest, "keep.txt"), "utf8")).toBe("existing progress");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(latestUpload().outcome).toBe("failed");
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("refuses an escaping XML alias during upload preflight", async () => {
    const dest = await existingWorld();
    const xml = path.join(scratch, "config", "sdtdserver.xml");
    const external = path.join(scratch, "external.xml");
    await rename(xml, external);
    await symlink(external, xml);
    const response = await upload(request(await archive({ "dtm.raw": "replacement terrain" })));
    expect(response.status).toBe(500);
    expect(await readFile(path.join(dest, "keep.txt"), "utf-8")).toBe("existing progress");
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("refuses a PZ-only MOD before reading the body or admitting an operation", async () => {
    state.games = "zomboid";
    const req = request(await archive({ "dtm.raw": "terrain" }));
    const before = finished().map((op) => op.id);
    const response = await upload(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "No access to this server" });
    expect(req.bodyUsed).toBe(false);
    expect(finished().map((op) => op.id)).toEqual(before);
    expect(await readdir(gameDir)).toEqual([]);
    expect(await stat(tmpDir).catch(() => null)).toBeNull();
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("rejects an ordinary-looking ZIP link before replacing an existing world", async () => {
    const dest = await existingWorld();
    const outside = path.join(scratch, "private.env");
    await writeFile(outside, "fabricated private data", { mode: 0o600 });
    const before = await stat(outside);
    const req = request(await archive({ "dtm.raw": "new terrain" }, { "notes.txt": outside }));
    const response = await upload(req);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/symbolic link.*notes\.txt/);
    expect(await readFile(path.join(dest, "dtm.raw"), "utf8")).toBe("existing terrain");
    expect(await readFile(path.join(dest, "keep.txt"), "utf8")).toBe("existing progress");
    const after = await stat(outside);
    expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid]);
    expect(await readFile(outside, "utf8")).toBe("fabricated private data");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(latestUpload().outcome).toBe("failed");
    expect(latestUpload().steps.some((step) => /Placing|Handing/.test(step.label))).toBe(false);
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("rejects a linked wrapper even when the markers are regular files", async () => {
    const dest = await existingWorld();
    const response = await upload(request(await archive(
      { "Map/dtm.raw": "new terrain" },
      { "Map/nested": scratch }
    )));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/symbolic link.*Map\/nested/);
    expect(await readFile(path.join(dest, "keep.txt"), "utf8")).toBe("existing progress");
    expect(await stat(path.join(gameDir, "GeneratedWorlds", "Map")).catch(() => null)).toBeNull();
  });

  it("refuses an existing destination parent link before moving a save outside its root", async () => {
    const outside = path.join(scratch, "outside");
    await mkdir(outside);
    await mkdir(path.join(outside, "Session"));
    await writeFile(path.join(outside, "Session", "main.ttw"), "outside progress");
    await mkdir(path.join(gameDir, "Saves"));
    await symlink(outside, path.join(gameDir, "Saves", "Other"));
    const response = await upload(request(await archive({ "Other/Session/main.ttw": "replacement" })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/destination.*unsafe filesystem link.*Nothing was replaced/);
    expect(await readFile(path.join(outside, "Session", "main.ttw"), "utf8")).toBe("outside progress");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("places a regular world, compares actual bytes and permissions, and records success", async () => {
    const dest = await existingWorld();
    const response = await upload(request(await archive({
      "dtm.raw": "new terrain",
      "nested/notes.txt": "regular nested file",
    })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, kind: "world", name: "World", replacedExisting: true });
    expect(await readFile(path.join(dest, "dtm.raw"), "utf8")).toBe("new terrain");
    expect(await readFile(path.join(dest, "nested", "notes.txt"), "utf8")).toBe("regular nested file");
    expect(await stat(path.join(dest, "keep.txt")).catch(() => null)).toBeNull();
    const marker = await stat(path.join(dest, "dtm.raw"));
    expect([marker.uid, marker.gid, marker.mode & 0o044]).toEqual([process.getuid!(), process.getgid!(), 0o044]);
    expect(latestUpload().facts.find((fact) => fact.label === "On disk")?.value).toBe("owned by the game's user and readable");
    expect(await readdir(tmpDir)).toEqual([]);
    expect(state.activity).toHaveBeenCalledTimes(1);
  });

  it("places a regular save under both its world and game names", async () => {
    const response = await upload(request(await archive({ "Other/Session/main.ttw": "saved progress" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, kind: "save", name: "Session", world: "Other" });
    expect(await readFile(path.join(gameDir, "Saves", "Other", "Session", "main.ttw"), "utf8")).toBe("saved progress");
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it("returns a structured unavailable response when token minting has no deployment secret", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.resetModules();
    const { GET } = await import("@/app/api/7dtd/world/token/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "World uploads are unavailable: configure AUTH_SECRET." });
  });
});

describe("direct upload tokens use current permissions", () => {
  beforeEach(() => { state.signedIn = false; });

  it.each(['["9007199254740994"]', '["legacy-display"]', '{invalid'])
    ("refuses a still-valid token after policy revocation or loss of a verifiable policy %s", async policy => {
      const token = mint("u1");
      await writeFile(path.join(scratch, "whitelist.json"), policy);
      const req = request(await archive({ "dtm.raw": "terrain" }), token);
      expect((await upload(req)).status).toBe(403);
      expect(req.bodyUsed).toBe(false);
      expect(await readdir(gameDir)).toEqual([]);
    });

  it("refuses unknown stored roles before reading a token upload body", async () => {
    state.user!.role = "ROOT" as Role;
    const req = request(await archive({ "dtm.raw": "terrain" }), mint("u1"));
    expect((await upload(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
  });

  it.each([
    { role: "MOD" as Role, games: "zomboid" },
    { role: "MEMBER" as Role, games: "7dtd" },
  ])("refuses a token after grants or role are revoked: %j", async ({ role, games }) => {
    const token = mint("u1");
    state.user = { id: "u1", role, games, discordId: "9007199254740993" };
    const req = request(await archive({ "dtm.raw": "terrain" }), token);
    const response = await upload(req);
    expect(response.status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(state.userRead).toHaveBeenCalledWith({ where: { id: "u1" }, select: { id: true, role: true, games: true, discordId: true } });
    expect(await readdir(gameDir)).toEqual([]);
    expect(await stat(tmpDir).catch(() => null)).toBeNull();
  });

  it("refuses a token belonging to a deleted user", async () => {
    const token = mint("u1");
    state.user = null;
    const req = request(await archive({ "dtm.raw": "terrain" }), token);
    expect((await upload(req)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });

  it("accepts a token when its user's current MOD grant still allows the upload", async () => {
    const response = await upload(request(await archive({ "dtm.raw": "terrain" }), mint("u1")));
    expect(response.status).toBe(200);
    expect(await readFile(path.join(gameDir, "GeneratedWorlds", "World", "dtm.raw"), "utf8")).toBe("terrain");
    expect(state.userRead).toHaveBeenCalledTimes(1);
  });
});
