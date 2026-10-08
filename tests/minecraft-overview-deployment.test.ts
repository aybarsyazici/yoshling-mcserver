import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, link, readFile, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const fault = vi.hoisted(() => ({ beforeOpen: null as null | ((file: string) => Promise<void>), duringRead: null as null | ((file: string) => Promise<void>) }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: (async (...args: Parameters<typeof actual.open>) => {
    if (fault.beforeOpen) { const work = fault.beforeOpen; fault.beforeOpen = null; await work(String(args[0])); }
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, key) { const value = Reflect.get(target, key);
      if (key === "createReadStream" && fault.duringRead) return (...options: Parameters<typeof handle.createReadStream>) => { const work = fault.duringRead; fault.duringRead = null; const stream = handle.createReadStream(...options), iterator = stream[Symbol.asyncIterator].bind(stream); stream[Symbol.asyncIterator] = async function* () { let first = true; for await (const bytes of { [Symbol.asyncIterator]: iterator }) { if (first) { first = false; await work?.(String(args[0])); } yield bytes; } }; return stream; };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof actual.open };
});
const { scanMinecraftOverviewStaging } = await import("../scripts/check-minecraft-overview-staging.mjs");
let root: string;
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", J = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const target = { mcVersion: "26.1.2", loader: "vanilla", loaderVersion: null, javaVariant: "java25" };
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "overview-deploy-"))); fault.beforeOpen = null; fault.duringRead = null; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const privateWrite = (file: string, value: string | Buffer) => writeFile(file, value, { mode: 0o600 });
async function fixture(phase = "queued", state = "queued") {
  const job = path.join(root, P, "jobs", J); await mkdir(path.join(job, "input/world/region"), { recursive: true, mode: 0o700 }); await mkdir(path.join(job, "output"), { mode: 0o700 });
  const level = Buffer.from("bounded synthetic saved level"), region = Buffer.alloc(8192);
  const files = [{ path: "level.dat", bytes: level.length, sha256: hash(level) }, { path: "region/r.0.0.mca", bytes: region.length, sha256: hash(region) }];
  await privateWrite(path.join(job, "input/world/level.dat"), level); await privateWrite(path.join(job, "input/world/region/r.0.0.mca"), region);
  const source = { kind: "saved-copy", id: J, sha256: hash(Buffer.from(JSON.stringify(files))), snapshotAt: "2026-10-08T12:00:00.000Z", sourceSavedAt: null, center: { x: 0, z: 0 }, layout: "legacy", files };
  const manifest = { format: 1, profileId: P, jobId: J, target, source: { kind: source.kind, id: source.id, sha256: source.sha256, snapshotAt: source.snapshotAt, sourceSavedAt: source.sourceSavedAt }, center: source.center, radius: 64, dimension: "overworld", layout: source.layout, files };
  await privateWrite(path.join(job, "input/manifest.json"), JSON.stringify(manifest));
  await privateWrite(path.join(job, "job.json"), JSON.stringify({ format: 1, profileId: P, id: J, phase, source, target, createdAt: source.snapshotAt, operationId: null, actor: null }));
  let artifact = null;
  if (state === "ready") { const bytes = Buffer.from("bounded published image fixture"), revision = hash(bytes); await mkdir(path.join(root, P, "images"), { mode: 0o700 }); await privateWrite(path.join(root, P, "images", `${revision}.png`), bytes); artifact = { revision, bytes: bytes.length, generatedAt: source.snapshotAt, jobId: J, renderer: { name: "bluemap", version: "5.28" }, source }; }
  await privateWrite(path.join(root, P, "overview.json"), JSON.stringify({ format: 1, profileId: P, state, target, reason: null, updatedAt: source.snapshotAt, jobId: J, operationId: null, retryAt: 0, artifact }));
  return job;
}
describe("read-only overview deployment admission", () => {
  it("allows absent overview storage and a verified queued saved copy", async () => { expect(await scanMinecraftOverviewStaging(path.join(root, "absent"))).toEqual([]); await fixture(); expect(await scanMinecraftOverviewStaging(root)).toEqual([]); });
  it.each(["rendering", "unverified", "unknown"])("refuses sidecar state %s", async state => { await fixture("queued", state); expect(await scanMinecraftOverviewStaging(root)).toEqual([path.join(root, P)]); });
  it("refuses running/incomplete publication jobs", async () => { const job = await fixture("rendering"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await rm(path.join(job, "job.json")); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); });
  it.each(["overview.json", "jobs/job.json", "input/manifest.json", "world/region/r.0.0.mca", "images/cover.png"])("refuses actual atomic-write suffix staging at %s", async where => {
    const job = await fixture();
    const file = where === "overview.json" ? path.join(root, P, `${where}.write-${J}`) : where === "jobs/job.json" ? path.join(job, `job.json.write-${J}`) : where === "images/cover.png" ? path.join(root, P, "images", `${"c".repeat(64)}.png.write-${J}`) : path.join(job, where.startsWith("world/") ? "input" : "", `${where}.write-${J}`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await privateWrite(file, "partial"); expect(await scanMinecraftOverviewStaging(root)).toEqual([path.join(root, P)]);
  });
  it("refuses a modified source, worker output scratch and unknown identities", async () => { const job = await fixture(); await privateWrite(path.join(job, "input/world/level.dat"), "different"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await rm(path.join(root, P), { recursive: true }); await fixture(); await privateWrite(path.join(job, "output/partial.png"), "partial"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await mkdir(path.join(root, "legacy-data"), { mode: 0o700 }); expect(await scanMinecraftOverviewStaging(root)).toContain(root); });
  it.each(["input", "world", "region", "level"])("refuses %s aliases even when they resolve to matching contained bytes", async entry => {
    const job = await fixture(), relative = entry === "input" ? "input" : entry === "world" ? "input/world" : entry === "region" ? "input/world/region" : "input/world/level.dat", file = path.join(job, relative), moved = path.join(root, `ordinary-${entry}`);
    const { rename } = await import("node:fs/promises"); await rename(file, moved); await symlink(moved, file); expect(await scanMinecraftOverviewStaging(root)).toContain(path.join(root, P));
  });
  it("refuses source hardlinks and nonprivate directory or file modes", async () => {
    const job = await fixture(), level = path.join(job, "input/world/level.dat"); await link(level, path.join(root, "ordinary-hardlink")); expect(await scanMinecraftOverviewStaging(root)).toContain(path.join(root, P)); await rm(path.join(root, "ordinary-hardlink"));
    await chmod(level, 0o644); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await chmod(level, 0o600);
    await chmod(path.join(job, "input"), 0o755); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await chmod(path.join(job, "input"), 0o700); expect(await scanMinecraftOverviewStaging(root)).toEqual([]);
  });
  it("rejects a final file swapped for an alias between lstat and open", async () => {
    const job = await fixture(), level = path.join(job, "input/world/level.dat"), ordinary = path.join(root, "ordinary-data"); await privateWrite(ordinary, "bounded synthetic saved level");
    // Open faults apply first to metadata; queue the source swap when its known bounded fd is reached.
    const swap = async (file: string) => { if (file === level) { await rm(level); await symlink(ordinary, level); } else fault.beforeOpen = swap; }; fault.beforeOpen = swap;
    expect(await scanMinecraftOverviewStaging(root)).toContain(path.join(root, P));
  });
  it("bounds opened JSON after same-inode growth between lstat and fd admission", async () => {
    await fixture(); const status = path.join(root, P, "overview.json"), original = await readFile(status); fault.beforeOpen = async file => { if (file === status) await privateWrite(status, Buffer.concat([original, Buffer.alloc(1024 * 1024 + 1, 32)])); };
    expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1);
  });
  it("rejects growth while hashing a pinned input instead of reading an unbounded new suffix", async () => {
    const job = await fixture(), region = path.join(job, "input/world/region/r.0.0.mca"), buffer = Buffer.alloc(2 * 1024 * 1024, 65); await privateWrite(region, buffer);
    const manifestFile = path.join(job, "input/manifest.json"), metadataFile = path.join(job, "job.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")), metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    manifest.files[1] = { path: "region/r.0.0.mca", bytes: buffer.length, sha256: hash(buffer) }; manifest.source.sha256 = hash(Buffer.from(JSON.stringify(manifest.files))); metadata.source.files = manifest.files; metadata.source.sha256 = manifest.source.sha256;
    await privateWrite(manifestFile, JSON.stringify(manifest)); await privateWrite(metadataFile, JSON.stringify(metadata));
    const grow = async (file: string) => { if (file === region) { const fd = await open(region, "a"); try { await fd.write(Buffer.alloc(1024 * 1024)); } finally { await fd.close(); } } else fault.duringRead = grow; }; fault.duringRead = grow;
    expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1);
  });
  it("refuses changed queued manifest provenance even when file checksums remain valid", async () => {
    const job = await fixture(), file = path.join(job, "input/manifest.json"), manifest = JSON.parse(await readFile(file, "utf8")); manifest.center = { x: 500, z: 500 }; await privateWrite(file, JSON.stringify(manifest)); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1);
  });
  it("refuses an uncommitted queued job whose profile pointer is still waiting", async () => { await fixture("queued", "waiting"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); });
  it("rechecks status after source hashing so admitted work cannot become quiet through a stale phase read", async () => {
    await fixture(); const file = path.join(root, P, "overview.json");
    fault.duringRead = async () => { const status = JSON.parse(await readFile(file, "utf8")); status.state = "rendering"; await privateWrite(file, JSON.stringify(status)); };
    expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1);
  });
  it("allows sealed completed metadata only after scratch cleanup", async () => { const job = await fixture("complete", "ready"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await rm(path.join(job, "input"), { recursive: true }); await rm(path.join(job, "output"), { recursive: true }); expect(await scanMinecraftOverviewStaging(root)).toEqual([]); });
  it("refuses metadata that cannot be parsed or exceeds its byte bound", async () => { await fixture(); const file = path.join(root, P, "overview.json"); await privateWrite(file, "not-json"); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); await privateWrite(file, " ".repeat(1024 * 1024 + 1)); expect(await scanMinecraftOverviewStaging(root)).toHaveLength(1); });
});
