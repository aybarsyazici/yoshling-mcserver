import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateManifest, verifyInput, validateAssetManifest } from "./run.mjs";
import { decodeVerifiedCanvas } from "./screenshot.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const records = [{ path: "level.dat", bytes: 5, sha256: sha("level") }, { path: "region/r.0.0.mca", bytes: 6, sha256: sha("region") }];
function input(over = {}) {
  const manifest = { format: 1, profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    target: { mcVersion: "1.21.1" }, source: { sha256: sha(JSON.stringify(records)) },
    center: { x: 0, z: 0 }, radius: 64, dimension: "overworld", layout: "legacy", files: structuredClone(records), ...over };
  if (over.files) manifest.source = { sha256: sha(JSON.stringify(over.files)) };
  return manifest;
}
test("exact known versions and saved-source layout are admitted", () => {
  assert.equal(validateManifest(input()).target.mcVersion, "1.21.1");
  const files = records.map(file => ({ ...file, path: file.path.replace("region/", "dimensions/minecraft/overworld/region/") }));
  assert.equal(validateManifest(input({ target: { mcVersion: "26.1.2" }, layout: "namespaced", files })).target.mcVersion, "26.1.2");
});
for (const [name, over] of [
  ["unsupported target", { target: { mcVersion: "26.2" } }],
  ["wrong profile", { profileId: "../outside" }],
  ["wrong job", { jobId: "not-an-id" }],
  ["oversized view", { radius: 128 }],
  ["other dimension", { dimension: "nether" }],
  ["invalid center", { center: { x: 0.5, z: 0 } }],
  ["out-of-range center", { center: { x: 30000001, z: 0 } }],
  ["traversal", { files: [records[0], { ...records[1], path: "../outside.mca" }] }],
  ["control file", { files: [records[0], { ...records[1], path: "server.properties" }] }],
  ["duplicate", { files: [records[0], records[0]] }],
  ["source cap", { files: [records[0], { ...records[1], bytes: 256 * 1024 * 1024 }] }],
  ["level cap", { files: [{ ...records[0], bytes: 1024 * 1024 + 1 }, records[1]] }],
  ["invalid byte count", { files: [records[0], { ...records[1], bytes: 1.5 }] }],
  ["empty source file", { files: [records[0], { ...records[1], bytes: 0 }] }],
  ["invalid file hash", { files: [records[0], { ...records[1], sha256: "not-a-hash" }] }],
  ["file count cap", { files: [records[0], ...Array.from({ length: 4096 }, (_, x) => ({ ...records[1], path: "region/c." + x + ".0.mcc" }))] }],
  ["aggregate source mismatch", { source: { sha256: "f".repeat(64) } }],
]) test("refuses " + name, () => assert.throws(() => validateManifest(input(over))));

test("immutable source inventory and bytes are verified without game or network", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "overview-source-"));
  try {
    await mkdir(path.join(directory, "world/region"), { recursive: true });
    await writeFile(path.join(directory, "world/level.dat"), "level");
    await writeFile(path.join(directory, "world/region/r.0.0.mca"), "region");
    const manifest = validateManifest(input());
    await verifyInput(directory, manifest);
    await writeFile(path.join(directory, "world/region/r.0.0.mca"), "edited");
    await assert.rejects(verifyInput(directory, manifest), /readback/);
    await writeFile(path.join(directory, "world/region/r.0.0.mca"), "region");
    await writeFile(path.join(directory, "world/server.properties"), "not admitted");
    await assert.rejects(verifyInput(directory, manifest), /Unexpected/);
    await rm(path.join(directory, "world/server.properties"));
    await rm(path.join(directory, "world/region/r.0.0.mca"));
    await symlink(path.join(directory, "world/level.dat"), path.join(directory, "world/region/r.0.0.mca"));
    await assert.rejects(verifyInput(directory, manifest), /links/);
    await rm(path.join(directory, "world/region/r.0.0.mca"));
    await writeFile(path.join(directory, "external-region"), "region");
    await link(path.join(directory, "external-region"), path.join(directory, "world/region/r.0.0.mca"));
    await assert.rejects(verifyInput(directory, manifest), /links/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("contained same-byte aliases cannot bypass the source link guard", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "overview-alias-"));
  try {
    await mkdir(path.join(directory, "world/region"), { recursive: true });
    await writeFile(path.join(directory, "world/level.dat"), "region");
    await symlink(path.join(directory, "world/level.dat"), path.join(directory, "world/region/r.0.0.mca"));
    const manifest = validateManifest(input({ files: [{ ...records[0], bytes: 6, sha256: sha("region") }, records[1]] }));
    await assert.rejects(verifyInput(directory, manifest), /links/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function assets() {
  return { format: 1, renderer: { name: "bluemap", version: "5.28", file: "bluemap-5.28-cli.jar", sha256: "c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2" },
    manifestSha256: "a".repeat(64), supportedVersions: ["26.1.2", "1.21.1"],
    clients: ["26.1.2", "1.21.1"].map(id => ({ id, file: "minecraft-client-" + id + ".jar", bytes: 10, sha1: "b".repeat(40), sha256: "c".repeat(64) })) };
}
test("asset catalog requires distinct known clients and pinned renderer metadata", () => {
  validateAssetManifest(assets());
  const duplicate = assets(); duplicate.clients[1] = duplicate.clients[0]; assert.throws(() => validateAssetManifest(duplicate));
  const escaped = assets(); escaped.renderer.file = "../../outside.jar"; assert.throws(() => validateAssetManifest(escaped));
  const changed = assets(); changed.renderer.sha256 = "f".repeat(64); assert.throws(() => validateAssetManifest(changed));
  const future = assets(); future.supportedVersions.push("26.2"); assert.throws(() => validateAssetManifest(future));
});
function canvas(over = {}) {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12); png.writeUInt32BE(1280, 16); png.writeUInt32BE(800, 20);
  return { width: 1280, height: 800, vertices: 1, data: "data:image/png;base64," + png.toString("base64"), ...over };
}
test("rendered image needs real geometry, exact dimensions, valid PNG header and bounded bytes", () => {
  assert.equal(decodeVerifiedCanvas(canvas()).length, 33);
  assert.throws(() => decodeVerifiedCanvas(canvas(), ["render error"]));
  for (const over of [{ width: 1281 }, { height: 801 }, { vertices: 0 }, { vertices: NaN }, { data: "not-png" },
    { data: "data:image/png;base64," + "A".repeat(7 * 1024 * 1024) }]) assert.throws(() => decodeVerifiedCanvas(canvas(over)));
  assert.throws(() => decodeVerifiedCanvas(canvas({ data: canvas().data + " ".repeat(7 * 1024 * 1024) })));
  const malformed = Buffer.alloc(33); assert.throws(() => decodeVerifiedCanvas(canvas({ data: "data:image/png;base64," + malformed.toString("base64") })));
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1); Buffer.from(canvas().data.split(",")[1], "base64").copy(oversized);
  assert.throws(() => decodeVerifiedCanvas(canvas({ data: "data:image/png;base64," + oversized.toString("base64") })));
  const changed = Buffer.from(canvas().data.split(",")[1], "base64"); changed.writeUInt32BE(1281, 16);
  assert.throws(() => decodeVerifiedCanvas(canvas({ data: "data:image/png;base64," + changed.toString("base64") })));
  const signature = Buffer.from(canvas().data.split(",")[1], "base64"); signature[0] = 0;
  assert.throws(() => decodeVerifiedCanvas(canvas({ data: "data:image/png;base64," + signature.toString("base64") })));
});
