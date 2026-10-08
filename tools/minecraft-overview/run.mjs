import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { screenshot } from "./screenshot.mjs";

process.umask(0o077);
const MAX_SOURCE = 256 * 1024 * 1024;
const VERSION_SET = new Set(["26.1.2", "1.21.1"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const base = path.dirname(fileURLToPath(import.meta.url));
const input = process.env.OVERVIEW_INPUT || "/input";
const output = process.env.OVERVIEW_OUTPUT || "/output";
const scratch = process.env.OVERVIEW_SCRATCH || "/tmp/overview";
const assets = process.env.OVERVIEW_ASSETS || path.join(base, "assets");
const java = process.env.JAVA_BINARY || "/opt/java/bin/java";
const bootstrap = process.env.OVERVIEW_BOOTSTRAP || path.join(base, "bootstrap");
export async function hash(file) {
  const digest = createHash("sha256");
  for await (const block of createReadStream(file)) digest.update(block);
  return digest.digest("hex");
}
export function validateManifest(manifest) {
  if (!manifest || manifest.format !== 1 || !UUID.test(manifest.profileId) || !UUID.test(manifest.jobId) ||
      !VERSION_SET.has(manifest.target?.mcVersion) || !SHA.test(manifest.source?.sha256) ||
      !manifest.center || !Number.isInteger(manifest.center.x) || !Number.isInteger(manifest.center.z) ||
      Math.abs(manifest.center.x) > 30000000 || Math.abs(manifest.center.z) > 30000000 ||
      manifest.radius !== 64 || manifest.dimension !== "overworld" || !["legacy", "namespaced"].includes(manifest.layout) ||
      !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 4096) throw new Error("Invalid overview input manifest");
  const prefix = manifest.layout === "legacy" ? "region/" : "dimensions/minecraft/overworld/region/";
  const region = new RegExp("^" + prefix + "(r\\.-?\\d+\\.-?\\d+\\.mca|c\\.-?\\d+\\.-?\\d+\\.mcc)$");
  let bytes = 0;
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path.length > 160 || paths.has(file.path) ||
        !(file.path === "level.dat" || region.test(file.path)) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
        file.bytes > MAX_SOURCE || !SHA.test(file.sha256)) throw new Error("Invalid overview source file");
    paths.add(file.path); bytes += file.bytes;
  }
  if (!paths.has("level.dat") || bytes > MAX_SOURCE || manifest.files.find(file => file.path === "level.dat").bytes > 1024 * 1024)
    throw new Error("Overview source exceeds bounds");
  if (createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex") !== manifest.source.sha256)
    throw new Error("Overview source inventory fingerprint mismatch");
  return manifest;
}
export async function verifyInput(directory, manifest) {
  const world = path.join(directory, "world");
  if (!(await lstat(world)).isDirectory()) throw new Error("Overview world must be a real directory");
  const canonical = await realpath(world), listed = new Set(manifest.files.map(file => file.path));
  const visited = [];
  let entries = 0;
  async function walk(folder, relative = "") {
    if (relative.split("/").length > 8) throw new Error("Overview source depth exceeds bounds");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++entries > 8192) throw new Error("Overview source inventory exceeds bounds");
      const file = path.join(folder, entry.name), name = relative ? relative + "/" + entry.name : entry.name;
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1)
        throw new Error("Overview source links/special files are refused");
      if (info.isDirectory()) await walk(file, name);
      else { if (!listed.has(name)) throw new Error("Unexpected overview source file"); visited.push(name); }
    }
  }
  await walk(world);
  if (visited.length !== manifest.files.length) throw new Error("Overview source inventory mismatch");
  for (const file of manifest.files) {
    const target = path.join(canonical, file.path), actual = await realpath(target);
    if (!actual.startsWith(canonical + path.sep) || (await stat(actual)).size !== file.bytes || await hash(actual) !== file.sha256)
      throw new Error("Overview source readback mismatch");
  }
}
export async function verifyAssets(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "assets.json"), "utf8"));
  validateAssetManifest(manifest);
  if (await hash(path.join(directory, manifest.renderer.file)) !== manifest.renderer.sha256 ||
      await hash(path.join(directory, "version-manifest.json")) !== manifest.manifestSha256) throw new Error("Overview asset verification failed");
  for (const client of manifest.clients) {
    if ((await stat(path.join(directory, client.file))).size !== client.bytes || await hash(path.join(directory, client.file)) !== client.sha256)
      throw new Error("Minecraft overview resource verification failed");
  }
  return manifest;
}
export function validateAssetManifest(manifest) {
  if (manifest.format !== 1 || manifest.renderer?.name !== "bluemap" || manifest.renderer.version !== "5.28" ||
      manifest.renderer.file !== "bluemap-5.28-cli.jar" || !SHA.test(manifest.manifestSha256) ||
      manifest.renderer.sha256 !== "c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2" ||
      JSON.stringify(manifest.supportedVersions) !== JSON.stringify([...VERSION_SET]) ||
      !Array.isArray(manifest.clients) || manifest.clients.length !== VERSION_SET.size ||
      new Set(manifest.clients.map(client => client.id)).size !== VERSION_SET.size) throw new Error("Unsupported overview assets");
  for (const client of manifest.clients) {
    if (!VERSION_SET.has(client.id) || client.file !== "minecraft-client-" + client.id + ".jar" ||
        !SHA.test(client.sha256) || !Number.isSafeInteger(client.bytes) || client.bytes < 1 || client.bytes > 128 * 1024 * 1024 ||
        !/^[a-f0-9]{40}$/.test(client.sha1))
      throw new Error("Minecraft overview resource verification failed");
  }
  if (manifest.clients.length !== VERSION_SET.size) throw new Error("Minecraft overview resources missing");
  return manifest;
}
async function cli(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let seen = 0;
    const terminate = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    const collect = block => { seen += block.length; if (seen > 1024 * 1024) terminate(); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timeout = setTimeout(terminate, 90000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => {
      clearTimeout(timeout);
      if (code === 0 && seen <= 1024 * 1024) resolve();
      else reject(new Error("Overview CLI did not complete"));
    });
  });
}
async function main() {
  const info = await stat(path.join(input, "manifest.json"));
  if (info.size > 1024 * 1024) throw new Error("Overview input manifest exceeds bound");
  const manifest = validateManifest(JSON.parse(await readFile(path.join(input, "manifest.json"), "utf8")));
  await verifyInput(input, manifest);
  const assetManifest = await verifyAssets(assets);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const config = path.join(scratch, "config"), data = path.join(scratch, "data"), web = path.join(scratch, "web");
  for (const directory of [output, data, path.join(config, "maps"), path.join(config, "storages")]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(output);
  if (!outputInfo.isDirectory() || outputInfo.uid !== process.getuid() || (await readdir(output)).length !== 0) throw new Error("Overview output must be an empty owned directory");
  await chmod(output, 0o700);
  const client = assetManifest.clients.find(client => client.id === manifest.target.mcVersion);
  await cp(path.join(assets, client.file), path.join(data, client.file));
  await writeFile(path.join(config, "core.conf"), "accept-download:false\ndata:" + JSON.stringify(data) + "\nrender-thread-count:1\nrender-thread-priority:1\nscan-for-mod-resources:false\nmetrics:false\nfull-update-interval:0\n");
  await writeFile(path.join(config, "webapp.conf"), "enabled:true\nwebroot:" + JSON.stringify(web) + "\nuse-cookies:false\nresolution-default:1\nhires-slider-max:256\nhires-slider-default:128\nlowres-slider-max:256\nlowres-slider-default:128\nlowres-slider-min:0\n");
  await writeFile(path.join(config, "webserver.conf"), "enabled:false\nsse-enabled:false\nwebroot:" + JSON.stringify(web) + "\n");
  await writeFile(path.join(config, "storages/file.conf"), "storage-type:file\nroot:" + JSON.stringify(path.join(web, "maps")) + "\ncompression:none\n");
  const { x, z } = manifest.center;
  await writeFile(path.join(config, "maps/overview.conf"), "world:" + JSON.stringify(path.join(input, "world")) +
    "\ndimension:\"minecraft:overworld\"\ndimension-type:\"minecraft:overworld\"\nname:\"Saved world overview\"\nstart-pos:{x:" + x + ",z:" + z + "}\n" +
    "sky-color:\"#b5d5ef\"\nvoid-color:\"#b5d5ef\"\nambient-light:0.18\nremove-caves-below-y:10000\nrender-edges:true\nedge-light-strength:15\n" +
    "enable-perspective-view:true\nenable-flat-view:true\nenable-free-flight-view:false\nmin-inhabited-time:0\nstorage:\"file\"\nrender-mask:[{type:box,min-x:" +
    (x - 64) + ",max-x:" + (x + 63) + ",min-z:" + (z - 64) + ",max-z:" + (z + 63) + "}]\n");
  await cli(java, ["-Djava.awt.headless=true", "-XX:ActiveProcessorCount=1", "-Xms64m", "-Xmx512m", "-cp",
    bootstrap + path.delimiter + path.join(assets, assetManifest.renderer.file), "OfflineBlueMap", path.join(assets, "version-manifest.json"),
    "-c", config, "-r", "-g", "-s", "-m", "overview", "-v", manifest.target.mcVersion], scratch);
  const image = await screenshot(web, path.join(output, "overview.png"), manifest.center, process.env.OVERVIEW_PLAYWRIGHT || "playwright");
  await verifyInput(input, manifest);
  const receipt = { format: 1, profileId: manifest.profileId, jobId: manifest.jobId, sourceSha256: manifest.source.sha256,
    renderer: { name: "bluemap", version: "5.28" }, width: image.width, height: image.height,
    image: { file: "overview.png", sha256: image.sha256, bytes: image.bytes }, center: manifest.center, radius: 64, dimension: "overworld" };
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n"), target = path.join(output, "receipt.json");
  await writeFile(target + ".partial", bytes, { mode: 0o600 });
  if (!(await readFile(target + ".partial")).equals(bytes)) throw new Error("Overview receipt staging readback failed");
  await rename(target + ".partial", target);
  if (!(await readFile(target)).equals(bytes)) throw new Error("Overview receipt publication readback failed");
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hardStop = setTimeout(() => process.exit(1), 120000);
  main().then(() => clearTimeout(hardStop)).catch(error => { console.error(error.message); process.exitCode = 1; clearTimeout(hardStop); });
}
