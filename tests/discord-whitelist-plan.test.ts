import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { planDiscordWhitelist } from "../scripts/plan-discord-whitelist.mjs";

const run = promisify(execFile);
const roots: string[] = [];
const known = [{ username: "Owner", discordId: "9007199254740993" }];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("reviewable Discord ID migration", () => {
  it("keeps explicit precision and suggests only unique stored username matches", () => {
    expect(planDiscordWhitelist(["9007199254740992", "owner"], known)).toMatchObject({
      complete: true, users: ["9007199254740992", "9007199254740993"], unresolved: [],
    });
  });

  it("refuses ambiguous names, global display labels and missing identities", () => {
    const result = planDiscordWhitelist(["owner", "Unstored display", "new-friend"],
      [...known, { username: "Owner", discordId: "9007199254740994" }]);
    expect(result.complete).toBe(false);
    expect(result.users).toEqual([]);
    expect(result.unresolved).toHaveLength(3);
  });

  it("deduplicates exact IDs while preserving deliberately open empty policy", () => {
    expect(planDiscordWhitelist(["9007199254740993", "Owner"], known).users).toEqual(["9007199254740993"]);
    expect(planDiscordWhitelist([], known)).toMatchObject({ complete: true, users: [] });
  });

  it.each([null, {}, [9007199254740993], [""], [" "]])("rejects unusable source values %j", value => {
    expect(() => planDiscordWhitelist(value, known)).toThrow();
  });

  async function fixture(entries: string[]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "yoshling-invite-plan-"));
    roots.push(root);
    const source = path.join(root, "old.json");
    const database = path.join(root, "users.db");
    await writeFile(source, JSON.stringify(entries));
    const client = createClient({ url: `file:${database}` });
    await client.execute('CREATE TABLE "User" ("discordId" TEXT, "username" TEXT)');
    await client.execute({ sql: 'INSERT INTO "User" VALUES (?, ?)', args: [known[0].discordId, known[0].username] });
    client.close();
    return { root, source, database, output: path.join(root, "candidate.json") };
  }

  it("executes read-only DB planning and writes/readbacks a separate private candidate", async () => {
    const f = await fixture(["Owner"]);
    const before = await readFile(f.source, "utf8");
    const output = await run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${f.database}`, "--output", f.output]);
    expect(JSON.parse(output.stdout)).toMatchObject({ complete: true, users: [known[0].discordId] });
    expect(JSON.parse(await readFile(f.output, "utf8"))).toEqual([known[0].discordId]);
    expect((await stat(f.output)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.source, "utf8")).toBe(before);
  });

  it("exits nonzero without a shortened candidate when a name is unresolved", async () => {
    const f = await fixture(["Owner", "Unknown"]);
    await expect(run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${f.database}`, "--output", f.output])).rejects.toMatchObject({ code: 2 });
    expect(await stat(f.output).catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(f.source, "utf8"))).toEqual(["Owner", "Unknown"]);
  });

  it("cannot overwrite the source or silently create a missing database", async () => {
    const f = await fixture(["Owner"]);
    await expect(run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${f.database}`, "--output", f.source])).rejects.toBeTruthy();
    const missing = path.join(f.root, "missing.db");
    await expect(run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${missing}`])).rejects.toBeTruthy();
    expect(await stat(missing).catch(() => null)).toBeNull();
  });

  it("refuses an existing candidate and leaves its contents untouched", async () => {
    const f = await fixture(["Owner"]);
    await writeFile(f.output, "existing reviewed candidate");
    await expect(run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${f.database}`, "--output", f.output])).rejects.toBeTruthy();
    expect(await readFile(f.output, "utf8")).toBe("existing reviewed candidate");
  });

  it("does not echo malformed source contents through parser errors", async () => {
    const f = await fixture(["Owner"]);
    await writeFile(f.source, "FAKE_PRIVATE_DATA");
    try {
      await run(process.execPath, ["scripts/plan-discord-whitelist.mjs", "--file", f.source, "--database", `file:${f.database}`]);
      throw new Error("planning should refuse malformed input");
    } catch (e) {
      const failure = e as Error & { stderr?: string; code?: number };
      expect(failure.code).toBe(1);
      expect(failure.stderr).not.toContain("FAKE");
      expect(await readFile(f.source, "utf8")).toBe("FAKE_PRIVATE_DATA");
    }
  });
});
