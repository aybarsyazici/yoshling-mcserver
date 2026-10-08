// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/app/minecraft/settings/page";
import { hasUnsavedSettings } from "@/lib/use-unsaved-settings";
import { gamesState, installBrowserStubs } from "./helpers/dom";
vi.mock("@/lib/use-games", async original => ({ ...await original<typeof import("@/lib/use-games")>(), useGames: () => gamesState() }));
vi.mock("@/components/memory-card", () => ({ MemoryCard: () => null }));
vi.mock("@/components/mc-game-rules", () => ({ McGameRules: () => null }));
vi.mock("@/components/mc-bans-card", () => ({ McBansCard: () => null }));
vi.mock("@/components/minecraft-profile-context", () => ({ MinecraftProfileContext: () => null }));
vi.mock("@/components/photo-footer", () => ({ PhotoFooter: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
beforeAll(installBrowserStubs);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const baseOp = { uuid: "test-op", name: "OriginalOp", level: 4, bypassesPlayerLimit: false }, baseWl = { uuid: "test-wl", name: "OriginalPlayer" };
beforeEach(() => {
  let ops: unknown[] = [baseOp], whitelist: unknown[] = [baseWl];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") { if (url.endsWith("/ops")) ops = JSON.parse(init.body as string); if (url.endsWith("/mc-whitelist")) whitelist = JSON.parse(init.body as string); }
    const data = url === "/api/settings" ? { mcVersion: "26.1.2", modLoader: "fabric", targetEditable: true } : url === "/api/minecraft-versions" ? { versions: ["26.1.2", "1.21.1"] } : url.endsWith("/ops") ? ops : url.endsWith("/mc-whitelist") ? whitelist : url.endsWith("/properties") ? { motd: "Original world" } : {};
    return new Response(JSON.stringify(data), { headers: { "X-Minecraft-Context": "test-context", "X-File-Revision": '"test-r1"' } });
  }));
});
function panel(title: string) { return within(screen.getByText(title).closest("[data-slot=card]")! as HTMLElement); }
async function ready() { render(<SettingsPage />); await screen.findByText("OriginalOp"); await screen.findByText("OriginalPlayer"); await waitFor(() => expect(hasUnsavedSettings()).toBe(false)); }
describe("actual Minecraft Settings drafts block tour entry", () => {
  it("registers a changed server property before any write", async () => { await ready(); fireEvent.change(await screen.findByDisplayValue("Original world"), { target: { value: "My unsaved world" } }); await waitFor(() => expect(hasUnsavedSettings()).toBe(true)); expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true); });
  it.each([{ title: "Operators (ops.json)", add: "Add Op", name: "DraftOp", remove: "Remove operator DraftOp", save: "Save Ops" }, { title: "MC Whitelist (whitelist.json)", add: "Add Player", name: "DraftPlayer", remove: "Remove whitelisted player DraftPlayer", save: "Save Whitelist" }])("tracks typed and added entries in $title, then clears only after readback", async item => {
    await ready(); const list = panel(item.title), input = list.getByPlaceholderText("Minecraft username");
    fireEvent.change(input, { target: { value: item.name } }); expect(hasUnsavedSettings()).toBe(true);
    fireEvent.click(list.getByRole("button", { name: item.add })); expect((input as HTMLInputElement).value).toBe(""); expect(hasUnsavedSettings()).toBe(true);
    fireEvent.click(list.getByRole("button", { name: item.remove })); expect(hasUnsavedSettings()).toBe(false);
    fireEvent.change(input, { target: { value: item.name } }); fireEvent.click(list.getByRole("button", { name: item.add })); fireEvent.click(list.getByRole("button", { name: item.save }));
    await waitFor(() => expect(hasUnsavedSettings()).toBe(false)); expect(list.getByText(item.name)).toBeTruthy();
  });
  it("keeps removed canonical entries dirty and releases registration on unmount", async () => {
    await ready(); fireEvent.click(panel("Operators (ops.json)").getByRole("button", { name: "Remove operator OriginalOp" })); expect(hasUnsavedSettings()).toBe(true); cleanup(); expect(hasUnsavedSettings()).toBe(false);
  });
});
