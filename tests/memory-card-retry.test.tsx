// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryCard } from "@/components/memory-card";

const f = vi.hoisted(() => ({ edit: true, success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: f.success, error: f.error, info: f.info } }));
vi.mock("@/lib/use-games", () => ({ useGames: () => ({ running: [], memoryGb: { zomboid: 12 }, maxGb: 13, can: { settings: f.edit } }) }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => ({ operations: [], elapsedMs: () => 0 }) }));

const state = { supported: true, hostGb: 16, configuredGb: 12, liveGb: 8 as number | null, applied: false, running: false, maxGb: 12, minGb: 2, nativeReserveGb: 2 };
beforeEach(() => { f.edit = true; f.success.mockClear(); f.error.mockClear(); f.info.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function load(overrides = {}) {
  const initial = { ...state, ...overrides };
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(
    options?.method === "PUT" ? { ...initial, liveGb: initial.configuredGb, applied: true, running: true } : initial
  ), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryCard game="zomboid" tint="var(--pz)" />);
  return fetcher;
}

describe("memory drift retry affordance", () => {
  it.each([8, null])("allows the same desired heap to be applied when live value is %s", async liveGb => {
    const fetcher = load({ liveGb });
    const save = await screen.findByRole("button", { name: "Save memory" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/games/memory", expect.objectContaining({ method: "PUT", body: JSON.stringify({ game: "zomboid", gb: 12 }) })));
    // Container start does not establish game readiness; the ledger owns the outcome.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save memory" })).toBeTruthy());
    expect(f.success).not.toHaveBeenCalled();
  });
  it("keeps an already verified unchanged setting disabled", async () => {
    load({ applied: true, liveGb: 12 });
    const save = await screen.findByRole("button", { name: "Save memory" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not offer an invalid historical desired value above the new limit", async () => {
    load({ configuredGb: 13 });
    const save = await screen.findByRole("button", { name: "Save memory" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "13G" })).toBeNull();
  });
  it("offers read-only users values without mutation controls", async () => {
    f.edit = false;
    load({ applied: true, liveGb: 12 });
    await screen.findByText(/Verified on the stopped container/);
    expect(screen.queryByRole("button", { name: "Save memory" })).toBeNull();
    expect(screen.queryByRole("button", { name: "12G" })).toBeNull();
  });
});
