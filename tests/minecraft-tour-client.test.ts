import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMinecraftTourState, requestMinecraftTourState } from "@/lib/minecraft-tour-client";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const state = (done = false) => ({ userId: "alice", version: 1, done });
describe("spotlight tour preference protocol", () => {
  it.each([null, [], {}, { ...state(), userId: "bob" }, { ...state(), version: 2 }, { ...state(), done: "false" }])("rejects unknown or wrong-user state %j", value => {
    expect(() => parseMinecraftTourState(value, "alice")).toThrow();
  });
  it("admits explicit own-user true and false without retaining extra fields", () => {
    expect(parseMinecraftTourState({ ...state(), unrelated: "fixture" }, "alice")).toEqual(state()); expect(parseMinecraftTourState(state(true), "alice")).toEqual(state(true));
  });
  it("sends only the own-account completion protocol and validates its readback", async () => {
    const calls: { url: string; method: string; body: unknown; actor: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => { calls.push({ url: String(input), method: init.method, body: init.body ? JSON.parse(init.body) : null, actor: new Headers(init.headers).get("X-Minecraft-Tour-User") }); return Response.json(state(true)); }));
    const controller = new AbortController(); expect(await requestMinecraftTourState("alice", "POST", controller.signal)).toEqual(state(true));
    expect(calls).toEqual([{ url: "/api/minecraft/tour", method: "POST", body: { version: 1, done: true }, actor: "alice" }]);
  });
  it("pins even a preference GET to the mounted account without sending a write body", async () => {
    let options!: RequestInit; vi.stubGlobal("fetch", vi.fn(async (_input, init) => { options = init; return Response.json(state()); }));
    expect(await requestMinecraftTourState("alice", "GET", new AbortController().signal)).toEqual(state()); expect(new Headers(options.headers).get("X-Minecraft-Tour-User")).toBe("alice"); expect(options.body).toBeUndefined(); expect(options.cache).toBe("no-store");
  });
  it("rejects gateway markup and refused or oversized response bodies", async () => {
    for (const response of [new Response(JSON.stringify(state()), { status: 200, headers: { "Content-Type": "text/html" } }), Response.json(state(), { status: 503 }), Response.json({ ...state(), padding: "x".repeat(65 * 1024) })]) {
      vi.stubGlobal("fetch", vi.fn(async () => response)); await expect(requestMinecraftTourState("alice", "GET", new AbortController().signal)).rejects.toThrow();
    }
  });
  it("aborts a stalled response body at the fifteen-second deadline", async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => { signal = init.signal; return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "Content-Type": "application/json" } }); }));
    const result = requestMinecraftTourState("alice", "GET", new AbortController().signal).then(() => "accepted", error => error.message);
    await vi.advanceTimersByTimeAsync(15000); expect(await result).toContain("timed out"); expect(signal.aborted).toBe(true);
  });
  it("cancels an old user lifetime even if its fetch ignores abort", async () => {
    let signal!: AbortSignal; vi.stubGlobal("fetch", vi.fn(async (_input, init) => { signal = init.signal; return new Promise<Response>(() => {}); }));
    const controller = new AbortController(), result = requestMinecraftTourState("alice", "GET", controller.signal).then(() => "accepted", error => error.message);
    controller.abort(); expect(await result).toContain("interrupted"); expect(signal.aborted).toBe(true);
  });
});
