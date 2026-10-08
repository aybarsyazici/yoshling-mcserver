// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { ServerMonitor } from "@/components/server-monitor";
import { useGames } from "@/lib/use-games";
import { installBrowserStubs, worlds } from "./helpers/dom";
import type { ReactNode } from "react";
vi.mock("recharts", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { AreaChart: Container, Area: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ResponsiveContainer: Container };
});
beforeAll(installBrowserStubs);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(new Date("2026-10-06T12:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const stats = { offline: false, container: { cpu: "21%", memory: "2GiB / 4GiB", memoryPercent: "50%", network: "1MB / 2MB", processes: "32" }, host: { disk: { used: "4GiB", total: "100GiB", percent: "4%" }, uptime: "1h" }, history: [{ time: Date.parse("2026-10-06T12:00:00Z"), cpu: 21, memory: 50 }] };
const payload = () => ({ games: worlds({ zomboid: { status: "online", containerRunning: true } }), serverNow: Date.now(), can: { start: true, stop: true, restart: true, settings: true }, access: ["zomboid"] });
const flush = async () => { await act(async () => {}); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe("monitor readings", () => {
  it.each(["HTTP", "network", "shape"])("retains historical values after %s failure without calling them live", async (kind) => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (count++ === 0) return json(stats);
      if (kind === "network") throw new Error("Disconnected");
      return kind === "HTTP" ? json({}, 500) : json({});
    }));
    const view = render(<ServerMonitor game="zomboid" />); await flush();
    expect(screen.getByText(/Live · refreshes/)).toBeDefined();
    expect(view.container.querySelector("span.absolute.inline-flex")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.queryByText(/Live · refreshes/)).toBeNull();
    expect(screen.getByText(/Last known reading · 5s old/)).toBeDefined();
    expect(screen.getAllByText("21%")).toHaveLength(2);
    expect(view.container.querySelector("span.absolute.inline-flex")).toBeNull();
  });
  it("ages a hung poll out of live state even before fetch settles", async () => {
    let count = 0; vi.stubGlobal("fetch", vi.fn(async () => count++ === 0 ? json(stats) : new Promise<Response>(() => {})));
    render(<ServerMonitor game="zomboid" />); await flush();
    await act(async () => vi.advanceTimersByTime(16000));
    expect(screen.queryByText(/Live · refreshes/)).toBeNull(); expect(screen.getByText(/Last known reading · 16s old/)).toBeDefined();
  });
  it("surfaces an initial failure and recovers with a confirmed stopped reading", async () => {
    let count = 0; vi.stubGlobal("fetch", vi.fn(async () => count++ === 0 ? json({}, 403) : json({ ...stats, offline: true })));
    render(<ServerMonitor game="zomboid" />); await flush(); expect(screen.getByRole("alert").textContent).toContain("HTTP 403");
    await act(async () => vi.advanceTimersByTime(5000)); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Project Zomboid is stopped/)).toBeDefined();
  });
  it("does not let an old game's delayed result replace the selected game's reading", async () => {
    const old = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("zomboid") ? old.promise : json({ ...stats, container: { ...stats.container, cpu: "7%" } })));
    const view = render(<ServerMonitor game="zomboid" />); view.rerender(<ServerMonitor game="minecraft" />); await flush();
    await act(async () => old.resolve(json(stats)));
    expect(screen.getAllByText("7%")).toHaveLength(2); expect(screen.queryByText("21%")).toBeNull();
  });
});

describe("shared status poll freshness", () => {
  it("does not guess privileged reads or writes before the first capability response", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useGames(0));
    for (const key of ["settings", "settingsEdit", "consoleExecute", "filesDelete", "usersManage"] as const) expect(result.current.can[key]).toBe(false);
  });
  it.each(["HTTP", "network", "shape"])("keeps the last snapshot with explicit %s error and success time", async (kind) => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (count++ === 0) return json(payload());
      if (kind === "network") throw new Error("lost status");
      return kind === "HTTP" ? json({}, 503) : json({ games: {} });
    }));
    const { result } = renderHook(() => useGames(5000)); await flush();
    const first = result.current.lastSuccessAt; expect(first).toBe(Date.now());
    await act(async () => vi.advanceTimersByTime(5000));
    expect(result.current.games?.zomboid.status).toBe("online"); expect(result.current.pollError).toBeTruthy(); expect(result.current.lastSuccessAt).toBe(first);
  });
  it("ignores an older failed poll after a newer successful reading", async () => {
    const old = deferred<Response>(); let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => count++ === 0 ? old.promise : json(payload())));
    const { result } = renderHook(() => useGames(5000));
    await act(async () => { await result.current.refresh(); });
    const latest = result.current.lastSuccessAt;
    await act(async () => old.resolve(json({}, 500)));
    expect(result.current.pollError).toBeNull(); expect(result.current.lastSuccessAt).toBe(latest);
  });
  it("does not guess privileged capabilities from an older payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(payload())));
    const { result } = renderHook(() => useGames(0)); await flush();
    expect(result.current.can.settings).toBe(true); expect(result.current.can.consoleExecute).toBe(false); expect(result.current.can.usersManage).toBe(false);
  });
});
