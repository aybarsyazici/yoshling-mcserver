import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minecraftProfileComposeSettings, type MinecraftProfileComposeSettings } from "@/lib/compose";
import {
  inspectMinecraftProfileContainer, minecraftProfileContainerAgrees, prepareMinecraftProfileImage,
  recreateMinecraftProfileForOperation, type MinecraftProfileContainerIdentity,
} from "@/lib/game-manager";
import { resetCommandRunner, setCommandRunner } from "@/lib/docker-cli";
import { runOperation } from "@/lib/operations";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let settings: MinecraftProfileComposeSettings;
let identity: MinecraftProfileContainerIdentity;
let commands: string[];
let extraDataMount: boolean;
let imageMissing: boolean;
let corruptImageReadback: boolean;

vi.mock("@/lib/minecraft-profile-store", () => ({
  readMinecraftRuntime: vi.fn(async () => ({ schemaReady: false, runtime: null })),
  getMinecraftProfile: vi.fn(async () => null), activeMinecraftServerPath: vi.fn(),
}));
vi.mock("@/lib/compose", async original => {
  const actual = await original<typeof import("@/lib/compose")>();
  return { ...actual, readMinecraftProfileComposeSettings: vi.fn(async () => ({ ...settings })),
    writeMinecraftProfileComposeSettings: vi.fn(async (wanted: MinecraftProfileComposeSettings) => { settings = { ...wanted }; }) };
});

beforeEach(() => {
  settings = minecraftProfileComposeSettings(id, { mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", javaVariant: "java21" });
  identity = { state: "created", image: "itzg/minecraft-server:java21", subpath: settings.subpath,
    volumeName: "yoshling_mc-data", project: "yoshling", service: "minecraft", type: "FABRIC", version: "1.21.1",
    fabricLoaderVersion: "0.16.10", forgeVersion: "", neoForgeVersion: "", quiltLoaderVersion: "", propertiesOverride: "false" };
  commands = []; extraDataMount = false; imageMissing = false; corruptImageReadback = false;
  setCommandRunner(async command => {
    commands.push(command);
    if (command.includes("docker image inspect")) {
      if (imageMissing) { imageMissing = false; throw new Error("No such image"); }
      return { stdout: corruptImageReadback ? "" : `sha256:${"a".repeat(64)}`, stderr: "" };
    }
    if (command.startsWith("docker pull ")) return { stdout: "downloaded", stderr: "" };
    if (command.includes("{{json .Mounts}}")) {
      const actual = [{ Type: "volume", Name: identity.volumeName, Destination: "/data" }];
      if (extraDataMount) actual.push({ ...actual[0] });
      const definitions = [{ Type: "volume", Source: identity.volumeName, Target: "/data", VolumeOptions: { Subpath: identity.subpath } }];
      return { stdout: [JSON.stringify(actual), JSON.stringify(definitions), JSON.stringify(identity.image), identity.state, identity.project, identity.service].join("|"), stderr: "" };
    }
    if (command.includes("{{range .Config.Env}}")) {
      const values = { TYPE: identity.type, VERSION: identity.version, FABRIC_LOADER_VERSION: identity.fabricLoaderVersion,
        FORGE_VERSION: identity.forgeVersion, NEOFORGE_VERSION: identity.neoForgeVersion, QUILT_LOADER_VERSION: identity.quiltLoaderVersion,
        OVERRIDE_SERVER_PROPERTIES: identity.propertiesOverride, RCON_PASSWORD: "fixture-only-private" };
      const requested = [...command.matchAll(/\(eq \(index \(split \. "="\) 0\) "([A-Z_]+)"\)/g)].map(match => match[1]);
      return { stdout: Object.entries(values).filter(([key]) => requested.length ? requested.includes(key) : true).map(([key, value]) => `${key}=${value}`).join("\n"), stderr: "" };
    }
    if (command.includes("{{.State.Status}}|{{.HostConfig.Memory}}")) return { stdout: `${identity.state}|${6 * 1024 ** 3}`, stderr: "" };
    if (command.includes("docker compose") && command.includes("create --force-recreate minecraft")) { identity.state = "created"; return { stdout: "", stderr: "" }; }
    if (command.startsWith("docker ps -a ")) return { stdout: "id|yoshling|minecraft", stderr: "" };
    throw new Error(`Unexpected fixture command: ${command}`);
  });
});
afterEach(() => { resetCommandRunner(); vi.clearAllMocks(); });

describe("created profile identity includes mount, image, target and properties ownership", () => {
  it("reads only public selectors and verifies the whole identity", async () => {
    const read = await inspectMinecraftProfileContainer();
    expect(read).toEqual(identity);
    expect(minecraftProfileContainerAgrees(read, settings)).toBe(true);
    expect(commands.find(command => command.includes("{{range .Config.Env}}"))).toContain("{{if or");
    expect(commands.every(command => !command.includes('"RCON_PASSWORD"'))).toBe(true);
    expect(JSON.stringify(read)).not.toContain("fixture-only-private");
  });

  it.each([
    ["subpath", "profiles/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/server"], ["volumeName", "other_volume"],
    ["project", "other_project"], ["service", "web"], ["image", "itzg/minecraft-server:java17"],
    ["type", "FORGE"], ["version", "1.20.1"], ["fabricLoaderVersion", "0.16.9"],
    ["forgeVersion", "47.3.22"], ["propertiesOverride", "true"],
  ])("refuses differing %s", (key, value) => {
    expect(minecraftProfileContainerAgrees({ ...identity, [key]: value }, settings)).toBe(false);
  });

  it("rejects duplicate actual /data mounts", async () => {
    extraDataMount = true;
    await expect(inspectMinecraftProfileContainer()).rejects.toThrow(/one named-volume mount/);
  });

  it("creates a stopped verified container and never starts a game", async () => {
    await runOperation({ kind: "profile.switch", game: "minecraft", title: "Selecting", resources: ["power", "files:minecraft"] }, async op => {
      await recreateMinecraftProfileForOperation(op, settings); return { value: null };
    });
    expect(commands.some(command => command.includes("create --force-recreate minecraft"))).toBe(true);
    expect(commands.some(command => /docker start| up -d/.test(command))).toBe(false);
  });

  it("refuses publication when Compose creation mounted another profile", async () => {
    identity.subpath = "profiles/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/server";
    await expect(runOperation({ kind: "profile.switch", game: "minecraft", title: "Selecting", resources: ["power", "files:minecraft"] }, async op => {
      await recreateMinecraftProfileForOperation(op, settings); return { value: null };
    })).rejects.toThrow(/did not match/);
    expect(commands.some(command => /docker start| up -d/.test(command))).toBe(false);
  });

  it("prepares a missing image before any container mutation", async () => {
    imageMissing = true;
    await runOperation({ kind: "profile.prepare", game: "minecraft", title: "Preparing" }, async op => {
      await prepareMinecraftProfileImage(op, "java21"); return { value: null };
    });
    expect(commands).toContain("docker pull itzg/minecraft-server:java21");
    expect(commands.some(command => /docker start|docker stop|docker compose/.test(command))).toBe(false);
  });

  it("refuses an image whose cached and downloaded IDs cannot be read back", async () => {
    corruptImageReadback = true;
    await expect(runOperation({ kind: "profile.prepare", game: "minecraft", title: "Preparing" }, async op => {
      await prepareMinecraftProfileImage(op, "java21"); return { value: null };
    })).rejects.toThrow(/could not be verified/);
  });

  it("rejects input-derived image names before invoking Docker", async () => {
    await expect(runOperation({ kind: "profile.prepare", game: "minecraft", title: "Preparing" }, async op => {
      await prepareMinecraftProfileImage(op, "java21; something"); return { value: null };
    })).rejects.toThrow(/unsupported/);
    expect(commands).toEqual([]);
  });
});
