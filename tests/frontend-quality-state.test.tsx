// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { ThemeToggle } from "@/components/theme-toggle";
import { usePrefersReducedMotion, AnimatedNumber } from "@/components/motion";
import { ModDetailDialog } from "@/components/mod-detail-dialog";
import { installBrowserStubs } from "./helpers/dom";
const theme = vi.hoisted(() => ({ theme: "dark" as string | undefined, resolvedTheme: "dark" as string | undefined, setTheme: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => theme }));
const animation = vi.hoisted(() => ({ value: 0, target: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("motion/react", () => ({
  motion: {},
  useMotionValue: () => ({ set: animation.target }),
  useSpring: () => ({ get: () => animation.value, on: (_event: string, notify: () => void) => { animation.listeners.add(notify); return () => { animation.listeners.delete(notify); }; } }),
}));
beforeAll(installBrowserStubs);
beforeEach(() => { animation.value = 0; theme.theme = "dark"; theme.resolvedTheme = "dark"; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); animation.listeners.clear(); });
function media(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = { matches: initial, addEventListener: (_event: string, callback: () => void) => listeners.add(callback), removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback) };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return { update: (value: boolean) => { query.matches = value; for (const listener of listeners) listener(); }, listeners };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const detail = (title: string, gallery: unknown[] = []) => ({ title, description: "Fixture", body: "Safe description", gallery, icon_url: null, downloads: 12, followers: 1, categories: [], loaders: ["fabric"], game_versions: ["1.21.1"], license: "MIT", source_url: null, issues_url: null, wiki_url: null, discord_url: null, date_created: "2026-01-01", date_modified: "2026-10-06", client_side: "optional", server_side: "required" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe("external browser and animation values", () => {
  it("reads the current reduced-motion preference, follows changes and unsubscribes", () => {
    const preference = media(true); const view = renderHook(() => usePrefersReducedMotion());
    expect(view.result.current).toBe(true); act(() => preference.update(false)); expect(view.result.current).toBe(false);
    view.unmount(); expect(preference.listeners.size).toBe(0);
  });
  it("renders reduced-motion numbers from current props instead of stale animation state", () => {
    media(true); const view = render(<AnimatedNumber value={12.25} decimals={2} prefix="$" suffix=" units" />);
    expect(screen.getByText("$12.25 units")).toBeDefined(); view.rerender(<AnimatedNumber value={18.5} decimals={2} prefix="$" suffix=" units" />);
    expect(screen.getByText("$18.50 units")).toBeDefined(); expect(animation.target).not.toHaveBeenCalled();
  });
  it("subscribes to spring changes when motion is permitted", () => {
    media(false); const view = render(<AnimatedNumber value={12} decimals={1} />);
    expect(animation.target).toHaveBeenCalledWith(12); act(() => { animation.value = 4.25; for (const notify of animation.listeners) notify(); });
    expect(screen.getByText("4.3")).toBeDefined(); view.rerender(<AnimatedNumber value={18} decimals={1} />);
    expect(animation.target).toHaveBeenCalledWith(18); view.unmount(); expect(animation.listeners.size).toBe(0);
  });
});

describe("theme hydration and actual mode", () => {
  it("keeps the server placeholder and hydrates without a mismatch", async () => {
    const html = renderToString(<ThemeToggle />); expect(html).not.toContain("button");
    const container = document.createElement("div"); container.innerHTML = html; document.body.appendChild(container);
    const errors: unknown[] = []; let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, <ThemeToggle />, { onRecoverableError: (error) => errors.push(error) }); });
    expect(container.querySelector('button[aria-label="Switch to the light theme"]')).not.toBeNull(); expect(errors).toEqual([]);
    await act(async () => root.unmount()); container.remove();
  });
  it.each(["dark", "light"])("toggles the resolved %s system theme", (mode) => {
    theme.theme = "system"; theme.resolvedTheme = mode; render(<ThemeToggle />);
    const next = mode === "dark" ? "light" : "dark";
    fireEvent.click(screen.getByRole("button", { name: `Switch to the ${next} theme` })); expect(theme.setTheme).toHaveBeenCalledWith(next);
  });
});

describe("mod detail request identity and typed galleries", () => {
  it("never renders a late previous project's response into the selected project", async () => {
    const old = deferred<Response>(); vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("id=old") ? old.promise : json(detail("Current project"))));
    const view = render(<ModDetailDialog open projectId="old" onClose={() => {}} />); view.rerender(<ModDetailDialog open projectId="current" onClose={() => {}} />);
    await screen.findByText("Current project"); await act(async () => old.resolve(json(detail("Old project"))));
    expect(screen.queryByText("Old project")).toBeNull(); expect(screen.getByText("Current project")).toBeDefined();
  });
  it.each(["HTTP", "network", "shape"])("shows a completed error state after %s instead of an indefinite loader", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => { if (kind === "network") throw new Error("Disconnected"); return kind === "HTTP" ? json(detail("Denied"), 403) : json({ title: "Malformed", gallery: [null] }); }));
    render(<ModDetailDialog open projectId="fixture" onClose={() => {}} />); await screen.findByRole("alert");
    expect(screen.queryByText("Denied")).toBeNull(); expect(screen.queryByText("Malformed")).toBeNull(); expect(screen.getByText("Mod details unavailable")).toBeDefined();
  });
  it("accepts nullable official captions and legacy string gallery entries in the lightbox", async () => {
    const first = "https://fixture.invalid/first.png"; const second = "https://fixture.invalid/second.png";
    vi.stubGlobal("fetch", vi.fn(async () => json(detail("Gallery project", [{ url: first, title: null, description: null }, second]))));
    const view = render(<ModDetailDialog open projectId="fixture" onClose={() => {}} />); await screen.findByText("Gallery project");
    fireEvent.click(view.container.querySelector(`img[src="${first}"]`) ?? document.querySelector(`img[src="${first}"]`)!);
    await waitFor(() => expect(document.querySelectorAll(`img[src="${first}"]`)).toHaveLength(2));
    fireEvent.keyDown(window, { key: "ArrowRight" }); await waitFor(() => expect(document.querySelectorAll(`img[src="${second}"]`)).toHaveLength(2));
  });
  it("starts a fresh session without stale content when a dialog reopens the same project", async () => {
    const fresh = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json(detail("First reading")) : fresh.promise));
    const view = render(<ModDetailDialog open projectId="fixture" onClose={() => {}} />); await screen.findByText("First reading");
    view.rerender(<ModDetailDialog open={false} projectId="fixture" onClose={() => {}} />);
    view.rerender(<ModDetailDialog open projectId="fixture" onClose={() => {}} />);
    expect(screen.queryByText("First reading")).toBeNull();
    await act(async () => fresh.resolve(json(detail("Fresh reading")))); await screen.findByText("Fresh reading");
  });
});
