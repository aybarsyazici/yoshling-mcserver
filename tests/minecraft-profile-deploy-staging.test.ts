import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const run = promisify(execFile);
let root: string;
let script: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "minecraft stage fixture ")); script = await readFile(path.resolve("scripts/deploy.sh"), "utf8"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function scan(name: "minecraft_profile_staging_paths" | "minecraft_profile_operation_paths" | "backup_staging_paths", volume: string) {
  const start = script.indexOf(`${name}() {`); const end = script.indexOf("\n}\n", start) + 3;
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const body = script.slice(start, end);
  const { stdout } = await run("bash", ["-c", `set -e\n${body}\n${name} "$1"`, "fixture", volume]);
  return stdout.trim().split("\n").filter(Boolean).sort();
}

describe("deployment discovers profile operations and every backup staging namespace", () => {
  it("detects durable lifecycle files and source/prepare/checkpoint/delete directories without reading their contents", async () => {
    const mc = path.join(root, "mc"); await mkdir(path.join(mc, "profiles/id/checkpoints"), { recursive: true });
    const names = ["profiles/.source-build", "profiles/id/.prepare-build", "profiles/id/checkpoints/.staging-copy", "profiles/.delete-old"];
    for (const name of names) await mkdir(path.join(mc, name));
    const marker = path.join(mc, "profiles/.operation-switch-id.json"); await writeFile(marker, "fixture content must never be printed");
    await mkdir(path.join(mc, "profiles/id/server/.prepare-normal-game-folder"), { recursive: true });
    expect(await scan("minecraft_profile_staging_paths", mc)).toEqual([...names.map(name => path.join(mc, name)), marker].sort());
  });

  it("detects legacy Minecraft, profile Minecraft and other-game backup work", async () => {
    const web = path.join(root, "web"); await mkdir(web);
    const names = ["backups/.work-legacy", "backups/profiles/id/.work-profile", "backups-zomboid/.work-world", "backups-7dtd/.work-world"];
    for (const name of names) await mkdir(path.join(web, name), { recursive: true });
    expect(await scan("backup_staging_paths", web)).toEqual(names.map(name => path.join(web, name)).sort());
  });

  it("detects private durable lifecycle markers in the persistent web volume", async () => {
    const web = path.join(root, "web"); const operations = path.join(web, "minecraft-profile-operations"); await mkdir(operations, { recursive: true });
    const marker = path.join(operations, ".operation-adopt-uuid.json"); await writeFile(marker, "private content must not be printed");
    expect(await scan("minecraft_profile_operation_paths", web)).toEqual([marker]);
  });

  it("does not treat published checkpoints or prepared server folders as active staging", async () => {
    const mc = path.join(root, "mc"); await mkdir(path.join(mc, "profiles/id/server"), { recursive: true });
    await mkdir(path.join(mc, "profiles/id/checkpoints/1720000000000-published/server"), { recursive: true });
    expect(await scan("minecraft_profile_staging_paths", mc)).toEqual([]);
  });

  it("reports aliased profile metadata as unverified without following the alias", async () => {
    const mc = path.join(root, "mc"); await mkdir(mc); await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(mc, "profiles"));
    expect(await scan("minecraft_profile_staging_paths", mc)).toEqual([path.join(mc, "profiles")]);
  });

  it("refuses unknown missing volume roots rather than declaring staging absent", async () => {
    await expect(scan("minecraft_profile_staging_paths", path.join(root, "absent"))).rejects.toThrow();
    await expect(scan("backup_staging_paths", path.join(root, "absent"))).rejects.toThrow();
  });

  it("keeps both pre-checkout and pre-replacement calls and the reviewed interruption override", () => {
    expect(script.match(/^assert_no_background_work$/gm)).toHaveLength(1);
    expect(script).toContain("  assert_no_background_work\n  # --no-deps");
    expect(script).toContain('[ "${FORCE_OPS:-0}" = "1" ] || return 1');
    expect(script).toContain("' < /dev/null");
  });
});
