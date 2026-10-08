import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(clientRoot, "../..");
const directory = path.join(repository, "public", "companions");
const fileName = "yoshling-screenshots-0.1.0+mc26.1.2.jar";
const source = path.join(clientRoot, "build", "libs", fileName);
if (path.dirname(await realpath(source)) !== path.join(clientRoot, "build", "libs")) throw new Error("Unexpected jar source");
const bytes = await readFile(source);
if (bytes.length < 4 || bytes.length > 2 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("Unexpected companion jar");
await mkdir(directory, { recursive: true });
if (!(await lstat(directory)).isDirectory()) throw new Error("Unexpected companion publication directory");
const digest = buffer => createHash("sha256").update(buffer).digest("hex");
const manifest = { version: "0.1.0", minecraftVersions: ["26.1.2"], loader: "fabric", fileName,
  downloadUrl: "/companions/" + fileName, sha256: digest(bytes), bytes: bytes.length };
async function publish(name, content) {
  const target = path.join(directory, name), staging = target + ".tmp-" + randomUUID();
  try {
    await writeFile(staging, content, { flag: "wx", mode: 0o644 });
    if (!(await readFile(staging)).equals(content)) throw new Error("Publication staging readback failed");
    await rename(staging, target);
    if (!(await readFile(target)).equals(content)) throw new Error("Publication readback failed");
  } finally { await rm(staging, { force: true }); }
}
await publish(fileName, bytes);
await publish("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
const stored = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
const jar = await readFile(path.join(directory, stored.fileName));
if (stored.sha256 !== digest(jar) || stored.bytes !== jar.length) throw new Error("Companion manifest readback failed");
console.log(JSON.stringify(manifest));
