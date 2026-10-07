import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const f = vi.hoisted(() => ({
  role: "ADMIN", games: ["minecraft"], fail: new Set<string>(), malformed: new Set<string>(),
  dependencies: [
    { project_id: "one", version_id: "one-v1", dependency_type: "required" },
    { project_id: "two", version_id: "two-v1", dependency_type: "embedded" },
  ] as Array<{ project_id: string | null; version_id: string | null; dependency_type: string }>,
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "saved-pack", ...data })),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", role: f.role, games: f.games } })) }));
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: vi.fn(async () => ({ mcVersion: "26.1.2" })) },
  modpack: { create: f.create },
} }));
vi.mock("@/lib/modrinth", () => ({
  getVersion: vi.fn(async (id: string) => ({ id, project_id: id.replace(/-v1$/, ""), game_versions: ["26.1.2"], loaders: ["fabric"] })),
  getProjectVersions: vi.fn(async () => [{ id: "pack-v1", game_versions: ["26.1.2"], loaders: ["fabric"], dependencies: f.dependencies }]),
  getProject: vi.fn(async (id: string) => {
    if (f.fail.has(id)) throw new Error("upstream timeout");
    return f.malformed.has(id) ? { id, slug: "" } : { id, slug: `mod-${id}`, title: `Mod ${id}` };
  }),
}));
const { POST } = await import("@/app/api/modpacks/import/route");
const request = () => new Request("http://localhost/api/modpacks/import", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modrinthId: "pack", name: "My pack" }),
}) as NextRequest;

beforeEach(() => {
  f.role = "ADMIN"; f.games = ["minecraft"]; f.fail.clear(); f.malformed.clear(); f.create.mockClear();
  f.dependencies = [
    { project_id: "one", version_id: "one-v1", dependency_type: "required" },
    { project_id: "two", version_id: "two-v1", dependency_type: "embedded" },
  ];
});

describe("complete pack imports", () => {
  it("does not save a shortened pack after one required lookup fails", async () => {
    f.fail.add("one");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ missingProjects: ["one"] });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("names every failed dependency and creates no row", async () => {
    f.fail.add("one"); f.fail.add("two");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ missingProjects: ["one", "two"] });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects unusable upstream metadata rather than discarding or misidentifying it", async () => {
    f.malformed.add("two");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("refuses content dependencies with no project identity instead of dropping them", async () => {
    f.dependencies.push({ project_id: null, version_id: "unresolved-build", dependency_type: "required" });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ unresolvedVersions: ["unresolved-build"] });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("saves all required and embedded mods after every lookup succeeds", async () => {
    f.dependencies.push({ project_id: "optional", version_id: null, dependency_type: "optional" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(f.create).toHaveBeenCalledOnce();
    const saved = f.create.mock.calls[0][0].data as { mods: { create: Array<{ modrinthId: string }> } };
    expect(saved.mods.create.map(m => m.modrinthId)).toEqual(["one", "two"]);
    expect(saved.mods.create).toMatchObject([{ versionId: "one-v1" }, { versionId: "two-v1" }]);
    expect(await response.json()).toMatchObject({ description: "Imported from Modrinth. 2 mods.", targetMcVersion: "26.1.2" });
  });
  it("preserves the existing capability refusal", async () => {
    f.role = "MEMBER";
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(f.create).not.toHaveBeenCalled();
  });
});
