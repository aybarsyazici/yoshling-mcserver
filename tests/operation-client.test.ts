import { afterEach, describe, expect, it, vi } from "vitest";
import { readOperationResponse, UnconfirmedOperationResult, unconfirmedOperationMessage } from "@/lib/operation-client";
import { applyModpackToServer } from "@/lib/modpack-apply";
afterEach(() => vi.unstubAllGlobals());
describe("operation response identity", () => {
  it.each([502,503,504,520,521,522,523,524,525,526,527])("does not convert gateway%s without an origin receipt into a failure", async (status) => {
    await expect(readOperationResponse(new Response(JSON.stringify({ error: "gateway" }), { status }))).rejects.toBeInstanceOf(UnconfirmedOperationResult);
  });
  it("preserves an explicit origin operation receipt even on gateway status", async () => {
    expect(await readOperationResponse(new Response(JSON.stringify({ error: "verified failure", operationId: "known-id" }), { status: 504 }))).toMatchObject({ operationId: "known-id", error: "verified failure" });
  });
  it("keeps operation identity from headers when a proxy loses the body", async () => {
    const response = new Response("<html>timeout</html>", { status: 524, headers: { "X-Operation-Id": "known-id" } });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await applyModpackToServer({ modpackId: "pack", packName: "Named pack" })).toEqual({ kind: "still-running", packName: "Named pack", operationId: "known-id" });
    expect(unconfirmedOperationMessage("backup", new UnconfirmedOperationResult("known-id"))).toContain("Operation known-id");
  });
  it("keeps a clear pre-admission refusal useful", async () => {
    expect(await readOperationResponse(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }))).toMatchObject({ error: "Forbidden" });
  });
});
