// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMinecraftProfileRequest } from "@/hooks/use-minecraft-profile-request";
import { InstalledMods } from "@/components/installed-mods";
import { GameBackups } from "@/components/game-backups";
import { GameConsole } from "@/components/game-console";
import { ModBrowser } from "@/components/mod-browser";
import MinecraftSettings from "@/app/minecraft/settings/page";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
import { profilesFixture } from "./helpers/minecraft-profiles";
import type { InstalledReading, InventoryEntry } from "@/lib/mod-inventory";
const boundary = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));
vi.mock("@/components/add-mod-dialog", () => ({ AddModDialog: () => null }));
vi.mock("@/components/change-pack-dialog", () => ({ ChangePackDialog: () => null }));
vi.mock("@/components/memory-card", () => ({ MemoryCard: () => null }));
vi.mock("@/components/mc-game-rules", () => ({ McGameRules: () => null }));
vi.mock("@/components/mc-bans-card", () => ({ McBansCard: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
beforeAll(installBrowserStubs);
beforeEach(() => { boundary.games = gamesState(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, context: string | null = "A@1", status = 200) => new Response(JSON.stringify(body), { status, headers: context ? { "X-Minecraft-Context": context } : {} });
function inventory(name = "Initial A"): InstalledReading {
  const mod: InventoryEntry = { id: "row", modrinthId: "m1", slug: "mod", name, version: "1", fileName: "a.jar", mcVersion: "1.21.1", loader: "fabric", source: "manual", versionId: "v1", installedBy: "actor", installedByName: "Actor", installedAt: "2026-10-07T10:00:00Z", state: "matched", sizeBytes: 12, sha512: null };
  return { mods: [mod], matched: ["a.jar"], missing: [], untracked: [], ignored: [], hashed: false, modsDirPresent: true, totalBytes: 12, pack: null, server: { mcVersion: "1.21.1", loader: "fabric" } };
}
function HookHarness() {
  const request = useMinecraftProfileRequest(); const [message, setMessage] = React.useState("");
  return <><p>Ready: {String(request.contextReady)}</p><p role="status">{message}</p><button onClick={() => void request.request("/read").catch(error => setMessage(error.message))}>Read context</button><button onClick={() => void request.request("/write", { method: "PUT" }).catch(error => setMessage(error.message))}>Attempt mutation</button></>;
}
function InheritedBrowser() { const context = useMinecraftProfileRequest(); const request = context.request; const [ready, setReady] = React.useState(false); React.useEffect(() => { void request("/parent-read").then(() => setReady(true)); }, [request]); return ready ? <ModBrowser activeRequest={context} /> : null; }
import * as React from "react";
describe("real profile request hook and active surfaces", () => {
  it("does not let a new mod browser silently bind profile B beneath an A editor", async () => { const writes: string[] = []; vi.stubGlobal("fetch", vi.fn(async (url, init) => { if (init?.method) writes.push(String(url)); const path = String(url); return path === "/parent-read" ? json({}) : path.includes("/mods/search") ? json({ hits: [{ project_id: "mod", title: "B-only mod", slug: "mod", description: "fixture", author: "fixture", categories: [], downloads: 1, icon_url: null }], total_hits: 1 }, "B@2") : json([]); })); render(<InheritedBrowser />); await screen.findByRole("alert"); expect(screen.getByRole("alert").textContent).toContain("Minecraft profile changed"); expect(screen.queryByRole("button", { name: "Install" })).toBeNull(); expect(writes).toEqual([]); });
  it("refuses a mutation without a first context read before any network write", async () => { const fetcher = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetcher); render(<HookHarness />); fireEvent.click(screen.getByRole("button", { name: "Attempt mutation" })); await screen.findByText(/Read the Minecraft profile context before editing/); expect(fetcher).not.toHaveBeenCalled(); });
  it("does not enable inventory mutation from a readable response with no context header", async () => { const fetcher = vi.fn(async () => json(inventory(), null)); vi.stubGlobal("fetch", fetcher); render(<InstalledMods />); await screen.findByText("Initial A"); expect(screen.queryByRole("button", { name: "Remove" })).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1); });
  it("pins inventory deletion to the first read rather than acquiring context at click", async () => { const writes: Headers[] = []; vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "DELETE") { writes.push(new Headers(init.headers)); return json({ success: true }); } return json(inventory()); })); render(<InstalledMods />); fireEvent.click(await screen.findByRole("button", { name: "Remove" })); await waitFor(() => expect(writes).toHaveLength(1)); expect(writes[0].get("X-Minecraft-Context")).toBe("A@1"); });
  it("never re-enables an invalidated editor when an older in-flight context reply finally arrives", async () => {
    let resolveOps!: (response: Response) => void, resolveProps!: (response: Response) => void;
    const oldOps = new Promise<Response>(ok => { resolveOps = ok; }), oldProps = new Promise<Response>(ok => { resolveProps = ok; });
    vi.stubGlobal("fetch", vi.fn(async url => String(url) === "/api/settings" ? json({ mcVersion: "1.21.1", modLoader: "fabric", targetEditable: true }) : String(url).includes("/profiles") ? json(profilesFixture()) : String(url).includes("/minecraft-versions") ? json({ versions: ["1.21.1"] }) : String(url).includes("/ops") ? oldOps : String(url).includes("/properties") ? oldProps : json([], "B@2")));
    render(<MinecraftSettings />); await screen.findAllByText(/The Minecraft profile changed/);
    expect((screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolveOps(json([{ uuid: "op", name: "Old operator", level: 4, bypassesPlayerLimit: false }])); resolveProps(json({})); });
    expect((screen.getByRole("button", { name: "Save Ops" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("adds the pinned Minecraft context to streaming backup links and omits it for other games", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => String(url).includes("meta=1") ? json({ policy: { keep: 5, maxAgeDays: 0 }, schedule: { enabled: false, everyHours: 24 }, journal: [], canDownload: true }) : json([{ name: "same-name.tar.gz", size: 12, createdAt: "2026-10-07", verifiable: true }])));
    const view = render(<GameBackups game="minecraft" />); const link = await screen.findByRole("link", { name: "Download backup same-name.tar.gz" }); expect(new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("context")).toBe("A@1");
    view.unmount(); render(<GameBackups game="zomboid" />); const other = await screen.findByRole("link", { name: "Download backup same-name.tar.gz" }); expect(new URL(other.getAttribute("href")!, "http://localhost").searchParams.has("context")).toBe(false);
  });
  it("keeps recovery logs readable without enabling commands from an unverified context", async () => { vi.stubGlobal("fetch", vi.fn(async url => String(url).includes("active-profile") ? json({ error: "Runtime drift" }, null, 409) : json({ logs: "Recovery log remains readable" }, null))); render(<GameConsole game="minecraft" />); await screen.findByText("Recovery log remains readable"); expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); });
  it("locks the old target editor when the server marks the version/loader profile-owned", async () => {
    const writes: unknown[] = []; vi.stubGlobal("fetch", vi.fn(async (url, init) => { if (init?.method === "PUT") { writes.push(init.body); return json({}); } const name = String(url); return json(name === "/api/settings" ? { mcVersion: "1.21.1", modLoader: "vanilla", targetEditable: false } : name.includes("/profiles") ? profilesFixture() : name.includes("/minecraft-versions") ? { versions: ["1.21.1"] } : name.includes("/properties") ? {} : []); }));
    render(<MinecraftSettings />); await screen.findByText(/Version and loader belong to a prepared profile/); await screen.findByRole("button", { name: "Save & Restart Server" }); expect((screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Save & Restart Server" })); expect(writes).toEqual([]);
  });
});
