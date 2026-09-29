import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { patchServiceEnv, readServiceEnv } from "@/lib/compose";

/**
 * `patchServiceEnv` — the only sanctioned way the app edits `docker-compose.yml`.
 *
 * Two defects make this worth pinning. The settings route used to regenerate the whole
 * file from a two-service template, which silently deleted the `sevendtd` and `zomboid`
 * services and the volume declarations the web container mounts. And the keys repeat with
 * different meanings: `VERSION` is the Minecraft version in one block and the Steam branch
 * in another, so an unscoped rewrite of "VERSION" changes which game 7 Days to Die
 * downloads while you are editing Minecraft.
 *
 * The fixture is the repository's own `docker-compose.yml` rather than a copy, so the test
 * cannot drift away from the file it is protecting. It asserts structure, never line
 * counts, so editing compose does not break the suite.
 */
const COMPOSE = readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf-8");

/** Every `  <name>:` under `services:`, so the tests cannot silently stop covering one. */
const SERVICES = ["minecraft", "sevendtd", "zomboid", "web"];

function changedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return b.filter((line, i) => line !== a[i]);
}

describe("readServiceEnv is scoped to one service block", () => {
  it("reads the same key differently from two blocks", () => {
    // The trap, stated as an assertion: both services define `VERSION` and the two values
    // are not interchangeable.
    const mc = readServiceEnv(COMPOSE, "minecraft", "VERSION");
    const sdtd = readServiceEnv(COMPOSE, "sevendtd", "VERSION");
    expect(mc).toBeTruthy();
    expect(sdtd).toBeTruthy();
    expect(mc).not.toBe(sdtd);
    // A Minecraft version, not a Steam branch.
    expect(mc).toMatch(/^\d+\.\d+/);
    expect(sdtd).toMatch(/latest|stable/);
  });

  it("returns null for a key the named service does not have", () => {
    // 7 Days to Die is a Unity native server with no JVM, so it has no memory key at all.
    // The memory card explains that instead of offering a control that does nothing, and
    // this null is what it reads.
    expect(readServiceEnv(COMPOSE, "sevendtd", "MEMORY")).toBeNull();
    expect(readServiceEnv(COMPOSE, "sevendtd", "MAX_MEMORY")).toBeNull();
  });

  it("returns null for a service that is not there", () => {
    expect(readServiceEnv(COMPOSE, "nosuchservice", "VERSION")).toBeNull();
  });

  it("strips the surrounding quotes", () => {
    expect(readServiceEnv(COMPOSE, "minecraft", "TYPE")).toBe("FABRIC");
  });
});

describe("patchServiceEnv changes one line in one block", () => {
  it("patches Minecraft's VERSION and leaves 7 Days to Die's alone", () => {
    const sdtdBefore = readServiceEnv(COMPOSE, "sevendtd", "VERSION");
    const { text, applied } = patchServiceEnv(COMPOSE, "minecraft", { VERSION: "1.21.4" });

    expect(applied).toEqual(["VERSION"]);
    expect(changedLines(COMPOSE, text)).toEqual(['      VERSION: "1.21.4"']);
    expect(readServiceEnv(text, "minecraft", "VERSION")).toBe("1.21.4");
    // The whole point: the other block's VERSION means a Steam branch and must not move.
    expect(readServiceEnv(text, "sevendtd", "VERSION")).toBe(sdtdBefore);
  });

  it("patches 7 Days to Die's VERSION and leaves Minecraft's alone", () => {
    const mcBefore = readServiceEnv(COMPOSE, "minecraft", "VERSION");
    const { text, applied } = patchServiceEnv(COMPOSE, "sevendtd", { VERSION: "stable" });
    expect(applied).toEqual(["VERSION"]);
    expect(readServiceEnv(text, "sevendtd", "VERSION")).toBe("stable");
    expect(readServiceEnv(text, "minecraft", "VERSION")).toBe(mcBefore);
  });

  it("keeps every service and every volume declaration", () => {
    // The regression that deleted `sevendtd` and `zomboid` outright, along with the volumes
    // the web container mounts. Stated as: a patch may not remove anything.
    const { text } = patchServiceEnv(COMPOSE, "minecraft", { VERSION: "1.21.4" });
    for (const svc of SERVICES) {
      expect(text).toContain(`\n  ${svc}:`);
    }
    expect(text.split("\n").filter((l) => /^volumes:/.test(l))).toHaveLength(
      COMPOSE.split("\n").filter((l) => /^volumes:/.test(l)).length
    );
    for (const vol of ["mc-data", "web-data", "pz-data", "pz-workshop", "sdtd-server"]) {
      expect(text).toContain(vol);
    }
  });

  it("does not touch MIN_MEMORY when patching MAX_MEMORY", () => {
    // Project Zomboid's `RUNTIME` entry patches only `MAX_MEMORY`. Writing `-Xmx` under a
    // larger `-Xms` makes the JVM refuse to start, so the two values must move
    // independently and visibly.
    const minBefore = readServiceEnv(COMPOSE, "zomboid", "MIN_MEMORY");
    expect(minBefore).toBeTruthy();
    const { text, applied } = patchServiceEnv(COMPOSE, "zomboid", { MAX_MEMORY: "8192m" });
    expect(applied).toEqual(["MAX_MEMORY"]);
    expect(readServiceEnv(text, "zomboid", "MAX_MEMORY")).toBe("8192m");
    expect(readServiceEnv(text, "zomboid", "MIN_MEMORY")).toBe(minBefore);
  });

  it("a MEMORY patch does not match MIN_MEMORY or MAX_MEMORY by suffix", () => {
    // `MEMORY` is Minecraft's key and `MAX_MEMORY` is Project Zomboid's. If the key match
    // were unanchored, changing one world's heap would silently change the other's.
    const { text, applied } = patchServiceEnv(COMPOSE, "zomboid", { MEMORY: "1G" });
    expect(applied).toEqual([]);
    expect(text).toBe(COMPOSE);
  });

  it("applies several keys in one pass and reports each", () => {
    const { text, applied } = patchServiceEnv(COMPOSE, "minecraft", {
      TYPE: "VANILLA",
      VERSION: "1.21.4",
    });
    expect(applied.sort()).toEqual(["TYPE", "VERSION"]);
    expect(changedLines(COMPOSE, text)).toHaveLength(2);
    expect(readServiceEnv(text, "minecraft", "TYPE")).toBe("VANILLA");
  });

  it("reports nothing applied for a key the block does not contain, and changes nothing", () => {
    // `applied` is how a caller learns the write did not land. Silently succeeding here is
    // the "reports success after doing nothing" defect at its smallest.
    const { text, applied } = patchServiceEnv(COMPOSE, "sevendtd", { MEMORY: "8G" });
    expect(applied).toEqual([]);
    expect(text).toBe(COMPOSE);
  });

  it("is a no-op for an unknown service", () => {
    const { text, applied } = patchServiceEnv(COMPOSE, "nosuchservice", { VERSION: "9" });
    expect(applied).toEqual([]);
    expect(text).toBe(COMPOSE);
  });

  it("always quotes the value it writes", () => {
    // `VERSION: 1.21` unquoted is a YAML float and reaches the container as "1.21"; worse,
    // `26.10` becomes `26.1`. Quoting is not cosmetic.
    const { text } = patchServiceEnv(COMPOSE, "minecraft", { VERSION: "1.21" });
    expect(text).toContain('VERSION: "1.21"');
  });

  it("patches a block without reaching past its end", () => {
    // Block boundaries are found by indentation. A synthetic file makes the boundary the
    // subject rather than a side effect of the real file's layout.
    const yaml = [
      "services:",
      "  alpha:",
      "    environment:",
      '      KEY: "a"',
      "  beta:",
      "    environment:",
      '      KEY: "b"',
      "volumes:",
      "  data:",
    ].join("\n");
    const { text, applied } = patchServiceEnv(yaml, "alpha", { KEY: "patched" });
    expect(applied).toEqual(["KEY"]);
    expect(readServiceEnv(text, "alpha", "KEY")).toBe("patched");
    expect(readServiceEnv(text, "beta", "KEY")).toBe("b");
    expect(text).toContain("volumes:");
  });
});
