// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MinecraftGuide } from "@/components/minecraft-guide";
import { MINECRAFT_GUIDE_CHAPTERS } from "@/lib/minecraft-guide";
import { MINECRAFT_GUIDE_CHAPTER_IDS, minecraftGuideStorageKey, parseMinecraftGuideProgress, type MinecraftGuideProgress } from "@/lib/minecraft-guide-progress";
import { ALL_POWERS, gamesState, installBrowserStubs, NO_POWERS } from "./helpers/dom";
const boundary = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage")!;
beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks(); boundary.games = gamesState();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected guide network request"); }));
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { callback(0); return 1; }));
});
afterEach(() => { cleanup(); Object.defineProperty(window, "localStorage", originalStorage); vi.unstubAllGlobals(); });
function storageFixture(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return { storage, values };
}
const progress = (current: MinecraftGuideProgress["current"], completed: MinecraftGuideProgress["completed"] = []): MinecraftGuideProgress => ({ version: 1, current, completed });
const chapters = () => within(screen.getByRole("navigation", { name: "Minecraft guide chapters" }));
const chapterTitle = (id: MinecraftGuideProgress["current"]) => MINECRAFT_GUIDE_CHAPTERS.find(chapter => chapter.id === id)!.title;
const choose = (id: MinecraftGuideProgress["current"]) => fireEvent.click(chapters().getByRole("button", { name: new RegExp(chapterTitle(id)) }));
async function hydrated() { await waitFor(() => expect((screen.getByRole("button", { name: "Start over" }) as HTMLButtonElement).disabled).toBe(false)); }
function currentProgress(values: Map<string, string>, user = "alice") { return parseMinecraftGuideProgress(values.get(minecraftGuideStorageKey(user)) ?? null); }

describe("guide hydration and local navigation", () => {
  it("disables initial actions until the user-scoped record is read without writing on mount", async () => {
    const { storage, values } = storageFixture(); render(<MinecraftGuide userId="alice" />);
    expect(screen.getByText("Loading your progress…")).toBeTruthy();
    expect(chapters().getAllByRole("button").every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByRole("button", { name: "Mark read & continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Start over" }) as HTMLButtonElement).disabled).toBe(true);
    await hydrated(); expect(storage.getItem).toHaveBeenCalledWith(minecraftGuideStorageKey("alice")); expect(storage.setItem).not.toHaveBeenCalled(); expect(values.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it("jumps chapters and goes Previous without marking them read or operating a game", async () => {
    const { values } = storageFixture(); render(<MinecraftGuide userId="alice" />); await hydrated(); choose("mods");
    expect(screen.getByRole("heading", { level: 2, name: chapterTitle("mods") })).toBeTruthy();
    expect(currentProgress(values)).toEqual(progress("mods")); expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Previous" })); expect(currentProgress(values)).toEqual(progress("play")); expect(fetch).not.toHaveBeenCalled();
  });
  it("marks only the current chapter on Next and claims saved only after canonical readback", async () => {
    const { storage, values } = storageFixture(); render(<MinecraftGuide userId="alice" />); await hydrated();
    fireEvent.click(screen.getByRole("button", { name: "Mark read & continue" }));
    expect(currentProgress(values)).toEqual(progress("profiles", ["welcome"]));
    expect(screen.getByText("Progress saved in this browser")).toBeTruthy(); expect(storage.setItem).toHaveBeenCalledOnce(); expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: chapterTitle("profiles") })); expect(fetch).not.toHaveBeenCalled();
  });
  it("reopens at the stored chapter and keeps different user accounts separate", async () => {
    const { storage, values } = storageFixture({ [minecraftGuideStorageKey("bob")]: JSON.stringify(progress("server", ["welcome", "play"])) });
    const view = render(<MinecraftGuide userId="alice" />); await hydrated(); choose("backups"); expect(currentProgress(values, "alice")).toEqual(progress("backups"));
    view.unmount(); render(<MinecraftGuide userId="alice" />); await hydrated(); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("backups") })).toBeTruthy();
    cleanup(); const changed = render(<MinecraftGuide userId="bob" />); await hydrated(); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("server") })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2"); changed.rerender(<MinecraftGuide userId="alice" />); await hydrated();
    expect(screen.getByRole("heading", { level: 2, name: chapterTitle("backups") })).toBeTruthy(); expect(storage.setItem).toHaveBeenCalledOnce();
  });
  it("cancels Start over without a write, then resets only this user's checklist after confirmation", async () => {
    const { storage, values } = storageFixture({ [minecraftGuideStorageKey("alice")]: JSON.stringify(progress("mods", ["welcome", "profiles"])), [minecraftGuideStorageKey("bob")]: JSON.stringify(progress("server", ["play"])) });
    render(<MinecraftGuide userId="alice" />); await hydrated(); fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("region", { name: "Reset guide progress" })).toBeTruthy(); expect(storage.setItem).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Keep my progress" }));
    expect(screen.queryByRole("region", { name: "Reset guide progress" })).toBeNull(); expect(currentProgress(values)).toEqual(progress("mods", ["welcome", "profiles"]));
    fireEvent.click(screen.getByRole("button", { name: "Start over" })); fireEvent.click(screen.getByRole("button", { name: "Reset guide progress" }));
    expect(currentProgress(values)).toEqual(progress("welcome")); expect(currentProgress(values, "bob")).toEqual(progress("server", ["play"])); expect(storage.setItem).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps all eight completed chapters revisitable without duplicating completion", async () => {
    const { values } = storageFixture(); render(<MinecraftGuide userId="alice" />); await hydrated();
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: "Mark read & continue" })); fireEvent.click(screen.getByRole("button", { name: "Mark chapter read" }));
    expect(screen.getByText("Guide complete — revisit any chapter")).toBeTruthy(); expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("8");
    expect(currentProgress(values)).toEqual(progress("server", [...MINECRAFT_GUIDE_CHAPTER_IDS]));
    choose("profiles"); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("profiles") })).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Mark read & continue" }));
    expect(currentProgress(values).completed).toEqual([...MINECRAFT_GUIDE_CHAPTER_IDS]); expect(fetch).not.toHaveBeenCalled();
  });
  it("provides normal local feature links instead of submitting tutorial actions to APIs", async () => {
    storageFixture(); render(<MinecraftGuide userId="alice" />); await hydrated();
    const paths = new Set(["/minecraft", "/minecraft/mods", "/minecraft/backups", "/minecraft/settings", "/minecraft/server"]);
    for (const chapter of MINECRAFT_GUIDE_CHAPTERS) {
      choose(chapter.id); const link = screen.getByRole("link", { name: chapter.linkLabel });
      expect(paths.has(link.getAttribute("href")!)).toBe(true); expect(link.tagName).toBe("A"); expect(link.getAttribute("target")).toBeNull();
    }
    expect(document.querySelectorAll("form")).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("guide storage limitations", () => {
  it("loads corrupt storage as an in-memory default without an automatic repair write", async () => {
    const key = minecraftGuideStorageKey("alice"), { storage, values } = storageFixture({ [key]: "corrupt fixture" });
    render(<MinecraftGuide userId="alice" />); await hydrated(); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("welcome") })).toBeTruthy();
    expect(storage.setItem).not.toHaveBeenCalled(); expect(values.get(key)).toBe("corrupt fixture"); choose("play");
    expect(currentProgress(values)).toEqual(progress("play")); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps a visit usable when the storage property itself is unavailable", async () => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
    render(<MinecraftGuide userId="alice" />); await hydrated(); choose("backups"); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("backups") })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark read & continue" })); expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("Progress is available for this visit")).toBeTruthy(); expect(screen.queryByText("Progress saved in this browser")).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not claim saved when publication is refused", async () => {
    const { storage } = storageFixture(); storage.setItem.mockImplementation(() => { throw new Error("Quota"); });
    render(<MinecraftGuide userId="alice" />); await hydrated(); choose("mods"); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("mods") })).toBeTruthy();
    expect(screen.queryByText("Progress saved in this browser")).toBeNull(); expect(screen.getByText("Progress is available for this visit")).toBeTruthy();
  });
  it("does not claim saved when a write's value is lost before readback", async () => {
    const { storage } = storageFixture(); storage.setItem.mockImplementation(() => {});
    render(<MinecraftGuide userId="alice" />); await hydrated(); choose("covers"); expect(storage.setItem).toHaveBeenCalledOnce();
    expect(screen.queryByText("Progress saved in this browser")).toBeNull(); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("covers") })).toBeTruthy();
  });
});

describe("guide Settings capability and entry points", () => {
  it.each([
    { loading: true }, { pollError: "Reading unavailable" }, { access: ["zomboid"] }, { can: NO_POWERS }, { can: { ...ALL_POWERS, settings: false } },
  ])("hides Settings navigation until a current capability is confirmed %j", async state => {
    boundary.games = gamesState(state as Parameters<typeof gamesState>[0]); storageFixture(); render(<MinecraftGuide userId="alice" />); await hydrated(); choose("settings");
    expect(document.querySelector('a[href="/minecraft/settings"]')).toBeNull(); expect(screen.getByRole("link", { name: "Profiles" }).getAttribute("href")).toBe("/minecraft");
    expect(screen.getByText(/Settings link needs confirmed moderator access/)).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
  });
  it("removes an already visible Settings link when permission is revoked", async () => {
    storageFixture(); const view = render(<MinecraftGuide userId="alice" />); await hydrated(); choose("settings");
    expect(screen.getByRole("link", { name: "Open applied profile settings" }).getAttribute("href")).toBe("/minecraft/settings");
    boundary.games = gamesState({ can: NO_POWERS }); view.rerender(<MinecraftGuide userId="alice" />);
    expect(screen.queryByRole("link", { name: "Open applied profile settings" })).toBeNull(); expect(screen.getByRole("heading", { level: 2, name: chapterTitle("settings") })).toBeTruthy();
  });
  it("keeps both entry links local and the guide route behind Minecraft access", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const sidebar = readFileSync(path.join(root, "src/components/game-sidebar.tsx"), "utf8"), profiles = readFileSync(path.join(root, "src/components/minecraft-profiles.tsx"), "utf8"), route = readFileSync(path.join(root, "src/app/minecraft/guide/page.tsx"), "utf8");
    expect(sidebar).toMatch(/game === "minecraft"[^\n]+Minecraft guide[^\n]+\$\{base\}\/guide/);
    expect(profiles).toContain('href="/minecraft/guide"'); expect(route).toContain('await auth()'); expect(route).toContain('if (!session?.user) redirect("/login")'); expect(route).toContain('if (!session.user.games.includes("minecraft")) redirect("/home")'); expect(route).toContain('userId={session.user.id}');
  });
});
