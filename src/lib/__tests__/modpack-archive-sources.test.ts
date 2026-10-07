import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { restoreMinecraftArchive } from "@/lib/mc-archive";

const f = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/yoshling-pack-sources-${process.pid}-${Date.now()}`;
  process.env.MC_SERVER_DIR = `${root}/minecraft`;
  return { root, mc: `${root}/minecraft`, backups: `${root}/backups`, removes: 0, installs: 0,
    target: "1.21.4", targetReads: 0, targetChanges: false, emptyInventory: false };
});
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "tester", name: "Tester", role: "MOD", games: "minecraft" } }) }));
vi.mock("@/lib/db", () => ({ db: {
  modpack: { findUnique: async () => ({ id: "pack", name: "Fixture", mods: [
    { id: "new", name: "New", slug: "new", modrinthId: "New", versionId: null, downloadUrl: null },
  ] }) },
  serverConfig: { findUnique: async () => ({ mcVersion: "1.21.4", modLoader: "fabric" }) },
  installedMod: { findMany: async () => f.emptyInventory ? [] : [
    { id: "old", name: "Old", fileName: "old.jar", slug: "old", version: "1", modrinthId: "Old", mcVersion: "1.21.4", loader: "fabric",
      source: "manual", versionId: "old-pin", installedBy: "original-owner", installedAt: new Date("2026-01-02T03:04:05Z"), updatedAt: new Date("2026-01-02T03:04:05Z") },
  ] },
  activity: { create: async () => ({}) },
} }));
vi.mock("@/lib/modrinth", () => ({ getVersion: async () => { throw new Error("no pins in this fixture"); }, getProjectVersions: async () => [{
  id: "new-version", project_id: "New", name: "New", version_number: "2", loaders: ["fabric"],
  game_versions: ["1.21.4"], environment: "server_only", dependencies: [],
  files: [{ primary: true, filename: "new.jar", size: 7, url: "https://local.invalid/fixture", hashes: {} }],
}] }));
vi.mock("@/lib/mod-manager", () => ({
  serverSideFor: async () => ({ install: true, decidedBy: "version", reason: "fixture server mod" }),
  removeMod: async () => { f.removes++; await unlink(path.join(f.mc, "mods", "old.jar")); },
  installMod: async () => {
    f.installs++;
    await writeFile(path.join(f.mc, "mods", "new.jar"), "new jar");
    return { ok: true, checked: "sha512", reason: "fixture verification" };
  },
}));
vi.mock("@/lib/game-manager", () => ({
  RUNTIME: { minecraft: { dir: f.mc }, "7dtd": { dir: `${f.root}/sdtd` }, zomboid: { dir: `${f.root}/pz` } },
  gameContainerState: async () => "exited",
  getMinecraftTarget: async () => ({ mcVersion: f.targetChanges && ++f.targetReads > 1 ? "26.1.2" : f.target, loader: "fabric" }),
  containerIsRunning: async () => false,
  stopGameForOperation: async () => { throw new Error("unexpected stop of fixture"); },
  startGameForOperation: async () => { throw new Error("unexpected start of fixture"); },
}));
vi.mock("@/lib/backup-store", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/backup-store")>(),
  BACKUP_DIRS: { minecraft: f.backups, "7dtd": `${f.root}/backup-sdtd`, zomboid: `${f.root}/backup-pz` },
}));
vi.mock("@/lib/backup-log", () => ({ recordBackupEvent: async () => {} }));
vi.mock("@/lib/rcon", () => ({ sendCommand: async () => { throw new Error("unexpected RCON call"); } }));

const { POST } = await import("@/app/api/mods/install-modpack/route");
beforeEach(async () => {
  f.removes = 0; f.installs = 0;
  f.target = "1.21.4"; f.targetReads = 0; f.targetChanges = false; f.emptyInventory = false;
  await rm(f.root, { recursive: true, force: true });
  await mkdir(path.join(f.mc, "world"), { recursive: true });
  await mkdir(path.join(f.mc, "mods"));
  await writeFile(path.join(f.mc, "world", "level.dat"), "saved world fixture");
  await writeFile(path.join(f.mc, "mods", "old.jar"), "saved jar fixture");
});
afterEach(async () => { await rm(f.root, { recursive: true, force: true }); });
async function apply() {
  return POST(new Request("http://local.invalid/pack", {
    method: "POST", body: JSON.stringify({ modpackId: "pack" }),
  }) as never);
}

describe("pack rollback source admission", () => {
  it("embeds explicit inventory/provenance/pins/target in the actual downloadable tar", async () => {
    expect((await apply()).status).toBe(200);
    const [archive] = (await readdir(f.backups)).filter(name => name.endsWith(".tar.gz"));
    const { stdout } = await promisify(execFile)("tar", ["-xzOf", path.join(f.backups, archive), "manifest.json"]);
    expect(JSON.parse(stdout)).toMatchObject({
      minecraftTarget: { mcVersion: "1.21.4", loader: "fabric" },
      installedMods: [{ id: "old", source: "manual", versionId: "old-pin", installedBy: "original-owner", installedAt: "2026-01-02T03:04:05.000Z" }],
    });
  });
  it("records an explicitly empty pre-apply inventory rather than omitting it", async () => {
    f.emptyInventory = true;
    expect((await apply()).status).toBe(200);
    const [archive] = (await readdir(f.backups)).filter(name => name.endsWith(".tar.gz"));
    const { stdout } = await promisify(execFile)("tar", ["-xzOf", path.join(f.backups, archive), "manifest.json"]);
    expect(JSON.parse(stdout).installedMods).toEqual([]);
  });
  it.each(["drift", "changed"])("refuses %s in verified target before any archive or jar changes", async kind => {
    if (kind === "drift") f.target = "26.1.2";
    else f.targetChanges = true;
    expect((await apply()).status).toBe(500);
    expect(f.removes).toBe(0);
    expect(f.installs).toBe(0);
    expect(await readFile(path.join(f.mc, "mods", "old.jar"), "utf-8")).toBe("saved jar fixture");
    expect(await readdir(f.backups).catch(() => [])).toEqual([]);
  });
  it.each(["world", "mods"])("refuses an escaping %s root before removal or installation", async member => {
    const external = path.join(f.root, "outside");
    await rename(path.join(f.mc, member), external);
    await symlink(external, path.join(f.mc, member));
    expect((await apply()).status).toBe(500);
    expect(f.removes).toBe(0);
    expect(f.installs).toBe(0);
    const fixture = member === "world" ? "level.dat" : "old.jar";
    expect(await readFile(path.join(external, fixture), "utf-8")).toBe(member === "world" ? "saved world fixture" : "saved jar fixture");
    expect((await readdir(f.backups).catch(() => [])).filter(name => name.endsWith(".tar.gz"))).toEqual([]);
  });

  it("refuses an escaping nested link before publishing a rollback point or removing jars", async () => {
    const external = path.join(f.root, "outside.txt");
    await writeFile(external, "outside fixture");
    await symlink(external, path.join(f.mc, "world", "linked.txt"));
    expect((await apply()).status).toBe(500);
    expect(f.removes).toBe(0);
    expect(f.installs).toBe(0);
    expect(await readFile(external, "utf-8")).toBe("outside fixture");
    expect((await readdir(f.backups).catch(() => [])).filter(name => name.endsWith(".tar.gz"))).toEqual([]);
  });

  it("archives and restores actual data from contained world/mods aliases", async () => {
    for (const member of ["world", "mods"]) {
      await rename(path.join(f.mc, member), path.join(f.mc, `contained-${member}`));
      await symlink(`contained-${member}`, path.join(f.mc, member));
    }
    expect((await apply()).status).toBe(200);
    expect(f.removes).toBe(1);
    const [archive] = (await readdir(f.backups)).filter(name => name.endsWith(".tar.gz"));
    const live = path.join(f.root, "restored");
    await mkdir(live);
    const result = await restoreMinecraftArchive({ archivePath: path.join(f.backups, archive), mcDir: live });
    expect(result.replaced).toEqual(["world", "mods"]);
    expect(await readFile(path.join(live, "world", "level.dat"), "utf-8")).toBe("saved world fixture");
    expect(await readFile(path.join(live, "mods", "old.jar"), "utf-8")).toBe("saved jar fixture");
    expect((await readdir(f.backups)).some(name => name.startsWith(".work-"))).toBe(false);
  });

  it("replaces untracked active jars and preserves them in the real rollback archive", async () => {
    await writeFile(path.join(f.mc, "mods", "untracked.jar"), "untracked fixture");
    await writeFile(path.join(f.mc, "mods", "disabled.jar.disabled"), "disabled fixture");
    expect((await apply()).status).toBe(200);
    expect((await readdir(path.join(f.mc, "mods"))).filter(name => name.endsWith(".jar"))).toEqual(["new.jar"]);
    expect(await readFile(path.join(f.mc, "mods", "disabled.jar.disabled"), "utf-8")).toBe("disabled fixture");
    const [archive] = (await readdir(f.backups)).filter(name => name.endsWith(".tar.gz"));
    const live = path.join(f.root, "restored");
    await mkdir(live);
    await restoreMinecraftArchive({ archivePath: path.join(f.backups, archive), mcDir: live });
    expect(await readFile(path.join(live, "mods", "untracked.jar"), "utf-8")).toBe("untracked fixture");
  });
  it("removes contained untracked jar aliases even when their tracked target is replaced first", async () => {
    await symlink("old.jar", path.join(f.mc, "mods", "alias.jar"));
    expect((await apply()).status).toBe(200);
    expect(await readdir(path.join(f.mc, "mods"))).toEqual(["new.jar"]);
  });
});
