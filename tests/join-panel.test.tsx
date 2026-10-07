// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JoinPanel } from "@/components/join-panel";
import { GameOverview } from "@/components/game-overview";
import { MissionControl } from "@/components/mission-control";
import { gamesState, installBrowserStubs, NO_POWERS, opsState, snap } from "./helpers/dom";
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState({ can: NO_POWERS, lastSuccessAt: Date.now() }) }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const info = { game: "minecraft", targetStatus: "checked", target: { mcVersion: "26.1.2", loader: "fabric" }, checkedAt: 123 };
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let writeText: ReturnType<typeof vi.fn>;
beforeAll(installBrowserStubs);
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", vi.fn(async () => json(info)));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();
  if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("copy addresses", () => {
  it("reports copied only after the clipboard promise succeeds", async () => {
    let complete!: () => void;
    writeText.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    render(<JoinPanel game="minecraft" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy mc.yoshling.xyz" }));
    expect(writeText).toHaveBeenCalledWith("mc.yoshling.xyz");
    expect(screen.queryByText("Address copied.")).toBeNull();
    await act(async () => complete());
    expect(screen.getByText("Address copied.")).toBeDefined();
  });
  it("offers manual selection after clipboard rejection", async () => {
    writeText.mockRejectedValue(new Error("Permission denied"));
    render(<JoinPanel game="zomboid" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy pz.yoshling.xyz:16261" }));
    await screen.findByText("Copy failed. Select the address and copy it manually.");
    expect(screen.queryByText("Address copied.")).toBeNull();
  });
  it("copies the raw IP fallback with its actual port", async () => {
    render(<JoinPanel game="7dtd" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy 89.58.50.155:26900" }));
    await screen.findByText("Address copied."); expect(writeText).toHaveBeenCalledWith("89.58.50.155:26900");
  });
  it("clears clipboard feedback when switching worlds", async () => {
    const view = render(<JoinPanel game="minecraft" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy mc.yoshling.xyz" }));
    await screen.findByText("Address copied.");
    view.rerender(<JoinPanel game="zomboid" />);
    expect(screen.queryByText("Address copied.")).toBeNull();
  });
});

describe("join guidance and target evidence", () => {
  it("reads the target only on opening, then displays its limited evidence", async () => {
    render(<JoinPanel game="minecraft" />); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "How to join Minecraft" }));
    await screen.findByText("26.1.2 · fabric");
    expect(fetch).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("does not verify a client pack");
    expect(screen.getByRole("link", { name: "View server mods and saved sets" }).getAttribute("href")).toBe("/minecraft/mods");
  });
  it.each(["HTTP", "HTML", "wrong-world", "partial", "unknown"])("renders %s as unknown with retry", async kind => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (kind === "HTML") return { ok: true, json: async () => { throw new Error("HTML gateway"); } };
      return kind === "HTTP" ? json(info, 403) : kind === "wrong-world" ? json({ ...info, game: "zomboid" }) : kind === "partial" ? json({ ...info, target: { mcVersion: "26.1.2" } }) : json({ ...info, targetStatus: "unknown", target: null });
    }));
    render(<JoinPanel game="minecraft" />); fireEvent.click(screen.getByRole("button", { name: "How to join Minecraft" }));
    await screen.findByRole("alert"); expect(screen.queryByText("26.1.2 · fabric")).toBeNull();
    expect((screen.getByRole("button", { name: "Retry target check" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("clears previously checked evidence while rechecking and after failure", async () => {
    let reads = 0; vi.stubGlobal("fetch", vi.fn(async () => ++reads === 1 ? json(info) : json({}, 503)));
    render(<JoinPanel game="minecraft" />); fireEvent.click(screen.getByRole("button", { name: "How to join Minecraft" }));
    await screen.findByText("26.1.2 · fabric"); fireEvent.click(screen.getByRole("button", { name: "Recheck target" }));
    expect(screen.queryByText("26.1.2 · fabric")).toBeNull(); await screen.findByRole("alert");
  });
  it("discards a late Minecraft read when the world changes", async () => {
    let complete!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
    const view = render(<JoinPanel game="minecraft" />);
    fireEvent.click(screen.getByRole("button", { name: "How to join Minecraft" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.rerender(<JoinPanel game="zomboid" />);
    await act(async () => complete(json(info)));
    fireEvent.click(screen.getByRole("button", { name: "How to join Project Zomboid" }));
    expect(screen.queryByText("26.1.2 · fabric")).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("cannot verify that build");
  });
  it("closes the join dialog when switching worlds", async () => {
    const view = render(<JoinPanel game="minecraft" />);
    fireEvent.click(screen.getByRole("button", { name: "How to join Minecraft" }));
    await screen.findByText("26.1.2 · fabric");
    view.rerender(<JoinPanel game="zomboid" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("availability is observed and expires", () => {
  it("shows responding and actual player count only while fresh", () => {
    vi.useFakeTimers();
    render(<JoinPanel game="minecraft" snapshot={snap({ status: "online", players: { online: 2, max: 20, players: [] } })} lastSuccessAt={Date.now()} />);
    expect(screen.getByText("Server responding · 2/20 players")).toBeDefined();
    act(() => vi.advanceTimersByTime(16_000));
    expect(screen.queryByText(/Server responding/)).toBeNull(); expect(screen.getByText(/availability is unconfirmed/)).toBeDefined();
  });
  it.each([null, undefined])("keeps a missing timestamp unknown", lastSuccessAt => {
    render(<JoinPanel game="minecraft" snapshot={snap({ status: "online" })} lastSuccessAt={lastSuccessAt} />);
    expect(screen.queryByText(/Server responding/)).toBeNull(); expect(screen.getByText(/availability is unconfirmed/)).toBeDefined();
  });
  it("does not advertise responding after a failed poll or during a server operation", () => {
    const view = render(<JoinPanel game="minecraft" snapshot={snap({ status: "online" })} lastSuccessAt={Date.now()} pollError="Failed" />);
    expect(screen.queryByText(/Server responding/)).toBeNull();
    view.rerender(<JoinPanel game="minecraft" snapshot={snap({ status: "online" })} lastSuccessAt={Date.now()} busy />);
    expect(screen.getByText(/server operation is in progress/)).toBeDefined(); expect(screen.queryByText(/Server responding/)).toBeNull();
  });
  it("separates a stopped world from a container that cannot answer", () => {
    const view = render(<JoinPanel game="minecraft" snapshot={snap()} lastSuccessAt={Date.now()} />);
    expect(screen.getByText(/server is stopped/)).toBeDefined();
    view.rerender(<JoinPanel game="minecraft" snapshot={snap({ containerRunning: true })} lastSuccessAt={Date.now()} />);
    expect(screen.getByText(/server is not responding/)).toBeDefined(); expect(screen.queryByText(/server is stopped/)).toBeNull();
  });
});

describe("player access on home and overview", () => {
  it.each(["home", "overview"])("offers the join flow to a MEMBER on %s", surface => {
    render(surface === "home" ? <MissionControl access={["minecraft"]} /> : <GameOverview game="minecraft" />);
    expect(screen.getByRole("button", { name: "How to join Minecraft" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy mc.yoshling.xyz" })).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
