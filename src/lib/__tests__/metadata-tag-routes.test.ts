import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "reader", role: "MEMBER", games: "minecraft" } }) }));
const versions = await import("@/app/api/minecraft-versions/route");
const categories = await import("@/app/api/mods/categories/route");
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => f.data }))); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("typed public metadata routes", () => {
  it("keeps release-only version selection and the thirty-entry cap", async () => {
    f.data = [...Array.from({ length: 32 }, (_, index) => ({ version: `version-${index}`, version_type: "release" })),
      { version: "snapshot", version_type: "snapshot" }];
    const result = await versions.GET();
    expect(result.status).toBe(200);
    expect((await result.json()).versions).toHaveLength(30);
  });
  it("keeps mod-only category selection and sorting", async () => {
    f.data = [{ project_type: "mod", name: "zeta", icon: "z" }, { project_type: "resourcepack", name: "ignored" },
      { project_type: "mod", name: "alpha", icon: null }];
    expect(await (await categories.GET()).json()).toEqual([{ name: "alpha", icon: null }, { name: "zeta", icon: "z" }]);
  });
  it.each(["versions", "categories"])("refuses malformed %s fields as an upstream failure", async route => {
    f.data = route === "versions" ? [{ version: 42, version_type: "release" }] : [{ project_type: "mod", name: 42 }];
    const response = await (route === "versions" ? versions.GET() : categories.GET());
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/Invalid/);
  });
});
