import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ signedIn: true, access: ["minecraft"], reads: [] as string[] }));
vi.mock("../auth", () => ({ auth: async () => f.signedIn ? { user: { id: "fixture", role: "MEMBER", games: f.access } } : null }));
vi.mock("../modrinth", () => ({
  getProject: async (ref: string) => { f.reads.push(ref); return { id: "pack", title: "Friends", project_type: "modpack" }; },
  getProjectVersions: async (id: string) => { f.reads.push(id); return [{ id: "build", project_id: "pack", name: "Friends 1", version_number: "1", date_published: "2026-01-01", game_versions: ["1.20.1"], loaders: ["forge"], files: [{ filename: "friends.mrpack", primary: true, url: "https://cdn.modrinth.com/friends", size: 100, hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) } }] }]; },
}));
const { GET } = await import("@/app/api/minecraft/profile-sources/modrinth/route");
beforeEach(() => { f.signedIn = true; f.access = ["minecraft"]; f.reads = []; });
describe("profile source choices are scoped reads", () => {
  it("refuses anonymous reads before reaching upstream", async () => { f.signedIn = false; expect((await GET(new Request("http://local/?ref=pack"))).status).toBe(401); expect(f.reads).toEqual([]); });
  it("refuses a different game's member before reaching upstream", async () => { f.access = ["zomboid"]; expect((await GET(new Request("http://local/?ref=pack"))).status).toBe(403); expect(f.reads).toEqual([]); });
  it("rejects a path-shaped source identity", async () => { expect((await GET(new Request("http://local/?ref=../users"))).status).toBe(400); expect(f.reads).toEqual([]); });
  it("lets a Minecraft reader choose exact builds without consulting the selected target", async () => {
    const response = await GET(new Request("http://local/?ref=friends")); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).versions[0]).toMatchObject({ id: "build", mcVersions: ["1.20.1"], loaders: ["forge"], supported: true }); expect(f.reads).toEqual(["friends", "pack"]);
  });
});
