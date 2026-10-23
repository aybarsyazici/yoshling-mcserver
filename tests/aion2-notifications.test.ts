import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AION_NOTIFICATION_LATENESS_MS, DEFAULT_AION_NOTIFICATION_SETTING, aionNotificationMessage, aionNotificationOccurrence, emptyAionNotificationState, planAionNotifications, validAionNotificationContext, validAionNotificationSetting, type AionEventNotificationSetting, type AionNotificationTarget } from "@/lib/aion2-notifications";
import { aionNotificationStore, type AionNotificationPort } from "@/lib/aion2-notification-store";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const setting: AionEventNotificationSetting = { enabled: true, leadMinutes: 5, sound: "chime", volume: 60 };
const target = (overrides: Partial<AionNotificationTarget> = {}): AionNotificationTarget => ({ id: "shugo", label: "Shugo Festival", contextKey: "eu:2322", verified: true, startsAt: new Date(NOW + 6 * 60_000).toISOString(), verifiedUntil: new Date(NOW + 20 * 60_000).toISOString(), ...overrides });
const initial = (value = target(), config = setting) => planAionNotifications(emptyAionNotificationState(), [value], { [value.id]: config }, NOW).state;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("notification plans", () => {
  it("defaults every event off and validates custom settings", () => {
    expect(DEFAULT_AION_NOTIFICATION_SETTING.enabled).toBe(false);
    expect(planAionNotifications(emptyAionNotificationState(), [target()], {}, NOW).state.armed).toEqual({});
    for (const leadMinutes of [0, 5, 10, 15, 120, 180]) expect(validAionNotificationSetting({ ...setting, leadMinutes })).toBe(true);
    for (const leadMinutes of [-1, 181, 1.5, NaN, "5"]) expect(validAionNotificationSetting({ ...setting, leadMinutes })).toBe(false);
    expect(validAionNotificationSetting({ ...setting, sound: "remote-url" })).toBe(false);
    expect(validAionNotificationSetting({ ...setting, volume: Infinity })).toBe(false);
    expect(validAionNotificationSetting({ ...setting, volume: -1 })).toBe(false);
    expect(validAionNotificationContext("eu:2322")).toBe(true);
    expect(validAionNotificationContext("eu:none")).toBe(true);
    expect(validAionNotificationContext("../../secret")).toBe(false);
  });

  it("delivers a previously armed alarm once when its lead instant is crossed", () => {
    const one = planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 60_000);
    expect(one.alerts).toHaveLength(1);
    expect(one.alerts[0]).toMatchObject({ id: "shugo", startsAt: target().startsAt, setting });
    expect(planAionNotifications(one.state, [target()], { shugo: setting }, NOW + 61_000).alerts).toEqual([]);
  });

  it("does not retroactively alert on initial read or setting enable after the lead instant", () => {
    expect(planAionNotifications(emptyAionNotificationState(), [target()], { shugo: setting }, NOW + 60_001).alerts).toEqual([]);
    const disabled = initial(target(), { ...setting, enabled: false });
    expect(planAionNotifications(disabled, [target()], { shugo: setting }, NOW + 60_001).alerts).toEqual([]);
  });

  it("does not retroactively alert after a lead or sound change", () => {
    for (const config of [{ ...setting, leadMinutes: 10 }, { ...setting, sound: "bell" as const }]) {
      expect(planAionNotifications(initial(), [target()], { shugo: config }, NOW + 60_000).alerts).toEqual([]);
    }
  });

  it("accepts a bounded ordinary hidden-tab delay, drops long sleeps and clock reversal", () => {
    expect(planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 120_000).alerts).toHaveLength(1);
    expect(planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 240_000).alerts).toEqual([]);
    expect(planAionNotifications(initial(), [target()], { shugo: setting }, NOW - 1).alerts).toEqual([]);
    expect(planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 60_000 + AION_NOTIFICATION_LATENESS_MS + 1).alerts).toEqual([]);
    const distant = target({ startsAt: new Date(NOW + 500_000).toISOString() });
    // Only one second late, but the runtime was absent for more than three minutes.
    expect(planAionNotifications(initial(distant), [distant], { shugo: setting }, NOW + 201_000).alerts).toEqual([]);
  });

  it("supports zero-minute alerts only when the start was known and armed beforehand", () => {
    const zero = { ...setting, leadMinutes: 0 }, next = target({ startsAt: new Date(NOW + 1_000).toISOString() });
    const armed = initial(next, zero);
    expect(planAionNotifications(armed, [next], { shugo: zero }, NOW + 1_001).alerts).toHaveLength(1);
    expect(planAionNotifications(emptyAionNotificationState(), [next], { shugo: zero }, NOW + 1_001).alerts).toEqual([]);
  });

  it("supports a lead longer than an hourly recurrence using multiple event occurrences", () => {
    const targets = [1, 2, 3, 4].map((hour) => target({ startsAt: new Date(NOW + hour * 3_600_000).toISOString(), verifiedUntil: new Date(NOW + 4 * 3_600_000).toISOString() }));
    const config = { ...setting, leadMinutes: 120 };
    const armed = planAionNotifications(emptyAionNotificationState(), targets, { shugo: config }, NOW - 1_000).state;
    expect(Object.keys(armed.armed)).toHaveLength(3);
    expect(planAionNotifications(armed, targets, { shugo: config }, NOW).alerts[0]?.startsAt).toBe(targets[1].startsAt);
  });

  it.each(["unverified", "expired", "missing", "changed-estimate", "other-context", "disabled"])("cancels a pending alert for %s", (kind) => {
    const source = target({ id: "gartua", estimate: true, occurrenceId: "kill:2026-10-23T00:06:00Z" });
    const state = initial(source);
    let latest = [source], config = setting;
    if (kind === "unverified") latest = [{ ...source, verified: false }];
    if (kind === "expired") latest = [{ ...source, verifiedUntil: new Date(NOW + 60_000).toISOString() }];
    if (kind === "missing") latest = [];
    if (kind === "changed-estimate") latest = [{ ...source, startsAt: new Date(NOW + 5 * 60_000).toISOString() }];
    if (kind === "other-context") latest = [{ ...source, contextKey: "eu:2321" }];
    if (kind === "disabled") config = { ...setting, enabled: false };
    expect(planAionNotifications(state, latest, { gartua: config }, NOW + 60_000).alerts).toEqual([]);
  });

  it("does not replace a canceled community estimate with a manufactured future cycle", () => {
    const t = target({ id: "gartua", estimate: true, occurrenceId: "known-kill" });
    const changed = { ...t, startsAt: new Date(NOW + 9 * 60_000).toISOString() };
    expect(aionNotificationOccurrence(t)).toBe(aionNotificationOccurrence(changed));
    const next = planAionNotifications(initial(t), [changed], { gartua: setting }, NOW + 1_000);
    expect(next.alerts).toEqual([]);
    expect(Object.values(next.state.armed)[0].target.startsAt).toBe(changed.startsAt);
    expect(planAionNotifications(next.state, [], { gartua: setting }, NOW + 2_000).state.armed).toEqual({});
  });

  it("fails closed for duplicate occurrence definitions and malformed sources", () => {
    const t = target();
    expect(planAionNotifications(initial(), [t, { ...t, verified: false }], { shugo: setting }, NOW + 60_000).alerts).toEqual([]);
    expect(planAionNotifications(initial(), [{ ...t, startsAt: null }], { shugo: setting }, NOW + 60_000).alerts).toEqual([]);
    expect(planAionNotifications(initial(), [{ ...t, verifiedUntil: "bad" }], { shugo: setting }, NOW + 60_000).alerts).toEqual([]);
    expect(planAionNotifications(initial(), [t], { shugo: setting }, NaN).alerts).toEqual([]);
  });

  it("attributes estimates and labels a delayed zero-lead reminder honestly", () => {
    expect(aionNotificationMessage({ label: "Gartua", startsAt: target().startsAt!, estimate: true }, NOW)).toMatch(/community-estimated.*not confirmed boss status/);
    expect(aionNotificationMessage({ label: "Kaira", startsAt: new Date(NOW - 30_000).toISOString(), estimate: false }, NOW)).toContain("browser reminder was delayed");
  });
});

function memoryPort(initialDocument: unknown = null) {
  let raw: unknown = initialDocument, tail: Promise<unknown> = Promise.resolve();
  const port: AionNotificationPort = {
    transact: (work) => {
      const operation = tail.then(() => { const result = work(structuredClone(raw)); if (result.document) raw = structuredClone(result.document); return result.value; });
      tail = operation.catch(() => {}); return operation;
    }, close: () => {},
  };
  return { port, raw: () => raw };
}

describe("atomic persisted alert records", () => {
  it("shares same-server preferences and preserves independent contexts and concurrent event updates", async () => {
    const memory = memoryPort(), one = aionNotificationStore(memory.port, "indexeddb"), two = aionNotificationStore(memory.port, "indexeddb");
    await Promise.all([one.save("eu:2322", "shugo", setting), two.save("eu:2322", "rift", { ...setting, sound: "bell" })]);
    expect(Object.keys(await one.load("eu:2322"))).toEqual(["shugo", "rift"]);
    expect(await two.load("eu:2321")).toEqual({}); expect(await two.load("nae:2322")).toEqual({});
    expect((await two.load("eu:2322")).shugo).toEqual(setting);
  });

  it("atomically claims an occurrence across tabs and deduplicates lead changes and estimate corrections", async () => {
    const memory = memoryPort(), one = aionNotificationStore(memory.port, "web-locks"), two = aionNotificationStore(memory.port, "web-locks");
    await one.save("eu:2322", "shugo", setting);
    const alert = planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 60_000).alerts[0];
    vi.setSystemTime(NOW + 60_000);
    expect(await Promise.all([one.claim(alert), two.claim(alert)])).toEqual([true, false]);
    await two.save("eu:2322", "shugo", { ...setting, sound: "bell" });
    expect(await one.claim({ ...alert, setting: { ...setting, sound: "bell" } })).toBe(false);
  });

  it("rechecks actual settings and source time inside the claim transaction", async () => {
    const memory = memoryPort(), store = aionNotificationStore(memory.port, "indexeddb");
    await store.save("eu:2322", "shugo", setting);
    const alert = planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 60_000).alerts[0];
    vi.setSystemTime(NOW + 60_000);
    await store.save("eu:2322", "shugo", { enabled: false });
    expect(await store.claim(alert)).toBe(false);
    await store.save("eu:2322", "shugo", setting);
    expect(await store.claim({ ...alert, verifiedUntil: new Date(NOW + 60_000).toISOString() })).toBe(false);
    expect(await store.claim({ ...alert, verifiedUntil: "invalid" })).toBe(false);
  });

  it("never overwrites malformed or future-version storage with defaults", async () => {
    for (const raw of [{ version: 2, contexts: {}, claims: {} }, { version: 1, contexts: { "eu:2322": { updatedAt: NOW, events: { shugo: { ...setting, leadMinutes: 900 } } } }, claims: {} }]) {
      const memory = memoryPort(raw), store = aionNotificationStore(memory.port, "web-locks");
      await expect(store.load("eu:2322")).rejects.toThrow(/verified/);
      await expect(store.save("eu:2322", "shugo", setting)).rejects.toThrow(/verified/);
      expect(memory.raw()).toEqual(raw);
    }
  });

  it("bounds persisted claims and prunes expired records without evicting live deduplication", async () => {
    const claims = Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [`old-${index}`, NOW - 1]));
    const memory = memoryPort({ version: 1, contexts: { "eu:2322": { updatedAt: NOW, events: { shugo: setting } } }, claims });
    const store = aionNotificationStore(memory.port, "indexeddb");
    vi.setSystemTime(NOW + 60_000);
    const alert = planAionNotifications(initial(), [target()], { shugo: setting }, NOW + 60_000).alerts[0];
    expect(await store.claim(alert)).toBe(true);
    expect(Object.keys((memory.raw() as { claims: object }).claims)).toHaveLength(1);
  });

  it("rejects invalid patches without changing persisted state", async () => {
    const memory = memoryPort(), store = aionNotificationStore(memory.port, "indexeddb");
    await expect(store.save("eu:2322", "shugo", { leadMinutes: 181 })).rejects.toThrow(/180/);
    await expect(store.save("eu:2322", "shugo", { volume: -1 })).rejects.toThrow(/100/);
    await expect(store.save("bad", "shugo", setting)).rejects.toThrow("Invalid alert");
    expect(memory.raw()).toBeNull();
  });
});
