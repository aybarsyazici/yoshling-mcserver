import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { minecraftProfilePath, minecraftProfileServerPath, minecraftCoverPath } from "@/lib/minecraft-profile-path";

const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "yoshling-profile-path-"))); await mkdir(path.join(root, "game")); await mkdir(path.join(root, "covers")); vi.stubEnv("MC_SERVER_DIR", path.join(root, "game")); vi.stubEnv("MC_PROFILE_COVER_DIR", path.join(root, "covers")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function server(id: string) { const dir = path.join(root, "game", "profiles", id, "server"); await mkdir(dir, { recursive: true }); return dir; }

describe("separate physical profile roots", () => {
  it("admits new suffixes only under a stable profile identity", async () => {
    expect(await minecraftProfileServerPath(A, "config/new.cfg")).toBe(path.join(root, "game", "profiles", A, "server", "config", "new.cfg"));
    await expect(minecraftProfileServerPath("../../outside", "new.cfg")).rejects.toThrow();
    await expect(minecraftProfileServerPath(`${A}\n`, "new.cfg")).rejects.toThrow();
    await expect(minecraftProfileServerPath(A, "../other.cfg")).rejects.toThrow();
    await expect(minecraftProfileServerPath(A, "config/new.cfg", { allowMissing: false })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("permits contained leaf aliases and preserves final-link unlink semantics", async () => {
    const dir = await server(A); await writeFile(path.join(dir, "actual.cfg"), "ordinary fixture"); await symlink("actual.cfg", path.join(dir, "alias.cfg"));
    expect(await minecraftProfileServerPath(A, "alias.cfg")).toBe(path.join(dir, "actual.cfg"));
    expect(await minecraftProfileServerPath(A, "alias.cfg", { followFinalSymlink: false })).toBe(path.join(dir, "alias.cfg"));
  });
  it("rejects a cross-profile leaf even when both profiles share the volume", async () => {
    const a = await server(A); const b = await server(B); await writeFile(path.join(b, "target.cfg"), "ordinary other-profile fixture"); await symlink(path.join(b, "target.cfg"), path.join(a, "cross.cfg"));
    await expect(minecraftProfileServerPath(A, "cross.cfg")).rejects.toThrow("outside this Minecraft profile");
    await expect(minecraftProfileServerPath(A, "cross.cfg", { followFinalSymlink: false })).rejects.toThrow("outside this Minecraft profile");
  });
  it.each(["profile", "server"])("rejects aliased managed %s directories", async level => {
    const b = await server(B); await mkdir(path.join(root, "game", "profiles", A), { recursive: true });
    if (level === "profile") { await rm(path.join(root, "game", "profiles", A), { recursive: true }); await symlink(path.dirname(b), path.join(root, "game", "profiles", A)); }
    else await symlink(b, path.join(root, "game", "profiles", A, "server"));
    await expect(minecraftProfileServerPath(A)).rejects.toThrow("separate real directories");
  });
  it("rejects external and dangling child links", async () => {
    const dir = await server(A); await mkdir(path.join(root, "external")); await writeFile(path.join(root, "external", "fixture.txt"), "non-sensitive fixture");
    await symlink(path.join(root, "external"), path.join(dir, "external")); await symlink(path.join(root, "absent"), path.join(dir, "dangling"));
    await expect(minecraftProfileServerPath(A, "external/fixture.txt")).rejects.toThrow();
    await expect(minecraftProfileServerPath(A, "dangling/new.cfg")).rejects.toThrow();
  });
  it("rejects root removal and cover aliases to another profile", async () => {
    await server(A); await expect(minecraftProfilePath(A, "", { allowRoot: false })).rejects.toThrow();
    const key = "00000000-0000-0000-0000-000000000003.png";
    await mkdir(path.join(root, "covers", A)); await mkdir(path.join(root, "covers", B)); await writeFile(path.join(root, "covers", B, key), "ordinary image fixture"); await symlink(path.join(root, "covers", B, key), path.join(root, "covers", A, key));
    await expect(minecraftCoverPath(A, key)).rejects.toThrow();
  });
});
