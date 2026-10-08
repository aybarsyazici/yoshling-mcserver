import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execute = promisify(execFile);
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", J = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string, storage: string, scanner: string, workerBranch: string;
const privateWrite = (file: string, value: string | Buffer) => writeFile(file, value, { mode: 0o600 });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "overview-cli-"))); storage = path.join(root, "private-overviews");
  const actual = await readFile(path.resolve(__dirname, "../scripts/check-minecraft-overview-staging.mjs"), "utf8");
  expect(actual).toContain('scanMinecraftOverviewStaging("/app/data/minecraft-profile-overviews")');
  // Run a disposable source copy against ordinary fixtures; no /app or production paths are touched.
  scanner = actual.replace('scanMinecraftOverviewStaging("/app/data/minecraft-profile-overviews")', `scanMinecraftOverviewStaging(${JSON.stringify(storage)})`);
  const deploy = await readFile(path.resolve(__dirname, "../scripts/deploy.sh"), "utf8"), begin = deploy.indexOf("  local overview_workers\n"), end = deploy.indexOf("  if ! docker exec -i yoshling-web-1", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin); workerBranch = deploy.slice(begin, end);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function queued(state = "queued") {
  const job = path.join(storage, P, "jobs", J); await mkdir(path.join(job, "input/world/region"), { recursive: true, mode: 0o700 }); await mkdir(path.join(job, "output"), { mode: 0o700 });
  const level = Buffer.from("ordinary bounded level fixture"), region = Buffer.alloc(8192);
  const files = [{ path: "level.dat", bytes: level.length, sha256: hash(level) }, { path: "region/r.0.0.mca", bytes: region.length, sha256: hash(region) }];
  const target = { mcVersion: "26.1.2", loader: "vanilla", loaderVersion: null, javaVariant: "java25" }, snapshotAt = "2026-10-08T12:00:00.000Z";
  const source = { kind: "saved-copy", id: J, sha256: hash(Buffer.from(JSON.stringify(files))), snapshotAt, sourceSavedAt: null, center: { x: 0, z: 0 }, layout: "legacy", files };
  await privateWrite(path.join(job, "input/world/level.dat"), level); await privateWrite(path.join(job, "input/world/region/r.0.0.mca"), region);
  await privateWrite(path.join(job, "input/manifest.json"), JSON.stringify({ format: 1, profileId: P, jobId: J, target, source: { kind: source.kind, id: source.id, sha256: source.sha256, snapshotAt, sourceSavedAt: null }, center: source.center, radius: 64, dimension: "overworld", layout: source.layout, files }));
  await privateWrite(path.join(job, "job.json"), JSON.stringify({ format: 1, id: J, profileId: P, phase: "queued", target, source, createdAt: snapshotAt, operationId: null, actor: null }));
  await privateWrite(path.join(storage, P, "overview.json"), JSON.stringify({ format: 1, profileId: P, target, state, updatedAt: snapshotAt, retryAt: 0, jobId: J, operationId: null, reason: null, artifact: null }));
}
async function stdin(binary: string, args: string[], source: string, extraEnv: Record<string, string> = {}) {
  const promise = execute(binary, args, { cwd: root, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  promise.child.stdin!.end(source);
  try { const output = await promise; return { code: 0, ...output }; }
  catch (error) { if (error && typeof error === "object" && "code" in error && typeof error.code === "number" && "stderr" in error) return { code: error.code, stderr: String(error.stderr) }; throw error; }
}
async function workers(scenario: "running" | "exited" | "unknown" | "none") {
  const bin = path.join(root, "bin"); await mkdir(bin, { mode: 0o700 });
  await writeFile(path.join(bin, "docker"), `#!/bin/bash
set -eu
if [ "$1" != "ps" ] || [ "$3" != "--filter" ] || [ "$4" != "label=yoshling.overview.worker=1" ]; then exit 90; fi
if [ "$SCENARIO" = "unknown" ]; then exit 12; fi
if [ "$SCENARIO" = "running" ]; then printf '%064d\\n' 1; fi
if [ "$SCENARIO" = "exited" ] && [ "$2" = "-aq" ]; then printf '%064d\\n' 2; fi
`, { mode: 0o700 });
  return stdin("bash", ["-s"], `set -euo pipefail\ncheck_workers() {\n${workerBranch}\n}\ncheck_workers\n`, { PATH: `${bin}:${process.env.PATH}`, SCENARIO: scenario });
}
describe("actual overview deployment entry points", () => {
  it("runs the scanner from Node stdin and allows a verified queued snapshot", async () => { await queued(); const result = await stdin(process.execPath, ["--input-type=module", "-"], scanner); expect(result.code).toBe(0); expect(result.stderr).toBe(""); });
  it("executes the Node stdin refusal instead of silently importing an unverified snapshot", async () => { await queued("unverified"); const result = await stdin(process.execPath, ["--input-type=module", "-"], scanner); expect(result.code).toBe(1); expect(result.stderr).toContain("active or unverified"); });
  it.each(["running", "exited"] as const)("refuses a %s labelled worker in the extracted real Bash guard", async scenario => { const result = await workers(scenario); expect(result.code).toBe(1); expect(result.stderr).toContain("worker is active or needs cleanup"); });
  it("refuses unknown Docker inspection rather than assuming an empty inventory", async () => { const result = await workers("unknown"); expect(result.code).toBe(1); expect(result.stderr).toContain("cannot inspect overview workers"); });
  it("allows a confirmed empty worker inventory", async () => { const result = await workers("none"); expect(result.code).toBe(0); expect(result.stderr).toBe(""); });
});
