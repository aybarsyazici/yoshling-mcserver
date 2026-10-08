// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useMinecraftProfiles } from "@/lib/use-minecraft-profiles";
import { useGames } from "@/lib/use-games";
import { OperationsProvider, useOperations } from "@/components/operations-provider";
import { MinecraftProfiles } from "@/components/minecraft-profiles";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { profilesFixture } from "./helpers/minecraft-profiles";
import { ALL_POWERS, installBrowserStubs, worlds, op } from "./helpers/dom";

const readers = vi.hoisted(() => ({ games: null as import("@/lib/use-games").GamesState | null, profiles: null as ReturnType<typeof import("@/lib/use-minecraft-profiles")["useMinecraftProfiles"]> | null }));
vi.mock("@/lib/use-games", async original => {
  const actual = await original<typeof import("@/lib/use-games")>();
  return { ...actual, useGames: (interval?: number) => { const value = actual.useGames(interval); readers.games = value; return value; } };
});
vi.mock("@/lib/use-minecraft-profiles", async original => {
  const actual = await original<typeof import("@/lib/use-minecraft-profiles")>();
  return { ...actual, useMinecraftProfiles: (enabled?: boolean) => { const value = actual.useMinecraftProfiles(enabled); readers.profiles = value; return value; } };
});

beforeAll(installBrowserStubs);
beforeEach(() => { readers.games = null; readers.profiles = null; vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(new Date("2026-10-08T14:00:00Z")); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const status = (over = {}) => ({ games: worlds(), access: ["minecraft"], can: ALL_POWERS, busy: null, running: [], serverNow: Date.now(), ...over });
const operations = () => ({ operations: [], finished: [], serverNow: Date.now() });
const flush = async () => { await act(async () => {}); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe("accepted profile readings during refresh", () => {
  it("keeps ready data and initial-loading controls stable during a pending refresh", async () => {
    const pending = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json(profilesFixture()) : pending.promise));
    const { result } = renderHook(() => useMinecraftProfiles());
    expect(result.current.ready).toBe(false); expect(result.current.loading).toBe(true);
    await flush(); const accepted = result.current.data;
    let refresh!: Promise<boolean>; act(() => { refresh = result.current.refresh(); });
    expect(result.current.refreshing).toBe(true); expect(result.current.loading).toBe(false);
    expect(result.current.ready).toBe(true); expect(result.current.data).toBe(accepted);
    await act(async () => { pending.resolve(json(profilesFixture())); await refresh; });
    expect(result.current.refreshing).toBe(false); expect(result.current.ready).toBe(true);
  });
  it.each(["HTTP", "network", "shape", "read permission"])("refuses actions after a %s refresh failure until confirmed recovery", async kind => {
    const pending = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 || calls > 2 ? json(profilesFixture()) : pending.promise));
    const { result } = renderHook(() => useMinecraftProfiles()); await flush(); const accepted = result.current.data;
    let refresh!: Promise<boolean>; act(() => { refresh = result.current.refresh(); });
    await act(async () => {
      if (kind === "network") pending.reject(new Error("Connection lost"));
      else pending.resolve(kind === "HTTP" ? json({ error: "Unavailable" }, 503) : kind === "shape" ? json({ profiles: [] }) : json(profilesFixture({ capabilities: { read: false, manage: false, start: false, switch: false } })));
      await refresh;
    });
    expect(result.current.ready).toBe(false); expect(result.current.error).toBeTruthy(); expect(result.current.data).toBe(accepted);
    await act(async () => { await result.current.refresh(); }); expect(result.current.ready).toBe(true); expect(result.current.error).toBeNull();
  });
  it("retains refusal during a pending recovery and exposes revoked management permissions on acceptance", async () => {
    const pending = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json(profilesFixture()) : calls === 2 ? json({}, 403) : pending.promise));
    const { result } = renderHook(() => useMinecraftProfiles()); await flush(); await act(async () => { await result.current.refresh(); });
    let refresh!: Promise<boolean>; act(() => { refresh = result.current.refresh(); });
    expect(result.current.ready).toBe(false); expect(result.current.error).toBeTruthy();
    await act(async () => { pending.resolve(json(profilesFixture({ capabilities: { read: true, manage: false, start: false, switch: false } }))); await refresh; });
    expect(result.current.data?.capabilities.manage).toBe(false); expect(result.current.data?.capabilities.start).toBe(false);
  });
  it("discards older responses and preserves the latest accepted identity", async () => {
    const old = deferred<Response>(); let calls = 0;
    const latest = profilesFixture({ runtime: { ...profilesFixture().runtime, selectedProfileId: "p2", appliedProfileId: "p2", revision: "new-context" } });
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json(profilesFixture()) : calls === 2 ? old.promise : json(latest)));
    const { result } = renderHook(() => useMinecraftProfiles()); await flush();
    let older!: Promise<boolean>; act(() => { older = result.current.refresh(); });
    await act(async () => { await result.current.refresh(); });
    await act(async () => { old.resolve(json(profilesFixture())); await older; });
    expect(result.current.data?.runtime.revision).toBe("new-context"); expect(result.current.ready).toBe(true); expect(result.current.refreshing).toBe(false);
  });
  it("requires a fresh accepted reading after the hook is disabled and enabled again", async () => {
    const pending = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json(profilesFixture()) : pending.promise));
    const { result, rerender } = renderHook(({ enabled }) => useMinecraftProfiles(enabled), { initialProps: { enabled: true } }); await flush();
    expect(result.current.ready).toBe(true); rerender({ enabled: false }); rerender({ enabled: true });
    expect(result.current.ready).toBe(false); await flush();
    expect(result.current.ready).toBe(false); expect(result.current.loading).toBe(true);
    await act(async () => pending.resolve(json(profilesFixture()))); expect(result.current.ready).toBe(true);
  });
  it("keeps first-read retry loading and rejects replies after the hook is disabled", async () => {
    const pending = deferred<Response>(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json({}, 503) : pending.promise));
    const { result, rerender } = renderHook(({ enabled }) => useMinecraftProfiles(enabled), { initialProps: { enabled: true } }); await flush();
    let refresh!: Promise<boolean>; act(() => { refresh = result.current.refresh(); });
    expect(result.current.loading).toBe(true); expect(result.current.ready).toBe(false);
    rerender({ enabled: false });
    await act(async () => { pending.resolve(json(profilesFixture())); await refresh; });
    expect(result.current.data).toBeNull(); expect(result.current.ready).toBe(false);
  });
});

function PollReadiness() {
  const profiles = useMinecraftProfiles(), games = useGames(4000), ledger = useOperations();
  const allowed = profiles.ready && !games.loading && !games.pollError && games.access.includes("minecraft") && games.can.settingsEdit === true && profiles.data?.capabilities.manage === true && !ledger.loading;
  return <><button disabled={!allowed}>Manage profile</button><button onClick={() => { void profiles.refresh(); void games.refresh(); void ledger.refresh(); }}>Recheck all</button></>;
}
describe("combined capability/status/ledger readiness", () => {
  it("does not disable accepted controls while all three reads are pending", async () => {
    const profilePoll = deferred<Response>(), statusPoll = deferred<Response>(), ledgerPoll = deferred<Response>(); const counts = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async url => { const key = String(url), count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      if (key === "/api/minecraft/profiles") return count === 1 ? json(profilesFixture()) : profilePoll.promise;
      if (key === "/api/games/status") return count === 1 ? json(status()) : statusPoll.promise;
      return count === 1 ? json(operations()) : ledgerPoll.promise;
    }));
    render(<OperationsProvider><PollReadiness /></OperationsProvider>); await flush();
    expect((screen.getByRole("button", { name: "Manage profile" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Recheck all" })); await flush();
    expect((screen.getByRole("button", { name: "Manage profile" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { profilePoll.resolve(json(profilesFixture({ capabilities: { read: true, manage: false, start: false, switch: false } }))); statusPoll.resolve(json(status({ can: { ...ALL_POWERS, settingsEdit: false } }))); ledgerPoll.resolve(json(operations())); });
    expect((screen.getByRole("button", { name: "Manage profile" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("preserves the picker's fifteen-second status expiry during a hung status refresh", async () => {
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async url => String(url) === "/api/minecraft/profiles" ? json(profilesFixture()) : String(url) === "/api/games/status" ? ++statusCalls === 1 ? json(status()) : new Promise<Response>(() => {}) : json(operations())));
    render(<OperationsProvider><MinecraftProfilePicker open initialProfileId="p2" onOpenChange={vi.fn()} /></OperationsProvider>); await flush();
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(16000));
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps gallery management and an open draft enabled during its actual background poll", async () => {
    const pending = deferred<Response>(); let profileCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async url => String(url) === "/api/minecraft/profiles" ? ++profileCalls === 1 ? json(profilesFixture()) : pending.promise : String(url) === "/api/games/status" ? json(status()) : String(url) === "/api/minecraft-versions" ? json({ versions: ["1.21.1"] }) : json(operations())));
    render(<OperationsProvider><MinecraftProfiles /></OperationsProvider>); await flush();
    expect((screen.getByRole("button", { name: "Create profile" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("button", { name: "Start this profile" }).every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create profile" })); await flush();
    const name = screen.getByRole("textbox", { name: "Profile name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Draft world" } }); expect((name.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(10000));
    expect(profileCalls).toBe(2); expect((name.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false); expect(name.value).toBe("Draft world");
    expect((screen.getByRole("button", { name: "Create profile", hidden: true }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("button", { name: "Start this profile", hidden: true }).every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  });
  it("keeps an open legacy adoption draft editable during a deferred gallery poll", async () => {
    const pending = deferred<Response>(); let reads = 0;
    const legacy = profilesFixture({ profiles: [], runtime: { selectedProfileId: null, appliedProfileId: null, verified: true, state: "legacy", revision: "0" }, requiresAdoption: true });
    vi.stubGlobal("fetch", vi.fn(async url => String(url) === "/api/minecraft/profiles" ? ++reads === 1 ? json(legacy) : pending.promise : String(url) === "/api/games/status" ? json(status()) : json(operations())));
    render(<OperationsProvider><MinecraftProfiles /></OperationsProvider>); await flush();
    const adopt = screen.getByRole("button", { name: "Keep existing world as a profile" }) as HTMLButtonElement; expect(adopt.disabled).toBe(false);
    fireEvent.click(adopt); await flush();
    const name = screen.getByRole("textbox", { name: "Profile name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Our existing world" } });
    await act(async () => vi.advanceTimersByTime(10000));
    expect(reads).toBe(2); expect((name.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false); expect(name.value).toBe("Our existing world");
    expect((screen.getByRole("button", { name: "Keep existing world" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

const provider = ({ children }: { children: React.ReactNode }) => <OperationsProvider>{children}</OperationsProvider>;
describe("confirmed ledger reads and bounded polling", () => {
  it("accepts a slow busy poll without repeatedly superseding it", async () => {
    const slow = deferred<Response>(); const live = { ...operations(), operations: [op()] };
    const fetcher = vi.fn(async () => slow.promise); vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useOperations(), { wrapper: ({ children }) => <OperationsProvider initial={live}>{children}</OperationsProvider> });
    await act(async () => vi.advanceTimersByTime(12000)); expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(json(live))); expect(result.current.loading).toBe(false); expect(result.current.operations).toHaveLength(1);
  });
  it("does not let an obsolete hung read pause polling after a newer confirmed recheck", async () => {
    const obsolete = deferred<Response>(); let reads = 0;
    const fetcher = vi.fn(async () => ++reads === 1 ? obsolete.promise : json(operations())); vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useOperations(), { wrapper: provider });
    let receipt: boolean | void; await act(async () => { receipt = await result.current.refresh(); }); expect(receipt!).toBe(true);
    await act(async () => vi.advanceTimersByTime(6000)); expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => obsolete.resolve(json({ ...operations(), operations: [op()] }))); expect(result.current.operations).toHaveLength(0);
  });
  it.each(["HTTP", "network", "shape"])("returns false for %s reconciliation without replacing accepted ledger rows", async kind => {
    const slow = deferred<Response>(); let reads = 0; const live = { ...operations(), operations: [op()] };
    vi.stubGlobal("fetch", vi.fn(async () => ++reads === 1 ? json(live) : slow.promise));
    const { result } = renderHook(() => useOperations(), { wrapper: provider }); await flush();
    let recheck!: Promise<boolean | void>; act(() => { recheck = result.current.refresh(); });
    await act(async () => { if (kind === "network") slow.reject(new Error("Disconnected")); else slow.resolve(kind === "HTTP" ? json({}, 503) : json({ ...operations(), operations: [{}] })); });
    expect(await recheck).toBe(false); expect(result.current.operations).toHaveLength(1);
  });
  it("returns false for an obsolete manual refresh and outside a provider", async () => {
    const older = deferred<Response>(); let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++reads === 1 ? json(operations()) : reads === 2 ? older.promise : json(operations())));
    const { result } = renderHook(() => useOperations(), { wrapper: provider }); await flush();
    let old!: Promise<boolean | void>; act(() => { old = result.current.refresh(); });
    await act(async () => { expect(await result.current.refresh()).toBe(true); });
    await act(async () => older.resolve(json(operations()))); expect(await old).toBe(false);
    const outside = renderHook(() => useOperations()); expect(await outside.result.current.refresh()).toBe(false);
  });
  it("aborts a real pending request when its deadline expires", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-08T14:00:00Z"));
    let aborted = false;
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("Request timed out")); })));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useOperations(), { wrapper: provider });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.signal).toBeDefined();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    await act(async () => vi.advanceTimersByTime(15000)); expect(aborted).toBe(true); expect(result.current.loading).toBe(false);
  });
});

describe("explicit profile retry reconciliation", () => {
  it.each(["accepted", "HTTP", "shape", "network"])("keeps retry blocked until all requested reads settle with %s ledger result", async kind => {
    const listRead = deferred<Response>(), statusRead = deferred<Response>(), ledgerRead = deferred<Response>(); let rechecking = false, writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "POST") { writes++; return new Response("gateway", { status: 524 }); }
      const key = String(url);
      if (key === "/api/minecraft/profiles") return rechecking ? listRead.promise : json(profilesFixture());
      if (key === "/api/games/status") return rechecking ? statusRead.promise : json(status());
      return rechecking ? ledgerRead.promise : json(operations());
    }));
    render(<OperationsProvider><MinecraftProfilePicker open initialProfileId="p2" onOpenChange={vi.fn()} /></OperationsProvider>); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start selected profile" })); await flush();
    expect(screen.getByRole("alert").textContent).toContain("unconfirmed"); expect(writes).toBe(1);
    rechecking = true; fireEvent.click(screen.getByRole("button", { name: "Recheck profiles and status" })); await flush();
    expect((screen.getByRole("button", { name: "Recheck profiles and status" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
    await act(async () => { listRead.resolve(json(profilesFixture())); statusRead.resolve(json(status())); });
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { if (kind === "network") ledgerRead.reject(new Error("Lost ledger")); else ledgerRead.resolve(kind === "accepted" ? json(operations()) : kind === "HTTP" ? json({}, 503) : json({ serverNow: Date.now(), operations: [{}], finished: [] })); });
    expect((screen.queryByRole("button", { name: "Recheck profiles and status", hidden: true }) as HTMLButtonElement | null)?.disabled ?? false).toBe(false);
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(kind !== "accepted");
    expect(writes).toBe(1);
    if (kind !== "accepted") expect(screen.getByRole("alert").textContent).toContain("could not all be confirmed");
  });
});


describe("recheck receipts bind to the requested accepted readings", () => {
  it.each(["profile", "status"])("does not unlock an ambiguous action from an obsolete %s response", async source => {
    const obsolete = deferred<Response>(), newer = deferred<Response>(); let reconciliation = false, selectedReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "POST") return new Response("gateway", { status: 524 });
      const key = String(url), selected = source === "profile" ? "/api/minecraft/profiles" : "/api/games/status";
      if (reconciliation && key === selected) return ++selectedReads === 1 ? obsolete.promise : newer.promise;
      return json(key === "/api/minecraft/profiles" ? profilesFixture() : key === "/api/games/status" ? status() : operations());
    }));
    render(<OperationsProvider><MinecraftProfilePicker open initialProfileId="p2" onOpenChange={vi.fn()} /></OperationsProvider>); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start selected profile" })); await flush();
    reconciliation = true; fireEvent.click(screen.getByRole("button", { name: "Recheck profiles and status" })); await flush();
    let newerRead!: Promise<boolean | void>; act(() => { newerRead = source === "profile" ? readers.profiles!.refresh() : readers.games!.refresh(); });
    await act(async () => obsolete.resolve(json(source === "profile" ? profilesFixture() : status())));
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("could not all be confirmed");
    await act(async () => { newer.resolve(json(source === "profile" ? profilesFixture() : status())); await newerRead; });
    expect((screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("drops privileged status capabilities when their fields disappear", async () => {
    let reads = 0; vi.stubGlobal("fetch", vi.fn(async () => json(status(++reads === 1 ? {} : { can: undefined }))));
    const { result } = renderHook(() => useGames(0)); await flush(); expect(result.current.can.settingsEdit).toBe(true);
    await act(async () => { expect(await result.current.refresh()).toBe(true); });
    expect(result.current.can.settingsEdit).toBe(false); expect(result.current.can.start).toBe(false);
  });
});

describe("pending manual rechecks keep otherwise-ready start controls gated", () => {
  it("keeps start disabled after status recovers while profile and ledger reads still wait", async () => {
    const profileRead = deferred<Response>(), statusRead = deferred<Response>(), ledgerRead = deferred<Response>();
    let mode: "initial" | "expired" | "recheck" = "initial";
    vi.stubGlobal("fetch", vi.fn(async url => {
      const key = String(url);
      if (mode === "recheck") return key === "/api/minecraft/profiles" ? profileRead.promise : key === "/api/games/status" ? statusRead.promise : ledgerRead.promise;
      if (mode === "expired" && key === "/api/games/status") return new Promise<Response>(() => {});
      return json(key === "/api/minecraft/profiles" ? profilesFixture() : key === "/api/games/status" ? status() : operations());
    }));
    render(<OperationsProvider><MinecraftProfilePicker open initialProfileId="p2" onOpenChange={vi.fn()} /></OperationsProvider>); await flush();
    mode = "expired"; await act(async () => vi.advanceTimersByTime(16000));
    mode = "recheck"; fireEvent.click(screen.getByRole("button", { name: "Recheck profiles and status" })); await flush();
    await act(async () => statusRead.resolve(json(status())));
    const start = screen.getByRole("button", { name: "Start selected profile" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); expect((screen.getByRole("button", { name: "Recheck profiles and status" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { profileRead.resolve(json(profilesFixture())); ledgerRead.resolve(json(operations())); }); expect(start.disabled).toBe(false);
  });
});
