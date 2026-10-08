import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Role, Permission } from "@/lib/permissions";
import type { GameId } from "@/lib/games";
import { profileFixture } from "./helpers/minecraft-profiles";
import { POST as start } from "@/app/api/minecraft/profiles/[id]/start/route";
import { POST as adopt } from "@/app/api/minecraft/profiles/adopt/route";
import { activateMinecraftProfile, MinecraftProfileActionError } from "@/lib/minecraft-profile-activation";
import { adoptLegacyMinecraftProfile } from "@/lib/minecraft-profile-adoption";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const state = vi.hoisted(() => ({ signedIn: true, role: "ADMIN" as Role, games: "minecraft", disabled: null as Permission | null }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => state.signedIn ? { user: { id: "user", name: "Friend", role: state.role, games: state.games } } : null) }));
vi.mock("@/lib/permissions", async original => {
  const actual = await original<typeof import("@/lib/permissions")>();
  return { ...actual, hasPermission: vi.fn((role: Role, permission: Permission) => permission !== state.disabled && actual.hasPermission(role, permission)) };
});
vi.mock("@/lib/minecraft-profile-activation", () => ({
  activateMinecraftProfile: vi.fn(async () => ({ profile: profileFixture({ id }), operationId: "start-operation", changed: true })),
  MinecraftProfileActionError: class extends Error {
    constructor(message: string, readonly status: number, readonly operationId?: string, readonly running?: GameId[]) { super(message); }
  },
}));
vi.mock("@/lib/minecraft-profile-adoption", () => ({ adoptLegacyMinecraftProfile: vi.fn(async () => ({ profile: profileFixture({ id }), operationId: "adopt-operation", changed: true })) }));

beforeEach(() => { state.signedIn = true; state.role = "ADMIN"; state.games = "minecraft"; state.disabled = null; vi.clearAllMocks(); });
function request(body: unknown) { return new NextRequest("http://local/api/minecraft/profiles/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function startRequest(body: unknown = { confirmStopPeers: false, confirmedPeers: [], expectedRevision: "r1" }, profileId = id) { return start(request(body), { params: Promise.resolve({ id: profileId }) }); }

describe("Minecraft profile lifecycle routes enforce world, action and reviewed input", () => {
  it.each(["start", "adopt"])("requires authentication for %s", async action => {
    state.signedIn = false;
    expect((await (action === "start" ? startRequest() : adopt(request({ name: "Friends" })))).status).toBe(401);
    expect(activateMinecraftProfile).not.toHaveBeenCalled(); expect(adoptLegacyMinecraftProfile).not.toHaveBeenCalled();
  });

  it.each(["start", "adopt"])("refuses a MOD without Minecraft access for %s", async action => {
    state.role = "MOD"; state.games = "zomboid";
    expect((await (action === "start" ? startRequest() : adopt(request({ name: "Friends" })))).status).toBe(403);
    expect(activateMinecraftProfile).not.toHaveBeenCalled(); expect(adoptLegacyMinecraftProfile).not.toHaveBeenCalled();
  });

  it.each(["server.start", "server.restart"] as const)("checks the %s permission before activation", async permission => {
    state.disabled = permission;
    expect((await startRequest()).status).toBe(403); expect(activateMinecraftProfile).not.toHaveBeenCalled();
  });

  it.each(["settings.edit", "server.stop"] as const)("checks the %s permission before adoption", async permission => {
    state.disabled = permission;
    expect((await adopt(request({ name: "Friends" }))).status).toBe(403); expect(adoptLegacyMinecraftProfile).not.toHaveBeenCalled();
  });

  it.each([{ confirmStopPeers: false }, { confirmStopPeers: "false", expectedRevision: "r1" }, { confirmStopPeers: false, expectedRevision: "" }])("requires the selector revision and explicit hand-off choice", async body => {
    expect((await startRequest(body)).status).toBe(400); expect(activateMinecraftProfile).not.toHaveBeenCalled();
  });

  it.each([undefined, ["minecraft"], ["zomboid", "zomboid"], ["unknown"]])("requires exact distinct reviewed peer IDs", async confirmedPeers => {
    expect((await startRequest({ confirmStopPeers: true, confirmedPeers, expectedRevision: "r1" })).status).toBe(400);
    expect(activateMinecraftProfile).not.toHaveBeenCalled();
  });

  it("uses immutable profile IDs rather than display names or paths", async () => {
    expect((await startRequest(undefined, "../Friends")).status).toBe(400); expect(activateMinecraftProfile).not.toHaveBeenCalled();
  });

  it("returns the verified operation receipt and passes the reviewed runtime revision", async () => {
    const response = await startRequest({ confirmStopPeers: true, confirmedPeers: ["zomboid"], expectedRevision: "r1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, operationId: "start-operation", changed: true, profile: { id } });
    expect(activateMinecraftProfile).toHaveBeenCalledWith(id, { confirmStopPeers: true, confirmedPeers: ["zomboid"], expectedRevision: "r1", startedBy: "Friend", userId: "user" });
  });

  it("preserves a refused hand-off's running worlds and operation ID in the response", async () => {
    vi.mocked(activateMinecraftProfile).mockRejectedValueOnce(new MinecraftProfileActionError("Confirm stopping PZ", 409, "refused-operation", ["zomboid"]));
    const response = await startRequest(); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Confirm stopping PZ", operationId: "refused-operation", conflict: "coresidency", running: ["zomboid"] });
  });

  it("passes explicit adoption shutdown review and records the actor", async () => {
    const response = await adopt(request({ name: " Friends ", description: "Our save", confirmStopCurrent: true }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true, operationId: "adopt-operation" });
    expect(adoptLegacyMinecraftProfile).toHaveBeenCalledWith({ name: "Friends", description: "Our save", confirmStopCurrent: true, loaderVersion: undefined, javaVariant: undefined }, { userId: "user", name: "Friend" });
  });

  it("refuses malformed adoption review fields before any runtime action", async () => {
    expect((await adopt(request({ name: "Friends", confirmStopCurrent: "yes" }))).status).toBe(400);
    expect(adoptLegacyMinecraftProfile).not.toHaveBeenCalled();
  });
});
