import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function guard(options: { text?: string; seed?: string; legacySeed?: string; broken?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yoshling-invite-deploy-"));
  roots.push(root);
  const file = path.join(root, "whitelist.json");
  if (options.text !== undefined) await writeFile(file, options.text);
  if (options.broken) await symlink(path.join(root, "missing.json"), file);
  const source = await readFile(path.resolve(__dirname, "../../../scripts/deploy.sh"), "utf8");
  const fn = source.match(/assert_app_invites_ready\(\) \{[\s\S]*?\n\}/)?.[0];
  if (!fn) throw new Error("invitation preflight missing");
  const script = path.join(root, "guard.sh");
  await writeFile(script, `set -e\n${fn}\nassert_app_invites_ready\n`);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // The actual deploy function runs its actual Node validator, not a successful fake.
  await writeFile(path.join(bin, "docker"), '#!/usr/bin/env bash\nargs=("$@")\nexec "$TEST_NODE" "${args[${#args[@]}-2]}" "${args[${#args[@]}-1]}"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_NODE: process.execPath, WHITELIST_FILE: file,
    ALLOWED_DISCORD_IDS: options.seed ?? "", ALLOWED_DISCORD_USERS: options.legacySeed ?? "" };
  if (options.legacySeed !== undefined && options.seed === undefined) delete (env as Partial<typeof env>).ALLOWED_DISCORD_IDS;
  return run("bash", [script], { env });
}

describe("web deploy validates immutable invitation policy first", () => {
  it.each(['["9007199254740993"]', "[]"])("allows exact ID or deliberately open policy %s", async text => {
    expect((await guard({ text })).stdout).toContain("format verified");
  });
  it.each(['["display-name"]', '[9007199254740993]', "{broken", "{}"])("refuses unusable current policy %s", async text => {
    await expect(guard({ text, seed: "9007199254740993" })).rejects.toMatchObject({ code: 1 });
  });
  it("uses new effective env seed only for true absence and refuses a broken link", async () => {
    expect((await guard({ seed: "9007199254740993" })).stdout).toContain("format verified");
    await expect(guard({ broken: true, seed: "9007199254740993" })).rejects.toMatchObject({ code: 1 });
    await expect(guard({ legacySeed: "old-name" })).rejects.toMatchObject({ code: 1 });
  });
  it("calls web policy preflight before any forced checkout or build", async () => {
    const source = await readFile(path.resolve(__dirname, "../../../scripts/deploy.sh"), "utf8");
    const call = source.indexOf("web) assert_app_invites_ready");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(source.indexOf("git checkout -f -q -B main"));
    expect(call).toBeLessThan(source.indexOf('docker compose build "$SERVICE"'));
  });
});
