import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/permissions";

const state = vi.hoisted(() => ({
  session: { user: { id: "u1", name: "Tester", role: "MEMBER" as Role, games: "minecraft" } } as { user: { id: string; name: string; role: Role; games: string } } | null,
  target: vi.fn(async () => ({ mcVersion: "26.1.2", loader: "fabric" })),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/game-manager", () => ({ getMinecraftTarget: state.target }));
import { GET } from "@/app/api/games/join/route";
const request = (game: string) => GET(new Request(`http://localhost/api/games/join?game=${game}`));

beforeEach(() => {
  state.session = { user: { id: "u1", name: "Tester", role: "MEMBER", games: "minecraft" } };
  state.target.mockReset(); state.target.mockResolvedValue({ mcVersion: "26.1.2", loader: "fabric" });
});

describe("join target admission and projection", () => {
  it("allows a granted MEMBER and returns only the verified target", async () => {
    const response = await request("minecraft"); const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "game", "target", "targetStatus"]);
    expect(body).toMatchObject({ game: "minecraft", targetStatus: "checked", target: { mcVersion: "26.1.2", loader: "fabric" } });
    expect(state.target).toHaveBeenCalledOnce();
  });
  it.each(["anonymous", "wrong-world"])("refuses %s before inspecting any container", async kind => {
    state.session = kind === "anonymous" ? null : { user: { id: "u1", name: "Tester", role: "MEMBER", games: "zomboid" } };
    expect((await request("minecraft")).status).toBe(kind === "anonymous" ? 401 : 403);
    expect(state.target).not.toHaveBeenCalled();
  });
  it("rejects an unknown game before inspection", async () => {
    expect((await request("typo")).status).toBe(400); expect(state.target).not.toHaveBeenCalled();
  });
  it("does not invent a target or expose inspection errors", async () => {
    state.target.mockRejectedValue(new Error("private fixture path /host/internal"));
    const body = await (await request("minecraft")).json();
    expect(body.targetStatus).toBe("unknown"); expect(body.target).toBeNull();
    expect(JSON.stringify(body)).not.toContain("private fixture");
  });
  it.each(["LATEST", "SNAPSHOT"])("does not call %s an exact client build", async mcVersion => {
    state.target.mockResolvedValue({ mcVersion, loader: "fabric" });
    expect(await (await request("minecraft")).json()).toMatchObject({ targetStatus: "unknown", target: null });
  });
  it.each(["7dtd", "zomboid"])("keeps %s exact build unknown without a Minecraft inspection", async game => {
    state.session!.user.games = game;
    expect(await (await request(game)).json()).toMatchObject({ game, targetStatus: "unknown", target: null });
    expect(state.target).not.toHaveBeenCalled();
  });
});
