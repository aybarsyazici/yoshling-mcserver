import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const f = vi.hoisted(() => ({
  target: "1.21.1" as string | null, loader: "fabric" as string | null,
  pin: null as string | null, fails: false, wrongPin: false,
  server: vi.fn(async () => ({ mcVersion: "26.1.2", modLoader: "forge" })),
  versions: vi.fn(), pinned: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "reader", role: "MEMBER", games: "minecraft" } }) }));
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: f.server },
  modpack: { findUnique: async () => ({ name: "Saved fixture", description: "fixture", targetMcVersion: f.target, targetLoader: f.loader,
    mods: [{ name: "Fixture", slug: "fixture", modrinthId: "project", versionId: f.pin, downloadUrl: null }] }) },
} }));
function version(id = "new") {
  return { id, project_id: f.wrongPin ? "different" : "project", game_versions: ["1.21.1"], loaders: ["fabric"], version_number: id,
    files: [{ primary: true, filename: `${id}.jar`, url: `https://local.invalid/${id}.jar` }] };
}
vi.mock("@/lib/modrinth", () => ({
  getProjectVersions: async (...args: unknown[]) => { f.versions(...args); if (f.fails) throw new Error("fixture failure"); return [version()]; },
  getVersion: async (id: string) => { f.pinned(id); return version(id); },
}));
const { GET } = await import("@/app/api/modpacks/[id]/export/route");
const exportPack = async () => (await GET(new Request("http://local.invalid/export") as NextRequest,
  { params: Promise.resolve({ id: "saved" }) })).json();
beforeEach(() => { vi.clearAllMocks(); f.target = "1.21.1"; f.loader = "fabric"; f.pin = null; f.fails = false; f.wrongPin = false; });

describe("saved pack export targets and pins", () => {
  it("uses the saved target instead of current server settings", async () => {
    const body = await exportPack();
    expect(body).toMatchObject({ complete: true, modpack: { mcVersion: "1.21.1", loader: "fabric" }, unresolved: [] });
    expect(f.versions).toHaveBeenCalledWith("project", { loaders: ["fabric"], game_versions: ["1.21.1"] });
    expect(f.server).not.toHaveBeenCalled();
  });
  it("resolves the exact recorded build without replacing it with a newer list entry", async () => {
    f.pin = "old-pin";
    expect((await exportPack()).mods[0]).toMatchObject({ versionId: "old-pin", fileName: "old-pin.jar" });
    expect(f.pinned).toHaveBeenCalledWith("old-pin");
    expect(f.versions).not.toHaveBeenCalled();
  });
  it.each(["lookup", "pin", "target"])("names incomplete %s evidence and cannot claim complete export", async kind => {
    if (kind === "lookup") f.fails = true;
    if (kind === "pin") { f.pin = "bad"; f.wrongPin = true; }
    if (kind === "target") f.target = null;
    const body = await exportPack();
    expect(body.complete).toBe(false);
    expect(body.unresolved.length).toBeGreaterThan(0);
    expect(body.mods[0].downloadUrl).toBeNull();
  });
});
