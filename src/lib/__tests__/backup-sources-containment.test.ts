import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import path from "path";

const dirs = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/yoshling-backup-boundary-${process.pid}-${Date.now()}`;
  return { root, mc: `${root}/mc`, sdtd: `${root}/sdtd`, xml: `${root}/xml`, pz: `${root}/pz`, outside: `${root}/outside` };
});
vi.mock("@/lib/game-manager", () => ({
  RUNTIME: { minecraft: { dir: dirs.mc }, "7dtd": { dir: dirs.sdtd }, zomboid: { dir: dirs.pz } },
  containerIsRunning: async () => false,
}));
vi.mock("@/lib/rcon", () => ({ sendCommand: vi.fn(), rconCommand: vi.fn() }));
vi.mock("@/lib/telnet", () => ({ sdtdSaveWorld: vi.fn() }));
vi.mock("@/lib/backup-log", () => ({ recordBackupEvent: vi.fn() }));
vi.mock("@/lib/backup-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backup-store")>(),
  BACKUP_DIRS: { minecraft: `${dirs.root}/backup-mc`, "7dtd": `${dirs.root}/backup-sdtd`, zomboid: `${dirs.root}/backup-pz` },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("SDTD_CONFIG_DIR", dirs.xml);
  vi.stubEnv("PZ_SERVER_DIR", dirs.pz);
  vi.stubEnv("PZ_SERVER_NAME", "yoshling");
  await mkdir(path.join(dirs.sdtd, "Saves"), { recursive: true });
  await mkdir(path.join(dirs.sdtd, "GeneratedWorlds"), { recursive: true });
  await mkdir(path.join(dirs.pz, "Server"), { recursive: true });
  await mkdir(path.join(dirs.pz, "Saves", "Multiplayer", "yoshling"), { recursive: true });
  await mkdir(path.join(dirs.pz, "db"), { recursive: true });
  await mkdir(dirs.xml);
  await mkdir(dirs.outside);
  await writeFile(path.join(dirs.sdtd, "Saves", "fixture.txt"), "saved sdtd fixture");
  await writeFile(path.join(dirs.xml, "sdtdserver.xml"), '<ServerSettings><property name="GameWorld" value="Navezgane"/></ServerSettings>');
  await writeFile(path.join(dirs.pz, "Server", "yoshling.ini"), "PVP=true\n");
  await writeFile(path.join(dirs.pz, "Server", "yoshling_SandboxVars.lua"), "sandbox fixture\n");
  await writeFile(path.join(dirs.pz, "Saves", "Multiplayer", "yoshling", "fixture.txt"), "saved pz fixture");
  await writeFile(path.join(dirs.pz, "db", "yoshling.db"), "player database fixture");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dirs.root, { recursive: true, force: true });
});
async function create(game: "7dtd" | "zomboid") {
  const { createBackup } = await import("@/lib/backup-create");
  return createBackup(game, { userId: "tester", name: "Tester" });
}
async function replaceWithOutsideAlias(file: string, fixture: string) {
  const external = path.join(dirs.outside, path.basename(file));
  await writeFile(external, fixture);
  await rm(file, { recursive: true, force: true });
  await symlink(external, file);
  return external;
}
async function expectNoArchive(game: "sdtd" | "pz") {
  expect((await readdir(path.join(dirs.root, `backup-${game}`)).catch(() => []))
    .filter((f) => f.endsWith(".tar.gz"))).toEqual([]);
}

describe("7DTD backup source admission", () => {
  it("refuses an escaping Saves root", async () => {
    await rm(path.join(dirs.sdtd, "Saves"), { recursive: true });
    await writeFile(path.join(dirs.outside, "fixture.txt"), "outside fixture");
    await symlink(dirs.outside, path.join(dirs.sdtd, "Saves"));
    await expect(create("7dtd")).rejects.toThrow("outside the configured game volume");
    await expectNoArchive("sdtd");
  });

  it("refuses an escaping XML alias rather than treating it as absent", async () => {
    const external = await replaceWithOutsideAlias(path.join(dirs.xml, "sdtdserver.xml"), "outside config fixture");
    await expect(create("7dtd")).rejects.toThrow("outside the configured game volume");
    expect(await readFile(external, "utf-8")).toBe("outside config fixture");
    await expectNoArchive("sdtd");
  });

  it("refuses an escaping generated-world root", async () => {
    await writeFile(path.join(dirs.xml, "sdtdserver.xml"), '<ServerSettings><property name="GameWorld" value="Custom"/></ServerSettings>');
    await symlink(dirs.outside, path.join(dirs.sdtd, "GeneratedWorlds", "Custom"));
    await expect(create("7dtd")).rejects.toThrow("outside the configured game volume");
    await expectNoArchive("sdtd");
  });

  it("copies actual saves through a contained top-level alias", async () => {
    await rm(path.join(dirs.sdtd, "Saves"), { recursive: true });
    await mkdir(path.join(dirs.sdtd, "contained-saves"));
    await writeFile(path.join(dirs.sdtd, "contained-saves", "fixture.txt"), "contained sdtd fixture");
    await symlink("contained-saves", path.join(dirs.sdtd, "Saves"));
    const { backup } = await create("7dtd");
    const extracted = path.join(dirs.root, "readback");
    await mkdir(extracted);
    await promisify(execFile)("tar", ["-xzf", path.join(dirs.root, "backup-sdtd", backup.name), "-C", extracted]);
    expect(await readFile(path.join(extracted, "Saves", "fixture.txt"), "utf-8")).toBe("contained sdtd fixture");
  });
});

describe("Project Zomboid backup source admission", () => {
  it("refuses an escaping world root", async () => {
    const world = path.join(dirs.pz, "Saves", "Multiplayer", "yoshling");
    await rm(world, { recursive: true });
    await symlink(dirs.outside, world);
    await expect(create("zomboid")).rejects.toThrow("outside the configured game volume");
    await expectNoArchive("pz");
  });

  it("refuses an escaping player database", async () => {
    const external = await replaceWithOutsideAlias(path.join(dirs.pz, "db", "yoshling.db"), "outside player fixture");
    await expect(create("zomboid")).rejects.toThrow("outside the configured game volume");
    expect(await readFile(external, "utf-8")).toBe("outside player fixture");
    await expectNoArchive("pz");
  });

  it("refuses escaping config members while copying the config trio", async () => {
    const external = await replaceWithOutsideAlias(path.join(dirs.pz, "Server", "yoshling_SandboxVars.lua"), "outside sandbox fixture");
    await expect(create("zomboid")).rejects.toThrow("outside the configured game volume");
    expect(await readFile(external, "utf-8")).toBe("outside sandbox fixture");
    await expectNoArchive("pz");
  });

  it("copies actual world files through a contained world alias", async () => {
    const world = path.join(dirs.pz, "Saves", "Multiplayer", "yoshling");
    await rm(world, { recursive: true });
    await mkdir(path.join(dirs.pz, "contained-world"));
    await writeFile(path.join(dirs.pz, "contained-world", "fixture.txt"), "contained pz fixture");
    await symlink("../../contained-world", world);
    const { backup } = await create("zomboid");
    const extracted = path.join(dirs.root, "readback");
    await mkdir(extracted);
    await promisify(execFile)("tar", ["-xzf", path.join(dirs.root, "backup-pz", backup.name), "-C", extracted]);
    expect(await readFile(path.join(extracted, "Saves", "Multiplayer", "yoshling", "fixture.txt"), "utf-8")).toBe("contained pz fixture");
    expect(await readFile(path.join(extracted, "db", "yoshling.db"), "utf-8")).toBe("player database fixture");
  });
});
