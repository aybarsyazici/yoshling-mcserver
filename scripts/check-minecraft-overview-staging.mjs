import { lstat, opendir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JSON = 1024 * 1024;
const owner = info => info.uid === process.getuid?.() && info.gid === process.getgid?.();
const isPrivateFile = (info, maximum) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && owner(info) && (info.mode & 0o777) === 0o600 && info.size >= 1 && info.size <= maximum;
const changed = (a, b) => a.ino !== b.ino || a.dev !== b.dev || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
const atomicWrite = name => name.includes(".write-");

async function ancestors(root, file, finalDirectory = false) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Overview path escaped its storage root");
  const parts = relative.split(path.sep).filter(Boolean), directories = [root];
  for (let index = 0; index < parts.length - (finalDirectory ? 0 : 1); index++) directories.push(path.join(directories.at(-1), parts[index]));
  for (const directory of directories) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || !owner(info) || (info.mode & 0o777) !== 0o700) throw new Error("Unverified private overview directory"); }
}
async function directory(root, file, maximum = 4096) {
  await ancestors(root, file, true);
  const entries = []; const handle = await opendir(file);
  for await (const entry of handle) { if (entries.length >= maximum || atomicWrite(entry.name)) throw new Error("Unverified or excessive overview staging"); entries.push(entry.name); }
  return entries;
}
async function json(root, file) {
  await ancestors(root, file);
  const before = await lstat(file); if (!isPrivateFile(before, MAX_JSON)) throw new Error("Unverified overview metadata");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat(); if (!isPrivateFile(info, MAX_JSON) || changed(before, info)) throw new Error("Changed overview metadata");
    const bytes = Buffer.alloc(info.size + 1); let total = 0;
    while (total < bytes.length) { const next = await fd.read(bytes, total, bytes.length - total, null); if (!next.bytesRead) break; total += next.bytesRead; }
    const after = await fd.stat(); if (total !== info.size || changed(info, after) || !isPrivateFile(after, MAX_JSON)) throw new Error("Changed overview metadata");
    return JSON.parse(bytes.subarray(0, total).toString());
  } finally { await fd.close(); }
}
async function digest(root, file, expected, maximum) {
  await ancestors(root, file);
  const before = await lstat(file); if (!isPrivateFile(before, maximum) || before.size !== expected) throw new Error("Unverified queued overview file");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat(); if (!isPrivateFile(info, maximum) || changed(before, info)) throw new Error("Changed queued overview file");
    const hash = createHash("sha256"); let total = 0;
    for await (const bytes of fd.createReadStream({ autoClose: false })) { total += bytes.length; if (total > expected || total > maximum) throw new Error("Growing queued overview file"); hash.update(bytes); }
    const after = await fd.stat(); if (total !== expected || changed(info, after) || !isPrivateFile(after, maximum)) throw new Error("Changed queued overview input");
    return hash.digest("hex");
  } finally { await fd.close(); }
}
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const target = value => plain(value) && typeof value.mcVersion === "string" && /^[0-9][A-Za-z0-9._-]{0,63}$/.test(value.mcVersion) && ["vanilla", "fabric", "forge", "neoforge", "quilt"].includes(value.loader) && (value.loaderVersion === null || typeof value.loaderVersion === "string") && ["java8", "java11", "java17", "java21", "java25"].includes(value.javaVariant);
const source = value => plain(value) && ["saved-copy", "checkpoint", "backup"].includes(value.kind) && typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}$/.test(value.id) && HASH.test(value.sha256) && date(value.snapshotAt) && (value.sourceSavedAt === null || date(value.sourceSavedAt)) && plain(value.center) && [value.center.x, value.center.z].every(item => Number.isSafeInteger(item) && Math.abs(item) <= 30_000_000) && ["legacy", "namespaced"].includes(value.layout) && Array.isArray(value.files);
const artifact = value => plain(value) && HASH.test(value.revision) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 5 * 1024 * 1024 && date(value.generatedAt) && UUID.test(value.jobId) && plain(value.renderer) && typeof value.renderer.name === "string" && typeof value.renderer.version === "string" && source(value.source);
function inputManifest(job, profileId, jobId) {
  const source = job.source;
  return { format: 1, profileId, jobId, target: job.target, source: { kind: source.kind, id: source.id, sha256: source.sha256, snapshotAt: source.snapshotAt, sourceSavedAt: source.sourceSavedAt }, center: source.center, radius: 64, dimension: "overworld", layout: source.layout, files: source.files };
}
async function queuedInput(root, jobRoot, job, profileId, jobId) {
  const manifest = await json(root, path.join(jobRoot, "input/manifest.json"));
  if (!target(job.target) || !source(job.source) || JSON.stringify(manifest) !== JSON.stringify(inputManifest(job, profileId, jobId)) || !HASH.test(manifest.source?.sha256 || "") || !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 4096 || new Set(manifest.files.map(item => item.path)).size !== manifest.files.length || createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex") !== manifest.source.sha256) throw new Error("Incomplete queued overview input");
  let total = 0; const world = path.join(jobRoot, "input/world"), allowed = new Set(["manifest.json"]);
  await ancestors(root, world, true);
  for (const item of manifest.files) {
    if (!plain(item) || !/^(?:level\.dat|(?:dimensions\/minecraft\/overworld\/)?region\/(?:r\.-?\d+\.-?\d+\.mca|c\.-?\d+\.-?\d+\.mcc))$/.test(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > (item.path === "level.dat" ? 1024 * 1024 : 128 * 1024 * 1024) || !HASH.test(item.sha256)) throw new Error("Invalid queued overview input");
    total += item.bytes; if (total > 256 * 1024 * 1024) throw new Error("Oversized queued overview input");
    if (await digest(root, path.join(world, item.path), item.bytes, item.path === "level.dat" ? 1024 * 1024 : 128 * 1024 * 1024) !== item.sha256) throw new Error("Changed queued overview input");
    let relative = `world/${item.path}`; allowed.add(relative);
    while (relative.includes("/")) { relative = relative.slice(0, relative.lastIndexOf("/")); allowed.add(relative); }
  }
  // Inspect all entries so temporary files and producer-controlled directory aliases cannot hide between declared files.
  const pending = [{ file: path.join(jobRoot, "input"), relative: "" }]; let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const name of await directory(root, current.file)) {
      if (++entries > 8192) throw new Error("Excessive queued input staging");
      const relative = current.relative ? `${current.relative}/${name}` : name;
      if (!allowed.has(relative)) throw new Error("Unexpected queued input staging");
      const file = path.join(current.file, name), info = await lstat(file);
      if (info.isDirectory() && !info.isSymbolicLink()) pending.push({ file, relative });
      else if (!isPrivateFile(info, relative === "manifest.json" ? MAX_JSON : 128 * 1024 * 1024)) throw new Error("Unverified queued input staging");
    }
  }
  const output = path.join(jobRoot, "output");
  if (await lstat(output).catch(error => { if (error.code === "ENOENT") return null; throw error; }) && (await directory(root, output)).length) throw new Error("Unverified queued renderer scratch");
  await json(root, path.join(jobRoot, "job.json")).then(latest => { if (JSON.stringify(latest) !== JSON.stringify(job)) throw new Error("Queued job changed during inspection"); });
}
/** Read-only admission. Waiting/verified queued work can survive web replacement. */
export async function scanMinecraftOverviewStaging(configuredRoot) {
  if (!await lstat(configuredRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; })) return [];
  const root = path.join(await realpath(path.dirname(configuredRoot)), path.basename(configuredRoot));
  const blocked = [], profiles = await directory(root, root, 256); let queued = 0;
  for (const profileId of profiles) {
    if (!UUID.test(profileId)) { blocked.push(root); continue; }
    const profile = path.join(root, profileId);
    try {
      const entries = await directory(root, profile);
      if (entries.some(name => !["overview.json", "jobs", "images"].includes(name))) throw new Error("Unknown overview storage");
      const status = await json(root, path.join(profile, "overview.json"));
      if (status.format !== 1 || status.profileId !== profileId || !target(status.target) || !["waiting", "queued", "ready", "stale", "failed", "unsupported"].includes(status.state) || !date(status.updatedAt) || !Number.isSafeInteger(status.retryAt) || status.retryAt < 0 || !(status.artifact === null || artifact(status.artifact)) || ["ready", "stale"].includes(status.state) && !status.artifact || status.state === "queued" && !UUID.test(status.jobId)) throw new Error("Active or unverified overview");
      if (entries.includes("images")) for (const name of await directory(root, path.join(profile, "images"))) { if (!/^[a-f0-9]{64}\.png$/.test(name) || !isPrivateFile(await lstat(path.join(profile, "images", name)), 5 * 1024 * 1024)) throw new Error("Unverified overview image staging"); }
      if (status.artifact && await digest(root, path.join(profile, "images", `${status.artifact.revision}.png`), status.artifact.bytes, 5 * 1024 * 1024) !== status.artifact.revision) throw new Error("Unverified published overview receipt");
      const jobIds = entries.includes("jobs") ? await directory(root, path.join(profile, "jobs"), 64) : [];
      if (status.state === "queued" && !jobIds.includes(status.jobId)) throw new Error("Queued overview pointer has no admitted job");
      for (const jobId of jobIds) {
        const jobRoot = path.join(profile, "jobs", jobId);
        if (!UUID.test(jobId)) throw new Error("Unknown overview staging");
        const names = await directory(root, jobRoot), job = await json(root, path.join(jobRoot, "job.json"));
        if (names.some(name => !["job.json", "input", "output"].includes(name)) || job.format !== 1 || job.profileId !== profileId || job.id !== jobId || !target(job.target) || !source(job.source) || !date(job.createdAt) || !["queued", "complete", "failed"].includes(job.phase)) throw new Error("Active or unverified overview job");
        if (job.phase === "queued") { if (++queued > 16 || status.state !== "queued" || status.jobId !== jobId) throw new Error("Excessive or uncommitted queued overview work"); await queuedInput(root, jobRoot, job, profileId, jobId); }
        else if (names.some(name => ["input", "output"].includes(name))) throw new Error("Unresolved overview scratch");
      }
      const latest = await json(root, path.join(profile, "overview.json")); if (JSON.stringify(latest) !== JSON.stringify(status)) throw new Error("Overview status changed during inspection");
      if (JSON.stringify((await directory(root, profile)).sort()) !== JSON.stringify(entries.sort()) || entries.includes("jobs") && JSON.stringify((await directory(root, path.join(profile, "jobs"), 64)).sort()) !== JSON.stringify(jobIds.sort())) throw new Error("Overview staging changed during inspection");
    } catch { blocked.push(profile); }
  }
  if (JSON.stringify((await directory(root, root, 256)).sort()) !== JSON.stringify(profiles.sort())) blocked.push(root);
  return blocked;
}
if (process.argv[1] === "-" || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const paths = await scanMinecraftOverviewStaging("/app/data/minecraft-profile-overviews");
    if (paths.length) { console.error("deploy: generated world overview work is active or unverified:"); for (const file of paths) console.error(`        ${file}`); process.exitCode = 1; }
  } catch { console.error("deploy: overview staging could not be inspected; replacement refused."); process.exitCode = 1; }
}
