import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "tester", name: "Tester", role: "ADMIN", games: ["minecraft", "zomboid"] } }),
}));
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: async () => ({ mcVersion: "1.21.4" }) },
  activity: { create: vi.fn(async () => ({})) },
} }));
vi.mock("@/lib/mc-identity", () => ({
  resolveEntryUuids: async (entries: object[]) => ({ ok: true, entries }),
  isValidMcName: (name: string) => /^\w{1,16}$/.test(name),
  isValidUuid: () => true,
}));
vi.mock("@/lib/game-manager", () => ({ containerIsRunning: async () => false }));
vi.mock("@/lib/rcon", () => ({
  sendCommand: async () => { throw new Error("offline fixture"); },
  sendCommandLong: async () => { throw new Error("offline fixture"); },
  rconCommand: async () => { throw new Error("offline fixture"); },
}));
vi.mock("@/lib/rcon-long", () => ({ rconCommandLong: async () => { throw new Error("offline fixture"); } }));

let root = "";
let game = "";
let outside = "";
beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(path.join(tmpdir(), "yoshling-config-boundary-"));
  game = path.join(root, "game");
  outside = path.join(root, "outside");
  await mkdir(game);
  await mkdir(outside);
  vi.stubEnv("MC_SERVER_DIR", game);
  vi.stubEnv("PZ_SERVER_DIR", game);
  vi.stubEnv("PZ_SERVER_NAME", "yoshling");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const cases = [
  { file: "server.properties", route: "properties", initial: "motd=fixture\n", body: { motd: "updated" }, expected: "motd=updated" },
  { file: "ops.json", route: "ops", initial: "[]", body: [{ uuid: "fixture", name: "Tester", level: 4 }], expected: "Tester" },
  { file: "whitelist.json", route: "mc-whitelist", initial: "[]", body: [{ uuid: "fixture", name: "Tester" }], expected: "Tester" },
] as const;
async function mcRoute(route: string) {
  if (route === "properties") return import("@/app/api/server/properties/route");
  if (route === "ops") return import("@/app/api/server/ops/route");
  return import("@/app/api/server/mc-whitelist/route");
}
function put(body: unknown) {
  return new Request("http://local.invalid/config", { method: "PUT", body: JSON.stringify(body) }) as never;
}

describe("Minecraft configuration file admission", () => {
  for (const item of cases) {
    it(`${item.file}: preserves a contained alias and reads writes back`, async () => {
      const target = path.join(game, "contained.txt");
      await writeFile(target, item.initial);
      await symlink("contained.txt", path.join(game, item.file));
      const route = await mcRoute(item.route);
      expect((await route.GET()).status).toBe(200);
      expect((await route.PUT(put(item.body))).status).toBe(200);
      expect(await readFile(target, "utf-8")).toContain(item.expected);
    });

    it(`${item.file}: refuses an out-of-volume read and write`, async () => {
      const target = path.join(outside, "fixture.txt");
      await writeFile(target, item.initial);
      await symlink(target, path.join(game, item.file));
      const route = await mcRoute(item.route);
      const read = await route.GET();
      expect(read.status).toBe(500);
      expect(await read.json()).toEqual({ error: "Refusing a path outside the configured game volume" });
      expect((await route.PUT(put(item.body))).status).toBe(500);
      expect(await readFile(target, "utf-8")).toBe(item.initial);
    });
  }

  it("retains first-install list creation and an absent properties response", async () => {
    const props = await mcRoute("properties");
    expect(await (await props.GET()).json()).toEqual({});
    expect((await props.PUT(put({ motd: "updated" }))).status).toBe(400);
    for (const item of cases.slice(1)) {
      const route = await mcRoute(item.route);
      expect(await (await route.GET()).json()).toEqual([]);
      expect((await route.PUT(put(item.body))).status).toBe(200);
      expect(await readFile(path.join(game, item.file), "utf-8")).toContain(item.expected);
    }
  });

  for (const file of ["banned-players.json", "banned-ips.json"]) {
    it(`${file}: refuses out-of-volume ban reads and mutations`, async () => {
      const target = path.join(outside, "ban-fixture.json");
      await writeFile(target, "[]");
      await symlink(target, path.join(game, file));
      const route = await import("@/app/api/server/bans/route");
      expect((await route.GET()).status).toBe(500);
      const kind = file === "banned-players.json" ? "player" : "ip";
      const targetName = kind === "player" ? "Tester" : "192.0.2.1";
      expect((await route.POST(new Request("http://local.invalid/bans", {
        method: "POST", body: JSON.stringify({ kind, target: targetName }),
      }) as never)).status).toBe(500);
      expect(await readFile(target, "utf-8")).toBe("[]");
    });
  }
});

describe("Project Zomboid configuration and save path admission", () => {
  const importedIni = ["PVP=false", ...Array.from({ length: 19 }, (_, i) => `Fixture${i}=value`)].join("\n");

  it("supports a first-install config import beneath the existing game volume", async () => {
    const route = await import("@/app/api/zomboid/config/import/route");
    const result = await route.POST(new Request("http://local.invalid/import", {
      method: "POST", body: JSON.stringify({ content: importedIni, apply: true }),
    }) as never);
    expect(result.status).toBe(200);
    expect(await readFile(path.join(game, "Server", "yoshling.ini"), "utf-8")).toBe(importedIni);
  });

  it("refuses an escaping timestamp config backup before replacing the INI", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:34:56Z"));
    await mkdir(path.join(game, "Server"));
    const file = path.join(game, "Server", "yoshling.ini");
    await writeFile(file, "PVP=true\n");
    const external = path.join(outside, "backup.txt");
    await writeFile(external, "outside fixture");
    await symlink(external, `${file}.bak-2026-10-06T12-34-56`);
    const route = await import("@/app/api/zomboid/config/import/route");
    const result = await route.POST(new Request("http://local.invalid/import", {
      method: "POST", body: JSON.stringify({ content: importedIni, apply: true }),
    }) as never);
    expect(result.status).toBe(500);
    expect(await readFile(external, "utf-8")).toBe("outside fixture");
    expect(await readFile(file, "utf-8")).toBe("PVP=true\n");
  });

  it("refuses an escaping sandbox backup before replacing the Lua", async () => {
    await mkdir(path.join(game, "Server"));
    const file = path.join(game, "Server", "yoshling_SandboxVars.lua");
    const before = "SandboxVars = {\n  FoodLootNew = 1.0,\n}\n";
    await writeFile(file, before);
    const external = path.join(outside, "backup.txt");
    await writeFile(external, "outside fixture");
    await symlink(external, `${file}.bak`);
    const sandbox = await import("@/lib/zomboid-sandbox");
    await expect(sandbox.updateSandbox({ FoodLootNew: "2.0" }, { minOptions: 1 })).rejects.toThrow(
      "outside the configured game volume"
    );
    expect(await readFile(external, "utf-8")).toBe("outside fixture");
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  it("keeps first-install paths beneath the existing volume", async () => {
    const pz = await import("@/lib/zomboid");
    expect(await pz.serverName()).toBe("yoshling");
    expect(await pz.iniPath()).toBe(path.join(await realpath(game), "Server", "yoshling.ini"));
    const paths = await pz.savePaths();
    expect(paths.world).toBe(path.join(await realpath(game), "Saves", "Multiplayer", "yoshling"));
  });

  it("reads and updates an INI through a contained Server alias", async () => {
    await mkdir(path.join(game, "settings"));
    await symlink("settings", path.join(game, "Server"));
    const file = path.join(game, "settings", "yoshling.ini");
    await writeFile(file, "PVP=true\nMaxPlayers=16\n");
    const pz = await import("@/lib/zomboid");
    expect((await pz.readIniProperties())[0].value).toBe("true");
    await pz.updateIni({ PVP: "false" });
    expect(await readFile(file, "utf-8")).toContain("PVP=false");
  });

  it("refuses a Server alias outside the volume without discovering its INI", async () => {
    await writeFile(path.join(outside, "yoshling.ini"), "PVP=true\n");
    await symlink(outside, path.join(game, "Server"));
    const pz = await import("@/lib/zomboid");
    await expect(pz.serverName()).rejects.toThrow("outside the configured game volume");
    await expect(pz.readIniProperties()).rejects.toThrow("outside the configured game volume");
    await expect(pz.updateIni({ PVP: "false" })).rejects.toThrow("outside the configured game volume");
    expect(await readFile(path.join(outside, "yoshling.ini"), "utf-8")).toBe("PVP=true\n");
  });

  it("refuses final INI aliases and missing files below an escaping parent", async () => {
    await mkdir(path.join(game, "Server"));
    await writeFile(path.join(outside, "ini.txt"), "PVP=true\n");
    await symlink(path.join(outside, "ini.txt"), path.join(game, "Server", "yoshling.ini"));
    const pz = await import("@/lib/zomboid");
    await expect(pz.iniPath()).rejects.toThrow("outside the configured game volume");
    await rm(path.join(game, "Server", "yoshling.ini"));
    await symlink(outside, path.join(game, "Saves"));
    await expect(pz.savePaths()).rejects.toThrow("outside the configured game volume");
  });

  it("refuses out-of-volume sandbox aliases", async () => {
    await mkdir(path.join(game, "Server"));
    const external = path.join(outside, "sandbox.txt");
    await writeFile(external, "SandboxVars = {\n  FoodLootNew = 1.0,\n}\n");
    await symlink(external, path.join(game, "Server", "yoshling_SandboxVars.lua"));
    const sandbox = await import("@/lib/zomboid-sandbox");
    await expect(sandbox.readSandboxOptions()).rejects.toThrow("outside the configured game volume");
    await expect(sandbox.updateSandbox({ FoodLootNew: "2.0" }, { minOptions: 1 })).rejects.toThrow("outside the configured game volume");
    expect(await readFile(external, "utf-8")).toContain("FoodLootNew = 1.0");
  });
});
