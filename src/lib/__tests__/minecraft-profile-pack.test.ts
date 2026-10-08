import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { profilePackPath, profileDownloadUrl, parseProfilePackIndex, readProfilePackArchive, downloadProfileFile, downloadProfileFileToPath, inspectProfilePackArchiveFile, streamProfilePackOverride, hashProfileFile, writeVerifiedProfileStream, PROFILE_PACK_LIMITS } from "../minecraft-profile-pack";

const index = () => ({ formatVersion: 1, game: "minecraft", name: "Friends", versionId: "1", dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" }, files: [] });
/** Stored ZIP fixture: tests use no Docker, binaries or network. */
function zip(entries: Array<{ name: string; content: string; kind?: number; size?: number; method?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const { name, content, kind = 0x8000, size, method = 0 } of entries) {
    const n = Buffer.from(name), data = Buffer.from(content), header = Buffer.alloc(30), dir = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size ?? data.length, 22); header.writeUInt16LE(n.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(3 << 8 | 20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(size ?? data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE((kind << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(header, n, data); central.push(dir, n); offset += header.length + n.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "profile-pack-stream-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
describe("profile pack admission", () => {
  it.each(["../world", "/world", "C:/world", "mods\\evil.jar", "config/../world", "config//file", "x\nworld", "."])("rejects unsafe destination %s", value => expect(() => profilePackPath(value)).toThrow());
  it("accepts a normal nested destination", () => expect(profilePackPath("config/pack/common.json")).toBe("config/pack/common.json"));
  it.each(["http://cdn.modrinth.com/file", "https://127.0.0.1/x", "https://cdn.modrinth.com.evil.test/x", "https://u:p@cdn.modrinth.com/x", "https://cdn.modrinth.com:8443/x"])("rejects unsupported download %s", value => expect(() => profileDownloadUrl(value)).toThrow());
  it("parses exact pack target", () => expect(parseProfilePackIndex(index()).target).toEqual({ mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.9" }));
  it("rejects unknown and competing loader dependencies", () => {
    expect(() => parseProfilePackIndex({ ...index(), dependencies: { minecraft: "1.21.1", magic: "1" } })).toThrow();
    expect(() => parseProfilePackIndex({ ...index(), dependencies: { minecraft: "1.21.1", forge: "1", "fabric-loader": "2" } })).toThrow();
  });
  it("refuses unpinned latest targets", () => expect(() => parseProfilePackIndex({ ...index(), dependencies: { minecraft: "latest" } })).toThrow());
  it("refuses missing hashes and unknown server environment", () => {
    const file = { path: "mods/a.jar", hashes: { sha1: "a".repeat(40), sha512: "a".repeat(128) }, fileSize: 2, downloads: ["https://cdn.modrinth.com/a"] };
    expect(() => parseProfilePackIndex({ ...index(), files: [{ ...file, hashes: {} }] })).toThrow();
    expect(() => parseProfilePackIndex({ ...index(), files: [{ ...file, env: { client: "required", server: "unknown" } }] })).toThrow();
  });
  it("loads server override precedence and excludes client overrides", async () => {
    const result = await readProfilePackArchive(zip([
      { name: "modrinth.index.json", content: JSON.stringify(index()) },
      { name: "overrides/config/a.json", content: "normal" },
      { name: "server-overrides/config/a.json", content: "server" },
      { name: "client-overrides/config/client.json", content: "client" },
    ]));
    expect(result.overrides.get("config/a.json")?.toString()).toBe("server");
    expect(result.overrides.has("config/client.json")).toBe(false);
  });
  it("rejects ZIP links before returning any files", async () => {
    await expect(readProfilePackArchive(zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) }, { name: "overrides/config/link", content: "../world", kind: 0xa000 }]))).rejects.toThrow(/link/);
  });
  it("requires an index", async () => await expect(readProfilePackArchive(zip([{ name: "overrides/config/a", content: "a" }]))).rejects.toThrow(/index/));
  it("checks both published hashes and exact bytes", async () => {
    const bytes = Buffer.from("jar");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(bytes)));
    const expected = { size: 3, sha1: createHash("sha1").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("hex") };
    await expect(downloadProfileFile("https://cdn.modrinth.com/a", 50, expected)).resolves.toEqual(bytes);
    await expect(downloadProfileFile("https://cdn.modrinth.com/a", 50, { ...expected, sha1: "a".repeat(40) })).rejects.toThrow(/checksums/);
  });
  it("refuses redirects to private endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadProfileFile("https://cdn.modrinth.com/a", 50)).rejects.toThrow(/registries/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("bounds downloaded bytes even without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("too large")));
    await expect(downloadProfileFile("https://cdn.modrinth.com/a", 2)).rejects.toThrow(/limit/);
  });
});


describe("disk-backed profile pack pipeline", () => {
  const hashes = (bytes: Uint8Array) => ({ size: bytes.byteLength, sha1: createHash("sha1").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("hex") });
  it("writes a large response incrementally without calling body buffer methods", async () => {
    const target = path.join(root, "large.jar"), chunk = Buffer.alloc(64 * 1024, 42), count = 192;
    let sent = 0, incremental = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent > 8) { try { incremental ||= statSync(target).size > 0; } catch {} }
      if (sent++ < count) controller.enqueue(chunk); else controller.close();
    } });
    const response = new Response(body); response.arrayBuffer = vi.fn().mockRejectedValue(new Error("Buffering body is forbidden"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const sha1 = createHash("sha1"), sha512 = createHash("sha512"); for (let i = 0; i < count; i++) { sha1.update(chunk); sha512.update(chunk); }
    const expected = { size: count * chunk.length, sha1: sha1.digest("hex"), sha512: sha512.digest("hex") };
    const receipt = await downloadProfileFileToPath("https://cdn.modrinth.com/a", target, PROFILE_PACK_LIMITS.file, expected);
    expect(incremental).toBe(true); expect(response.arrayBuffer).not.toHaveBeenCalled();
    expect(receipt).toEqual({ bytes: expected.size, sha1: expected.sha1, sha512: expected.sha512 });
    expect(await hashProfileFile(target)).toEqual(receipt);
  });
  it("refuses actual streamed overflows and removes incomplete bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ordinary bytes")));
    const target = path.join(root, "oversized.jar");
    await expect(downloadProfileFileToPath("https://cdn.modrinth.com/a", target, 3)).rejects.toThrow(/limit/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses published size/hash mismatches and leaves no staged file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("jar")));
    const target = path.join(root, "mismatch.jar"), expected = hashes(Buffer.from("jar"));
    await expect(downloadProfileFileToPath("https://cdn.modrinth.com/a", target, 50, { ...expected, sha512: "a".repeat(128) })).rejects.toThrow(/checksums/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("independently reads disk bytes and refuses corruption after streaming writes", async () => {
    const target = path.join(root, "changed.jar"), chunk = Buffer.from("ordinary fixture");
    async function* source() { yield chunk; await writeFile(target, Buffer.alloc(chunk.length, 97)); }
    await expect(writeVerifiedProfileStream(target, source(), 50)).rejects.toThrow(/readback/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cancels interruption and disk-space failures without publishing a partial file", async () => {
    const target = path.join(root, "interrupted.jar");
    async function* source() { yield Buffer.from("part"); yield Buffer.from("rest"); }
    let checks = 0; const reserve = vi.fn(async () => {});
    await expect(writeVerifiedProfileStream(target, source(), 50, undefined, () => { if (++checks === 2) throw new Error("Interrupted"); }, reserve)).rejects.toThrow("Interrupted");
    expect(reserve).toHaveBeenCalledTimes(1);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeVerifiedProfileStream(target, source(), 50, undefined, undefined, async () => { throw new Error("Disk reserve"); })).rejects.toThrow("Disk reserve");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("validates disk ZIP descriptors and streams server override precedence", async () => {
    const archive = path.join(root, "fixture.mrpack");
    await writeFile(archive, zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) },
      { name: "overrides/config/a", content: "ordinary" }, { name: "server-overrides/config/a", content: "server" }, { name: "client-overrides/config/client", content: "client" }]));
    const pack = await inspectProfilePackArchiveFile(archive);
    expect(pack.overrides.has("config/client")).toBe(false);
    expect([...pack.overrides.keys()]).toEqual(["config/a"]);
    expect(pack.overrides.get("config/a")).not.toHaveProperty("bytes");
    const target = path.join(root, "config", "a"); await mkdir(path.dirname(target));
    const receipt = await streamProfilePackOverride(archive, pack.overrides.get("config/a")!, target);
    expect(await readFile(target, "utf8")).toBe("server"); expect(receipt.bytes).toBe(6);
  });
  it("validates every disk ZIP member before extraction, including excluded client members", async () => {
    const archive = path.join(root, "bad.mrpack");
    await writeFile(archive, zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) }, { name: "client-overrides/link", content: "../world", kind: 0xa000 }]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/link/);
    await writeFile(archive, zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) }, { name: "overrides/../world", content: "fixture" }]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/invalid|unsafe/);
  });
  it("refuses expanded individual, aggregate and entry budgets before opening overrides", async () => {
    const archive = path.join(root, "budgets.mrpack"), first = { name: "modrinth.index.json", content: JSON.stringify(index()) };
    await writeFile(archive, zip([first, { name: "overrides/large", content: "f", size: PROFILE_PACK_LIMITS.file + 1, method: 8 }]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/expanded byte limit/);
    await writeFile(archive, zip([first, ...Array.from({ length: 17 }, (_, i) => ({ name: `overrides/${i}`, content: "f", size: PROFILE_PACK_LIMITS.file, method: 8 }))]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/expanded byte limit/);
    await writeFile(archive, zip([first, ...Array.from({ length: PROFILE_PACK_LIMITS.entries }, (_, i) => ({ name: `overrides/${i}`, content: "" }))]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/too many entries/);
  });
  it("rejects oversized properties descriptors before decoding their payloads", async () => {
    const archive = path.join(root, "huge-properties.mrpack");
    await writeFile(archive, zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) }, { name: "overrides/server.properties", content: "f", size: 1024 ** 2 + 1, method: 8 }]));
    await expect(inspectProfilePackArchiveFile(archive)).rejects.toThrow(/1 MiB/);
    const file = { path: "server.properties", hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) }, fileSize: 1024 ** 2 + 1, downloads: ["https://cdn.modrinth.com/a"] };
    expect(() => parseProfilePackIndex({ ...index(), files: [file] })).toThrow(/1 MiB/);
  });
  it("rejects an interrupted disk inspection and member publication", async () => {
    const archive = path.join(root, "interrupt.mrpack");
    await writeFile(archive, zip([{ name: "modrinth.index.json", content: JSON.stringify(index()) }, { name: "overrides/a", content: "ordinary" }]));
    await expect(inspectProfilePackArchiveFile(archive, () => { throw new Error("Interrupted"); })).rejects.toThrow("Interrupted");
    const inspected = await inspectProfilePackArchiveFile(archive), target = path.join(root, "a");
    await expect(streamProfilePackOverride(archive, inspected.overrides.get("a")!, target, () => { throw new Error("Interrupted"); })).rejects.toThrow("Interrupted");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves production caps and bounds legacy Buffer helpers separately", async () => {
    expect(PROFILE_PACK_LIMITS).toEqual({ archive: 256 * 1024 ** 2, file: 128 * 1024 ** 2, total: 2 * 1024 ** 3, entries: 20_000 });
    await expect(downloadProfileFile("https://cdn.modrinth.com/a", PROFILE_PACK_LIMITS.file)).rejects.toThrow(/streamed/);
    await expect(readProfilePackArchive(Buffer.alloc(8 * 1024 ** 2 + 1))).rejects.toThrow(/disk-backed/);
  });
});
