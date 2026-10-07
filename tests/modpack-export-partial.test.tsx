// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modpacks } from "@/components/modpacks";
import { gamesState, installBrowserStubs } from "./helpers/dom";
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState(), CAPABILITY_POLL_MS: 30000 }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
beforeAll(installBrowserStubs); afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const pack = { id: "p1", name: "Saved target", description: "", createdBy: "u", createdAt: "2026-01-01", targetMcVersion: "1.21.1", targetLoader: "fabric", mods: [{ id: "m1", name: "First", slug: "first", modrinthId: "m1", versionId: "v1" }] };
const good = { name: "First", slug: "first", modrinthId: "m1", fileName: "first.jar", downloadUrl: "https://fixture.invalid/first.jar", version: "1" };
async function open(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith("/export") ? payload : String(url) === "/api/modpacks" ? [pack] : { versions: ["1.21.1"] }))));
  render(<Modpacks />); fireEvent.click(await screen.findByRole("button", { name: "Export" }));
  await screen.findByText('Install "Saved target" Locally');
}
describe("export completeness", () => {
  it("names unresolved entries and prevents ordinary bulk download for a partial export", async () => {
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await open({ modpack: { name: "Saved target", description: "", mcVersion: "1.21.1", loader: "fabric" }, complete: false, unresolved: [{ name: "Missing build", reason: "Pinned version unavailable" }], mods: [good, { ...good, name: "Missing build", downloadUrl: null }] });
    expect(screen.getByRole("alert").textContent).toContain("Missing build: Pinned version unavailable");
    const bulk = screen.getByRole("button", { name: "Download All" }) as HTMLButtonElement;
    expect(bulk.disabled).toBe(true); fireEvent.click(bulk); expect(clicks).not.toHaveBeenCalled();
  });
  it("does not assume a target for a legacy export with unknown saved version and loader", async () => {
    await open({ modpack: { name: "Saved target", description: "", mcVersion: null, loader: null }, complete: false, unresolved: [{ name: "Saved target", reason: "Target unknown" }], mods: [good] });
    expect(screen.getByText(/No target was assumed/)).toBeDefined(); expect((screen.getByRole("button", { name: "Download All" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not label a saved NeoForge target as Forge", async () => {
    await open({ modpack: { name: "Saved target", description: "", mcVersion: "1.21.1", loader: "neoforge" }, complete: true, unresolved: [], mods: [good] });
    expect(screen.getByText("neoforge", { selector: "strong" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Forge" })).toBeNull();
  });
  it("allows a verified complete export and reports only requested downloads", async () => {
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await open({ modpack: { name: "Saved target", description: "", mcVersion: "1.21.1", loader: "fabric" }, complete: true, unresolved: [], mods: [good] });
    const bulk = screen.getByRole("button", { name: "Download All" }) as HTMLButtonElement;
    expect(bulk.disabled).toBe(false); fireEvent.click(bulk); expect(clicks).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("1.21.1");
  });
});
