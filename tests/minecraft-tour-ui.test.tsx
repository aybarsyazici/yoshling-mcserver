// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import type { Config, Driver, DriveStep, PopoverDOM } from "driver.js";
import { MinecraftTourButton, MinecraftTourProvider } from "@/components/minecraft-tour-provider";
import { minecraftTourSteps } from "@/lib/minecraft-tour-steps";
import { useUnsavedSettings } from "@/lib/use-unsaved-settings";
import { gamesState, installBrowserStubs, NO_POWERS } from "./helpers/dom";
const boundary = vi.hoisted(() => ({ games: null as unknown, pathname: "/minecraft", search: "", navigate: null as null | ((route: string) => void), push: vi.fn(), replace: vi.fn(), drivers: [] as unknown[], refreshes: vi.fn(), destroys: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => boundary.pathname, useSearchParams: () => new URLSearchParams(boundary.search), useRouter: () => router }));
const router = { push: (route: string) => { boundary.push(route); boundary.pathname = route; boundary.navigate?.(route); }, replace: (route: string) => { boundary.replace(route); boundary.search = new URL(route, "https://fixture.invalid").search.slice(1); boundary.pathname = new URL(route, "https://fixture.invalid").pathname; boundary.navigate?.(boundary.pathname); } };
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
vi.mock("driver.js", () => ({ driver: (config: Config) => makeDriver(config) }));
interface FakeDriver { api: Driver; config: Config; active: boolean; index: number; popover?: PopoverDOM }
function makeDriver(config: Config): Driver {
  const value = { config, active: false, index: 0 } as FakeDriver;
  const opts = () => ({ config: value.config, state: { activeIndex: value.index }, driver: value.api, index: value.index });
  const current = () => value.config.steps?.[value.index] ?? {};
  function hook(name: "onNextClick" | "onPrevClick" | "onDoneClick" | "onCloseClick") { value.config[name]?.(current().element instanceof Element ? current().element as Element : undefined, current(), opts()); }
  const keyboard = (event: Event) => { if ((event as KeyboardEvent).key === "Escape" && value.active) hook("onCloseClick"); };
  function present(index: number) {
    value.index = index; value.active = true; value.popover?.wrapper.remove();
    const wrapper = document.createElement("div"); wrapper.className = `driver-popover ${value.config.popoverClass ?? ""}`; wrapper.setAttribute("role", "dialog");
    const title = document.createElement("h2"), description = document.createElement("p"), footer = document.createElement("div"), progress = document.createElement("span"), footerButtons = document.createElement("div"), arrow = document.createElement("div");
    title.textContent = current().popover?.title ?? ""; description.textContent = current().popover?.description ?? ""; wrapper.setAttribute("aria-label", title.textContent);
    const previousButton = document.createElement("button"), nextButton = document.createElement("button"), closeButton = document.createElement("button"); previousButton.textContent = "Previous"; nextButton.textContent = index === (value.config.steps?.length ?? 0) - 1 ? value.config.doneBtnText ?? "Finish tour" : "Next"; closeButton.textContent = "Close tour";
    closeButton.className = "driver-popover-close-btn";
    previousButton.disabled = index === 0; previousButton.onclick = () => hook("onPrevClick"); nextButton.onclick = () => hook(index === (value.config.steps?.length ?? 0) - 1 ? "onDoneClick" : "onNextClick"); closeButton.onclick = () => hook("onCloseClick");
    footerButtons.append(previousButton, nextButton); footer.append(progress, footerButtons); wrapper.append(title, description, closeButton, footer); document.body.appendChild(wrapper);
    value.popover = { wrapper, title, description, footer, progress, footerButtons, arrow, previousButton, nextButton, closeButton }; value.config.onPopoverRender?.(value.popover, opts()); nextButton.focus();
    document.removeEventListener("keyup", keyboard); document.addEventListener("keyup", keyboard);
  }
  value.api = {
    setConfig: next => { value.config = next; }, getConfig: () => value.config, getState: key => key === "popover" ? value.popover : { activeIndex: value.index, popover: value.popover }, setSteps: steps => { value.config.steps = steps; }, drive: index => present(index ?? 0), moveTo: present,
    isActive: () => value.active, refresh: () => boundary.refreshes(), destroy: () => { const was = value.active; value.active = false; value.popover?.wrapper.remove(); document.removeEventListener("keyup", keyboard); boundary.destroys(); if (was) value.config.onDestroyed?.(undefined, current(), opts()); },
    getActiveIndex: () => value.index, getActiveStep: current, getActiveElement: () => current().element as Element | undefined, getPreviousElement: () => undefined, getPreviousStep: () => undefined, getNextStep: () => value.config.steps?.[value.index + 1], isFirstStep: () => value.index === 0, isLastStep: () => value.index === (value.config.steps?.length ?? 0) - 1,
    moveNext: () => hook("onNextClick"), movePrevious: () => hook("onPrevClick"), hasNextStep: () => value.index < (value.config.steps?.length ?? 0) - 1, hasPreviousStep: () => value.index > 0, highlight: (step: DriveStep) => { value.config.steps = [step]; present(0); },
  };
  boundary.drivers.push(value); return value.api;
}
const targets: Record<string, string[]> = { "/minecraft": ["profiles", "worlds", "profile-create", "current-profile", "join", "operation-strip"], "/minecraft/mods": ["mods", "mods-installed", "saved-mod-sets"], "/minecraft/backups": ["backups", "backup-list"], "/minecraft/server": ["server", "server-tabs"], "/minecraft/settings": ["settings"] };
const detailPath = "/minecraft/profiles/11111111-1111-1111-1111-111111111111";
function Dirty({ dirty }: { dirty: boolean }) { useUnsavedSettings(dirty); return <input aria-label="Draft" defaultValue="Unsaved fixture" />; }
function Host({ userId = "alice", dirty = false, missing = [], modal = false, details = true, action = vi.fn() }: { userId?: string; dirty?: boolean; missing?: string[]; modal?: boolean; details?: boolean; action?: () => void }) {
  const [route, setRoute] = useState(boundary.pathname);
  useEffect(() => { boundary.navigate = setRoute; return () => { if (boundary.navigate === setRoute) boundary.navigate = null; }; }, []);
  const names = route.startsWith("/minecraft/profiles/") ? ["profile-image"] : targets[route] ?? ["profiles"];
  return <MinecraftTourProvider userId={userId}><main><MinecraftTourButton /><Dirty dirty={dirty} />{names.filter(name => !missing.includes(name)).map(name => <button key={name} data-minecraft-tour={name} onClick={action}>{name}</button>)}{details && route === "/minecraft" && <a data-minecraft-tour="profile-details" href={detailPath}>Profile Details</a>}{modal && <div role="dialog" aria-label="Existing application modal">Existing modal</div>}</main></MinecraftTourProvider>;
}
beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks(); boundary.games = gamesState(); boundary.pathname = "/minecraft"; boundary.search = ""; boundary.drivers = []; boundary.navigate = null;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) { return this.hidden || this.style.display === "none" ? [] as unknown as DOMRectList : [{ x: 10, y: 10, width: 200, height: 50, top: 10, left: 10, right: 210, bottom: 60, toJSON() {} }] as unknown as DOMRectList; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); for (const value of boundary.drivers as FakeDriver[]) value.api.destroy(); document.querySelectorAll(".driver-popover").forEach(node => node.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const json = (user = "alice", done = false, status = 200) => Response.json({ userId: user, version: 1, done }, { status });
function requests(done = false, options: { get?: (count: number) => Promise<Response> | Response; post?: () => Promise<Response> | Response } = {}) {
  const calls: { method: string; url: string; body: unknown; actor: string | null }[] = []; let gets = 0;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => { const method = init.method ?? "GET"; calls.push({ method, url: String(input), body: init.body ? JSON.parse(init.body) : null, actor: new Headers(init.headers).get("X-Minecraft-Tour-User") }); return method === "POST" ? options.post?.() ?? json("alice", true) : options.get?.(++gets) ?? json("alice", done); })); return calls;
}
const activeDriver = () => (boundary.drivers as FakeDriver[]).at(-1)!;
async function launched() { await waitFor(() => expect(boundary.drivers).toHaveLength(1)); await screen.findByRole("dialog", { name: "A quick tour of Minecraft" }); }
async function replay() { fireEvent.click(screen.getByRole("button", { name: "Take tour" })); await launched(); }
async function next() { fireEvent.click(screen.getByRole("button", { name: "Next" })); await waitFor(() => expect((screen.queryByRole("button", { name: "Next" }) ?? screen.getByRole("button", { name: "Finish tour" })).getAttribute("disabled")).toBeNull()); }

describe("spotlight first visit and replay", () => {
  it("automatically starts only for a validated own false preference and never sends a feature mutation", async () => {
    const calls = requests(); render(<Host />); await launched(); expect(activeDriver().api.getActiveElement()).toBe(document.querySelector('[data-minecraft-tour="profiles"]'));
    expect(calls).toEqual([{ method: "GET", url: "/api/minecraft/tour", body: null, actor: "alice" }]); expect(activeDriver().config.disableActiveInteraction).toBe(true);
  });
  it.each(["done", "unknown", "wrong-user"])("keeps auto launch closed for %s but retains explicit replay", async kind => {
    const calls = requests(true, { get: () => kind === "done" ? json("alice", true) : kind === "wrong-user" ? json("bob", false) : new Response("gateway", { status: 503 }) });
    render(<Host />); await waitFor(() => expect(calls).toHaveLength(1)); await act(async () => {}); expect(boundary.drivers).toHaveLength(0); expect(screen.getByRole("button", { name: "Take tour" })).toBeTruthy(); await replay(); expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it("replays a completed account without resetting or rewriting its DB flag", async () => {
    const calls = requests(true); render(<Host />); await replay(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" })); await screen.findByText(/Tour complete/); expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it.each(["Close tour", "Escape"])("dismisses this visit with %s without marking done", async close => {
    const calls = requests(); render(<Host />); await launched(); if (close === "Escape") fireEvent.keyUp(document, { key: "Escape" }); else fireEvent.click(screen.getByRole("button", { name: close }));
    await waitFor(() => expect(document.querySelector(".driver-popover")).toBeNull()); expect(calls.every(call => call.method === "GET")).toBe(true); expect((screen.getByRole("button", { name: "Take tour" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not steal the first visit after the user has already interacted", async () => {
    let resolve!: (r: Response) => void; const delayed = new Promise<Response>(ok => { resolve = ok; }); requests(false, { get: () => delayed }); render(<Host />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "worlds" })); await act(async () => resolve(json())); expect(boundary.drivers).toHaveLength(0); await replay();
  });
  it("delays automatic launch while another visible modal is open", async () => {
    requests(); const view = render(<Host modal />); await act(async () => {}); expect(boundary.drivers).toHaveLength(0); view.rerender(<Host modal={false} />); await launched();
  });
  it("keeps unknown timed-out preference state from triggering auto while replay remains available", async () => {
    vi.useFakeTimers(); requests(false, { get: () => new Promise<Response>(() => {}) }); await act(async () => render(<Host />)); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(boundary.drivers).toHaveLength(0); expect(screen.getByText(/preference could not be read/)).toBeTruthy(); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Take tour" })));
    expect(boundary.drivers).toHaveLength(1);
  });
  it("waits for initial capabilities before auto launch and uses only read-only steps after a failed capability read", async () => {
    boundary.games = gamesState({ loading: true }); requests(); const view = render(<Host />); await act(async () => {}); expect(boundary.drivers).toHaveLength(0);
    boundary.games = gamesState({ loading: false, pollError: "unavailable" }); view.rerender(<Host />); await launched();
    expect(screen.getByText(/management permissions could not be verified/)).toBeTruthy(); expect(activeDriver().config.steps!.some(step => step.popover?.title === "Review settings in context")).toBe(false);
    expect(activeDriver().config.steps!.some(step => step.popover?.title === "Prepare another adventure")).toBe(false);
  });
  it("protects a busy capture panel from auto and manual launch, then permits deliberate replay after it clears", async () => {
    const panel = document.createElement("section"); panel.setAttribute("data-minecraft-tour-busy", ""); panel.textContent = "Private pairing session"; document.body.append(panel);
    try { requests(); render(<Host />); await act(async () => {}); expect(boundary.drivers).toHaveLength(0); fireEvent.click(screen.getByRole("button", { name: "Take tour" })); expect(screen.getByText(/Finish or close the current screenshot pairing task/)).toBeTruthy();
      panel.removeAttribute("data-minecraft-tour-busy"); await replay(); }
    finally { panel.remove(); }
  });
  it("uses the replay query without resetting completion and removes only that launch parameter", async () => {
    boundary.search = "tour=1&keep=fixture"; const calls = requests(true); render(<Host />); await launched(); expect(boundary.replace).toHaveBeenCalledWith("/minecraft?keep=fixture");
    fireEvent.click(screen.getByRole("button", { name: "Close tour" })); expect(calls.every(call => call.method === "GET")).toBe(true);
  });
});

describe("screen navigation and interaction containment", () => {
  it("uses real visible targets across routes and omits unconfirmed privileged steps", async () => {
    boundary.games = gamesState({ can: NO_POWERS }); const calls = requests(); render(<Host />); await launched();
    const ids = minecraftTourSteps("/minecraft", { settings: false, manageProfiles: false, power: false }).map(step => step.id); expect(ids).not.toContain("create"); expect(ids).not.toContain("settings");
    for (let i = 1; i < ids.length; i++) await next(); expect(boundary.push.mock.calls.flat()).not.toContain("/minecraft/settings"); expect(boundary.push).toHaveBeenCalledWith("/minecraft/mods"); expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it("waits for a delayed real target before claiming it was highlighted", async () => {
    requests(true); const view = render(<Host missing={["worlds"]} />); await replay(); fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Opening the next tour screen…"); expect(activeDriver().api.getActiveElement()).not.toBe(document.querySelector('[data-minecraft-tour="worlds"]'));
    view.rerender(<Host missing={[]} />); await screen.findByRole("dialog", { name: "Your worlds, kept together" }); expect(activeDriver().api.getActiveElement()).toBe(document.querySelector('[data-minecraft-tour="worlds"]'));
  });
  it("uses an honest unavailable explanation after the bounded target wait", async () => {
    vi.useFakeTimers(); requests(true); await act(async () => render(<Host missing={["worlds"]} />)); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Take tour" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" }))); await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(screen.getByText(/world list is not available/)).toBeTruthy(); expect(activeDriver().api.getActiveElement()).toBeUndefined();
  });
  it("blocks a dirty launch and refuses a route change when the discard confirmation is declined", async () => {
    requests(true); const view = render(<Host dirty />); fireEvent.click(screen.getByRole("button", { name: "Take tour" })); await screen.findByText(/Save or discard/); expect(boundary.drivers).toHaveLength(0);
    view.rerender(<Host dirty={false} />); await replay(); view.rerender(<Host dirty />); vi.spyOn(window, "confirm").mockReturnValue(false);
    const steps = activeDriver().config.steps!; const routeIndex = steps.findIndex(step => step.popover?.title === "See what this world uses");
    for (let i = 1; i < routeIndex; i++) await next(); fireEvent.click(screen.getByRole("button", { name: "Next" })); await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(boundary.push).not.toHaveBeenCalledWith("/minecraft/mods"); expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value).toBe("Unsaved fixture");
  });
  it("keeps highlighted app controls inert and blocks their click or Enter actions", async () => {
    const action = vi.fn(); requests(); render(<Host action={action} />); await launched(); const control = screen.getByRole("button", { name: "profiles" });
    expect(control.closest("[inert]")).toBeTruthy(); fireEvent.click(control); fireEvent.keyDown(control, { key: "Enter" }); expect(action).not.toHaveBeenCalled();
    expect(activeDriver().config.animate).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Close tour" })); await waitFor(() => expect(control.closest("[inert]")).toBeNull());
  });
  it("keeps Tab focus within enabled popover controls and restores launcher focus on close", async () => {
    requests(true); render(<Host />); const launcher = screen.getByRole("button", { name: "Take tour" }); launcher.focus(); await replay(); const skip = screen.getByRole("button", { name: "Skip tour" }); skip.focus();
    fireEvent.keyDown(skip, { key: "Tab" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close tour" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(skip);
    screen.getByRole("button", { name: "profiles" }).focus(); expect(document.activeElement?.closest(".driver-popover")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tour" })); await waitFor(() => expect(document.activeElement).toBe(launcher));
  });
  it("closes cleanly if current Minecraft membership is revoked", async () => {
    requests(); const view = render(<Host />); await launched(); boundary.games = gamesState({ access: ["zomboid"] }); view.rerender(<Host />);
    await waitFor(() => expect(document.querySelector(".driver-popover")).toBeNull()); expect(screen.getByText(/screen or access changed/)).toBeTruthy();
  });
  it("closes a privileged step if its current capability is revoked", async () => {
    requests(); const view = render(<Host />); await launched(); await next(); await next(); expect(screen.getByRole("dialog", { name: "Prepare another adventure" })).toBeTruthy();
    boundary.games = gamesState({ can: NO_POWERS }); view.rerender(<Host />); await waitFor(() => expect(document.querySelector(".driver-popover")).toBeNull());
  });
  it("closes when a retained hidden modal becomes visible and never marks that dismissal complete", async () => {
    const modal = document.createElement("section"); modal.setAttribute("role", "dialog"); modal.hidden = true; document.body.append(modal);
    try { const calls = requests(); render(<Host />); await launched(); modal.hidden = false; await waitFor(() => expect(document.querySelector(".driver-popover")).toBeNull()); expect(screen.getByText(/another dialog opened/)).toBeTruthy(); expect(calls.every(call => call.method === "GET")).toBe(true); }
    finally { modal.remove(); }
  });
  it("stops claiming a highlight when its accepted target is hidden", async () => {
    requests(); render(<Host />); await launched(); const target = document.querySelector<HTMLElement>('[data-minecraft-tour="profiles"]')!; target.hidden = true;
    await waitFor(() => expect(activeDriver().api.getActiveElement()).toBeUndefined()); expect(screen.getByText(/heading is not available/)).toBeTruthy();
  });
  it("waits for the destination route and heading even for the final immediate-fallback step", async () => {
    vi.useFakeTimers(); requests(true); await act(async () => render(<Host />)); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Take tour" })));
    const length = activeDriver().config.steps!.length; for (let i = 1; i < length - 1; i++) await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    expect(boundary.pathname).toBe("/minecraft/settings"); boundary.navigate = () => {};
    const staleTarget = document.createElement("section"); staleTarget.dataset.minecraftTour = "operation-strip"; document.body.append(staleTarget);
    try { await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" }))); expect(screen.getByText("Opening the next tour screen…")).toBeTruthy();
      await act(async () => vi.advanceTimersByTimeAsync(8000)); expect(activeDriver().api.getActiveElement()).toBeUndefined(); expect(screen.getByText(/next screen could not be opened or verified/)).toBeTruthy(); }
    finally { staleTarget.remove(); }
  });
  it("disconnects target observers and removes matching document input guards on unmount", async () => {
    const disconnect = vi.fn(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
    const added = vi.spyOn(document, "addEventListener"), removed = vi.spyOn(document, "removeEventListener"); requests(); const view = render(<Host />); await launched();
    const handlers = added.mock.calls.filter(call => ["pointerdown", "click", "touchstart", "keydown", "input", "wheel", "beforeinput", "focusin"].includes(call[0]) && call[2] === true);
    view.unmount(); expect(disconnect).toHaveBeenCalled(); expect(boundary.destroys).toHaveBeenCalled(); for (const [name, handler, capture] of handlers) expect(removed).toHaveBeenCalledWith(name, handler, capture);
    expect(document.querySelector(".driver-popover")).toBeNull(); expect(document.querySelector("[inert]")).toBeNull();
  });
});

describe("tour completion and user lifetime", () => {
  it("confirms explicit Skip with the exact own completion write and GET readback", async () => {
    const calls = requests(false, { get: count => json("alice", count > 1) }); render(<Host />); await launched(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await screen.findByText("Tour completion verified for your account."); expect(calls).toEqual([{ method: "GET", url: "/api/minecraft/tour", body: null, actor: "alice" }, { method: "POST", url: "/api/minecraft/tour", body: { version: 1, done: true }, actor: "alice" }, { method: "GET", url: "/api/minecraft/tour", body: null, actor: "alice" }]);
  });
  it("confirms Finish only at the final step without feature API calls", async () => {
    const calls = requests(false, { get: count => json("alice", count > 1) }); render(<Host />); await launched(); const length = activeDriver().config.steps!.length;
    for (let i = 1; i < length; i++) await next(); fireEvent.click(screen.getByRole("button", { name: "Finish tour" })); await screen.findByText("Tour completion verified for your account."); expect(calls.filter(call => call.method === "POST")).toHaveLength(1); expect(calls.every(call => call.url === "/api/minecraft/tour")).toBe(true);
  });
  it("reconciles an ambiguous POST through GET before allowing any retry", async () => {
    const calls = requests(false, { post: () => Promise.reject(new Error("network")), get: count => json("alice", count > 1) }); render(<Host />); await launched(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await screen.findByText("Tour completion verified for your account."); expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("keeps failed completion unconfirmed and checks GET first on Retry save/read", async () => {
    let done = false; const calls = requests(false, { post: () => new Response("gateway", { status: 524 }), get: () => json("alice", done) }); render(<Host />); await launched(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await screen.findByRole("dialog", { name: "Tour completion is unconfirmed" }); expect(screen.queryByText("Tour completion verified for your account.")).toBeNull(); done = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry save/read" })); await screen.findByText("Tour completion verified for your account."); expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("ignores an old user's delayed preference when identity changes", async () => {
    let resolve!: (r: Response) => void; const old = new Promise<Response>(ok => { resolve = ok; }); let gets = 0;
    requests(false, { get: () => ++gets === 1 ? old : json("bob", true) }); const view = render(<Host />); view.rerender(<Host userId="bob" />); await waitFor(() => expect(gets).toBe(2)); await act(async () => resolve(json("alice", false)));
    expect(boundary.drivers).toHaveLength(0); expect(screen.queryByText(/Tour completion verified/)).toBeNull();
  });
  it("does not claim completion for mismatched POST and GET identities", async () => {
    const calls = requests(false, { post: () => json("bob", true), get: count => count === 1 ? json() : json("bob", true) }); render(<Host />); await launched(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await screen.findByRole("dialog", { name: "Tour completion is unconfirmed" }); expect(screen.queryByText(/completion verified/)).toBeNull(); expect(calls.every(call => call.actor === "alice")).toBe(true);
  });
  it("keeps timed-out completion unconfirmed and dismisses its pending lifetime without a second POST", async () => {
    vi.useFakeTimers(); const calls = requests(false, { post: () => new Promise<Response>(() => {}) }); await act(async () => render(<Host />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip tour" }))); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByRole("dialog", { name: "Tour completion is unconfirmed" })).toBeTruthy(); expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close for now" }))); expect(screen.queryByText(/completion verified/)).toBeNull(); expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("drops old completion events and delayed responses after a new user session mounts", async () => {
    let resolve!: (r: Response) => void; const old = new Promise<Response>(ok => { resolve = ok; }); let gets = 0;
    const calls = requests(false, { post: () => old, get: () => ++gets === 1 ? json() : json("bob", true) }); const view = render(<Host />); await launched(); const oldConfig = activeDriver().config;
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" })); await waitFor(() => expect(calls.some(call => call.method === "POST")).toBe(true)); view.rerender(<Host userId="bob" />);
    await act(async () => resolve(json("alice", true))); oldConfig.onDoneClick?.(undefined, {}, { config: oldConfig, state: {}, driver: activeDriver().api, index: 0 });
    expect(screen.queryByText(/completion verified/)).toBeNull(); expect(calls.filter(call => call.method === "POST")).toHaveLength(1); expect(calls.filter(call => call.actor === "alice")).toHaveLength(2);
  });
  it("keeps verified completion when a pre-save preference read settles late with false", async () => {
    let resolve!: (r: Response) => void; const early = new Promise<Response>(ok => { resolve = ok; }); const calls = requests(false, { get: count => count === 1 ? early : json("alice", true) });
    render(<Host />); await replay(); fireEvent.click(screen.getByRole("button", { name: "Skip tour" })); await screen.findByText("Tour completion verified for your account.");
    await act(async () => resolve(json("alice", false))); fireEvent.click(screen.getByRole("button", { name: "Take tour" })); await waitFor(() => expect(boundary.drivers).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" })); await screen.findByText(/Tour complete/); expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
});
