import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { activeModJars, verifyModReplacement } from "@/lib/mc-mod-replacement";

let root = "";
let mods = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yoshling-replacement-"));
  mods = path.join(root, "mods");
  await mkdir(mods);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const expected = { name: "Fixture", file: { filename: "fixture.jar", url: "https://local.invalid/jar", primary: true, size: 4,
  hashes: { sha512: createHash("sha512").update("good").digest("hex") } } };

describe("actual mod replacement directory/digests", () => {
  it("compares the actual requested bytes and leaves inactive files out of the jar set", async () => {
    await writeFile(path.join(mods, "fixture.jar"), "good");
    await writeFile(path.join(mods, "old.jar.disabled"), "inactive");
    expect(await activeModJars(mods, root)).toEqual(["fixture.jar"]);
    expect(await verifyModReplacement(mods, root, [expected])).toEqual([]);
  });
  it("refuses a same-length changed jar and an unrequested active jar", async () => {
    await writeFile(path.join(mods, "fixture.jar"), "evil");
    await writeFile(path.join(mods, "untracked.jar"), "extra");
    const errors = await verifyModReplacement(mods, root, [expected]);
    expect(errors).toContain("Fixture: actual jar readback did not match its download");
    expect(errors.some(error => error.includes("untracked.jar"))).toBe(true);
  });
  it("refuses a jar alias outside its configured volume", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "yoshling-outside-jar-"));
    try {
      await writeFile(path.join(outside, "fixture.jar"), "good");
      await symlink(path.join(outside, "fixture.jar"), path.join(mods, "fixture.jar"));
      await expect(activeModJars(mods, root)).rejects.toThrow("outside");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
