// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MinecraftProfileCard } from "@/components/minecraft-profile-card";
import { MinecraftProfileDetail } from "@/components/minecraft-profile-detail";
import { MinecraftProfileCapture } from "@/components/minecraft-profile-capture";
import { MinecraftProfileOverview } from "@/components/minecraft-profile-overview";
import { MinecraftProfilePicker } from "@/components/minecraft-profile-picker";
import { overviewDate, parseMinecraftProfileOverview, profileImagePresentation } from "@/lib/minecraft-profile-images";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
import { profileFixture, profilesFixture, worldSettingsFixture } from "./helpers/minecraft-profiles";
import { overviewFixture, overviewHash, waitingOverview } from "./helpers/minecraft-overviews";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
const boundary = vi.hoisted(() => ({ games: null as unknown, operations: null as unknown, list: null as unknown }));
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
vi.mock("@/lib/use-minecraft-profiles", () => ({ useMinecraftProfiles: () => boundary.list }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => boundary.operations }));
beforeAll(installBrowserStubs);
beforeEach(() => { vi.clearAllMocks(); boundary.games = gamesState({ lastSuccessAt: Date.now() }); boundary.operations = { ...opsState(), refresh: vi.fn(async () => true) }; boundary.list = { data: profilesFixture(), ready: true, loading: false, refresh: vi.fn(async () => true) }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const defaultProfile = (over: Partial<MinecraftProfileDTO> = {}) => profileFixture({ overview: overviewFixture(), ...over });
function panelRequests(options: { first?: unknown; status?: number; post?: Response | (() => Promise<Response>); read?: () => Promise<Response> } = {}) {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return typeof options.post === "function" ? options.post() : options.post ?? json({ profileId: "p1", jobId: "job-1", operationId: "op-1", overview: waitingOverview({ state: "queued", operationId: "op-1", reason: "Queued" }) }, 202); }
    return options.read ? options.read() : json(options.first ?? { profileId: "p1", overview: overviewFixture() }, options.status ?? 200);
  })); return writes;
}
const panel = (over: Partial<Parameters<typeof MinecraftProfileOverview>[0]> = {}) => <MinecraftProfileOverview profile={defaultProfile()} canRender onOverviewRead={vi.fn()} onProfileRecheck={vi.fn(async () => true)} {...over} />;

describe("profile image provenance", () => {
  it("prefers a custom cover over the generated default without relabeling it", () => {
    const profile = defaultProfile({ coverUrl: "/api/minecraft/profiles/p1/cover?v=2" });
    expect(profileImagePresentation(profile).kind).toBe("custom");
    render(<MinecraftProfileCard profile={profile} selected applied canPlay running={false} onPlay={vi.fn()} />);
    const card = within(screen.getByRole("article", { name: "Profile Cozy Survival" })); expect(card.getByText("Custom cover")).toBeTruthy(); expect(card.queryByText("Generated world overview")).toBeNull();
    expect(card.getByRole("button", { name: "Start this profile" })).toBeTruthy();
  });
  it("shows a generated saved-world default with its actual generation time", () => {
    render(<MinecraftProfileCard profile={defaultProfile()} selected applied canPlay running={false} onPlay={vi.fn()} />);
    expect(screen.getByText("Generated world overview")).toBeTruthy(); expect(screen.getByText(`Generated ${overviewDate(overviewFixture().generatedAt!)}`)).toBeTruthy();
    expect(screen.queryByText("Custom cover")).toBeNull();
  });
  it("shows the same generated provenance in the picker without changing start admission", () => {
    boundary.list = { data: profilesFixture({ profiles: [defaultProfile()] }), ready: true, loading: false, refresh: vi.fn(async () => true) };
    render(<MinecraftProfilePicker open initialProfileId="p1" onOpenChange={vi.fn()} />);
    expect(screen.getByText("Generated world overview")).toBeTruthy(); expect(screen.getByRole("button", { name: "Start selected profile" })).toBeTruthy();
  });
  it("keeps a previous verified image visibly older while a render fails", () => {
    render(<MinecraftProfileCard profile={defaultProfile({ overview: overviewFixture("p1", { state: "failed", reason: "Renderer unavailable" }) })} selected applied canPlay running={false} onPlay={vi.fn()} />);
    expect(screen.getByText("Generated world overview")).toBeTruthy(); expect(screen.getByText("Overview generation failed")).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute("src")).toContain(overviewHash);
  });
  it("retains a verified earlier image when only the new render result is unverified", () => {
    render(<MinecraftProfileCard profile={defaultProfile({ overview: overviewFixture("p1", { state: "unverified", reason: "The newer worker was interrupted" }) })} selected applied canPlay running={false} onPlay={vi.fn()} />);
    expect(screen.getByText("Generated world overview")).toBeTruthy(); expect(screen.getByText("Latest overview result unverified")).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute("src")).toContain(overviewHash);
  });
  it("shows an illustration and a first-save wait only when the backend reports no saved chunks", () => {
    render(<MinecraftProfileCard profile={defaultProfile({ overview: waitingOverview() })} selected applied canPlay running={false} onPlay={vi.fn()} />);
    expect(screen.getByText("World illustration")).toBeTruthy(); expect(screen.getByText(/Waiting for the first world save/)).toBeTruthy(); expect(document.querySelector("img")).toBeNull();
    expect(profileImagePresentation(profileFixture()).detail).toBe("Overview status not available");
  });
  it.each([
    { imageUrl: "https://untrusted.invalid/overview.png" }, { imageUrl: `/api/minecraft/profiles/p2/overview/image?revision=${overviewHash}` },
    { revision: "c".repeat(64) }, { generatedAt: null }, { snapshotAt: null }, { source: null }, { renderer: null }, { state: ["ready"] },
  ])("refuses unverified image metadata %j while keeping gameplay data usable", over => {
    const bad = { ...overviewFixture(), ...over }; expect(parseMinecraftProfileOverview(bad, "p1")).toBeNull();
    const profile = { ...defaultProfile(), overview: bad } as MinecraftProfileDTO;
    expect(profileImagePresentation(profile).kind).toBe("illustration");
    render(<MinecraftProfileCard profile={profile} selected applied canPlay running={false} onPlay={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Start this profile" }) as HTMLButtonElement).disabled).toBe(false); expect(screen.getByText("Overview could not be verified")).toBeTruthy();
  });
});

describe("overview request and recovery", () => {
  it("aborts a stalled GET after fifteen seconds and enables explicit recheck without admitting a render", async () => {
    vi.useFakeTimers(); let reads = 0; let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { signal = init?.signal; return ++reads === 1 ? new Promise<Response>(() => {}) : json({ profileId: "p1", overview: overviewFixture() }); }));
    await act(async () => render(panel())); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(signal?.aborted).toBe(true); expect(screen.getByText(/request timed out/)).toBeTruthy(); expect((screen.getByRole("button", { name: "Recheck overview" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recheck overview" }))); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps a stalled POST unconfirmed after its deadline without submitting it again", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "POST") { posts++; signal = init.signal; return new Promise<Response>(() => {}); } return json({ profileId: "p1", overview: overviewFixture() }); }));
    await act(async () => render(panel())); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" }))); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(signal?.aborted).toBe(true); expect(screen.getByText(/world overview request result is unconfirmed/)).toBeTruthy(); expect(posts).toBe(1);
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByRole("button", { name: "Recheck profile and overview" })).toBeTruthy();
  });
  it("retains a known operation header when the POST response body stalls", async () => {
    vi.useFakeTimers();
    panelRequests({ post: new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 202, headers: { "X-Operation-Id": "op-body-stalled" } }) });
    await act(async () => render(panel())); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" }))); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByText(/Operation op-body-stalled/)).toBeTruthy(); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not admit a render while its first status read is unresolved", async () => {
    let resolve!: (r: Response) => void; const pending = new Promise<Response>(ok => { resolve = ok; }); const writes = panelRequests({ read: () => pending });
    render(panel()); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" })); expect(writes).toEqual([]);
    await act(async () => resolve(json({ profileId: "p1", overview: overviewFixture() })));
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("gates failed initial status reads and exposes an explicit read retry", async () => {
    const writes = panelRequests({ status: 503 }); render(panel()); await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true); expect(writes).toEqual([]);
    panelRequests(); fireEvent.click(screen.getByRole("button", { name: "Recheck overview" })); await waitFor(() => expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false));
  });
  it("sends exact profile and independent overview revisions without claiming render success", async () => {
    const writes = panelRequests(); render(panel()); await waitFor(() => expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" })); await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ expectedRevision: 1, expectedOverviewRevision: overviewHash }); expect(screen.queryByText(/successfully rendered/i)).toBeNull();
  });
  it("does not expose rendering writes without management permission", async () => {
    const writes = panelRequests(); render(panel({ canRender: false })); await screen.findByText("Generated world overview");
    expect(screen.queryByRole("button", { name: "Refresh world overview" })).toBeNull(); expect(writes).toEqual([]);
  });
  it("ignores an old profile's delayed read without updating the new detail", async () => {
    let resolve!: (r: Response) => void; const old = new Promise<Response>(ok => { resolve = ok; }); const observed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async input => String(input).includes("/p1/") ? old : json({ profileId: "p2", overview: waitingOverview() })));
    const view = render(panel({ onOverviewRead: observed })); await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce()); view.rerender(panel({ profile: defaultProfile({ id: "p2" }), onOverviewRead: observed }));
    await screen.findByText(/Waiting for the first world save/); await act(async () => resolve(json({ profileId: "p1", overview: overviewFixture() })));
    expect(observed.mock.calls.every(([overview]) => overview.imageUrl === null)).toBe(true);
  });
  it("keeps an unknown proxy result blocked even after a successful background read", async () => {
    vi.useFakeTimers(); panelRequests({ post: new Response("gateway", { status: 524 }) }); await act(async () => render(panel()));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" })));
    expect(screen.getByText(/world overview request result is unconfirmed/)).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText(/world overview request result is unconfirmed/)).toBeTruthy(); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recheck profile and overview" })));
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not clear unconfirmed admission when guarded reload is declined", async () => {
    const reload = vi.fn(async () => false); panelRequests({ post: json({ operationId: "op-missing-receipt" }, 202) }); render(panel({ onProfileRecheck: reload }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" }));
    await screen.findByRole("button", { name: "Recheck profile and overview" }); fireEvent.click(screen.getByRole("button", { name: "Recheck profile and overview" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce()); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps the readback blocked when operation reconciliation fails", async () => {
    boundary.operations = { ...opsState(), refresh: vi.fn(async () => false) }; panelRequests({ post: json({ operationId: "op-missing-receipt" }, 202) }); render(panel());
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" }));
    await screen.findByRole("button", { name: "Recheck profile and overview" }); fireEvent.click(screen.getByRole("button", { name: "Recheck profile and overview" }));
    await screen.findByText(/readings could not both be confirmed/); expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not let polling supersede a delayed tracked request or start overlapping reads", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const post = new Promise<Response>(ok => { resolve = ok; }); let gets = 0;
    const queued = waitingOverview({ state: "queued", operationId: "op-delayed", reason: "Queued saved source" });
    const writes = panelRequests({ post: () => post, read: async () => json({ profileId: "p1", overview: ++gets === 1 ? overviewFixture() : queued }) });
    await act(async () => render(panel())); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh world overview" })));
    await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(gets).toBe(1); expect(writes).toHaveLength(1);
    await act(async () => resolve(json({ profileId: "p1", jobId: "job-delayed", operationId: "op-delayed", overview: queued }, 202)));
    expect(screen.getByText("Queued saved source")).toBeTruthy(); expect(gets).toBe(2); expect((screen.getByRole("button", { name: "Request world overview" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps accepted controls steady during a delayed background refresh", async () => {
    vi.useFakeTimers(); let reads = 0; let resolve!: (r: Response) => void; const pending = new Promise<Response>(ok => { resolve = ok; });
    panelRequests({ read: async () => ++reads === 1 ? json({ profileId: "p1", overview: overviewFixture() }) : pending });
    await act(async () => render(panel())); await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2); expect((screen.getByRole("button", { name: "Recheck overview" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refresh world overview" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolve(json({ profileId: "p1", overview: overviewFixture() })));
  });
  it("ignores a delayed same-profile read after an explicit parent reload epoch changed", async () => {
    let resolve!: (r: Response) => void; const old = new Promise<Response>(ok => { resolve = ok; }); let reads = 0; const observed = vi.fn();
    panelRequests({ read: async () => ++reads === 1 ? old : json({ profileId: "p1", overview: waitingOverview({ reason: "Fresh reload snapshot" }) }) });
    const view = render(panel({ onOverviewRead: observed, readEpoch: 0 })); await waitFor(() => expect(reads).toBe(1)); view.rerender(panel({ onOverviewRead: observed, readEpoch: 1 }));
    await screen.findByText("Fresh reload snapshot"); await act(async () => resolve(json({ profileId: "p1", overview: overviewFixture() })));
    expect(observed.mock.calls.every(([overview]) => overview.imageUrl === null)).toBe(true);
  });
});

describe("custom override and draft integration", () => {
  function detailRequests(custom = false) {
    let current = defaultProfile({ coverUrl: custom ? "/api/minecraft/profiles/p1/cover?v=1" : null }); const writes: { url: string; method: string; body: unknown }[] = [];
    const overviewReads: (() => Response)[] = [() => json({ profileId: "p1", overview: current.overview })];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      if (method !== "GET") writes.push({ url, method, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "DELETE") { current = { ...current, revision: 2, coverUrl: null }; return json({ profile: current }); }
      if (url.endsWith("/overview")) return (overviewReads.shift() ?? (() => json({ profileId: "p1", overview: current.overview })))();
      if (url.endsWith("/world-settings")) return new Response(JSON.stringify(worldSettingsFixture({ profileId: "p1" })), { headers: { "X-File-Revision": '"file-1"' } });
      if (url.endsWith("/companion")) return json({});
      return json({ profile: current, runtime: profilesFixture({ runtime: { ...profilesFixture().runtime, selectedProfileId: "p2", appliedProfileId: "p2" } }).runtime, capabilities: profilesFixture().capabilities });
    })); return { writes, overviewReads };
  }
  it("reveals the generated default after canonical custom-cover deletion", async () => {
    const { writes } = detailRequests(true); render(<MinecraftProfileDetail id="p1" />); await screen.findByText("Custom cover");
    fireEvent.click(screen.getByRole("button", { name: "Remove cover" })); await screen.findByText("Cover removal read back.");
    expect(screen.getByRole("img", { name: "Generated Overworld overview for Cozy Survival" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "Remove cover" })).toBeNull();
    expect(writes).toMatchObject([{ method: "DELETE", body: { expectedRevision: 1 } }]);
  });
  it("updates only the generated field while metadata, world and manual-upload drafts remain unchanged", async () => {
    const h = detailRequests(); render(<MinecraftProfileDetail id="p1" />); fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Unsaved description" } });
    fireEvent.change(await screen.findByRole("textbox", { name: "difficulty" }), { target: { value: "hard" } });
    fireEvent.change(screen.getByLabelText("JPEG, PNG or WebP cover"), { target: { files: [new File(["manual"], "manual.png", { type: "image/png" })] } });
    h.overviewReads.push(() => json({ profileId: "p1", overview: waitingOverview({ state: "rendering", operationId: "op-2", reason: "Working from saved chunks" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Recheck overview" })); await within(screen.getByLabelText("Generated world overview")).findByText("Working from saved chunks");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved name"); expect((screen.getByRole("textbox", { name: "Description" }) as HTMLInputElement).value).toBe("Unsaved description");
    expect((screen.getByRole("textbox", { name: "difficulty" }) as HTMLInputElement).value).toBe("hard"); expect((screen.getByRole("button", { name: "Upload cover" }) as HTMLButtonElement).disabled).toBe(false); expect(h.writes).toEqual([]);
  });
  it("does not require custom replacement consent when only a generated default exists", async () => {
    const writes: unknown[] = []; const session = { id: "session", profileId: "p1", expiresAt: new Date(Date.now() + 900000).toISOString(), expectedRevision: 1, command: `/yoshling pair ${"c".repeat(43)}` };
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return json({ session }); }
      if (String(input).endsWith("/companion")) return json({ version: "0.1.0", minecraftVersions: ["26.1.2"], loader: "fabric", fileName: "client.jar", downloadUrl: "/companions/client.jar", sha256: overviewHash, bytes: 123 });
      return json({ session: { id: session.id, profileId: session.profileId, expiresAt: session.expiresAt, expectedRevision: 1, state: "waiting" }, verified: false });
    }));
    render(<MinecraftProfileCapture profile={defaultProfile({ target: { mcVersion: "26.1.2", loader: "fabric", loaderVersion: "0.19.5", javaVariant: "java25" } })} runtime={{ ...profilesFixture().runtime, state: "running" }} canEdit onCaptured={vi.fn(async () => {})} onRecheck={vi.fn(async () => true)} />);
    await screen.findByRole("link", { name: /Download client companion/ }); expect(screen.queryByRole("checkbox")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByRole("textbox", { name: "Local Minecraft command" }); expect(writes).toEqual([{ expectedRevision: 1, replaceExisting: false }]);
  });
});
