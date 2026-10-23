// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AionEventNotificationSetting, AionNotificationTarget } from "@/lib/aion2-notifications";

const fixture = vi.hoisted(() => ({ open: vi.fn(), load: vi.fn(), save: vi.fn(), claim: vi.fn(), close: vi.fn(), notify: vi.fn(), request: vi.fn(), audio: vi.fn(), permission: "default" as NotificationPermission, settings: {} as Record<string, AionEventNotificationSetting>, subscribers: new Set<() => void>() }));
vi.mock("@/lib/aion2-notification-store", async (original) => ({ ...await original<typeof import("@/lib/aion2-notification-store")>(), openAionNotificationStore: fixture.open }));
import { useAionNotifications } from "@/hooks/use-aion2-notifications";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const setting: AionEventNotificationSetting = { enabled: true, leadMinutes: 1, sound: "chime", volume: 60 };
const target = (overrides: Partial<AionNotificationTarget> = {}): AionNotificationTarget => ({ id: "shugo", label: "Shugo Festival", contextKey: "eu:2322", verified: true, startsAt: new Date(NOW + 64_000).toISOString(), verifiedUntil: new Date(NOW + 20 * 60_000).toISOString(), ...overrides });
let contexts: FakeAudio[];
class FakeAudio {
  state = "suspended"; currentTime = 0; destination = {}; onstatechange: (() => void) | null = null;
  notes: number[] = [];
  resume = vi.fn(async () => { this.state = "running"; this.onstatechange?.(); });
  close = vi.fn(async () => { this.state = "closed"; });
  createOscillator = () => {
    const oscillator = { type: "", frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), onended: null, start: () => this.notes.push(oscillator.frequency.value), stop: vi.fn() };
    return oscillator;
  };
  createGain = () => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() });
}
class FakeNotification {
  static get permission() { return fixture.permission; }
  static requestPermission = () => fixture.request();
  constructor(title: string, options: NotificationOptions) { fixture.notify(title, options); }
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function render(targets = [target()]) { return renderHook(({ context }) => useAionNotifications({ contextKey: context, targets }), { initialProps: { context: "eu:2322" } }); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] }); vi.setSystemTime(NOW);
  fixture.settings = { shugo: { ...setting } }; fixture.permission = "default"; fixture.subscribers.clear(); contexts = [];
  fixture.open.mockReset().mockResolvedValue({ mode: "web-locks", load: fixture.load, save: fixture.save, claim: fixture.claim, close: fixture.close, subscribe: (listener: () => void) => { fixture.subscribers.add(listener); return () => { fixture.subscribers.delete(listener); }; } });
  fixture.load.mockReset().mockImplementation(async () => structuredClone(fixture.settings));
  fixture.save.mockReset().mockImplementation(async (_context, id, patch) => { fixture.settings = { ...fixture.settings, [id]: { ...fixture.settings[id], ...patch } }; return structuredClone(fixture.settings); });
  fixture.claim.mockReset().mockResolvedValue(true); fixture.close.mockReset(); fixture.notify.mockReset(); fixture.request.mockReset().mockImplementation(async () => { fixture.permission = "granted"; return "granted"; });
  fixture.audio.mockReset().mockImplementation(function () { const context = new FakeAudio(); contexts.push(context); return context; });
  vi.stubGlobal("Notification", FakeNotification); vi.stubGlobal("AudioContext", fixture.audio);
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("app-open alert runtime", () => {
  it("loads preferences without creating audio or requesting Notification permission", async () => {
    const hook = render(); await flush();
    expect(hook.result.current.storageStatus).toBe("ready");
    expect(hook.result.current.settings.shugo).toEqual(setting);
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.audio).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("does not save defaults before the initial browser read finishes", async () => {
    let release!: (settings: object) => void;
    fixture.load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const hook = render(); await flush();
    expect(hook.result.current.storageStatus).toBe("loading");
    await act(async () => { expect(await hook.result.current.setEventSetting("shugo", { enabled: true })).toBe(false); });
    expect(fixture.save).not.toHaveBeenCalled();
    await act(async () => release({ shugo: setting })); expect(hook.result.current.storageStatus).toBe("ready");
  });

  it("unlocks and previews distinct sounds only through the explicit action", async () => {
    const hook = render(); await flush();
    await act(async () => { await hook.result.current.testSound("chime", 60); });
    expect(hook.result.current.audioStatus).toBe("ready"); expect(contexts[0].notes).toEqual([660, 880]);
    await act(async () => { await hook.result.current.testSound("bell", 40); await hook.result.current.testSound("pulse", 20); });
    expect(contexts[0].notes).toEqual([660, 880, 880, 1320, 1760, 440, 440, 660]);
    await act(async () => { await hook.result.current.testSound("silent", 80); });
    expect(contexts[0].notes).toHaveLength(8);
    act(() => { contexts[0].state = "suspended"; contexts[0].onstatechange?.(); });
    expect(hook.result.current.audioStatus).toBe("locked");
  });

  it("requires a user gesture for permission and audio and handles denied/unsupported browsers", async () => {
    const hook = render(); await flush();
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: false } });
    await act(async () => { await hook.result.current.requestPermission(); await hook.result.current.testSound("chime", 60); });
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.audio).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    fixture.permission = "denied";
    await act(async () => { await hook.result.current.requestPermission(); });
    expect(hook.result.current.permission).toBe("denied"); expect(fixture.request).not.toHaveBeenCalled();
    vi.stubGlobal("Notification", undefined); vi.stubGlobal("AudioContext", undefined);
    await act(async () => { await hook.result.current.requestPermission(); await hook.result.current.testSound("chime", 60); });
    expect(hook.result.current.permission).toBe("unsupported"); expect(hook.result.current.audioStatus).toBe("unsupported");
  });

  it("delivers while hidden with custom audio and silent native notification", async () => {
    fixture.permission = "granted";
    const hook = render(); await flush();
    await act(async () => { await hook.result.current.testSound("bell", 40); });
    contexts[0].notes = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await advance(4_000);
    expect(fixture.claim).toHaveBeenCalledTimes(1); expect(fixture.notify).toHaveBeenCalledTimes(1);
    expect(fixture.notify.mock.calls[0][1]).toMatchObject({ silent: true, body: expect.stringContaining("starts in 1 minute") });
    expect(contexts[0].notes).toEqual([660, 880]); expect(hook.result.current.lastAlert?.id).toBe("shugo");
  });

  it("catches a previously armed warning on a short visibility resume", async () => {
    fixture.permission = "granted";
    render(); await flush(); await advance(1_000);
    vi.setSystemTime(NOW + 4_500);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush(); expect(fixture.notify).toHaveBeenCalledTimes(1);
  });

  it("does not retroactively remind after a long resume or initial load after due", async () => {
    fixture.permission = "granted";
    const hook = render(); await flush(); await advance(1_000);
    vi.setSystemTime(NOW + 4 * 60_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(1_000);
    expect(fixture.notify).not.toHaveBeenCalled();
    hook.unmount(); render(); await flush(); await advance(1_000);
    expect(fixture.notify).not.toHaveBeenCalled();
  });

  it.each(["unmount", "context", "source-expiry", "source-revoked", "changed-estimate", "event-elapsed"])("cancels delivery when %s happens while the persisted claim is pending", async (kind) => {
    fixture.permission = "granted";
    let release!: (value: boolean) => void;
    fixture.claim.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const t = target({ estimate: true, occurrenceId: "last-kill" });
    const hook = render([t]); await flush(); await advance(4_000);
    expect(release).toBeTypeOf("function");
    if (kind === "unmount") hook.unmount();
    if (kind === "context") hook.rerender({ context: "eu:2321" });
    if (kind === "source-expiry") act(() => hook.result.current.updateTargets([{ ...t, verifiedUntil: new Date(NOW + 4_000).toISOString() }]));
    if (kind === "source-revoked") act(() => hook.result.current.updateTargets([{ ...t, verified: false }]));
    if (kind === "changed-estimate") act(() => hook.result.current.updateTargets([{ ...t, startsAt: new Date(NOW + 10 * 60_000).toISOString() }]));
    if (kind === "event-elapsed") vi.setSystemTime(NOW + 65_000);
    await act(async () => release(true)); await flush();
    expect(fixture.notify).not.toHaveBeenCalled();
    if (kind !== "unmount") expect(hook.result.current.lastAlert).toBeNull();
  });

  it("does not deliver when another tab has already claimed the occurrence", async () => {
    fixture.permission = "granted"; fixture.claim.mockResolvedValue(false);
    const hook = render(); await flush(); await advance(4_000);
    expect(fixture.notify).not.toHaveBeenCalled(); expect(hook.result.current.lastAlert).toBeNull();
  });

  it("keeps an in-app reminder and sound when a mobile Notification constructor fails", async () => {
    fixture.permission = "granted"; fixture.notify.mockImplementationOnce(() => { throw new TypeError("Use ServiceWorkerRegistration"); });
    const hook = render(); await flush(); await advance(4_000);
    expect(hook.result.current.lastAlert?.id).toBe("shugo"); expect(hook.result.current.deliveryError).toMatch(/desktop notification/);
  });

  it("keeps notification and storage usable when a browser audio node fails", async () => {
    fixture.permission = "granted";
    const hook = render(); await flush(); await act(async () => { await hook.result.current.testSound("chime", 60); });
    contexts[0].createOscillator = () => { throw new Error("Interrupted audio"); };
    await advance(4_000);
    expect(fixture.notify).toHaveBeenCalledTimes(1); expect(hook.result.current.audioStatus).toBe("error");
    expect(hook.result.current.deliveryError).toMatch(/sound could not play/); expect(hook.result.current.storageStatus).toBe("ready");
  });

  it("shows storage failures, disables delivery, and reloads on explicit retry", async () => {
    fixture.open.mockRejectedValueOnce(new Error("Storage blocked"));
    const hook = render(); await flush();
    expect(hook.result.current.storageStatus).toBe("error"); expect(hook.result.current.storageError).toBe("Storage blocked");
    await advance(4_000); expect(fixture.claim).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.retryStorage(); }); await flush();
    expect(hook.result.current.storageStatus).toBe("ready"); expect(fixture.save).not.toHaveBeenCalled();
  });

  it("verifies canonical preference readback and ignores save receipts from the previous context", async () => {
    const hook = render(); await flush();
    await act(async () => expect(await hook.result.current.setEventSetting("shugo", { leadMinutes: 15 })).toBe(true));
    expect(hook.result.current.settings.shugo.leadMinutes).toBe(15);
    let release!: (value: object) => void;
    fixture.save.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.setEventSetting("shugo", { enabled: false }); });
    hook.rerender({ context: "eu:2321" }); await flush();
    await act(async () => { release({ shugo: { ...setting, enabled: false } }); expect(await pending).toBe(false); });
    expect(hook.result.current.storageStatus).toBe("ready");
  });

  it("refreshes same-context settings from other tabs and cleans every timer/listener/audio on unmount", async () => {
    fixture.permission = "granted";
    const hook = render(); await flush(); await act(async () => { await hook.result.current.testSound("chime", 50); });
    fixture.settings = { shugo: { ...setting, enabled: false } };
    act(() => fixture.subscribers.forEach((listener) => listener())); await flush();
    await advance(4_000); expect(fixture.notify).not.toHaveBeenCalled();
    hook.unmount(); expect(fixture.subscribers.size).toBe(0); expect(fixture.close).toHaveBeenCalled(); expect(contexts[0].close).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
