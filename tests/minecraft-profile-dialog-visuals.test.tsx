// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MinecraftProfileCreate } from "@/components/minecraft-profile-create";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { ProfileDraftPreview } from "@/components/minecraft-profile-dialog-visuals";
import { gamesState, installBrowserStubs, NO_POWERS, opsState } from "./helpers/dom";
import { profilesFixture } from "./helpers/minecraft-profiles";
const boundary = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));
beforeAll(installBrowserStubs);
beforeEach(() => { boundary.games = gamesState(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const json = (body: unknown) => new Response(JSON.stringify(body));
function backend() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async url => {
    const path = String(url); calls.push(path);
    return json(path === "/api/minecraft-versions" ? { versions: ["1.21.1"] } : path.startsWith("/api/modpacks/search") ? { hits: [{ project_id: "pack-a", title: "Pack A" }] } : path.includes("profile-sources") ? { project: { id: "pack-a", title: "Pack A" }, versions: [{ id: "build-a", name: "Build A", versionNumber: "4.2", mcVersions: ["1.21.1"], loaders: ["fabric"], publishedAt: "2026-10-08T10:00:00Z", supported: true }] } : []);
  })); return calls;
}
function create() { return render(<MinecraftProfileCreate open data={profilesFixture()} onOpenChange={vi.fn()} onPrepared={vi.fn()} />); }

it("keeps source tiles as the single accessible choice and treats clicking the selected tile as a no-op", async () => {
  const calls = backend(); create(); await screen.findByRole("option", { name: "1.21.1" });
  fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), { target: { value: "Sunday survival" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Minecraft version" }), { target: { value: "1.21.1" } });
  const group = within(screen.getByRole("group", { name: "Start from" })); expect(group.getAllByRole("button")).toHaveLength(3); expect(screen.queryByRole("combobox", { name: "Start from" })).toBeNull();
  const selected = group.getByRole("button", { name: "Vanilla" }); expect(selected.getAttribute("aria-pressed")).toBe("true"); fireEvent.click(selected);
  expect((screen.getByRole("button", { name: "Prepare profile" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("textbox", { name: "Profile name" }) as HTMLInputElement).value).toBe("Sunday survival");
  expect((screen.getByRole("combobox", { name: "Minecraft version" }) as HTMLSelectElement).value).toBe("1.21.1"); expect(screen.queryByText("Reading available sources…")).toBeNull(); expect(calls).toEqual(["/api/minecraft-versions"]);
});
it("clears the live preview's old declared target when a new search no longer has a selected pack", async () => {
  backend(); create(); fireEvent.click(screen.getByRole("button", { name: "Published pack" })); await screen.findByRole("option", { name: "Pack A" });
  fireEvent.change(screen.getByRole("combobox", { name: "Published pack" }), { target: { value: "pack-a" } }); await screen.findByRole("option", { name: /Build A.*4.2/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Published pack build" }), { target: { value: "build-a" } });
  const preview = within(screen.getByRole("complementary", { name: "Profile preview" })); expect(preview.getByText("Declared MC 1.21.1 · fabric · 4.2")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search published packs" }), { target: { value: "Another adventure" } });
  expect(preview.queryByText("Declared MC 1.21.1 · fabric · 4.2")).toBeNull(); expect(preview.getByText("Choose an exact published build")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Prepare profile" }) as HTMLButtonElement).disabled).toBe(true);
});
it("keeps tile interaction unavailable without verified editing permission", async () => {
  boundary.games = gamesState({ can: NO_POWERS }); const calls = backend(); create(); await screen.findByRole("option", { name: "1.21.1" });
  const tile = screen.getByRole("button", { name: "Published pack" }) as HTMLButtonElement; expect(tile.disabled).toBe(true); fireEvent.click(tile); expect(tile.getAttribute("aria-pressed")).toBe("false"); expect(calls).toEqual(["/api/minecraft-versions"]);
});
it("renders an optional empty description and marks the preview as a draft illustration", () => { render(<ProfileDraftPreview name="" source="Vanilla" target="Choose a version" />); expect(screen.getByText("Your next adventure")).toBeTruthy(); expect(screen.getByText("Your profile · Draft illustration")).toBeTruthy(); });
it("uses decorative non-focusable scenes with unique gradient identities", () => { const view = render(<><MinecraftProfileScene /><MinecraftProfileScene variant="adopt" /></>); const scenes = view.container.querySelectorAll("svg"); expect(scenes).toHaveLength(2); for (const scene of scenes) { expect(scene.getAttribute("aria-hidden")).toBe("true"); expect(scene.getAttribute("focusable")).toBe("false"); } const ids = [...view.container.querySelectorAll("defs [id]")].map(node => node.id); expect(new Set(ids).size).toBe(ids.length); });
it("keeps decorative animation off under OS reduced motion while revealing every form section", async () => { backend(); const view = create(); await screen.findByRole("option", { name: "1.21.1" }); expect(view.container.ownerDocument.querySelector('[data-motion-mode="animated"]')).toBeNull(); expect(view.container.ownerDocument.querySelector('[data-motion-mode="reduced"]')).toBeTruthy(); const sections = [...view.container.ownerDocument.querySelectorAll("[data-profile-motion]")]; expect(sections.length).toBeGreaterThan(0); expect(sections.every(section => section.getAttribute("data-profile-motion") === "reduced")).toBe(true); expect(screen.getByRole("textbox", { name: "Profile name" })).toBeTruthy(); });
it("offers ambient motion when requested and reduced motion is not active", async () => { vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => false) })); const view = render(<MinecraftProfileScene animated />); await waitFor(() => expect(view.container.querySelector('[data-motion-mode="animated"]')).toBeTruthy()); });
