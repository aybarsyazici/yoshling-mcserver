// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InventoryEntry, InstalledReading } from "@/lib/mod-inventory";
import { InstalledMods } from "@/components/installed-mods";
import { ZomboidMods } from "@/components/zomboid-mods";
import { gamesState, installBrowserStubs, ALL_POWERS, NO_POWERS } from "./helpers/dom";
const stub = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async (original) => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => stub.games }));
vi.mock("@/components/add-mod-dialog", () => ({ AddModDialog: ({ open }: { open: boolean }) => open ? <div>Browse dialog opened</div> : null }));
vi.mock("@/components/change-pack-dialog", () => ({ ChangePackDialog: ({ open, counts }: { open: boolean; counts: unknown }) => open ? <div data-testid="full-pack-counts">{JSON.stringify(counts)}</div> : null }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
beforeAll(installBrowserStubs);
beforeEach(() => { stub.games = gamesState({ can: ALL_POWERS }); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const entry = (name: string, fileName: string, over: Partial<InventoryEntry> = {}): InventoryEntry => ({
  id: name, name, fileName, state: "matched", source: "manual", version: "1", mcVersion: "1.21.1", loader: "fabric", modrinthId: `project-${name}`, slug: name.toLowerCase(), versionId: `version-${name}`, installedBy: "actor", installedByName: "Actor", installedAt: "2026-10-01", sizeBytes: 12, sha512: null, ...over,
});
const mc = [
  entry("Copper Tools", "copper[v1].jar", { source: "pack", modrinthId: "COPPER-ID", versionId: "COPPER-VERSION" }),
  entry("Quartz Library", "quartz.jar", { state: "missing", source: "pack", sizeBytes: null }),
  entry("Map Helper", "map-helper.jar"), entry("Legacy Mod", "legacy.jar", { source: null }),
  entry("loose.jar", "loose.jar", { id: null, modrinthId: null, versionId: null, slug: null, state: "untracked", source: null }),
];
const mcReading = (mods = mc): InstalledReading => ({ mods, matched: mods.filter((m) => m.state === "matched").map((m) => m.fileName), missing: mods.filter((m) => m.state === "missing").map((m) => m.fileName), untracked: mods.filter((m) => m.state === "untracked").map((m) => m.fileName), ignored: [], modsDirPresent: true, hashed: false, totalBytes: 48, pack: null, server: { mcVersion: "1.21.1", loader: "fabric" } });
const pz = [
  { workshopId: "111111", title: "Variant Tools", previewUrl: null, provides: ["VariantB42", "VariantB41"], enabled: ["VariantB42"], downloaded: true },
  { workshopId: "222222", title: "Pending Library", previewUrl: null, provides: ["PendingLib"], enabled: ["PendingLib"], downloaded: false },
  { workshopId: "333333", title: "Unknown IDs", previewUrl: null, provides: [], enabled: [], downloaded: true },
  { workshopId: "444444", title: "Disabled Extras", previewUrl: null, provides: ["Extras"], enabled: [], downloaded: true },
];
function setup({ minecraft = mcReading(), zomboid = pz, orphans = ["ZuluLoose", "AlphaLoose"] } = {}) {
  const requests: { url: string; method: string; body?: unknown; headers?: Headers }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const method = init?.method ?? "GET"; requests.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers ? new Headers(init.headers) : undefined });
    const body = method === "GET" ? String(url).startsWith("/api/mods/installed") ? minecraft : { mods: zomboid, orphanModIds: orphans } : { success: true };
    return new Response(JSON.stringify(body), { headers: { "X-File-Revision": '"full-list-revision"' } });
  }));
  return requests;
}
function rows(game: "minecraft" | "zomboid") {
  const list = document.querySelector(`[data-mod-list="${game}"]`);
  return list?.textContent ?? "";
}
async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.mouseMove(item); fireEvent.focus(item); fireEvent.keyDown(item, { key: "Enter" });
}
const search = (game: "Minecraft" | "PZ", text: string) => fireEvent.change(screen.getByRole("searchbox", { name: `Search ${game} mods` }), { target: { value: text } });
async function viewMC() { render(<InstalledMods />); await screen.findByRole("searchbox", { name: "Search Minecraft mods" }); }
async function viewPZ() { render(<ZomboidMods tint="var(--pz)" />); await screen.findByRole("searchbox", { name: "Search PZ mods" }); }

describe("Minecraft inventory search and filters", () => {
  it.each(["Copper Tools", "  copper-id  ", "copper-version", "copper[v1].jar"])("filters actual rows by %s with accurate counts and no new requests", async (query) => {
    const requests = setup(); await viewMC(); search("Minecraft", query);
    expect(rows("minecraft")).toContain("Copper Tools"); expect(rows("minecraft")).not.toContain("Map Helper");
    expect(screen.getByRole("status").textContent).toBe("Showing 1 of 5 mod entries"); expect(requests).toHaveLength(1);
  });
  it("combines file state and recorded origin, then resets every control", async () => {
    setup(); await viewMC(); await choose("File state", "Tracked jar present"); await choose("Recorded origin", "From a pack");
    expect(rows("minecraft")).toContain("Copper Tools"); expect(rows("minecraft")).not.toContain("Map Helper"); expect(rows("minecraft")).not.toContain("Quartz Library");
    await choose("File state", "Missing jar"); search("Minecraft", "quartz");
    expect(rows("minecraft")).toContain("Quartz Library"); expect(rows("minecraft")).not.toContain("Copper Tools");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(""); expect(screen.getByRole("status").textContent).toBe("Showing 5 of 5 mod entries");
    expect(rows("minecraft")).toContain("loose.jar"); expect(rows("minecraft")).toContain("Map Helper");
  });
  it("shows no matches without replacing the full summary, diagnostic bands or pack action counts", async () => {
    setup(); await viewMC(); search("Minecraft", "absent");
    expect(screen.getByText("No Minecraft mods match these filters.")).toBeDefined(); expect(screen.queryByText("No mods installed")).toBeNull();
    expect(screen.getByText(/4 jars in the mods folder/)).toBeDefined();
    expect(document.querySelector('[data-band="missing"]')?.textContent).toContain("quartz.jar");
    expect((screen.getByRole("button", { name: "Hash the jars" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Change pack" }));
    expect(JSON.parse(screen.getByTestId("full-pack-counts").textContent!)).toMatchObject({ jars: 4, fromPack: 1, ownInstall: 1, unrecorded: 1, untracked: 1, missing: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Show all mods" })); expect(screen.getByRole("status").textContent).toBe("Showing 5 of 5 mod entries");
  });
  it("keeps Add/Browse and full re-check actions available with no matches, without changing the search", async () => {
    const requests = setup(); await viewMC(); search("Minecraft", "absent");
    fireEvent.click(screen.getByRole("button", { name: "Add a mod" })); expect(screen.getByText("Browse dialog opened")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Re-check" })); await waitFor(() => expect(requests).toHaveLength(2));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("absent"); expect(screen.getByRole("status").textContent).toBe("Showing 0 of 5 mod entries");
  });
  it("lets read-only members search while keeping existing write permissions", async () => {
    stub.games = gamesState({ can: NO_POWERS }); setup(); await viewMC(); await choose("File state", "Untracked jar");
    expect(rows("minecraft")).toContain("loose.jar"); expect(screen.queryByRole("button", { name: "Change pack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull(); expect(screen.getByRole("button", { name: "Browse mods" })).toBeDefined();
  });
});

describe("PZ Workshop search and filters", () => {
  it.each(["Variant Tools", "111111", "variantb41"])("searches %s including disabled variant IDs with no write or new read", async (query) => {
    const requests = setup(); await viewPZ(); search("PZ", query);
    expect(rows("zomboid")).toContain("Variant Tools"); await waitFor(() => expect(rows("zomboid")).not.toContain("Pending Library"));
    expect(screen.getByRole("status").textContent).toContain("Showing 1 of 4 Workshop items"); expect(requests).toHaveLength(1);
    expect(screen.getByText("3 of 4 downloaded · 1 pending · 1 without a mod id")).toBeDefined();
  });
  it("shows actual download and variant states and preserves install order when reset", async () => {
    setup(); await viewPZ(); await choose("Workshop state", "Pending download"); expect(rows("zomboid")).toContain("Pending Library"); await waitFor(() => expect(rows("zomboid")).not.toContain("Variant Tools"));
    await choose("Workshop state", "With disabled variants"); expect(rows("zomboid")).toContain("Variant Tools"); expect(rows("zomboid")).toContain("Disabled Extras"); await waitFor(() => expect(rows("zomboid")).not.toContain("Unknown IDs"));
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    const body = rows("zomboid"); expect(body.indexOf("Variant Tools")).toBeLessThan(body.indexOf("Pending Library")); expect(body.indexOf("Pending Library")).toBeLessThan(body.indexOf("Unknown IDs"));
  });
  it("searches unpaired IDs without inventing their download state", async () => {
    setup(); await viewPZ(); await choose("Workshop state", "Pending download"); search("PZ", "ZuluLoose");
    await waitFor(() => expect(rows("zomboid")).toBe("")); expect(screen.getByText("ZuluLoose")).toBeDefined(); expect(screen.queryByText("AlphaLoose")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Showing 0 of 4 Workshop items · 1 of 2 unpaired mod IDs"); expect(screen.getByText(/Matching unpaired mod IDs/)).toBeDefined();
  });
  it("shows a no-results view while Add remains available and reset restores the full list", async () => {
    const requests = setup(); await viewPZ(); search("PZ", "absent");
    expect(screen.getByText("No Workshop items match these filters.")).toBeDefined(); expect(screen.queryByText(/No mods installed/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/steamcommunity/), { target: { value: "999999" } });
    expect((screen.getByRole("button", { name: "Add mod" }) as HTMLButtonElement).disabled).toBe(false);
    expect(requests).toHaveLength(1); fireEvent.click(screen.getByRole("button", { name: "Show all mods" })); expect(rows("zomboid")).toContain("Pending Library");
  });
  it("keeps a current ID draft intact while filter controls are locked and saves only enabled IDs", async () => {
    const requests = setup(); await viewPZ(); search("PZ", "111111"); await waitFor(() => expect(screen.getAllByTitle("Edit mod ids")).toHaveLength(1)); fireEvent.click(screen.getByTitle("Edit mod ids"));
    expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true); expect((screen.getByRole("combobox", { name: "Workshop state" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Save or cancel the mod ID edit/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    const patch = requests.find((r) => r.method === "PATCH")!; expect(patch.body).toEqual({ workshopId: "111111", modIds: ["VariantB42"] }); expect(patch.headers?.get("X-Expected-File-Revision")).toBe('"full-list-revision"');
    await waitFor(() => expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(false));
  });
  it("keeps pending polling based on the full list even when the visible filter excludes pending items", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests = setup(); await viewPZ(); await choose("Workshop state", "Downloaded");
    await act(async () => vi.advanceTimersByTime(15000)); expect(requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });
  it("keeps read-only controls hidden while exposing filters", async () => {
    stub.games = gamesState({ can: NO_POWERS }); setup(); await viewPZ(); search("PZ", "Extras");
    expect(rows("zomboid")).toContain("Disabled Extras"); expect(screen.queryByRole("button", { name: "Add mod" })).toBeNull(); expect(screen.queryByTitle("Edit mod ids")).toBeNull(); expect(screen.queryByTitle("Remove mod")).toBeNull();
  });
  it("handles an orphan-only reading without calling it a Workshop match", async () => {
    setup({ zomboid: [], orphans: ["LooseOnly"] }); await viewPZ(); search("PZ", "LooseOnly");
    expect(screen.getByText("LooseOnly")).toBeDefined(); expect(screen.getByRole("status").textContent).toContain("0 of 0 Workshop items · 1 of 1 unpaired mod IDs");
    expect(screen.queryByText(/No mods installed/)).toBeNull(); expect(screen.getByText("No Workshop items match these filters.")).toBeDefined();
  });
});

describe("adjacent deletion and background-read integrity", () => {
  it.each(["network", "malformed receipt", "missing success"])("reconciles a possibly applied Minecraft deletion after %s without retry or invented no-change", async (failure) => {
    const pending: { promise: Promise<Response>; reject(reason: Error): void; resolve(value: Response): void } = (() => {
      let reject!: (reason: Error) => void; let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((ok, no) => { resolve = ok; reject = no; }); return { promise, reject, resolve };
    })();
    const requests: string[] = []; let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "DELETE") { requests.push("DELETE"); return pending.promise; }
      requests.push("GET"); return new Response(JSON.stringify(mcReading(++reads === 1 ? mc : mc.filter((m) => m.name !== "Map Helper"))));
    }));
    await viewMC(); search("Minecraft", "Map Helper"); fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(toasts.info).not.toHaveBeenCalled();
    await act(async () => {
      if (failure === "network") pending.reject(new Error("Reply lost"));
      else pending.resolve(failure === "malformed receipt" ? new Response("<html>proxy</html>") : new Response(JSON.stringify({})));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Showing 0 of 4 mod entries"));
    expect(toasts.success).not.toHaveBeenCalled(); expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("result is unconfirmed"));
    expect(toasts.info.mock.calls[0][0]).not.toContain("Nothing was changed"); expect(requests).toEqual(["GET", "DELETE", "GET"]);
  });
  it("pauses pending polling while editing, retains the draft, then resumes on Cancel", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests = setup(); await viewPZ();
    fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]); fireEvent.change(screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra"), { target: { value: "VariantB42; CustomDraft" } });
    await act(async () => vi.advanceTimersByTime(45000)); expect(requests).toHaveLength(1);
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("VariantB42; CustomDraft");
    expect((screen.getByPlaceholderText(/steamcommunity/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTitle("Remove mod")).toBeNull();
    expect(screen.queryByTitle("Edit mod ids")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel mod edit" })); await act(async () => vi.advanceTimersByTime(15000));
    expect(requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });
  it("resumes pending polling after Save without losing the configured enabled subset", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests = setup(); await viewPZ(); fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]);
    await act(async () => vi.advanceTimersByTime(15000)); expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.filter(r => r.method === "GET")).toHaveLength(2));
    expect(requests.find(r => r.method === "PATCH")?.body).toEqual({ workshopId: "111111", modIds: ["VariantB42"] });
    await act(async () => vi.advanceTimersByTime(15000)); expect(requests.filter(r => r.method === "GET")).toHaveLength(3);
  });
  it("keeps a permission-revoked draft read-only with Cancel, then resumes full-list polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests = setup(); const view = render(<ZomboidMods tint="var(--pz)" />); await screen.findByRole("searchbox");
    fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]); fireEvent.change(screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra"), { target: { value: "CustomDraft" } });
    stub.games = gamesState({ can: NO_POWERS }); view.rerender(<ZomboidMods tint="var(--pz)" />);
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("CustomDraft");
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByText(/This draft is read-only/)).toBeDefined();
    await act(async () => vi.advanceTimersByTime(30000)); expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel mod edit" })); await act(async () => vi.advanceTimersByTime(15000));
    expect(requests.filter(r => r.method === "GET")).toHaveLength(2); expect(requests.some(r => r.method !== "GET")).toBe(false);
    expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(false); expect(screen.queryByTitle("Edit mod ids")).toBeNull();
  });
  it("ignores a background response from before an edit even when the draft was already cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolve!: (response: Response) => void; const background = new Promise<Response>(ok => { resolve = ok; }); let gets = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++gets === 1 ? new Response(JSON.stringify({ mods: pz, orphanModIds: [] })) : background));
    await viewPZ(); await act(async () => vi.advanceTimersByTime(15000)); expect(gets).toBe(2);
    fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]); fireEvent.click(screen.getByRole("button", { name: "Cancel mod edit" }));
    await act(async () => resolve(new Response(JSON.stringify({ mods: [{ ...pz[0], enabled: ["VariantB41"] }], orphanModIds: [] }))));
    expect(screen.getByRole("status").textContent).toContain("Showing 4 of 4 Workshop items");
    fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]); expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("VariantB42");
  });
  it("ignores an in-flight background response after editing begins and keeps the draft revision", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolve!: (response: Response) => void; const background = new Promise<Response>((ok) => { resolve = ok; }); let gets = 0;
    const writes: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PATCH") { writes.push(new Headers(init.headers)); return new Response(JSON.stringify({ error: "Changed on disk", stale: true }), { status: 409 }); }
      if (++gets > 1) return background;
      return new Response(JSON.stringify({ mods: pz, orphanModIds: [] }), { headers: { "X-File-Revision": '"draft-revision"' } });
    }));
    await viewPZ();
    await act(async () => vi.advanceTimersByTime(15000)); expect(gets).toBe(2);
    fireEvent.click(screen.getAllByTitle("Edit mod ids")[0]); fireEvent.change(screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra"), { target: { value: "VariantB42; CustomDraft" } });
    await act(async () => resolve(new Response(JSON.stringify({ mods: [{ ...pz[0], enabled: ["VariantB41"] }], orphanModIds: [] }), { headers: { "X-File-Revision": '"later-background-revision"' } })));
    expect((screen.getByPlaceholderText("AuthenticZ; AuthenticZExtra") as HTMLInputElement).value).toBe("VariantB42; CustomDraft");
    fireEvent.click(screen.getByRole("button", { name: "Save" })); await screen.findByRole("alert");
    expect(writes[0].get("X-Expected-File-Revision")).toBe('"draft-revision"');
    expect(toasts.success).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Retry mod list" })).toBeDefined();
  });
});
