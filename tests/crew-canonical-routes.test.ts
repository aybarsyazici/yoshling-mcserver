import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ role: "ADMIN", target: { id: "target", role: "ADMIN", games: "zomboid" }, mismatch: false }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "self", role: state.role } }) }));
vi.mock("@/lib/db", () => ({ db: { user: {
  findUnique: vi.fn(async () => ({ ...state.target })),
  update: vi.fn(async ({ data }) => { if (!state.mismatch) Object.assign(state.target, data); return { ...state.target }; }),
}, activity: { create: vi.fn(async () => ({})) } } }));
import { PUT as role } from "@/app/api/users/[id]/role/route";
import { PUT as games } from "@/app/api/users/[id]/games/route";
beforeEach(() => { state.role = "ADMIN"; state.target = { id: "target", role: "ADMIN", games: "zomboid" }; state.mismatch = false; });
const params = { params: Promise.resolve({ id: "target" }) };
function request(suffix: string, body: unknown) { return new NextRequest(`http://localhost/api/users/target/${suffix}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
describe("saved Crew response", () => {
  it("demotes ADMIN with its stored grants intact", async () => {
    const res = await role(request("role", { role: "MOD" }), params);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ success: true, user: { id: "target", role: "MOD", games: ["zomboid"] } });
    expect(state.target.games).toBe("zomboid");
  });
  it("returns stored grants for ADMIN separately from all-world effective access", async () => {
    const res = await games(request("games", { games: ["minecraft", "zomboid"] }), params);
    expect(await res.json()).toMatchObject({ user: { id: "target", role: "ADMIN", games: ["minecraft", "zomboid"] } });
    expect(state.target.games).toBe("minecraft,zomboid");
  });
  it.each(["role", "games"])("refuses a success claim when the persisted %s readback disagrees", async (suffix) => {
    state.mismatch = true;
    const res = await (suffix === "role" ? role : games)(request(suffix, suffix === "role" ? { role: "MOD" } : { games: ["minecraft"] }), params);
    expect(res.status).toBe(500); expect(await res.json()).not.toHaveProperty("success", true);
  });
  it.each([null, "minecraft", ["unknown"], [null]])("rejects malformed grants without clearing stored access", async (input) => {
    const res = await games(request("games", { games: input }), params);
    expect(res.status).toBe(400); expect(state.target.games).toBe("zomboid");
  });
  it("retains the admin authorization boundary", async () => {
    state.role = "MOD";
    expect((await role(request("role", { role: "MEMBER" }), params)).status).toBe(403);
    expect((await games(request("games", { games: ["minecraft"] }), params)).status).toBe(403);
    expect(state.target.games).toBe("zomboid");
  });
});
