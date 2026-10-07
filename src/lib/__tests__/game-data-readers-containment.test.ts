import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// These are disk readers. Any accidental control/network call fails locally.
vi.mock("@/lib/docker-cli", () => ({ runCommand: async () => { throw new Error("unexpected Docker call"); } }));
vi.mock("@/lib/rcon", () => ({
  sendCommand: async () => { throw new Error("unexpected RCON call"); },
  rconCommand: async () => { throw new Error("unexpected RCON call"); },
}));
vi.mock("@/lib/rcon-long", () => ({ rconCommandLong: async () => { throw new Error("unexpected RCON call"); } }));

let root = "";
let game = "";
let outside = "";
beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(path.join(tmpdir(), "yoshling-property-reader-"));
  game = path.join(root, "game");
  outside = path.join(root, "outside.txt");
  await mkdir(game);
  vi.stubEnv("MC_SERVER_DIR", game);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("shared Minecraft properties readers", () => {
  it("reads a contained alias through the manager and identity helpers", async () => {
    await writeFile(path.join(game, "contained.txt"), "online-mode=false\nmotd=contained fixture\n");
    await symlink("contained.txt", path.join(game, "server.properties"));
    const manager = await import("@/lib/game-manager");
    const identity = await import("@/lib/mc-identity");
    expect(await manager.getMinecraftProperties()).toEqual({ "online-mode": "false", motd: "contained fixture" });
    expect(await identity.readOnlineMode()).toBe(false);
  });

  it("refuses an external properties alias and preserves identity's unreadable-file default", async () => {
    await writeFile(outside, "online-mode=false\nmotd=outside fixture\n");
    await symlink(outside, path.join(game, "server.properties"));
    const manager = await import("@/lib/game-manager");
    const identity = await import("@/lib/mc-identity");
    await expect(manager.getMinecraftProperties()).rejects.toThrow("outside the configured game volume");
    expect(await identity.readOnlineMode()).toBe(true);
    expect(await readFile(outside, "utf-8")).toBe("online-mode=false\nmotd=outside fixture\n");
  });
});
