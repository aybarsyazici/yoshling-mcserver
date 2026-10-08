import { describe, it, expect, vi, beforeEach } from "vitest";
const f = vi.hoisted(() => ({ profileId: "profile-a", unlinks: 0, deletes: 0, queries: [] as unknown[] }));
vi.mock("../minecraft-active-profile", () => ({ minecraftActiveContext: async () => ({ profileId: f.profileId, root: "/minecraft/profile-a", schemaReady: true }), minecraftInventoryWhere: (context: { profileId: string }) => ({ profileId: context.profileId }), MinecraftActiveProfileError: class extends Error {} }));
vi.mock("../server-manager", () => ({ getModsDir: async () => "/minecraft/profile-a/mods" }));
vi.mock("../mod-path", () => ({ modFilePath: async (dir: string, name: string) => `${dir}/${name}` }));
vi.mock("fs/promises", () => ({ unlink: async () => { f.unlinks++; }, readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("../db", () => ({ db: { installedMod: { findUnique: async () => ({ id: "foreign", profileId: "profile-b", fileName: "b.jar" }), delete: async () => { f.deletes++; }, findMany: async (args: unknown) => { f.queries.push(args); return []; } }, activity: { create: vi.fn() } } }));
const { removeMod, updateMod, checkForUpdates } = await import("../mod-manager");
beforeEach(() => { f.profileId = "profile-a"; f.unlinks = 0; f.deletes = 0; f.queries = []; });
describe("mod inventory profile isolation", () => {
  it("cannot remove a foreign row or jar", async () => {
    await expect(removeMod("foreign", "user")).rejects.toThrow(/another/);
    expect(f.unlinks).toBe(0); expect(f.deletes).toBe(0);
  });
  it("cannot update a foreign mod", async () => {
    await expect(updateMod("foreign", {} as never, "user")).rejects.toThrow(/another/);
    expect(f.unlinks).toBe(0);
  });
  it("queries updates only for the active profile", async () => {
    await checkForUpdates(); expect(f.queries).toEqual([{ where: { profileId: "profile-a" } }]);
  });
});
