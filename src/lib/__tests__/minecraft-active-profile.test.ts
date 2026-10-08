import { describe, it, expect, vi, beforeEach } from "vitest";
import { minecraftActiveContext, requireMinecraftProfileContext, assertMinecraftProfileCurrent, withMinecraftContext, minecraftInventoryWhere,
  withMinecraftProfileRead, withMinecraftProfileFileWrite } from "../minecraft-active-profile";
import { NextResponse } from "next/server";
import { withGameFileWrite } from "../operation-response";
const state = vi.hoisted(() => ({ profileId: "11111111-1111-4111-8111-111111111111" as string | null, revision: "r1", schemaReady: true, verified: true,
  changeDuringRoot: false, changeAtAdmission: false }));
vi.mock("../minecraft-profile-store", () => ({
  MinecraftProfileError: class extends Error { readonly status = 503; },
  readMinecraftRuntime: async () => ({ schemaReady: state.schemaReady, runtime: { selectedProfileId: state.profileId, revision: state.revision } }),
  getMinecraftDataRoot: async () => {
    if (state.changeDuringRoot) { state.changeDuringRoot = false; state.revision = "r2"; }
    return state.profileId ? `/minecraft/profiles/${state.profileId}/server` : "/minecraft";
  },
}));
vi.mock("../operation-response", () => ({ withGameFileWrite: vi.fn(async (_game, work: () => Promise<NextResponse>) => {
  if (state.changeAtAdmission) { state.changeAtAdmission = false; state.revision = "r2"; }
  return work();
}) }));
vi.mock("../minecraft-profile-activation", () => ({ getMinecraftProfileRuntimeStatus: async () => ({ verified: state.verified, appliedProfileId: state.profileId, state: state.verified ? "stopped" : "unknown", reason: "Mount differs" }) }));
const request = (token?: string) => ({ headers: new Headers(token ? { "X-Minecraft-Context": token } : {}) });
beforeEach(() => { state.profileId = "11111111-1111-4111-8111-111111111111"; state.revision = "r1"; state.schemaReady = true; state.verified = true;
  state.changeDuringRoot = false; state.changeAtAdmission = false; vi.clearAllMocks(); });
describe("active Minecraft profile identity", () => {
  it("stamps a private read with its identity", async () => {
    const context = await minecraftActiveContext();
    const response = withMinecraftContext(new Response("ok"), context);
    expect(response.headers.get("X-Minecraft-Context")).toBe(`${state.profileId}@r1`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("requires the identity read by a profile editor", async () => {
    await expect(requireMinecraftProfileContext(request())).rejects.toThrow(/Reload/);
    await expect(requireMinecraftProfileContext(request(`${state.profileId}@r1`))).resolves.toMatchObject({ profileId: state.profileId });
  });
  it("rejects an old tab after switching away and back to the same profile", async () => {
    const context = await minecraftActiveContext(); state.revision = "r2";
    await expect(requireMinecraftProfileContext(request(context.token))).rejects.toThrow(/Reload/);
    await expect(assertMinecraftProfileCurrent(context)).rejects.toThrow(/Reload/);
  });
  it("refuses runtime drift even with the right pointer and browser identity", async () => {
    const context = await minecraftActiveContext(); state.verified = false;
    await expect(assertMinecraftProfileCurrent(context)).rejects.toThrow("Mount differs");
  });
  it("accepts revisionless clients only on legacy data", async () => {
    state.profileId = null; state.revision = "0";
    await expect(requireMinecraftProfileContext(request())).resolves.toMatchObject({ token: "legacy@0" });
  });
  it("scopes inventory and avoids querying the new column before migration", async () => {
    expect(minecraftInventoryWhere(await minecraftActiveContext())).toEqual({ profileId: state.profileId });
    state.profileId = null;
    expect(minecraftInventoryWhere(await minecraftActiveContext())).toEqual({ profileId: null });
    state.schemaReady = false;
    expect(minecraftInventoryWhere(await minecraftActiveContext())).toEqual({});
  });

  it("rejects a snapshot whose pointer revision changed while resolving its root", async () => {
    state.changeDuringRoot = true;
    await expect(minecraftActiveContext()).rejects.toThrow(/changed while/);
  });

  it("stamps a complete successful read with the captured profile context", async () => {
    const response = await withMinecraftProfileRead(async context => NextResponse.json({ root: context.root }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Minecraft-Context")).toBe(`${state.profileId}@r1`);
    expect(await response.json()).toEqual({ root: `/minecraft/profiles/${state.profileId}/server` });
  });

  it("discards a read across a profile revision change without stamping the old identity", async () => {
    const response = await withMinecraftProfileRead(async () => { state.revision = "r2"; return NextResponse.json({ fromOldProfile: true }); });
    expect(response.status).toBe(409);
    expect(response.headers.get("X-Minecraft-Context")).toBeNull();
    expect(await response.json()).not.toHaveProperty("fromOldProfile");
  });

  it("refuses a context-free write before taking the file lane", async () => {
    const write = vi.fn(async () => NextResponse.json({ success: true }));
    const response = await withMinecraftProfileFileWrite(request(), write);
    expect(response.status).toBe(409);
    expect(write).not.toHaveBeenCalled();
    expect(withGameFileWrite).not.toHaveBeenCalled();
  });

  it("rechecks identity inside admission before preparatory reads or writes", async () => {
    state.changeAtAdmission = true;
    const write = vi.fn(async () => NextResponse.json({ success: true }));
    const response = await withMinecraftProfileFileWrite(request(`${state.profileId}@r1`), write);
    expect(response.status).toBe(409);
    expect(withGameFileWrite).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("blocks a matching browser identity when the created runtime drifted", async () => {
    state.verified = false;
    const write = vi.fn(async () => NextResponse.json({ success: true }));
    const response = await withMinecraftProfileFileWrite(request(`${state.profileId}@r1`), write);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Mount differs" });
    expect(write).not.toHaveBeenCalled();
  });

  it("allows recovery reads under runtime drift without granting an editor context", async () => {
    state.verified = false;
    const response = await withMinecraftProfileRead(async () => NextResponse.json({ logs: "recovery log" }), { verifyRuntime: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Minecraft-Context")).toBeNull();
  });

  it("refuses an ordinary read under runtime drift before granting an editor context", async () => {
    state.verified = false;
    const read = vi.fn(async () => NextResponse.json({ content: "profile properties" }));
    const response = await withMinecraftProfileRead(read);
    expect(response.status).toBe(409); expect(read).not.toHaveBeenCalled();
    expect(response.headers.get("X-Minecraft-Context")).toBeNull();
  });
});
