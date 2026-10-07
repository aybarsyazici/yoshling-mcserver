// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FileBrowser } from "@/components/file-browser";
import { ConfigPanel } from "@/components/config-panel";
import { ZomboidQuickSettings } from "@/components/zomboid-quick-settings";
import { ZomboidMaps } from "@/components/zomboid-maps";
import { ZomboidMods } from "@/components/zomboid-mods";
import MinecraftSettings from "@/app/minecraft/settings/page";
import SevenDtdSettings from "@/app/7dtd/settings/page";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
vi.mock("@/lib/use-games", async (original) => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => gamesState() }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));
vi.mock("@/components/memory-card", () => ({ MemoryCard: () => null }));
vi.mock("@/components/mc-game-rules", () => ({ McGameRules: () => null }));
vi.mock("@/components/mc-bans-card", () => ({ McBansCard: () => null }));
vi.mock("@/components/sdtd-all-settings", () => ({ SdtdAllSettings: () => null }));
vi.mock("@/components/sdtd-world-upload", () => ({ SdtdWorldUpload: () => null }));
vi.mock("@/components/sdtd-maintenance", () => ({ SdtdMaintenance: () => null }));
vi.mock("@/components/photo-footer", () => ({ PhotoFooter: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
beforeAll(() => { installBrowserStubs(); window.scrollTo = vi.fn(); }); afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, tag: string | null = null, status = 200) => new Response(JSON.stringify(body), { status, headers: tag ? { ETag: tag } : {} });
const tag = '"loaded-revision"';
const property = { name: "FixtureOption", value: "12", help: "fixture" };
const pzQuick = { properties: Object.entries({ PublicName: "Daily world", Password: "fixture", MaxPlayers: "12", Public: "true", PVP: "false", PauseEmpty: "true" }).map(([name,value]) => ({ name,value })) };
const pzMaps = { maps: [], order: ["First", "Last"], conflicts: [], unlisted: [], missing: [], stock: ["First", "Last"], configMissing: false };
const pzMod = { workshopId: "123456", title: "Fixture variants", previewUrl: null, provides: ["Enabled", "Disabled"], enabled: ["Enabled"], downloaded: true };

it("binds file save validators to the loaded identity, advances them after verified writes, and reloads a stale draft", async () => {
  const headers: (string | null)[] = []; let read = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "PUT") { headers.push(new Headers(init.headers).get("If-Match")); return headers.length === 1 ? json({}, '"written-revision"') : json({ error: "Changed on disk", stale: true }, null, 409); }
    return String(url).includes("action=read") ? json({ content: `READ ${++read}` }, tag) : json({ items: [{ name: "fixture.ini", path: "fixture.ini", isDirectory: false, size: 1 }] });
  }));
  render(<FileBrowser endpoint="/api/zomboid/files" roots={[{ key: "config", label: "Config" }]} />);
  fireEvent.click(await screen.findByRole("button", { name: "fixture.ini" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" })); fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Edit" })); fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert"); expect(headers).toEqual([tag, '"written-revision"']);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reload file" })); await screen.findByText("READ 2");
});

describe.each(["/api/zomboid/config", "/api/7dtd/config/all", "/api/zomboid/sandbox?scope=world", "/api/zomboid/sandbox?scope=mods"])("%s revision", (endpoint) => {
  it("sends the loaded validator and disables a stale snapshot until reload", async () => {
    const writes: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); }
      return String(url).includes("/status") ? json({ live: null }) : json({ properties: [property] }, tag);
    }));
    render(<ConfigPanel tint="var(--pz)" endpoint={endpoint} subtitle="Fixture" groupOrder={["Fixture"]} groupOf={() => "Fixture"} />);
    fireEvent.click(screen.getByText("All settings"));
    fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "13" } }); fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 change" }));
    await screen.findByRole("alert"); expect(writes).toEqual([tag]); expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and reload" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("12");
  });
});

describe.each([
  { title: "operators", url: "/api/server/ops", save: "Save Ops", retry: "Retry operators" },
  { title: "whitelist", url: "/api/server/mc-whitelist", save: "Save Whitelist", retry: "Retry Minecraft whitelist" },
])("MC $title snapshots", (surface) => {
  it("includes its own read revision and recovers from stale refusal", async () => {
    const writes: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); }
      const u = String(url);
      if (u === "/api/settings") return json({ mcVersion: "1.21.1", modLoader: "fabric" });
      if (u === "/api/minecraft-versions") return json({ versions: ["1.21.1"] });
      if (u === "/api/server/properties") return json({ "max-players": "12" });
      return json([{ uuid: "id", name: "Player", level: 4, bypassesPlayerLimit: false }], u === surface.url ? tag : '"other-list"');
    }));
    render(<MinecraftSettings />); await waitFor(() => expect((screen.getByRole("button", { name: surface.save }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: surface.save })); await screen.findByRole("button", { name: surface.retry });
    expect(writes).toEqual([tag]); expect((screen.getByRole("button", { name: surface.save }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("sends the server.properties read revision for partial updates", async () => {
  const writes: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ applied: ["max-players"] }, '"new"'); }
    const u = String(url);
    return json(u === "/api/settings" ? { mcVersion: "1.21.1", modLoader: "fabric" } : u === "/api/server/properties" ? { "max-players": "12" } : u === "/api/minecraft-versions" ? { versions: ["1.21.1"] } : [], u === "/api/server/properties" ? tag : null);
  }));
  render(<MinecraftSettings />); const label = await screen.findByText("Max Players"); const row = label.closest("div")!;
  fireEvent.change(within(row as HTMLElement).getByRole("spinbutton"), { target: { value: "13" } }); fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
  await waitFor(() => expect(writes).toEqual([tag]));
});

it("sends the 7DTD quick config read revision", async () => {
  const writes: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); }
    return json({ serverName: "Fixture", password: "fixture", maxPlayers: 12, sandboxCode: "ABCD", sandboxCodeSource: "file" }, tag);
  }));
  render(<SevenDtdSettings />); fireEvent.click(await screen.findByRole("button", { name: "Save settings" }));
  await screen.findByRole("button", { name: "Retry 7DTD settings" }); expect(writes).toEqual([tag]);
});

it("sends the PZ quick config read revision and freezes a stale draft", async () => {
  const writes: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); }
    return json(pzQuick, tag);
  }));
  render(<ZomboidQuickSettings tint="var(--pz)" />); fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "13" } }); fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByRole("alert"); expect(writes).toEqual([tag]); expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
});
it("sends the PZ map list INI revision", async () => {
  const writes: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "PUT") { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); } return json(pzMaps, tag); }));
  render(<ZomboidMaps tint="var(--pz)" />); fireEvent.click((await screen.findAllByTitle("Lower priority"))[0]); fireEvent.click(screen.getByRole("button", { name: "Save map order" }));
  await screen.findByRole("alert"); expect(writes).toEqual([tag]);
});
it.each(["POST", "PATCH", "DELETE"])("sends the PZ mod list INI revision for %s", async (method) => {
  const writes: (string | null)[] = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === method) { writes.push(new Headers(init.headers).get("If-Match")); return json({ error: "Changed on disk", stale: true }, null, 409); } return json({ mods: [pzMod], orphanModIds: [] }, tag); }));
  render(<ZomboidMods tint="var(--pz)" />); await screen.findByText("Fixture variants");
  if (method === "POST") { fireEvent.change(screen.getByPlaceholderText(/steamcommunity/), { target: { value: "987654" } }); fireEvent.click(screen.getByRole("button", { name: "Add mod" })); }
  if (method === "PATCH") { fireEvent.click(screen.getByTitle("Edit mod ids")); fireEvent.click(screen.getByRole("button", { name: "Save" })); }
  if (method === "DELETE") fireEvent.click(screen.getByTitle("Remove mod"));
  await screen.findByRole("alert"); expect(writes).toEqual([tag]);
});
