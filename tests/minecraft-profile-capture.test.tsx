// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MinecraftProfileCapture } from "@/components/minecraft-profile-capture";
import { MinecraftProfileDetail } from "@/components/minecraft-profile-detail";
import { parseMinecraftCaptureCompanion, parseMinecraftCaptureGrant, parseMinecraftCaptureReceipt } from "@/lib/minecraft-capture-client";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";
import { profileFixture, profilesFixture, worldSettingsFixture } from "./helpers/minecraft-profiles";
import { waitingOverview } from "./helpers/minecraft-overviews";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
const boundary = vi.hoisted(() => ({ games: null as unknown, operations: null as unknown }));
vi.mock("@/lib/use-games", async original => ({ ...(await original<typeof import("@/lib/use-games")>()), useGames: () => boundary.games }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => boundary.operations }));
beforeAll(installBrowserStubs);
beforeEach(() => { boundary.games = gamesState({ lastSuccessAt: Date.now() }); boundary.operations = opsState(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const json = (raw: unknown, status = 200) => new Response(JSON.stringify(raw), { status });
const manifest = { version: "0.1.0", minecraftVersions: ["26.1.2"], loader: "fabric", fileName: "yoshling-screenshots-0.1.0+mc26.1.2.jar", downloadUrl: "/companions/yoshling-screenshots-0.1.0+mc26.1.2.jar", sha256: "a".repeat(64), bytes: 12345 };
const profile = () => profileFixture({ target: { mcVersion: "26.1.2", loader: "fabric", loaderVersion: "0.19.5", javaVariant: "java25" } });
const runtime = () => ({ ...profilesFixture().runtime, state: "running" as const });
const grant = () => ({ id: "session1", profileId: "p1", expiresAt: new Date(Date.now() + 900_000).toISOString(), expectedRevision: 1, command: `/yoshling pair ${"c".repeat(43)}` });
function status(session = grant(), state = "waiting", captured?: MinecraftProfileDTO) { return { session: { id: session.id, profileId: session.profileId, expiresAt: session.expiresAt, expectedRevision: session.expectedRevision, state }, verified: state === "complete", ...(captured ? { profile: captured } : {}) }; }
function harness(options: { status?: (session: ReturnType<typeof grant>) => Promise<Response> | Response; mint?: () => Promise<Response> | Response; manifest?: unknown; cancel?: unknown } = {}) {
  const session = grant(), writes: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    if (method !== "GET") writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/companion")) return json(options.manifest ?? manifest);
    if (method === "POST") return options.mint ? options.mint() : json({ session });
    if (method === "DELETE") return json(options.cancel ?? { cancelled: true, sessionId: session.id });
    return options.status ? options.status(session) : json(status(session));
  }));
  return { writes, session };
}
const renderPanel = (over: Partial<Parameters<typeof MinecraftProfileCapture>[0]> = {}) => render(<MinecraftProfileCapture profile={profile()} runtime={runtime()} canEdit onCaptured={vi.fn(async () => {})} onRecheck={vi.fn(async () => true)} {...over} />);
async function mint() { await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" })); await screen.findByRole("textbox", { name: "Local Minecraft command" }); }

describe("player-camera capture panel", () => {
  it("pairs explicitly for this profile without power actions or persistent command storage", async () => {
    const { writes } = harness(); renderPanel(); await mint();
    expect(writes).toEqual([{ method: "POST", url: "/api/minecraft/profiles/p1/capture", body: { expectedRevision: 1, replaceExisting: false } }]);
    expect(screen.getByText(/Java 25/)).toBeTruthy(); expect(screen.getByText(/separate from the generated world overview/)).toBeTruthy();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it.each([
    { canEdit: false }, { profile: profileFixture() }, { profile: { ...profile(), status: "failed" as const } },
    { runtime: { ...runtime(), verified: false } }, { runtime: { ...runtime(), state: "stopped" as const } },
    { runtime: { ...runtime(), appliedProfileId: "p2" } }, { runtime: { ...runtime(), selectedProfileId: "p2" } },
  ])("never mints when permission, exact target or applied running identity is unavailable %j", async over => {
    const { writes } = harness(); renderPanel(over); await screen.findByRole("link", { name: /Download client companion/ });
    const button = screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(writes).toEqual([]);
  });
  it("requires explicit existing-cover replacement consent", async () => {
    const { writes } = harness(); renderPanel({ profile: { ...profile(), coverUrl: "/api/minecraft/profiles/p1/cover?v=1" } });
    await screen.findByRole("link", { name: /Download client companion/ }); const button = screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    await screen.findByRole("textbox", { name: "Local Minecraft command" }); expect(writes[0].body).toEqual({ expectedRevision: 1, replaceExisting: true });
  });
  it("does not offer an untrusted companion and supports read retry", async () => {
    const { writes } = harness({ manifest: { ...manifest, downloadUrl: "https://untrusted.invalid/file.jar" } }); renderPanel();
    await screen.findByRole("alert"); expect(screen.queryByRole("link", { name: /Download client companion/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
    harness(); fireEvent.click(screen.getByRole("button", { name: "Retry companion download" })); await screen.findByRole("link", { name: /Download client companion/ }); expect(writes).toEqual([]);
  });
  it("waits for Clipboard success and offers manual copying on denial", async () => {
    let resolve!: () => void; const pending = new Promise<void>(ok => { resolve = ok; });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => pending) } });
    harness(); renderPanel(); await mint(); fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(screen.queryByRole("button", { name: "Command copied" })).toBeNull(); await act(async () => resolve());
    expect(screen.getByRole("button", { name: "Command copied" })).toBeTruthy();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    fireEvent.click(screen.getByRole("button", { name: "Command copied" })); await screen.findByText(/Clipboard unavailable/);
    expect((screen.getByRole("textbox", { name: "Local Minecraft command" }) as HTMLInputElement).readOnly).toBe(true);
  });
  it("expires the displayed command and disables copy without silently minting another session", async () => {
    const { writes, session } = harness(); renderPanel(); await screen.findByRole("link", { name: /Download client companion/ }); vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Request pairing session" })));
    await act(async () => { vi.setSystemTime(Date.parse(session.expiresAt) + 1); await vi.advanceTimersByTimeAsync(1000); });
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Local Minecraft command" }) as HTMLInputElement).value).toBe("Session no longer active");
    expect(screen.getByText(/pairing session expired/)).toBeTruthy(); expect(writes.filter(w => w.method === "POST")).toHaveLength(1);
  });
  it.each(["network", "malformed"])("keeps unknown mint %s outcomes unconfirmed without an automatic retry", async kind => {
    const { writes } = harness({ mint: () => kind === "network" ? Promise.reject(new Error("offline")) : json({ session: { ...grant(), profileId: "p2" } }) }); renderPanel();
    await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByText(/pairing request result is unconfirmed/); expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true); expect(writes).toHaveLength(1);
  });
  it("never treats paired status or unverified complete data as a saved cover", async () => {
    const onCaptured = vi.fn(async () => {}); let bad = false;
    harness({ status: session => json(bad ? { ...status(session, "complete", { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" }), verified: false } : status(session, "paired")) });
    renderPanel({ onCaptured }); await screen.findByRole("link", { name: /Download client companion/ }); vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Request pairing session" })));
    expect(screen.getByText(/Client paired/)).toBeTruthy(); expect(onCaptured).not.toHaveBeenCalled();
    bad = true; await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); vi.useRealTimers();
    await screen.findByText(/capture result is unconfirmed/); expect(onCaptured).not.toHaveBeenCalled(); expect(screen.queryByText(/^Screenshot cover read back and saved/)).toBeNull();
  });
  it("waits for parent canonical readback before claiming success", async () => {
    let resolve!: () => void; const readback = new Promise<void>(ok => { resolve = ok; }); const onCaptured = vi.fn(() => readback);
    const captured = { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" };
    harness({ status: session => json(status(session, "complete", captured)) }); renderPanel({ onCaptured }); await mint();
    await waitFor(() => expect(onCaptured).toHaveBeenCalledWith(captured, profile())); expect(screen.queryByText(/^Screenshot cover read back and saved/)).toBeNull();
    await act(async () => resolve()); await screen.findByText(/^Screenshot cover read back and saved/);
  });
  it("ignores an old-profile status reply after changing detail identity", async () => {
    let resolve!: (r: Response) => void; const pending = new Promise<Response>(ok => { resolve = ok; }); const onCaptured = vi.fn(async () => {});
    const { session } = harness({ status: () => pending }); const view = renderPanel({ onCaptured }); await mint();
    view.rerender(<MinecraftProfileCapture profile={{ ...profile(), id: "p2" }} runtime={runtime()} canEdit onCaptured={onCaptured} onRecheck={vi.fn(async () => true)} />);
    await act(async () => resolve(json(status(session, "complete", { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" }))));
    expect(onCaptured).not.toHaveBeenCalled(); expect(screen.queryByRole("textbox", { name: "Local Minecraft command" })).toBeNull();
  });
  it("requires a matching cancellation receipt before forgetting the grant", async () => {
    const { writes } = harness({ cancel: { cancelled: true, sessionId: "another-session" } }); renderPanel(); await mint();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pairing session" })); await screen.findByText(/Cancellation is unconfirmed/);
    expect(screen.getByRole("textbox", { name: "Local Minecraft command" })).toBeTruthy(); expect(writes.filter(w => w.method === "DELETE")).toHaveLength(1);
  });
  it("rechecks an unknown status without reminting or treating old waiting data as success", async () => {
    let reads = 0; const onCaptured = vi.fn(async () => {});
    const { writes } = harness({ status: session => ++reads === 1 ? json({ error: "lookup unavailable" }, 503) : json(status(session, "uploading")) });
    renderPanel({ onCaptured }); await mint(); await screen.findByText(/capture result is unconfirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Recheck capture status" })); await screen.findByText(/Your client is uploading/);
    expect(writes.filter(w => w.method === "POST")).toHaveLength(1); expect(onCaptured).not.toHaveBeenCalled();
  });
  it("hides the command on permission loss and allows no new grant", async () => {
    const { writes } = harness(); const view = renderPanel(); await mint();
    view.rerender(<MinecraftProfileCapture profile={profile()} runtime={runtime()} canEdit={false} onCaptured={vi.fn(async () => {})} onRecheck={vi.fn(async () => true)} />);
    expect(screen.queryByRole("textbox", { name: "Local Minecraft command" })).toBeNull();
    expect((screen.getByRole("button", { name: "Request a new pairing session" }) as HTMLButtonElement).disabled).toBe(true); expect(writes).toHaveLength(1);
  });
  it("cancels explicitly and discards a delayed status or Clipboard receipt from that session", async () => {
    let resolve!: (r: Response) => void, copied!: () => void;
    const old = new Promise<Response>(ok => { resolve = ok; }), copy = new Promise<void>(ok => { copied = ok; });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => copy) } });
    const onCaptured = vi.fn(async () => {}); const { writes, session } = harness({ status: () => old }); renderPanel({ onCaptured }); await mint();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" })); fireEvent.click(screen.getByRole("button", { name: "Cancel pairing session" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Local Minecraft command" })).toBeNull());
    await act(async () => { copied(); resolve(json(status(session, "complete", { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" }))); });
    expect(onCaptured).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Command copied" })).toBeNull();
    expect(writes.filter(w => w.method === "DELETE")).toEqual([{ method: "DELETE", url: "/api/minecraft/profiles/p1/capture/session1", body: null }]);
  });
  it.each([false, "throws"])("keeps pairing blocked when the explicit profile recheck is not accepted (%s)", async result => {
    const onRecheck = vi.fn(async () => { if (result === "throws") throw new Error("read failed"); return false; });
    harness({ mint: () => Promise.reject(new Error("offline")) }); renderPanel({ onRecheck });
    await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByRole("button", { name: "Recheck profile for capture" }); fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalledOnce()); await waitFor(() => expect((screen.getByRole("button", { name: "Recheck profile for capture" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("capture detail reconciliation", () => {
  function detailHarness(mode: "matching" | "changed" | "local-newer") {
    const session = grant(); let resolve!: (response: Response) => void; const pending = new Promise<Response>(ok => { resolve = ok; }); let captured = false;
    const cover = { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" };
    const manualCover = { ...profile(), revision: 3, coverUrl: "/api/minecraft/profiles/p1/cover?v=manual" }; let manual = false;
    let settingReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/companion")) return json(manifest);
      if (url.endsWith("/capture") && init?.method === "POST") return json({ session });
      if (url.endsWith("/capture/session1")) return pending;
      if (url.endsWith("/cover") && init?.method === "POST") { manual = true; return json({ profile: manualCover }); }
      if (url.endsWith("/overview")) return json({ profileId: "p1", overview: waitingOverview() });
      if (url.endsWith("/world-settings")) { settingReads++; return new Response(JSON.stringify(worldSettingsFixture({ profileId: "p1", editable: false })), { headers: { "X-File-Revision": '"r1"' } }); }
      return json({ profile: captured ? mode === "changed" ? { ...cover, name: "Changed elsewhere" } : cover : manual ? manualCover : profile(), runtime: runtime(), capabilities: profilesFixture().capabilities });
    }));
    return { complete: async () => { captured = true; await act(async () => resolve(json(status(session, "complete", cover)))); }, settingReads: () => settingReads };
  }
  it("merges a canonical cover without resetting metadata or the selected manual upload", async () => {
    const h = detailHarness("matching"); render(<MinecraftProfileDetail id="p1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Unsaved description" } });
    fireEvent.change(screen.getByLabelText("JPEG, PNG or WebP cover"), { target: { files: [new File(["manual"], "manual.png", { type: "image/png" })] } });
    await mint(); await h.complete(); await screen.findByText(/^Screenshot cover read back and saved. Unsaved/);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved name");
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLInputElement).value).toBe("Unsaved description");
    expect((screen.getByRole("button", { name: "Upload cover" }) as HTMLButtonElement).disabled).toBe(false);
    expect(h.settingReads()).toBe(1); expect(screen.getByAltText("Cover for Cozy Survival")).toBeTruthy();
  });
  it("freezes a conflicting canonical readback and preserves the draft for explicit reload", async () => {
    const h = detailHarness("changed"); render(<MinecraftProfileDetail id="p1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Keep my draft" } }); await mint(); await h.complete();
    await screen.findByRole("button", { name: "Reload profile" });
    expect(screen.queryByText(/^Screenshot cover read back and saved/)).toBeNull(); expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Keep my draft");
    expect((screen.getByRole("button", { name: "Save profile details" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not replace a newer manual cover with a late verified capture receipt", async () => {
    const h = detailHarness("local-newer"); render(<MinecraftProfileDetail id="p1" />); await mint();
    fireEvent.change(screen.getByLabelText("JPEG, PNG or WebP cover"), { target: { files: [new File(["manual"], "manual.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload cover" })); await screen.findByText("Cover upload read back.");
    await h.complete(); await screen.findByRole("button", { name: "Reload profile" });
    expect(screen.getByAltText("Cover for Cozy Survival").getAttribute("src")).toContain("v=manual"); expect(screen.queryByText(/^Screenshot cover read back and saved/)).toBeNull();
  });
  function recheckHarness(failRead: boolean, mintRefusal = false) {
    let reads = 0, writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/companion")) return json(manifest);
      if (url.endsWith("/capture") && init?.method === "POST") { writes++; if (mintRefusal) return json({ error: "This profile changed; reload before pairing", code: "capture_stale" }, 409); throw new Error("offline"); }
      if (url.endsWith("/overview")) return json({ profileId: "p1", overview: waitingOverview() });
      if (url.endsWith("/world-settings")) return new Response(JSON.stringify(worldSettingsFixture({ profileId: "p1", editable: false })), { headers: { "X-File-Revision": '"r1"' } });
      reads++; if (reads > 1 && failRead) return json({ error: "Profile read unavailable" }, 503);
      return json({ profile: mintRefusal && reads > 1 ? { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" } : profile(), runtime: runtime(), capabilities: profilesFixture().capabilities });
    })); return { reads: () => reads, writes: () => writes };
  }
  it("preserves drafts and blocks another mint when the user declines capture recheck discard", async () => {
    const h = recheckHarness(false); vi.stubGlobal("confirm", vi.fn(() => false)); render(<MinecraftProfileDetail id="p1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Keep this name" } });
    fireEvent.change(screen.getByLabelText("JPEG, PNG or WebP cover"), { target: { files: [new File(["manual"], "manual.png", { type: "image/png" })] } });
    await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByRole("button", { name: "Recheck profile for capture" }); fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(h.reads()).toBe(1); expect(h.writes()).toBe(1); expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Keep this name");
    expect((screen.getByRole("button", { name: "Upload cover" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not clear capture block after a confirmed reload whose profile read failed", async () => {
    const h = recheckHarness(true); vi.stubGlobal("confirm", vi.fn(() => true)); render(<MinecraftProfileDetail id="p1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unanswered draft" } });
    await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByRole("button", { name: "Recheck profile for capture" }); fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await screen.findByText(/Profile read unavailable/); expect(h.reads()).toBe(2); expect(h.writes()).toBe(1);
    expect(screen.getByRole("button", { name: "Recheck profile for capture" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unanswered draft");
  });
  it("clears capture block only after an accepted guarded fresh profile read", async () => {
    const h = recheckHarness(false); vi.stubGlobal("confirm", vi.fn(() => true)); render(<MinecraftProfileDetail id="p1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Deliberate discard" } });
    await screen.findByRole("link", { name: /Download client companion/ }); expect(screen.getByText(/Fabric Loader 0.19.5\+/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request pairing session" })); await screen.findByRole("button", { name: "Recheck profile for capture" });
    fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recheck profile for capture" })).toBeNull());
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Cozy Survival");
    expect(h.reads()).toBe(2); expect(h.writes()).toBe(1); expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("offers a guarded fresh running-profile recheck before pairing from a stopped snapshot", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async input => {
      const url = String(input);
      if (url.endsWith("/companion")) return json(manifest);
      if (url.endsWith("/overview")) return json({ profileId: "p1", overview: waitingOverview() });
      if (url.endsWith("/world-settings")) return new Response(JSON.stringify(worldSettingsFixture({ profileId: "p1", editable: false })), { headers: { "X-File-Revision": '"r1"' } });
      return json({ profile: profile(), runtime: reads++ === 0 ? { ...runtime(), state: "stopped" } : runtime(), capabilities: profilesFixture().capabilities });
    }));
    render(<MinecraftProfileDetail id="p1" />); await screen.findByRole("link", { name: /Download client companion/ });
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(false));
    expect(reads).toBe(2); expect(screen.queryByRole("button", { name: "Recheck profile for capture" })).toBeNull();
  });
  it("preserves a named stale refusal and blocks its old revision until explicit canonical recheck", async () => {
    const h = recheckHarness(false, true); render(<MinecraftProfileDetail id="p1" />);
    await screen.findByRole("link", { name: /Download client companion/ }); fireEvent.click(screen.getByRole("button", { name: "Request pairing session" }));
    await screen.findByText("This profile changed; reload before pairing");
    expect(screen.queryByText(/pairing request result is unconfirmed/)).toBeNull();
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recheck profile for capture" }));
    await screen.findByRole("checkbox", { name: /Replace this profile/ });
    expect(h.reads()).toBe(2); expect(h.writes()).toBe(1); expect(screen.queryByText("This profile changed; reload before pairing")).toBeNull();
    expect(screen.getByAltText("Cover for Cozy Survival").getAttribute("src")).toContain("v=2");
    expect((screen.getByRole("button", { name: "Request pairing session" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("capture response admission", () => {
  it("rejects wrong profile/revision commands and unsupported or external artifacts", () => {
    const session = grant(); expect(parseMinecraftCaptureGrant({ session }, "p1", 1)).not.toBeNull();
    expect(parseMinecraftCaptureGrant({ session }, "p2", 1)).toBeNull(); expect(parseMinecraftCaptureGrant({ session }, "p1", 2)).toBeNull();
    expect(parseMinecraftCaptureGrant({ session: { ...session, command: "/send secret" } }, "p1", 1)).toBeNull();
    expect(parseMinecraftCaptureGrant({ session: { ...session, command: "/yoshling pair short-code" } }, "p1", 1)).toBeNull();
    expect(parseMinecraftCaptureCompanion(manifest)).not.toBeNull();
    expect(parseMinecraftCaptureCompanion({ ...manifest, sha256: "wrong" })).toBeNull(); expect(parseMinecraftCaptureCompanion({ ...manifest, downloadUrl: "//untrusted.invalid/artifact.jar" })).toBeNull();
  });
  it("refuses false complete, wrong session, and mismatched canonical profile revision", () => {
    const session = grant(), captured = { ...profile(), revision: 2, coverUrl: "/api/minecraft/profiles/p1/cover?v=2" };
    expect(parseMinecraftCaptureReceipt(status(session, "complete", captured), session)).not.toBeNull();
    expect(parseMinecraftCaptureReceipt({ ...status(session, "complete", captured), verified: false }, session)).toBeNull();
    expect(parseMinecraftCaptureReceipt(status({ ...session, id: "other" }, "complete", captured), session)).toBeNull();
    expect(parseMinecraftCaptureReceipt(status(session, "complete", { ...captured, revision: 3 }), session)).toBeNull();
  });
  it("rejects non-string session states instead of coercing them into progress", () => {
    const session = grant(), receipt = status(session);
    expect(parseMinecraftCaptureReceipt({ ...receipt, session: { ...receipt.session, state: ["waiting"] } }, session)).toBeNull();
  });
});
