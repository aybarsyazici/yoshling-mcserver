import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execute = promisify(execFile);
let folder: string;
let indexFile: string;
let logFile: string;
let originalIndex: string;
type AwsCall = { args: string[]; profile: string | null; hasAccessKey: boolean; hasSecretKey: boolean; hasSessionToken: boolean; legacyKeyPresent: boolean; body?: { dimensions: number; normalize: boolean; inputText: string } };

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "yoshling-embedding-builder-"));
  for (const directory of ["scripts", "src/lib", "src/data/aion2", "node_modules", "bin"]) await mkdir(path.join(folder, directory), { recursive: true });
  await writeFile(path.join(folder, "package.json"), '{"type":"module"}');
  for (const file of ["scripts/aion2-embed.mjs", "scripts/aion2-embedding-aws.mjs", "scripts/aion2-semantic-core.mjs", "src/lib/aion2-knowledge-validation.ts", "src/lib/aion2-checklist-validation.ts", "src/lib/aion2-gear-validation.ts", "src/data/aion2/knowledge.json", "src/data/aion2/checklist.json", "src/data/aion2/gear-priorities.json", "src/data/aion2/semantic-index.json"]) await copyFile(path.join(process.cwd(), file), path.join(folder, file));
  await symlink(path.join(process.cwd(), "node_modules/dotenv"), path.join(folder, "node_modules/dotenv"), "dir");
  // Only fixture dates change. The existing approved text vectors remain reusable.
  for (const file of ["knowledge.json", "checklist.json", "gear-priorities.json"]) {
    const target = path.join(folder, "src/data/aion2", file), value = JSON.parse(await readFile(target, "utf8"));
    value.expiresAt = file === "checklist.json" ? "2099-01-01T00:00:00.000Z" : "2099-01-01";
    await writeFile(target, JSON.stringify(value));
  }
  indexFile = path.join(folder, "src/data/aion2/semantic-index.json"); originalIndex = await readFile(indexFile, "utf8");
  logFile = path.join(folder, "aws-calls.jsonl");
  const stub = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const bodyIndex=args.indexOf('--body');
const body=bodyIndex<0?undefined:JSON.parse(readFileSync(args[bodyIndex+1].slice('fileb://'.length),'utf8'));
appendFileSync(process.env.FIXTURE_AWS_LOG,JSON.stringify({args,profile:process.env.AWS_PROFILE??null,hasAccessKey:!!process.env.AWS_ACCESS_KEY_ID,hasSecretKey:!!process.env.AWS_SECRET_ACCESS_KEY,hasSessionToken:!!process.env.AWS_SESSION_TOKEN,legacyKeyPresent:!!process.env.aws_access_key_id,body})+'\\n');
if(process.env.FIXTURE_AWS_FAIL){console.error('An error occurred (ExpiredTokenException) when calling InvokeModel: SYNTHETIC_SECRET_MUST_STAY_PRIVATE');process.exit(1);}
if(args[0]==='configure'){console.log(process.env.FIXTURE_CONFIGURED_REGION||'eu-west-1');process.exit(0);}
if(args[0]!=='bedrock-runtime'||args[1]!=='invoke-model')process.exit(9);
writeFileSync(args.at(-1),JSON.stringify({embedding:[1,...Array(511).fill(0)],inputTextTokenCount:1}));
`;
  await writeFile(path.join(folder, "bin/aws"), stub, { mode: 0o700 });
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

async function calls(): Promise<AwsCall[]> { try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function run(args: string[], variables: Record<string, string> = {}) {
  const env = { NODE_ENV: "test" as const, PATH: `${path.join(folder, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`, FIXTURE_AWS_LOG: logFile, ...variables };
  try { const result = await execute(process.execPath, [path.join(folder, "scripts/aion2-embed.mjs"), ...args], { cwd: folder, env, encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024 }); return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
  catch (error) { const failure = error as { code: number; stdout: string; stderr: string }; return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }; }
}
async function miss() {
  const file = path.join(folder, "src/data/aion2/knowledge.json"), value = JSON.parse(await readFile(file, "utf8"));
  value.rules[0].steps[0].instruction += " Offline fixture reviewed wording.";
  await writeFile(file, JSON.stringify(value));
}
async function legacy() { await writeFile(path.join(folder, ".env"), "aws_access_key_id=SYNTHETIC_LEGACY_KEY\naws_secret_access_key=SYNTHETIC_SECRET_MUST_STAY_PRIVATE\naws_session_token=SYNTHETIC_EXPIRED_TOKEN\naws_region=us-east-2\n", { mode: 0o600 }); }

describe("offline embedding CLI credentials and cache", () => {
  it("rebuilds a complete cache without .env or any AWS invocation", async () => {
    const result = await run(["--build"], { FIXTURE_AWS_FAIL: "must-never-run" });
    expect(result.code).toBe(0); expect(await calls()).toEqual([]);
    const output = JSON.parse(result.stdout); expect(output.invoked).toBe(0); expect(output.reused).toBe(output.chunks + output.queries);
  });

  it("does not consult even an unreadable legacy .env when all vectors are cached", async () => {
    await mkdir(path.join(folder, ".env"));
    const result = await run(["--build", "--profile", "fixture-profile"], { AWS_ACCESS_KEY_ID: "EXPIRED", AWS_SECRET_ACCESS_KEY: "EXPIRED", AWS_SESSION_TOKEN: "EXPIRED", FIXTURE_AWS_FAIL: "must-never-run" });
    expect(result.code).toBe(0); expect(await calls()).toEqual([]);
  });

  it("keeps a credential-free dry run, including workload and explicit flags", async () => {
    await miss(); const result = await run(["--profile=fixture-profile", "--region=us-west-2"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).dryRun).toBe(true); expect(await calls()).toEqual([]);
    expect(await readFile(indexFile, "utf8")).toBe(originalIndex);
  });

  it("gives --profile precedence over AWS_PROFILE, static environment keys and legacy .env", async () => {
    await legacy(); await miss();
    const result = await run(["--build", "--profile", "fixture-cli-profile", "--region", "us-west-2"], { AWS_PROFILE: "fixture-ambient-profile", AWS_ACCESS_KEY_ID: "AMBIENT_KEY", AWS_SECRET_ACCESS_KEY: "AMBIENT_SECRET", AWS_SESSION_TOKEN: "AMBIENT_TOKEN", aws_access_key_id: "LOWERCASE_AMBIENT" });
    expect(result.code).toBe(0);
    const requests = await calls(); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ profile: "fixture-cli-profile", hasAccessKey: false, hasSecretKey: false, hasSessionToken: false, legacyKeyPresent: false });
    expect(requests[0].args).toEqual(expect.arrayContaining(["--profile", "fixture-cli-profile", "--region", "us-west-2", "--model-id", "amazon.titan-embed-text-v2:0"]));
    expect(requests[0].body).toMatchObject({ dimensions: 512, normalize: true });
    expect(JSON.parse(result.stdout).invoked).toBe(1);
  });

  it("honors AWS_PROFILE and resolves its region without reading stale legacy keys", async () => {
    await legacy(); await miss();
    const result = await run(["--build"], { AWS_PROFILE: "fixture-sso-profile", AWS_ACCESS_KEY_ID: "EXPIRED", AWS_SECRET_ACCESS_KEY: "EXPIRED", AWS_SESSION_TOKEN: "EXPIRED" });
    expect(result.code).toBe(0);
    const requests = await calls(); expect(requests).toHaveLength(2);
    expect(requests[0].args).toEqual(["configure", "get", "region", "--profile", "fixture-sso-profile"]);
    for (const request of requests) expect(request).toMatchObject({ profile: "fixture-sso-profile", hasAccessKey: false, hasSecretKey: false, hasSessionToken: false });
    expect(requests[1].args).toEqual(expect.arrayContaining(["--region", "eu-west-1"]));
  });

  it("supports the normal provider chain without .env and without forcing a profile", async () => {
    await miss(); const result = await run(["--build", "--region", "us-west-2"]);
    expect(result.code).toBe(0);
    expect((await calls())[0]).toMatchObject({ profile: null, hasAccessKey: false, hasSecretKey: false, hasSessionToken: false });
    expect((await calls())[0].args).not.toContain("--profile");
  });

  it("uses ambient static credentials before stale legacy .env credentials", async () => {
    await legacy(); await miss();
    const result = await run(["--build", "--region", "us-west-2"], { AWS_ACCESS_KEY_ID: "AMBIENT_KEY", AWS_SECRET_ACCESS_KEY: "AMBIENT_SECRET" });
    expect(result.code).toBe(0); expect((await calls())[0]).toMatchObject({ hasAccessKey: true, hasSecretKey: true, hasSessionToken: false });
  });

  it("preserves legacy --build --region use when no profile or ambient identity is selected", async () => {
    await legacy(); await miss(); const result = await run(["--build", "--region", "us-west-2"]);
    expect(result.code).toBe(0); expect((await calls())[0]).toMatchObject({ profile: null, hasAccessKey: true, hasSecretKey: true, hasSessionToken: true });
    expect((await calls())[0].args).toEqual(expect.arrayContaining(["--region", "us-west-2"]));
  });

  it("preserves the previous index and suppresses raw AWS errors on expired credentials", async () => {
    await miss(); const result = await run(["--build", "--profile", "fixture-sso-profile", "--region", "us-west-2"], { FIXTURE_AWS_FAIL: "expired" });
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("ExpiredTokenException");
    expect(result.stderr).not.toContain("SYNTHETIC_SECRET_MUST_STAY_PRIVATE"); expect(await readFile(indexFile, "utf8")).toBe(originalIndex);
  });

  it.each([["--profile"], ["--profile", ""], ["--profile", "--region"], ["--profile", "bad\nprofile"], ["--region"], ["--region", "not-a-region"], ["--region", "us-west-2", "--region", "us-east-1"], ["--profile", "first", "--profile", "second"], ["--build", "--build"], ["--unknown"]])("rejects invalid CLI arguments %j without invoking AWS or changing the index", async (...args) => {
    const result = await run(args); expect(result.code).not.toBe(0); expect(await calls()).toEqual([]); expect(await readFile(indexFile, "utf8")).toBe(originalIndex);
  });
});
