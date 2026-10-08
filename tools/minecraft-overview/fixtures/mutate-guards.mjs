// Offline deliberate break -> red proof. Mutations are isolated copies; source stays intact.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const original = Object.fromEntries(await Promise.all(["run.mjs", "screenshot.mjs", "worker.test.mjs"].map(async name => [name, await readFile(path.join(directory, name), "utf8")])));
const mutations = [
  ["target allowlist", "run.mjs", [["!VERSION_SET.has(manifest.target?.mcVersion) || ", ""]]],
  ["profile identity", "run.mjs", [["!UUID.test(manifest.profileId) || ", ""]]],
  ["job identity", "run.mjs", [["!UUID.test(manifest.jobId) ||", ""]]],
  ["view radius", "run.mjs", [["manifest.radius !== 64 || ", ""]]],
  ["overworld only", "run.mjs", [["manifest.dimension !== \"overworld\" || ", ""]]],
  ["integral center", "run.mjs", [["!Number.isInteger(manifest.center.x) || ", ""]]],
  ["center range", "run.mjs", [["Math.abs(manifest.center.x) > 30000000 || ", ""]]],
  ["source paths", "run.mjs", [["!(file.path === \"level.dat\" || region.test(file.path))", "false"]]],
  ["duplicate paths", "run.mjs", [["paths.has(file.path) ||", ""]]],
  ["total byte cap", "run.mjs", [["!paths.has(\"level.dat\") || bytes > MAX_SOURCE || ", "!paths.has(\"level.dat\") || "]]],
  ["level byte cap", "run.mjs", [[" || manifest.files.find(file => file.path === \"level.dat\").bytes > 1024 * 1024", ""]]],
  ["integral bytes", "run.mjs", [["!Number.isSafeInteger(file.bytes) || ", ""]]],
  ["nonempty files", "run.mjs", [["file.bytes < 1 ||", ""]]],
  ["file digest grammar", "run.mjs", [[" || !SHA.test(file.sha256)", ""]]],
  ["file count", "run.mjs", [[" || manifest.files.length > 4096", ""]]],
  ["inventory fingerprint", "run.mjs", [["createHash(\"sha256\").update(JSON.stringify(manifest.files)).digest(\"hex\") !== manifest.source.sha256", "false"]]],
  ["file byte readback", "run.mjs", [[" || await hash(actual) !== file.sha256", ""]]],
  ["source link guard", "run.mjs", [["info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1", "false"]]],
  ["hardlink guard", "run.mjs", [[" || info.isFile() && info.nlink !== 1", ""]]],
  ["extra file inventory", "run.mjs", [["if (!listed.has(name)) throw new Error(\"Unexpected overview source file\");", ""], ["if (visited.length !== manifest.files.length) throw new Error(\"Overview source inventory mismatch\");", ""]]],
  ["asset client distinctness", "run.mjs", [[" ||\n      new Set(manifest.clients.map(client => client.id)).size !== VERSION_SET.size", ""]]],
  ["renderer asset path", "run.mjs", [["manifest.renderer.file !== \"bluemap-5.28-cli.jar\" || ", ""]]],
  ["renderer checksum pin", "run.mjs", [["manifest.renderer.sha256 !== \"c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2\" ||", ""]]],
  ["asset version list", "run.mjs", [["JSON.stringify(manifest.supportedVersions) !== JSON.stringify([...VERSION_SET]) ||", ""]]],
  ["canvas width", "screenshot.mjs", [["capture.width !== 1280 || ", ""]]],
  ["canvas height", "screenshot.mjs", [["capture.height !== 800 ||", ""]]],
  ["loaded geometry", "screenshot.mjs", [["capture.vertices < 1 || ", ""]]],
  ["geometry count", "screenshot.mjs", [["!Number.isSafeInteger(capture.vertices) || ", ""]]],
  ["encoded image cap", "screenshot.mjs", [[" || capture.data.length > 7 * 1024 * 1024", ""]]],
  ["decoded image cap", "screenshot.mjs", [["png.length > 5 * 1024 * 1024 ||", ""]]],
  ["PNG signature", "screenshot.mjs", [["!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || ", ""]]],
  ["PNG width", "screenshot.mjs", [["png.readUInt32BE(16) !== 1280 || ", ""]]],
];
const temporary = await mkdtemp(path.join(os.tmpdir(), "overview-mutants-"));
try {
  let killed = 0;
  for (const [name, module, edits] of mutations) {
    const files = { ...original };
    for (const [from, to] of edits) {
      assert.equal(files[module].split(from).length, 2, "Mutation must replace exactly one guard: " + name);
      files[module] = files[module].replace(from, to);
    }
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(temporary, file), content);
    const result = spawnSync(process.execPath, ["--test", path.join(temporary, "worker.test.mjs")], { encoding: "utf8", timeout: 20000 });
    if (result.status === 0 || !result.stdout.includes("ERR_ASSERTION")) {
      console.error(result.stdout, result.stderr);
      throw new Error("Protection did not produce an assertion failure: " + name);
    }
    console.log("RED: " + name); killed++;
  }
  for (const [file, content] of Object.entries(original)) assert.equal(await readFile(path.join(directory, file), "utf8"), content);
  const result = spawnSync(process.execPath, ["--test", path.join(directory, "worker.test.mjs")], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(JSON.stringify({ killed, restored: true, originalTestsGreen: true }));
} finally { await rm(temporary, { recursive: true, force: true }); }
