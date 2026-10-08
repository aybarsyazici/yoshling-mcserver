import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { offlineUuid, isValidMcName, isValidUuid } from "../mc-identity";
const active = vi.hoisted(() => ({ root: "/minecraft" }));
vi.mock("../minecraft-profile-store", () => ({ getMinecraftDataRoot: async () => active.root }));

/**
 * Explicit captured roots exercise real profile files without a database or a live
 * server. The default resolver is tested separately across a profile switch.
 */
async function withMcDir(dir: string) {
  const mod = await import("../mc-identity");
  return { ...mod, readOnlineMode: () => mod.readOnlineMode(dir),
    resolveEntryUuids: <T extends { uuid: string; name: string }>(entries: T[]) => mod.resolveEntryUuids(entries, dir) };
}

/**
 * The oracle for these vectors is **the game**, not this implementation.
 *
 * `LinnMarie` and `Yoshiane` are the two real operators in the live `ops.json` on the
 * box, and that file was last rewritten by Minecraft itself (the game rewrites it at
 * shutdown, which is how the dashboard's blank-UUID entries were discovered to have
 * been silently dropped). The ids below were read off that file before this code
 * existed, so a test failure here means we no longer agree with what the server
 * derives — which is exactly the bug this module fixes.
 *
 * `Notch` and `jeb_` are the widely-published offline ids for the same algorithm,
 * kept as a second, independent source.
 */
describe("offlineUuid", () => {
  it("matches the UUIDs Minecraft itself wrote into the live ops.json", () => {
    expect(offlineUuid("LinnMarie")).toBe("cec627a9-5bfb-3db1-82de-b433dc37d3c3");
    expect(offlineUuid("Yoshiane")).toBe("607f15d3-e93b-303f-93af-6d1024a4d992");
  });

  it("matches known published offline ids", () => {
    expect(offlineUuid("Notch")).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
    expect(offlineUuid("jeb_")).toBe("a762f560-4fce-3236-812a-b80efff0b62b");
  });

  it("stamps version 3 and the RFC 4122 variant on every name", () => {
    // Skipping the two bit-fiddles yields a raw MD5 digest that *looks* like a UUID
    // and that the game will not match, so assert the nibbles rather than trusting
    // the four vectors above to have caught it.
    for (const name of ["a", "Steve", "zzzz_probe", "ABCDEFGHIJKLMNOP", "jeb_", "Notch"]) {
      const id = offlineUuid(name);
      expect(isValidUuid(id)).toBe(true);
      expect(id[14]).toBe("3");
      expect("89ab").toContain(id[19]);
    }
  });

  it("is stable and distinct per name", () => {
    expect(offlineUuid("Steve")).toBe(offlineUuid("Steve"));
    expect(offlineUuid("Steve")).not.toBe(offlineUuid("steve"));
  });
});

describe("isValidMcName", () => {
  it("rejects the inputs that would silently write a useless entry", () => {
    expect(isValidMcName("")).toBe(false);
    expect(isValidMcName("a".repeat(17))).toBe(false);
    expect(isValidMcName("a b")).toBe(false);
    expect(isValidMcName("a-b")).toBe(false);
  });

  it("accepts real Java usernames", () => {
    expect(isValidMcName("Notch")).toBe(true);
    expect(isValidMcName("jeb_")).toBe(true);
    expect(isValidMcName("a".repeat(16))).toBe(true);
  });
});

describe("isValidUuid", () => {
  it("accepts the dashed form both json files use", () => {
    expect(isValidUuid("cec627a9-5bfb-3db1-82de-b433dc37d3c3")).toBe(true);
  });

  it("rejects the blank and undashed forms that caused the bug", () => {
    // `""` is precisely what the settings page used to send for every new entry.
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid("cec627a95bfb3db182deb433dc37d3c3")).toBe(false);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("zec627a9-5bfb-3db1-82de-b433dc37d3c3")).toBe(false);
  });
});

describe("readOnlineMode / resolveEntryUuids, against a real properties file", () => {
  it("reads the current profile's identity mode after switching profiles", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "mc-identity-profile-a-"));
    const b = await mkdtemp(path.join(tmpdir(), "mc-identity-profile-b-"));
    await writeFile(path.join(a, "server.properties"), "online-mode=false\n");
    await writeFile(path.join(b, "server.properties"), "online-mode=true\n");
    const mod = await import("../mc-identity");
    active.root = a; expect(await mod.readOnlineMode()).toBe(false);
    active.root = b; expect(await mod.readOnlineMode()).toBe(true);
  });
  it("reads online-mode off disk and resolves a blank uuid offline", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-identity-"));
    // The live server's own values, so this exercises the branch production takes.
    await writeFile(path.join(dir, "server.properties"), "online-mode=false\nwhite-list=false\n");
    const mod = await withMcDir(dir);

    expect(await mod.readOnlineMode()).toBe(false);

    const r = await mod.resolveEntryUuids([{ uuid: "", name: "LinnMarie" }]);
    expect(r.ok).toBe(true);
    // The whole point: what goes to disk is the id the game derives, not `""`.
    if (r.ok) expect(r.entries[0].uuid).toBe("cec627a9-5bfb-3db1-82de-b433dc37d3c3");
  });

  it("leaves an already-valid uuid untouched", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-identity-"));
    await writeFile(path.join(dir, "server.properties"), "online-mode=false\n");
    const mod = await withMcDir(dir);

    // The two real operators must keep the ids Minecraft wrote for them, even if a
    // future name resolution would produce something else.
    const r = await mod.resolveEntryUuids([
      { uuid: "607f15d3-e93b-303f-93af-6d1024a4d992", name: "Yoshiane" },
      { uuid: "", name: "LinnMarie" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries[0].uuid).toBe("607f15d3-e93b-303f-93af-6d1024a4d992");
      expect(r.entries[1].uuid).toBe("cec627a9-5bfb-3db1-82de-b433dc37d3c3");
    }
  });

  it("defaults to online-mode=true when server.properties is unreadable", async () => {
    // Minecraft's own default. Guessing offline instead would mint offline ids for a
    // licensed server — the same silent-discard bug with the sign flipped.
    const mod = await withMcDir(path.join(tmpdir(), "mc-identity-does-not-exist"));
    expect(await mod.readOnlineMode()).toBe(true);
  });
});
