import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Writing `Server/<name>_SandboxVars.lua` on disk.
 *
 * The parsing and validating is `sandbox-lua.test.ts`; this file covers only what needs
 * a filesystem. Three properties, each for a failure that has already cost this project
 * something on a different file:
 *
 * - **The previous file is kept as `.bak`.** The `.ini` has four `.bak-*` copies on the
 *   box and this file has none, so before this there was no way back from a bad sandbox
 *   edit short of restoring a whole-world backup.
 * - **The replacement preserves mode (and, in production, owner).** The game runs as uid
 *   1000 and rewrites this file itself on every startup; the web container is root. Hand
 *   it back a root-owned 0644 file and the server can no longer persist its own options —
 *   it logs `Unable to save options to filename` and keeps going. `chown` is not
 *   exercised here (the test does not run as root and the file is already the test
 *   user's), so mode is what is pinned; the owner restore is one line beside it.
 * - **The write is read back.** `updateSandbox` re-reads and re-parses after the rename
 *   and reports anything that does not match, instead of reporting success because the
 *   write call did not throw. "Reports success after doing nothing" is this project's
 *   documented defect class, and it is what three shipped settings bugs were.
 */

const FIXTURE = path.join(__dirname, "fixtures/pz-sandboxvars.lua");

/**
 * The read-back guard cannot be provoked honestly — the writer and the parser agree on
 * every value in the fixture, which is the round-trip property `sandbox-lua.test.ts`
 * pins. So the only way to see the guard work is to make the file on disk disagree with
 * what was written, which is a stand-in for the real cause: something else (the game's
 * own startup rewrite, a restore, a hand edit) touching the file in the same instant.
 */
const hooks = vi.hoisted(() => ({ decoy: null as null | { file: string; text: string } }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (hooks.decoy && to === hooks.decoy.file) {
        await actual.unlink(from).catch(() => {});
        await actual.writeFile(to, hooks.decoy.text, "utf-8");
        return;
      }
      return actual.rename(from, to);
    }),
  };
});

let dir: string;
let file: string;

async function load() {
  vi.resetModules();
  process.env.PZ_SERVER_DIR = dir;
  process.env.PZ_SERVER_NAME = "yoshling";
  return import("@/lib/zomboid-sandbox");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yoshling-sandbox-"));
  mkdirSync(path.join(dir, "Server"));
  file = path.join(dir, "Server", "yoshling_SandboxVars.lua");
  copyFileSync(FIXTURE, file);
});

afterEach(() => {
  hooks.decoy = null;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PZ_SERVER_DIR;
  delete process.env.PZ_SERVER_NAME;
});

describe("updateSandbox", () => {
  it("writes the value and reports it as applied", async () => {
    const { updateSandbox } = await load();
    const outcome = await updateSandbox({ "ZombieConfig.PopulationMultiplier": "1.2" });
    expect(outcome).toEqual({
      applied: ["ZombieConfig.PopulationMultiplier"],
      rejected: [],
      unlanded: [],
    });
    expect(readFileSync(file, "utf-8")).toContain("        PopulationMultiplier = 1.2,");
  });

  it("keeps the previous file as .bak", async () => {
    const before = readFileSync(file, "utf-8");
    const { updateSandbox } = await load();
    await updateSandbox({ FoodLootNew: "1.5" });
    expect(readFileSync(`${file}.bak`, "utf-8")).toBe(before);
    expect(readFileSync(file, "utf-8")).not.toBe(before);
  });

  it("leaves no temp file behind", async () => {
    const { updateSandbox } = await load();
    await updateSandbox({ FoodLootNew: "1.5" });
    expect(() => statSync(`${file}.tmp`)).toThrow();
  });

  it("preserves the file's mode, because the game has to rewrite it too", async () => {
    // Production is 1000:1000 664 and the game truncates it at every startup. A fresh
    // `writeFile` would give it 0644 minus umask and a root owner.
    const { chmodSync } = await import("node:fs");
    chmodSync(file, 0o664);
    const { updateSandbox } = await load();
    await updateSandbox({ FoodLootNew: "1.5" });
    expect(statSync(file).mode & 0o777).toBe(0o664);
  });

  it("writes nothing when a value is refused", async () => {
    const before = readFileSync(file, "utf-8");
    const { updateSandbox } = await load();
    const outcome = await updateSandbox({
      FoodLootNew: "1.5",
      "ZombieConfig.ZombiesCountBeforeDelete": "99999",
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected).toHaveLength(1);
    expect(readFileSync(file, "utf-8")).toBe(before);
    // And no backup either: nothing happened, so there is nothing to have a backup of.
    expect(() => statSync(`${file}.bak`)).toThrow();
  });

  it("reports an option that does not read back, instead of reporting success", async () => {
    // The read-back is the only thing standing between "the write call returned" and "the
    // setting is in the file".
    const { setSandboxValues } = await import("@/lib/sandbox-lua");
    hooks.decoy = {
      file,
      text: setSandboxValues(readFileSync(FIXTURE, "utf-8"), { FoodLootNew: "2.0" }).text,
    };
    const { updateSandbox } = await load();
    const outcome = await updateSandbox({ FoodLootNew: "1.5" });
    expect(outcome.applied).toEqual([]);
    expect(outcome.unlanded).toEqual([{ name: "FoodLootNew", wanted: "1.5", found: "2.0" }]);
  });

  it("reports the file being absent rather than creating one", async () => {
    // A SandboxVars.lua this app invented would be missing every option the installed
    // mods add, and the server would load it as the whole truth.
    rmSync(file);
    const { updateSandbox } = await load();
    await expect(updateSandbox({ FoodLootNew: "1.5" })).rejects.toThrow();
  });
});
