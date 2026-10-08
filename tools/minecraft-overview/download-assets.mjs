import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const destination = path.resolve(process.argv[2] || ".assets");
const versions = ["26.1.2", "1.21.1"];
const cliSha256 = "c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2";
await mkdir(destination, { recursive: true });
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest("hex");
}
async function json(url, cap) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Asset metadata request refused");
  const blocks = []; let bytes = 0;
  for await (const block of response.body) { bytes += block.length; if (bytes > cap) throw new Error("Asset metadata exceeds bound"); blocks.push(block); }
  return JSON.parse(Buffer.concat(blocks).toString("utf8"));
}
async function download(url, name, algorithm, expected, expectedBytes) {
  const file = path.join(destination, name);
  try { if ((!expectedBytes || (await stat(file)).size === expectedBytes) && await digest(file, algorithm) === expected) return file; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const staging = file + ".partial";
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("Asset download refused");
  let bytes = 0;
  const hash = createHash(algorithm);
  const source = Readable.from((async function* () {
    for await (const block of response.body) {
      bytes += block.length; if (bytes > 128 * 1024 * 1024) throw new Error("Asset exceeds bound");
      hash.update(block); yield block;
    }
  })());
  try {
    await pipeline(source, createWriteStream(staging, { flags: "w", mode: 0o600 }));
    if (hash.digest("hex") !== expected || expectedBytes && bytes !== expectedBytes) throw new Error("Asset digest or size mismatch");
    await rename(staging, file);
    if (await digest(file, algorithm) !== expected) throw new Error("Asset readback mismatch");
  } finally { await rm(staging, { force: true }); }
  return file;
}
await download("https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v5.28/bluemap-5.28-cli.jar", "bluemap-5.28-cli.jar", "sha256", cliSha256, 7287266);
const manifest = await json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", 4 * 1024 * 1024);
const selected = manifest.versions.filter(entry => [...versions, "1.13", "1.19.4"].includes(entry.id));
if (selected.length !== 4) throw new Error("Pinned Minecraft metadata entries missing");
const pinnedManifest = { latest: { release: versions[0], snapshot: versions[0] }, versions: selected };
const manifestBytes = Buffer.from(JSON.stringify(pinnedManifest));
await writeFile(path.join(destination, "version-manifest.json"), manifestBytes, { mode: 0o600 });
const clients = [];
for (const id of versions) {
  const version = await json(selected.find(entry => entry.id === id).url, 2 * 1024 * 1024);
  const client = version.downloads.client;
  if (new URL(client.url).origin !== "https://piston-data.mojang.com" || !/^[a-f0-9]{40}$/.test(client.sha1) || client.size > 128 * 1024 * 1024) throw new Error("Unexpected Minecraft asset");
  const file = "minecraft-client-" + id + ".jar";
  await download(client.url, file, "sha1", client.sha1, client.size);
  clients.push({ id, file, bytes: client.size, sha1: client.sha1, sha256: await digest(path.join(destination, file), "sha256") });
}
const receipt = { format: 1, renderer: { name: "bluemap", version: "5.28", file: "bluemap-5.28-cli.jar", sha256: cliSha256 },
  supportedVersions: versions, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), clients };
await writeFile(path.join(destination, "assets.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const readback = JSON.parse(await readFile(path.join(destination, "assets.json"), "utf8"));
if (JSON.stringify(readback) !== JSON.stringify(receipt)) throw new Error("Asset receipt readback failed");
console.log(JSON.stringify(receipt));
