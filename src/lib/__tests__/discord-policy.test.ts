import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discordIdList, discordUserId } from "@/lib/discord-identity";

const io = vi.hoisted(() => ({ mismatch: false, file: "" }));
vi.mock("fs/promises", async original => {
  const actual = await original<typeof import("fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (io.mismatch && String(args[0]) === io.file) return typeof args[1] === "string" ? "mismatched fixture" : Buffer.from("mismatched fixture");
    return actual.readFile(...args);
  } };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (io.mismatch && String(args[0]) === io.file) return typeof args[1] === "string" ? "mismatched fixture" : Buffer.from("mismatched fixture");
    return actual.readFile(...args);
  } };
});

const FIRST = "9007199254740992";
const SECOND = "9007199254740993";
let root = "";
beforeEach(async () => {
  vi.resetModules();
  io.mismatch = false;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "yoshling-discord-policy-")));
  io.file = path.join(root, "whitelist.json");
  vi.stubEnv("WHITELIST_FILE", io.file);
  vi.stubEnv("ALLOWED_DISCORD_IDS", FIRST);
  vi.stubEnv("ALLOWED_DISCORD_USERS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  io.mismatch = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("immutable Discord string identity", () => {
  it("keeps adjacent IDs beyond Number's precision distinct", () => {
    expect(Number(FIRST)).toBe(Number(SECOND));
    expect(discordUserId(FIRST)).toBe(FIRST);
    expect(discordUserId(SECOND)).toBe(SECOND);
    expect(discordIdList([FIRST, SECOND, ` ${FIRST} `])).toEqual([FIRST, SECOND]);
  });
  it("accepts the uint64 maximum and refuses overflow", () => {
    expect(discordUserId("18446744073709551615")).toBe("18446744073709551615");
    expect(discordUserId("18446744073709551616")).toBeNull();
  });
  it.each([null, undefined, 1234, Number(SECOND), {}, [], "", "0", "01", "-1", "1e18", "VictimName", "123.4"].map(value => ({ value })))("refuses noncanonical identity $value", ({ value }) => {
    expect(discordUserId(value)).toBeNull();
  });
  it.each([null, {}, FIRST, [FIRST, SECOND, "VictimName"], [Number(SECOND)]].map(value => ({ value })))("refuses partial or non-string invitation lists $value", ({ value }) => {
    expect(discordIdList(value)).toBeNull();
  });
});

describe("the sign-in policy distinguishes deliberate empty from unknown", () => {
  it("uses a valid ID env seed only when the policy file is absent", async () => {
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toEqual({ users: [FIRST], source: "env" });
    expect(await policy.isWhitelisted(FIRST)).toBe(true);
    expect(await policy.isWhitelisted(SECOND)).toBe(false);
  });
  it("reads exact file IDs, ignores broader env seed, and refuses display names", async () => {
    await writeFile(io.file, JSON.stringify([SECOND]));
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toEqual({ users: [SECOND], source: "file" });
    expect(await policy.isWhitelisted(SECOND)).toBe(true);
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
    expect(await policy.isWhitelisted("VictimName")).toBe(false);
    expect(await policy.isWhitelisted(Number(SECOND))).toBe(false);
  });
  it("keeps a deliberately empty policy open only to valid Discord identities", async () => {
    await writeFile(io.file, "[]");
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toEqual({ users: [], source: "file" });
    expect(await policy.isWhitelisted(SECOND)).toBe(true);
    expect(await policy.isWhitelisted("VictimName")).toBe(false);
  });
  it.each(["invalid fixture", '"empty"', "null", "{}", `[${SECOND}]`, '["VictimName"]', `['${FIRST}']`])("refuses malformed or legacy policy contents %s without falling back", async contents => {
    await writeFile(io.file, contents);
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toMatchObject({ users: [], source: "file", error: expect.any(String) });
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
  });
  it("fails closed on an actual file read error", async () => {
    await mkdir(io.file);
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toMatchObject({ users: [], source: "file", error: expect.stringMatching(/could not be read/) });
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
  });
  it("refuses an existing dangling policy link instead of treating it as first install", async () => {
    await symlink(path.join(root, "missing-policy.json"), io.file);
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toMatchObject({ users: [], source: "file", error: expect.any(String) });
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
  });
  it("refuses a dangling configured parent instead of treating it as first install", async () => {
    const parent = path.join(root, "policy-parent");
    await symlink(path.join(root, "missing-parent"), parent);
    vi.stubEnv("WHITELIST_FILE", path.join(parent, "whitelist.json"));
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toMatchObject({ users: [], source: "file", error: expect.any(String) });
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
  });
  it("fails closed for a legacy name seed but accepts deliberate fresh-install empty", async () => {
    vi.stubEnv("ALLOWED_DISCORD_IDS", "VictimName");
    const policy = await import("@/lib/whitelist");
    expect(await policy.readWhitelist()).toMatchObject({ source: "env", error: expect.any(String) });
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
    vi.stubEnv("ALLOWED_DISCORD_IDS", "");
    expect(await policy.readWhitelist()).toEqual({ users: [], source: "env" });
    expect(await policy.isWhitelisted(FIRST)).toBe(true);
  });
  it("does not echo content from an invalid policy path", async () => {
    const sensitiveFixture = "FABRICATED_AUTH_SECRET=must-not-be-in-errors";
    await writeFile(io.file, sensitiveFixture);
    const policy = await import("@/lib/whitelist");
    const read = await policy.readWhitelist();
    expect(JSON.stringify(read)).not.toContain(sensitiveFixture);
    expect(await policy.isWhitelisted(FIRST)).toBe(false);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(sensitiveFixture);
  });
  it("atomically saves normalized IDs with private mode, verifies bytes, and removes staging", async () => {
    const policy = await import("@/lib/whitelist");
    await policy.saveWhitelist([FIRST, ` ${SECOND} `, FIRST]);
    expect(JSON.parse(await readFile(io.file, "utf-8"))).toEqual([FIRST, SECOND]);
    expect((await stat(io.file)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["whitelist.json"]);
    expect(await policy.readWhitelist()).toEqual({ users: [FIRST, SECOND], source: "file" });
  });
  it("refuses invalid saves before replacing the real policy", async () => {
    await writeFile(io.file, JSON.stringify([FIRST]));
    const policy = await import("@/lib/whitelist");
    await expect(policy.saveWhitelist(["VictimName"])).rejects.toThrow(/Discord user ID/);
    expect(JSON.parse(await readFile(io.file, "utf-8"))).toEqual([FIRST]);
    expect(await readdir(root)).toEqual(["whitelist.json"]);
  });
  it("throws if publication cannot be read back and still removes its temporary file", async () => {
    const policy = await import("@/lib/whitelist");
    io.mismatch = true;
    await expect(policy.saveWhitelist([FIRST])).rejects.toThrow(/could not be verified/);
    io.mismatch = false;
    expect(JSON.parse(await readFile(io.file, "utf-8"))).toEqual([FIRST]);
    expect(await readdir(root)).toEqual(["whitelist.json"]);
  });
});
