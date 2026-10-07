// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
import { GameControls } from "@/components/game-controls";
import { GameOverview } from "@/components/game-overview";
import { MissionControl } from "@/components/mission-control";
import { GameBackups } from "@/components/game-backups";
import { SdtdMaintenance } from "@/components/sdtd-maintenance";
import { ZomboidUpdateStatus } from "@/components/zomboid-update-status";
import { ModpackBrowserModrinth } from "@/components/modpack-browser-modrinth";
import { Modpacks } from "@/components/modpacks";
const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState(), CAPABILITY_POLL_MS: 30000 }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState({ refresh }) }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
beforeAll(() => { installBrowserStubs(); window.scrollTo = vi.fn(); });
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const backup = { name: "fixture.tar.gz", size: 12, createdAt: "2026-01-01" };
const update = { branch: "stable", resolvedBranch: "public", installedBuildId: "1", latestBuildId: "2", lookupStatus: "checked", updateAvailable: true, checkError: null };
const pz = { stale: [], checkedAt: Date.now(), lastError: "", applyingSince: null, applyingTitles: [], announcedAt: null, appliedAt: null, pollMs: 300000, watching: true };
const pack = { id: "p1", name: "Fixture pack", description: "", createdBy: "u", createdAt: "2026-01-01", targetMcVersion: "1.21.1", targetLoader: "fabric", mods: [{ id: "m1", modrinthId: "m1", name: "Mod", slug: "mod", versionId: "v1" }] };
function stub(reply: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") { if (reply instanceof Error) throw reply; return reply; }
    const u = String(url);
    if (u === "/api/7dtd/update") return json(update);
    if (u === "/api/7dtd/reset") return json({ world: "RWG", gameName: "old", nextGameName: "new" });
    if (u === "/api/zomboid/updates") return json(pz);
    if (u === "/api/modpacks") return json([pack]);
    if (u === "/api/minecraft-versions") return json({ versions: ["1.21.1"] });
    return json(u.includes("meta=1") ? {} : [backup]);
  }));
}
const surfaces = [
  { name: "server power", render: () => <GameControls game="zomboid" />, click: async () => fireEvent.click(screen.getByRole("button", { name: /Power on/ })) },
  { name: "overview power", render: () => <GameOverview game="zomboid" />, click: async () => fireEvent.click(screen.getByRole("button", { name: /Power on/ })) },
  { name: "landing power", render: () => <MissionControl access={["zomboid"]} />, click: async () => fireEvent.click(screen.getByRole("button", { name: /Power on/ })) },
  { name: "backup create", render: () => <GameBackups game="zomboid" />, click: async () => fireEvent.click(screen.getByRole("button", { name: "Create backup" })) },
  { name: "backup restore", render: () => <GameBackups game="zomboid" />, click: async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restore" }));
  } },
  { name: "Workshop update", render: () => <ZomboidUpdateStatus tint="var(--pz)" />, click: async () => fireEvent.click(await screen.findByRole("button", { name: "Check now" })) },
  { name: "7DTD update", render: () => <SdtdMaintenance tint="var(--sdtd)" />, click: async () => { await waitFor(() => expect((screen.getByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Update now" })); } },
  { name: "7DTD reset", render: () => <SdtdMaintenance tint="var(--sdtd)" />, click: async () => { await waitFor(() => expect((screen.getByRole("button", { name: "Reset world" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Reset world" })); fireEvent.click(screen.getByRole("button", { name: "Reset & start fresh" })); } },
];

describe.each(surfaces)("$name lost receipt", (surface) => {
  it.each([524, 504])("does not declare failure or continued execution from HTML HTTP %s", async (status) => {
    stub({ ok: false, status, json: async () => { throw new SyntaxError("HTML timeout"); } } as unknown as Response);
    render(surface.render()); await surface.click();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalled(); expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("result is unconfirmed"));
    expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("may still be running"));
  });
  it("keeps a rejected network request unconfirmed and refreshes the ledger", async () => {
    stub(new Error("Connection lost")); render(surface.render()); await surface.click();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalled(); expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("result is unconfirmed"));
  });
  it("keeps a known operation receipt owned by the ledger", async () => {
    stub(json({ operationId: "known-operation", error: "Origin refused after admission" }, 500));
    render(surface.render()); await surface.click(); await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalled(); expect(toasts.success).not.toHaveBeenCalled();
  });
});
it("shows an uncertain pack report after an HTML524 without fabricated counts", async () => {
  stub({ ok: false, status: 524, json: async () => { throw new SyntaxError("HTML"); } } as unknown as Response);
  render(<Modpacks />); await screen.findByText("Fixture pack");
  fireEvent.click(screen.getByRole("button", { name: "Install to Server" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, replace all mods" }));
  await screen.findByText("Install result unconfirmed · Fixture pack");
  expect(document.body.textContent).toContain("may still be running");
  expect(document.body.textContent).not.toMatch(/Installed \d+ of \d+ mods/);
  expect(toasts.error).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalled();
});

it.each(["network", "HTML524", "missing receipt"])("direct pack import stays unconfirmed after %s and refreshes Saved sets", async (failure) => {
  const onImported = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") {
      if (failure === "network") throw new Error("Lost reply");
      if (failure === "HTML524") return { ok: false, status: 524, json: async () => { throw new Error("HTML"); } } as unknown as Response;
      return json({ mods: [] });
    }
    return json({ hits: [{ project_id: "fixture", slug: "fixture", title: "Upstream pack", description: "Fixture", icon_url: null, downloads: 123, author: "Fixture", categories: [] }], total_hits: 1, filter: { mcVersion: "1.21.1", loader: "fabric" } });
  }));
  render(<ModpackBrowserModrinth onImported={onImported} />); fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(toasts.error).not.toHaveBeenCalled(); expect(toasts.success).not.toHaveBeenCalled();
  expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("Check Saved sets before importing again"));
  expect(toasts.info.mock.calls[0][0]).not.toContain("Nothing was saved");
});
