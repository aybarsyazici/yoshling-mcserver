// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_POWERS, NO_POWERS, gamesState, installBrowserStubs, opsState } from "./helpers/dom";
import { ZomboidMods } from "@/components/zomboid-mods";
import { ZomboidQuickSettings } from "@/components/zomboid-quick-settings";
import { ZomboidMaps } from "@/components/zomboid-maps";
import { ZomboidUpdateStatus } from "@/components/zomboid-update-status";
import { GameConsole } from "@/components/game-console";
import { GameBackups } from "@/components/game-backups";
import { GameSidebar } from "@/components/game-sidebar";
import MinecraftServerPage from "@/app/minecraft/server/page";
import SevenDtdServerPage from "@/app/7dtd/server/page";
import ZomboidServerPage from "@/app/zomboid/server/page";
const state = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", () => ({ useGames: () => state.games, CAPABILITY_POLL_MS: 30000 }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));
vi.mock("@/components/photo-footer", () => ({ PhotoFooter: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/zomboid" }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
beforeAll(installBrowserStubs);
beforeEach(() => { state.games = gamesState({ can: ALL_POWERS }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const tint = "var(--pz)";
const mod = { workshopId: "123456", title: "Variant Mod", previewUrl: null, provides: ["RootB41", "B42", "Alternate"], enabled: ["B42"], downloaded: true };
const quick = { properties: Object.entries({ PublicName: "Daily world", Password: "fixture", MaxPlayers: "12", Public: "true", PVP: "false", PauseEmpty: "true" }).map(([name,value]) => ({ name,value })) };
const maps = { maps: [{ name: "Town", workshopId: "123456", modId: "TownMod", title: "Town", mapTitle: "Town", parent: "", cellCount: 3, order: 0 }], order: ["Town", "Muldraugh, KY"], conflicts: [], unlisted: [], missing: [], stock: ["Muldraugh, KY"], configMissing: false };
const updates = { stale: [], checkedAt: Date.now(), lastError: "", applyingSince: null, applyingTitles: [], announcedAt: null, appliedAt: null, pollMs: 300000, watching: true };

describe("PZ mod enabled variants", () => {
  it("posts only actual enabled IDs on an unchanged save and preserves disabled variants in the readback", async () => {
    const patches: unknown[] = []; let enabled = [...mod.enabled];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PATCH") { const body = JSON.parse(init.body); patches.push(body); enabled = body.modIds; return json({ success: true, modIds: enabled }); }
      return json({ mods: [{ ...mod, enabled }], orphanModIds: [] });
    }));
    render(<ZomboidMods tint={tint} />);
    fireEvent.click(await screen.findByTitle("Edit mod ids"));
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("B42");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toEqual([{ workshopId: "123456", modIds: ["B42"] }]));
    await waitFor(() => expect(screen.queryByPlaceholderText("AuthenticZ; AuthenticZExtra")).toBeNull());
    expect(enabled).toEqual(["B42"]);
    expect(screen.getAllByText("RootB41").every((el) => el.title === "not in the server's load list")).toBe(true);
    expect(screen.getAllByText("Alternate").every((el) => el.title === "not in the server's load list")).toBe(true);
  });
  it("keeps an edit through pending polling and refreshes enabled IDs after cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let reads = 0;
      vi.stubGlobal("fetch", vi.fn(async () => json({ mods: [{ ...mod, downloaded: reads++ > 0, enabled: reads > 1 ? ["B42", "Alternate"] : ["B42"] }], orphanModIds: [] })));
      render(<ZomboidMods tint={tint} />); await act(async () => {});
      fireEvent.click(screen.getByTitle("Edit mod ids"));
      await act(async () => vi.advanceTimersByTime(15000));
      expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("B42");
      expect(reads).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Cancel mod edit" }));
      await act(async () => vi.advanceTimersByTime(15000));
      fireEvent.click(screen.getByTitle("Edit mod ids"));
      expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("B42; Alternate");
    } finally { vi.useRealTimers(); }
  });

  it("drops cancelled draft changes and seeds the next edit from current enabled IDs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ mods: [mod], orphanModIds: [] })));
    render(<ZomboidMods tint={tint} />); fireEvent.click(await screen.findByTitle("Edit mod ids"));
    fireEvent.change(screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra"), { target: { value: "B42; Alternate" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel mod edit" }));
    fireEvent.click(screen.getByTitle("Edit mod ids"));
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("B42");
  });
});

describe.each([
  ["quick settings", () => <ZomboidQuickSettings tint={tint} />, quick, "Retry quick settings"],
  ["map list", () => <ZomboidMaps tint={tint} />, maps, "Retry map list"],
] as const)("%s failed initial reads", (_label, component, valid, retry) => {
  it.each(["network", "denied", "shape"])("shows a retryable error after %s", async (failure) => {
    let first = true; const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method) { writes.push(init); return json({}); }
      if (first) { first = false; if (failure === "network") throw new Error("Disconnected"); return failure === "denied" ? json(valid, 403) : json({ error: "malformed" }); }
      return json(valid);
    }));
    render(component()); await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: retry }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: /^Save/ })).not.toBeNull();
  });
});

describe.each([
  ["mods", () => <ZomboidMods tint={tint} />, { mods: [mod], orphanModIds: [] }, "Retry mod list", "Variant Mod"],
  ["updates", () => <ZomboidUpdateStatus tint={tint} />, updates, "Retry update status", "All mods up to date"],
] as const)("PZ %s read states", (_label, component, valid, retry, recovered) => {
  it.each(["network", "denied", "shape"])("shows a usable retry after %s", async (failure) => {
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (first) { first = false; if (failure === "network") throw new Error("Disconnected"); return failure === "denied" ? json(valid, 403) : json({ error: "malformed" }); }
      return json(valid);
    }));
    render(component()); await screen.findByRole("alert");
    expect(screen.queryByText("No mods installed. Paste a Workshop link above to add the first one.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: retry })); await screen.findByText(recovered);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

it("does not call a stale Workshop restart status updating now after polling fails", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    let read = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (read++ > 0) throw new Error("Disconnected");
      return json({ ...updates, applyingSince: Date.now(), applyingTitles: ["Fixture mod"] });
    }));
    render(<ZomboidUpdateStatus tint={tint} />); await act(async () => {});
    expect(screen.getByText("Updating now — restarting the server")).toBeDefined();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Updating now — restarting the server")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("last successful read");
  } finally { vi.useRealTimers(); }
});

it("refuses a partial quick-settings list instead of defaulting the missing field", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ properties: quick.properties.filter((p) => p.name !== "MaxPlayers") })));
  render(<ZomboidQuickSettings tint={tint} />); await screen.findByRole("alert");
  expect(screen.queryByRole("spinbutton")).toBeNull(); expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
});

describe("read-only capabilities", () => {
  beforeEach(() => { state.games = gamesState({ can: NO_POWERS }); });
  it("keeps PZ mods visible without Add/Edit/Remove", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ mods: [mod], orphanModIds: [] })));
    render(<ZomboidMods tint={tint} />); await screen.findByText("Variant Mod");
    expect(screen.queryByRole("button", { name: "Add mod" })).toBeNull();
    expect(screen.queryByTitle("Edit mod ids")).toBeNull(); expect(screen.queryByTitle("Remove mod")).toBeNull();
  });
  it("keeps console output without a command form", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ logs: "Historical console" })));
    render(<GameConsole game="zomboid" />); await screen.findByText("Historical console");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("disables every backup mutation while preserving the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => json(String(url).includes("meta=1") ? {} : [{ name: "fixture.tar.gz", size: 12, createdAt: "2026-01-01" }])));
    render(<GameBackups game="zomboid" />); await screen.findByText("fixture.tar.gz");
    for (const name of ["Create backup", "Restore", "Delete backup fixture.tar.gz"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("disables map changes and save while showing measured maps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(maps))); render(<ZomboidMaps tint={tint} />); await screen.findByText("Town");
    expect((screen.getByRole("button", { name: "Save map order" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByTitle("Lower priority")[0] as HTMLButtonElement).disabled).toBe(true);
  });
  it("omits Workshop Check now for accounts without settings edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(updates))); render(<ZomboidUpdateStatus tint={tint} />); await screen.findByText("All mods up to date");
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
  it.each([MinecraftServerPage, SevenDtdServerPage, ZomboidServerPage])("omits Files from the server page", (Page) => {
    render(<Page />); expect(screen.queryByRole("button", { name: "Files" })).toBeNull(); expect(screen.getByText("Raw server files require settings access.")).toBeDefined();
  });
  it("does not advertise admin Whitelist to non-admins", () => {
    render(<GameSidebar game="zomboid" access={["zomboid"]} />); expect(screen.queryByRole("link", { name: "Whitelist" })).toBeNull();
  });
  it("shows Whitelist to ADMIN from its own capability, independently of settings", () => {
    state.games = gamesState({ can: { ...NO_POWERS, usersManage: true } });
    render(<GameSidebar game="zomboid" access={["zomboid"]} />); expect(screen.getByRole("link", { name: "Whitelist" })).toBeDefined();
  });
});
