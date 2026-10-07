// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SdtdMaintenance } from "@/components/sdtd-maintenance";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState(), CAPABILITY_POLL_MS: 30000 }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
beforeAll(installBrowserStubs); afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const checked = { branch: "stable", resolvedBranch: "public", installedBuildId: "10", latestBuildId: "10", updateAvailable: false, lookupStatus: "checked", checkError: null };
const reset = { world: "RWG", gameName: "old", nextGameName: "new" };
describe("verified update comparison", () => {
  it.each([
    { ...checked, lookupStatus: "unknown", updateAvailable: null, latestBuildId: null, checkError: "Steam lookup unavailable" },
    { ...checked, lookupStatus: "unknown", updateAvailable: null, installedBuildId: null, checkError: "Installed build unavailable" },
    { ...checked, lookupStatus: "checked", latestBuildId: "11", updateAvailable: false },
    { error: "Bad response" },
  ])("does not call missing/failed/inconsistent comparison up to date", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async (url) => json(String(url).endsWith("reset") ? reset : body)));
    render(<SdtdMaintenance tint="var(--sdtd)" />);
    await waitFor(() => expect(screen.queryByText(/checking…/)).toBeNull());
    expect(screen.queryByText(/up to date/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Update" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeDefined();
  });
  it("renders a confirmed match and replaces it with unknown after failed recheck", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("reset") ? json(reset) : ++call === 1 ? json(checked) : json({}, 503)));
    render(<SdtdMaintenance tint="var(--sdtd)" />); await screen.findByRole("button", { name: "Up to date" });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("alert"); expect(screen.queryByText(/up to date/i)).toBeNull();
    expect(document.body.textContent).toContain("comparison unknown");
  });
  it("allows an available update only from a consistent checked comparison", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => json(String(url).endsWith("reset") ? reset : { ...checked, latestBuildId: "11", updateAvailable: true })));
    render(<SdtdMaintenance tint="var(--sdtd)" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
