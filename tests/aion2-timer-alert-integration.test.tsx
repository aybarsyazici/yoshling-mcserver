// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AionTimerPanel } from "@/components/aion2-timer-panel";
import type { AionNotificationTarget, AionEventNotificationSetting } from "@/lib/aion2-notifications";
import type { AionKnowledgeStatus } from "@/lib/aion2-types";

const state = vi.hoisted(() => ({ settings: {} as Record<string, Record<string, AionEventNotificationSetting>>, updateTargets: vi.fn() }));
vi.mock("@/hooks/use-aion2-notifications", () => ({ useAionNotifications: ({ contextKey }: { contextKey: string }) => ({
  settings: state.settings[contextKey] ?? {}, updateTargets: state.updateTargets, storageStatus: "ready", storageError: null, coordination: "web-locks", permission: "unsupported", audioStatus: "locked", lastAlert: null, deliveryError: null,
  setEventSetting: vi.fn(async () => true), requestPermission: vi.fn(async () => {}), testSound: vi.fn(async () => {}), retryStorage: vi.fn(async () => {}),
}) }));
const NOW = "2026-10-23T12:00:00.000Z";
const knowledge: AionKnowledgeStatus = { version: "review", status: "current", reviewedAt: "2026-10-23", expiresAt: "2026-10-28", checkedAt: NOW, supportedClasses: [], notices: [] };
const setting = { enabled: true, leadMinutes: 10, sound: "silent" as const, volume: 0 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function latest(): AionNotificationTarget[] { return state.updateTargets.mock.lastCall?.[0] ?? []; }
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); state.settings = {}; state.updateTargets.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/knowledge") ? json({ knowledge: { ...knowledge, checkedAt: new Date().toISOString() } }) : json({ report: null, checkedAt: new Date().toISOString() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("makes no background source request while every alert preference is off", async () => {
  render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/knowledge"))).toBe(false);
});

it("refreshes sources every five minutes while hidden and advances the hidden clock only for enabled alerts", async () => {
  state.settings["eu:2322"] = { "shugo-festival": setting };
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  expect(screen.getByRole("timer", { name: "Shugo Festival entry closes in" }).textContent).toBe("03:00");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByRole("timer", { name: "Shugo Festival entry closes in" }).textContent).toBe("02:00");
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/knowledge"))).toHaveLength(2);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/timers?"))).toHaveLength(0);
  expect(latest().some(target => target.verified && target.id === "shugo-festival")).toBe(true);
});

it("refreshes the community feed in a hidden tab only when Gartua alerts are enabled", async () => {
  state.settings["eu:2322"] = { gartua: setting };
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/knowledge") ? json({ knowledge: { ...knowledge, checkedAt: new Date().toISOString() } }) : json({ checkedAt: new Date().toISOString(), report: { name: "Immortal Gartua", region: "eu", serverId: 2322, serverName: "Atiel", status: "reported-dead", provider: "aion2timers.com", source: "https://www.aion2timers.com/", fetchedAt: new Date().toISOString(), reportedAt: "2026-10-23T04:00:00Z", lastKilledAt: "2026-10-23T04:00:00Z", estimatedSpawnAt: "2026-10-23T16:00:00Z" } })));
  render(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/timers?"))).toHaveLength(4);
  expect(latest().find(target => target.id === "gartua")?.verified).toBe(true);
});

it("withdraws all authorization immediately when a hidden source refresh fails despite fresh old props", async () => {
  state.settings["eu:2322"] = { "shugo-festival": setting };
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/knowledge") ? ++reads === 1 ? json({ knowledge }) : json({ error: "Source check denied" }, 401) : json({ report: null, checkedAt: NOW })));
  render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  expect(latest().some(target => target.verified)).toBe(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(latest().some(target => target.verified)).toBe(false);
  expect(screen.getByText("Event source check failed. Alerts are paused until a successful check.")).toBeTruthy();
});

it("aborts old-context reads and refuses a late successful source response for a different server", async () => {
  state.settings["eu:2322"] = { "shugo-festival": setting }; state.settings["eu:2323"] = { "shugo-festival": setting };
  let release!: (value: Response) => void; const old = new Promise<Response>(resolve => { release = resolve; });
  let reads = 0, oldSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    if (String(url).includes("/knowledge")) { if (++reads === 1) { oldSignal = options?.signal as AbortSignal; return old; } return Promise.resolve(json({ knowledge: { ...knowledge, status: "unverified" } })); }
    return Promise.resolve(json({ report: null, checkedAt: NOW }));
  }));
  const view = render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  view.rerender(<AionTimerPanel region="eu" serverId={2323} knowledge={knowledge} />); await settle();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { release(json({ knowledge })); await old; });
  expect(latest().every(target => target.contextKey === "eu:2323" && !target.verified)).toBe(true);
});

it("cleans up its source interval and aborts a pending request when unmounted", async () => {
  state.settings["eu:2322"] = { "shugo-festival": setting }; let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return new Promise<Response>(() => {}); }));
  const view = render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  const calls = vi.mocked(fetch).mock.calls.length; view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
});
