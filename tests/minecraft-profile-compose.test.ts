import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "minecraft-profile-compose-"));
  await writeFile(path.join(root, "docker-compose.yml"), await readFile(path.resolve("docker-compose.yml"), "utf8"));
  await writeFile(path.join(root, ".env"), "UNRELATED_FIXTURE=value-to-preserve\nMC_MEMORY=4G\n", { mode: 0o600 });
  vi.stubEnv("COMPOSE_FILE", path.join(root, "docker-compose.yml"));
  vi.stubEnv("COMPOSE_ENV_FILE", path.join(root, ".env"));
  vi.resetModules();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.resetModules(); await rm(root, { recursive: true, force: true }); });
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("profile Compose selectors are explicit and read back", () => {
  it("preserves the legacy volume root and floating image until adoption", async () => {
    const { readMinecraftProfileComposeSettings } = await import("@/lib/compose");
    expect(await readMinecraftProfileComposeSettings()).toMatchObject({ subpath: ".", javaVariant: "latest", propertiesOverride: "true" });
  });

  it("writes the exact profile target, preserves shared values and clears unrelated loader pins", async () => {
    const { minecraftProfileComposeSettings, readMinecraftProfileComposeSettings, writeMinecraftProfileComposeSettings } = await import("@/lib/compose");
    const wanted = minecraftProfileComposeSettings(id, { mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", javaVariant: "java21" });
    await writeMinecraftProfileComposeSettings(wanted);
    expect(await readMinecraftProfileComposeSettings()).toEqual(wanted);
    const bytes = await readFile(path.join(root, ".env"), "utf8");
    expect(bytes).toContain("UNRELATED_FIXTURE=value-to-preserve\nMC_MEMORY=4G\n");
    expect(bytes).toContain(`MC_PROFILE_SUBPATH=profiles/${id}/server`);
    expect(bytes).toContain("MC_FORGE_VERSION=\n");
    expect(bytes).toContain("MC_PROFILE_PROPERTIES_OVERRIDE=false");
    expect(await readFile(path.join(root, "docker-compose.yml"), "utf8")).toBe(await readFile(path.resolve("docker-compose.yml"), "utf8"));
  });

  it("refuses selector writes when Compose no longer resolves the UI-owned key", async () => {
    const { minecraftProfileComposeSettings, writeMinecraftProfileComposeSettings } = await import("@/lib/compose");
    const file = path.join(root, "docker-compose.yml");
    await writeFile(file, (await readFile(file, "utf8")).replace('${MC_PROFILE_SUBPATH:-.}', "."));
    await expect(writeMinecraftProfileComposeSettings(minecraftProfileComposeSettings(id,
      { mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, javaVariant: "java21" }))).rejects.toThrow(/did not resolve/);
  });

  it.each(["latest", "LATEST", "snapshot", "release", "recommended"])("refuses floating game version %s", async mcVersion => {
    const { minecraftProfileComposeSettings } = await import("@/lib/compose");
    expect(() => minecraftProfileComposeSettings(id, { mcVersion, loader: "vanilla", loaderVersion: null, javaVariant: "java21" })).toThrow(/concrete version/);
  });

  it.each([null, "LATEST", "recommended"])("refuses missing or floating mod-loader build %s", async loaderVersion => {
    const { minecraftProfileComposeSettings } = await import("@/lib/compose");
    expect(() => minecraftProfileComposeSettings(id, { mcVersion: "1.21.1", loader: "fabric", loaderVersion, javaVariant: "java21" })).toThrow(/exact loader/);
  });

  it("refuses display names and traversal as mount identities", async () => {
    const { minecraftProfileComposeSettings } = await import("@/lib/compose");
    for (const value of ["friend-world", "../other-profile", `${id}/../other`]) {
      expect(() => minecraftProfileComposeSettings(value, { mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, javaVariant: "java21" })).toThrow(/mount selector/);
    }
  });
});
