import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";

let root = "";
let applied = "";
let fails = false;
let manager: typeof import("@/lib/game-manager");
let reset: () => void;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yoshling-mc-target-"));
  const compose = path.join(root, "docker-compose.yml");
  await writeFile(compose, 'services:\n  minecraft:\n    environment:\n      VERSION: "${MC_VERSION}"\n      TYPE: "${MC_TYPE}"\n');
  // Public, non-sensitive temporary settings only; no workspace environment is read.
  await writeFile(path.join(root, ".env"), "MC_VERSION=26.1.2\nMC_TYPE=FABRIC\n");
  vi.stubEnv("COMPOSE_FILE", compose);
  vi.resetModules();
  manager = await import("@/lib/game-manager");
  const runner = await import("@/lib/docker-cli");
  reset = runner.resetCommandRunner;
  applied = "VERSION=26.1.2\nTYPE=FABRIC\n"; fails = false;
  runner.setCommandRunner(async command => {
    if (!command.startsWith("docker inspect")) throw new Error("Unexpected fixture control call");
    if (fails) throw new Error("Fixture inspection unavailable");
    return { stdout: applied, stderr: "" };
  });
});
afterEach(async () => { reset(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("verified Minecraft target authority", () => {
  it("returns only configured and created-container values that agree", async () => {
    expect(await manager.getMinecraftTarget()).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
  });
  it.each(["version", "loader", "missing", "inspection"])("refuses %s drift or unknown evidence", async kind => {
    if (kind === "version") applied = "VERSION=1.21.4\nTYPE=FABRIC\n";
    if (kind === "loader") applied = "VERSION=26.1.2\nTYPE=FORGE\n";
    if (kind === "missing") applied = "TYPE=FABRIC\n";
    if (kind === "inspection") fails = true;
    await expect(manager.getMinecraftTarget()).rejects.toThrow("unknown or differs");
  });
  it("runs final restore admission before either downtime or the file callback", async () => {
    const callback = vi.fn(async () => {});
    await expect(manager.withGameStopped("minecraft", "restart", callback, {
      kind: "backup.restore", restartOnFailure: false,
      beforeStop: async () => { throw new Error("fixture target changed"); },
    })).rejects.toThrow("fixture target changed");
    expect(callback).not.toHaveBeenCalled();
  });
});
