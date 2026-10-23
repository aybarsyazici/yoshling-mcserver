// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AION_NOTIFICATION_STORAGE_KEY, openAionNotificationStore } from "@/lib/aion2-notification-store";
import { emptyAionNotificationState, planAionNotifications, type AionEventNotificationSetting } from "@/lib/aion2-notifications";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const setting: AionEventNotificationSetting = { enabled: true, leadMinutes: 5, sound: "bell", volume: 30 };
function alert() {
  const target = { id: "shugo", label: "Shugo", contextKey: "eu:2322", startsAt: new Date(NOW + 360_000).toISOString(), verifiedUntil: new Date(NOW + 900_000).toISOString(), verified: true };
  const armed = planAionNotifications(emptyAionNotificationState(), [target], { shugo: setting }, NOW).state;
  return planAionNotifications(armed, [target], { shugo: setting }, NOW + 60_000).alerts[0];
}

/** A network-free browser API fixture: transactions serialize and publish only
 * on complete. Reads queued after put observe that transaction's own writes. */
function fakeIndexedDB() {
  type Operation = () => void;
  type Request = { result?: unknown; onsuccess?: () => void };
  let committed = new Map<string, unknown>(), busy = false, created = false;
  const queue: (() => void)[] = [];
  const next = () => { if (!busy && queue.length) { busy = true; queue.shift()!(); } };
  const database = {
    objectStoreNames: { contains: () => created }, createObjectStore: () => { created = true; }, close: vi.fn(), onversionchange: null,
    transaction: vi.fn(() => {
      let aborted = false, working = new Map<string, unknown>();
      const operations: Operation[] = [];
      const tx = {
        oncomplete: null as (() => void) | null, onerror: null as (() => void) | null, onabort: null as (() => void) | null,
        abort: () => { aborted = true; },
        objectStore: () => ({
          get: (key: string) => { const request: Request = {}; operations.push(() => { request.result = structuredClone(working.get(key)); request.onsuccess?.(); }); return request; },
          put: (value: unknown, key: string) => { const request: Request = {}; operations.push(() => { working.set(key, structuredClone(value)); request.onsuccess?.(); }); return request; },
        }),
      };
      const pump = () => {
        if (aborted) { tx.onabort?.(); busy = false; next(); return; }
        const operation = operations.shift();
        if (operation) { operation(); queueMicrotask(pump); }
        else { committed = working; tx.oncomplete?.(); busy = false; next(); }
      };
      queue.push(() => { working = new Map([...committed].map(([key, value]) => [key, structuredClone(value)])); queueMicrotask(pump); });
      queueMicrotask(next); return tx;
    }),
  };
  const factory = { open: vi.fn(() => {
    const request = { result: database, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null, onblocked: null };
    queueMicrotask(() => { if (!created) request.onupgradeneeded?.(); request.onsuccess?.(); }); return request;
  }) };
  return { factory, database };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); localStorage.clear();
  vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); vi.stubGlobal("indexedDB", undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("browser coordination adapters", () => {
  it("uses an exclusive Web Lock, verifies persisted values, and suppresses cross-tab duplicates", async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, options: { mode: string }, work: () => unknown) => {
      expect(options.mode).toBe("exclusive"); const result = tail.then(work); tail = result.catch(() => {}); return result;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const a = await openAionNotificationStore(), b = await openAionNotificationStore();
    expect(a.mode).toBe("web-locks");
    await a.save("eu:2322", "shugo", setting); expect((await b.load("eu:2322")).shugo).toEqual(setting);
    vi.setSystemTime(NOW + 60_000);
    expect(await Promise.all([a.claim(alert()), b.claim(alert())])).toEqual([true, false]);
    expect(JSON.parse(localStorage.getItem(AION_NOTIFICATION_STORAGE_KEY)!).version).toBe(1);
    a.close(); b.close();
  });

  it("falls back to atomic IndexedDB transactions when Web Locks is absent", async () => {
    const idb = fakeIndexedDB(); vi.stubGlobal("indexedDB", idb.factory);
    const a = await openAionNotificationStore(), b = await openAionNotificationStore();
    expect(a.mode).toBe("indexeddb"); expect(b.mode).toBe("indexeddb");
    await Promise.all([a.save("eu:2322", "shugo", setting), b.save("eu:2322", "rift", { ...setting, sound: "pulse" })]);
    expect(Object.keys(await a.load("eu:2322"))).toEqual(["shugo", "rift"]);
    vi.setSystemTime(NOW + 60_000);
    expect(await Promise.all([a.claim(alert()), b.claim(alert())])).toEqual([true, false]);
    expect(localStorage.getItem(AION_NOTIFICATION_STORAGE_KEY)).toBeNull();
    expect(idb.database.transaction.mock.calls.every((args: unknown[]) => args[1] === "readwrite")).toBe(true);
    a.close(); b.close(); expect(idb.database.close).toHaveBeenCalled();
  });

  it("explicitly refuses delivery coordination when neither safe primitive exists", async () => {
    await expect(openAionNotificationStore()).rejects.toThrow(/across tabs.*disabled/);
  });

  it("preserves unreadable local storage and does not silently write default preferences", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: object, work: () => unknown) => Promise.resolve().then(work) } });
    localStorage.setItem(AION_NOTIFICATION_STORAGE_KEY, "broken-json");
    const store = await openAionNotificationStore();
    await expect(store.load("eu:2322")).rejects.toThrow("unreadable");
    await expect(store.save("eu:2322", "shugo", setting)).rejects.toThrow("unreadable");
    expect(localStorage.getItem(AION_NOTIFICATION_STORAGE_KEY)).toBe("broken-json"); store.close();
  });
});
