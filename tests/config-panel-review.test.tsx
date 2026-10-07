// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfigPanel, type ConfigProperty } from "@/components/config-panel";
import { ALL_POWERS, gamesState, installBrowserStubs } from "./helpers/dom";

const capabilities = vi.hoisted(() => ({ edit: true, loading: false, error: null as string | null, access: true }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/lib/use-games", async original => ({
  ...(await original<typeof import("@/lib/use-games")>()),
  useGames: () => gamesState({ can: { ...ALL_POWERS, settingsEdit: capabilities.edit }, loading: capabilities.loading,
    pollError: capabilities.error, access: capabilities.access ? ["minecraft", "7dtd", "zomboid"] : [] }),
}));

beforeAll(() => { installBrowserStubs(); window.scrollTo = vi.fn(); });
beforeEach(() => { Object.assign(capabilities, { edit: true, loading: false, error: null, access: true }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const PROPERTIES: ConfigProperty[] = [
  { name: "PublicName", value: "Old world", help: "Visible world title" },
  { name: "MaxPlayers", value: "12", help: "Connection limit" },
  { name: "ResetID", value: "7", help: "Reset handshake" },
];
const ENDPOINT = "/api/zomboid/config";
const REVISION = '"fixture-loaded"';
const json = (body: unknown, revision: string | null = REVISION, status = 200) => new Response(JSON.stringify(body), {
  status, headers: revision ? { "X-File-Revision": revision } : {},
});

type Write = { endpoint: string; updates: Record<string, string>; revision: string | null };
type Readback = (writes: Write[]) => Response | Promise<Response>;
type WriteAnswer = Response | Promise<Response> | Readback;
function requests(properties = PROPERTIES, answer?: WriteAnswer, readback?: Readback) {
  const writes: Write[] = [];
  const reads = vi.fn();
  let current = properties.map(property => ({ ...property }));
  let currentRevision: string | null = REVISION;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const { updates } = JSON.parse(String(init.body));
      writes.push({ endpoint: String(url), updates, revision: new Headers(init.headers).get("X-Expected-File-Revision") });
      const response = await (typeof answer === "function" ? answer(writes) : answer ?? json({ applied: Object.keys(updates) }, '"fixture-written"'));
      if (response.ok) {
        currentRevision = response.headers.get("X-File-Revision") || response.headers.get("ETag");
        const receipt = await response.clone().json();
        if (Array.isArray(receipt.applied)) current = current.map(property => receipt.applied.includes(property.name) && typeof updates[property.name] === "string" ? { ...property, value: updates[property.name] } : property);
      }
      return response;
    }
    if (String(url).includes("/status")) { reads(url); return json({ live: null }); }
    return writes.length > 0 && readback ? readback(writes) : json({ properties: current }, currentRevision);
  }));
  return { writes, reads };
}

function panel(endpoint = ENDPOINT) {
  return <ConfigPanel tint="var(--pz)" endpoint={endpoint} subtitle="Fixture config" groupOrder={["Fixture"]} groupOf={() => "Fixture"} />;
}

async function open(properties = PROPERTIES, answer?: WriteAnswer, readback?: Readback) {
  const calls = requests(properties, answer, readback);
  const result = render(panel());
  fireEvent.click(screen.getByText("All settings"));
  await screen.findByDisplayValue(properties[0].value);
  return { ...calls, ...result };
}

async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Save all" }));
  return within(await screen.findByRole("dialog", { name: "Review settings changes" }));
}

describe("configuration review", () => {
  it("requires review confirmation, sends only changed values with their revision and refreshes live evidence", async () => {
    const { writes, reads } = await open();
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload); expect(cleanUnload.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload); expect(dirtyUnload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    expect(writes).toEqual([]);
    const dialog = within(await screen.findByRole("dialog", { name: "Review settings changes" }));
    expect(dialog.getByText("Old world")).toBeTruthy();
    expect(dialog.getByText("New world")).toBeTruthy();
    expect(dialog.queryByText("MaxPlayers")).toBeNull();
    expect(dialog.getByText(/Saving does not prove/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Keep editing" }));
    expect(writes).toEqual([]);
    expect((screen.getByDisplayValue("New world") as HTMLInputElement).value).toBe("New world");
    const confirmed = await review();
    fireEvent.click(confirmed.getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(writes).toEqual([{ endpoint: ENDPOINT, updates: { PublicName: "New world" }, revision: REVISION }]));
    await screen.findByText("No changes");
    expect(reads.mock.calls.some(([url]) => String(url).includes("fresh=1"))).toBe(true);
    expect(toasts.success).toHaveBeenCalledWith("Saved 1 setting.");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("masks both secret values inside the rendered review", async () => {
    await open([
      { name: "ServerPassword", value: "old-fixture-lock", help: "" },
      { name: "DiscordToken", value: "old-fixture-token", help: "" },
    ]);
    fireEvent.change(screen.getByDisplayValue("old-fixture-lock"), { target: { value: "new-fixture-lock" } });
    fireEvent.change(screen.getByDisplayValue("old-fixture-token"), { target: { value: "new-fixture-token" } });
    const dialog = await review();
    expect(dialog.getAllByText("Hidden")).toHaveLength(4);
    for (const value of ["old-fixture-lock", "new-fixture-lock", "old-fixture-token", "new-fixture-token"]) {
      expect(screen.getByRole("dialog").textContent).not.toContain(value);
      expect(dialog.queryByText(value)).toBeNull();
    }
    expect(dialog.getByText("Secret values are hidden in this review.")).toBeTruthy();
  });

  it("shows the existing next-world explanation for a changed creation key", async () => {
    await open();
    fireEvent.change(screen.getByDisplayValue("7"), { target: { value: "8" } });
    const dialog = await review();
    expect(dialog.getByText("applies to the next world")).toBeTruthy();
    expect(dialog.getByText("ResetID")).toBeTruthy();
  });

  it("filters the editor to changed settings and combines that filter with search", async () => {
    await open();
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show changed only" }));
    expect(screen.queryByDisplayValue("12")).toBeNull();
    expect(screen.getByDisplayValue("New world")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Filter settings…"), { target: { value: "Connection" } });
    expect(screen.queryByDisplayValue("New world")).toBeNull();
    expect(screen.queryByDisplayValue("12")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter settings…"), { target: { value: "Visible" } });
    expect(screen.getByDisplayValue("New world")).toBeTruthy();
  });

  it("confirms discard, preserves cancelled drafts and writes nothing", async () => {
    const { writes } = await open();
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    let dialog = within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Keep changes" }));
    expect(screen.getByDisplayValue("New world")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    dialog = within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Discard draft" }));
    await screen.findByDisplayValue("Old world");
    expect(screen.getByText("No changes")).toBeTruthy();
    expect(writes).toEqual([]);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
  });

  it("freezes a stale snapshot and asks before discarding it for reload", async () => {
    const { writes } = await open(PROPERTIES, json({ error: "Changed on disk", stale: true }, "", 409));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("New world") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    let dialog = within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Keep changes" }));
    expect(screen.getByDisplayValue("New world")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    dialog = within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Discard and reload" }));
    await screen.findByDisplayValue("Old world");
    expect(writes).toHaveLength(1);
  });

  it.each([
    { loading: true }, { edit: false }, { error: "Status read failed" }, { access: false },
  ])("blocks editing when current permission cannot authorize it: %j", async permission => {
    Object.assign(capabilities, permission);
    const { writes } = await open();
    const input = screen.getByDisplayValue("Old world") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Unauthorized draft" } });
    expect(screen.queryByRole("button", { name: "Save all" })).toBeNull();
    expect(screen.getByText("No changes")).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("rechecks permission while a reviewed draft is open", async () => {
    const { writes, rerender } = await open();
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    await review();
    capabilities.edit = false; rerender(panel());
    const confirm = screen.getByRole("button", { name: "Save 1 change" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(writes).toEqual([]);
    expect(screen.getByRole("dialog").textContent).toContain("Saving is unavailable");
  });

  it("keeps existing partial-save reporting and fresh live checks", async () => {
    const { reads } = await open(PROPERTIES, json({ applied: ["PublicName"], ignored: ["MaxPlayers"] }, '"partial-written"'));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.change(screen.getByDisplayValue("12"), { target: { value: "13" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 2 changes" }));
    await screen.findByText("No changes");
    expect(screen.getByDisplayValue("New world")).toBeTruthy();
    expect(screen.getByDisplayValue("12")).toBeTruthy();
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining("Saved 1 of 2 settings"));
    expect(reads.mock.calls.some(([url]) => String(url).includes("fresh=1"))).toBe(true);
  });

  it("locks the reviewed draft while its save is pending", async () => {
    let resolve!: (value: Response) => void;
    const { writes } = await open(PROPERTIES, new Promise<Response>(done => { resolve = done; }));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "Reviewed world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const field = screen.getByDisplayValue("Reviewed world") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Later draft" } });
    expect(field.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    resolve(json({ applied: ["PublicName"] }, '"written"'));
    await screen.findByText("No changes");
    expect(screen.getByDisplayValue("Reviewed world")).toBeTruthy();
    expect(writes[0].updates).toEqual({ PublicName: "Reviewed world" });
  });

  it("drops old endpoint reads and drafts when the panel identity changes", async () => {
    let oldRead!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/status") ? json({ live: null }) : url === ENDPOINT ? new Promise<Response>(done => { oldRead = done; }) : json({ properties: [{ name: "ServerName", value: "New endpoint", help: "" }] })));
    const view = render(panel()); fireEvent.click(screen.getByText("All settings"));
    view.rerender(panel("/api/7dtd/config/all"));
    fireEvent.click(screen.getByText("All settings"));
    await screen.findByDisplayValue("New endpoint");
    oldRead(json({ properties: PROPERTIES }));
    await waitFor(() => expect(screen.queryByDisplayValue("Old world")).toBeNull());
    expect(screen.getByDisplayValue("New endpoint")).toBeTruthy();
  });

  it("offers no writable fallback while the config read is pending", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") { writes.push("write"); return json({ applied: [] }); }
      return new Promise<Response>(() => {});
    }));
    render(panel()); fireEvent.click(screen.getByText("All settings"));
    expect(screen.queryByRole("button", { name: "Save all" })).toBeNull();
    expect(screen.queryByDisplayValue("Old world")).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each([{ body: { error: "Read unavailable" }, status: 503 }, { body: { properties: [{ name: "Bad" }] }, status: 200 }])("blocks review after a failed or incomplete initial read", async answer => {
    vi.stubGlobal("fetch", vi.fn(async () => json(answer.body, "", answer.status)));
    render(panel()); fireEvent.click(screen.getByText("All settings"));
    await screen.findByRole("alert");
    const save = screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([{}, { applied: ["A different setting"] }, { applied: ["MaxPlayers"] }, { applied: ["PublicName"], ignored: [null] },
    { applied: ["PublicName", "PublicName"] }, { applied: [], ignored: ["PublicName", "PublicName"] },
    { applied: ["PublicName"], ignored: ["PublicName"] },
  ])("keeps a draft unconfirmed after an unusable save receipt: %j", async receipt => {
    const { writes } = await open(PROPERTIES, json(receipt));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByRole("alert");
    expect(writes).toHaveLength(1);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("unconfirmed"));
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  });

  it("reads canonical saved values and carries their GET revision into the next review", async () => {
    const { writes } = await open(PROPERTIES, writes => json({ applied: Object.keys(writes.at(-1)!.updates) }, `"canonical-${writes.length}"`), writes => json({ properties: PROPERTIES.map(property =>
      property.name === "PublicName" ? { ...property, value: writes.at(-1)!.updates.PublicName.trim() } : property,
    ) }, `"canonical-${writes.length}"`));
    fireEvent.change(screen.getByRole("textbox", { name: "Public Name" }), { target: { value: "  New world  " } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByDisplayValue("New world");
    await screen.findByText("No changes");
    expect(screen.queryByDisplayValue("  New world  ")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Public Name" }), { target: { value: "Next world" } });
    const dialog = await review(); expect(dialog.getByText("New world")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(writes[1].revision).toBe('"canonical-1"'));
    await screen.findByText("No changes");
  });

  it.each([
    { properties: null }, { properties: [] }, { error: "Readback unavailable" },
    { properties: [{ name: "PublicName", value: 17, help: "" }] },
    { properties: [{ name: "PublicName", value: "New world", help: "" }, { name: "PublicName", value: "Another value", help: "" }] },
  ])("freezes accepted writes when canonical readback cannot confirm their fields: %j", async body => {
    await open(PROPERTIES, undefined, () => json(body, '"fixture-written"'));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByRole("alert");
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retains an unanswered draft only when its baseline stayed unchanged", async () => {
    await open(PROPERTIES, json({ applied: ["PublicName"] }, '"readback-current"'), () => json({ properties: PROPERTIES.map(property => property.name === "PublicName" ? { ...property, value: "New world" } : property) }, '"readback-current"'));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.change(screen.getByDisplayValue("12"), { target: { value: "13" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 2 changes" }));
    await screen.findByText("1 changed");
    expect(screen.getByDisplayValue("13")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("accepts an explicit empty applied receipt and reports its ignored field without success", async () => {
    await open(PROPERTIES, json({ applied: [], ignored: ["PublicName"] }));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByText("No changes");
    expect(screen.getByDisplayValue("Old world")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining("Nothing was saved"));
  });

  it("freezes an unanswered draft whose baseline changed during readback", async () => {
    await open(PROPERTIES, json({ applied: ["PublicName"] }, '"concurrent-rewrite"'), () => json({ properties: PROPERTIES.map(property =>
      property.name === "PublicName" ? { ...property, value: "New world" } : property.name === "MaxPlayers" ? { ...property, value: "14" } : property,
    ) }, '"concurrent-rewrite"'));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.change(screen.getByDisplayValue("12"), { target: { value: "13" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 2 changes" }));
    await screen.findByRole("alert");
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("13")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives every editor control an explicit accessible label", async () => {
    await open([
      ...PROPERTIES, { name: "PVP", value: "true", help: "" },
    ]);
    expect(screen.getByRole("textbox", { name: "Public Name" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Max Players" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "PVP" })).toBeTruthy();
  });

  it("associates enum labels with their dropdown controls", async () => {
    requests([...PROPERTIES, { name: "Region", value: "Europe", help: "" }]);
    render(<ConfigPanel tint="var(--pz)" endpoint={ENDPOINT} subtitle="Fixture config" groupOrder={["Fixture"]} groupOf={() => "Fixture"}
      selects={{ Region: [{ value: "Europe", label: "Europe" }, { value: "Asia", label: "Asia" }] }} />);
    fireEvent.click(screen.getByText("All settings"));
    expect(await screen.findByRole("combobox", { name: "Region" })).toBeTruthy();
  });

  it.each([
    { description: "an intervening applied-key rewrite", revision: '"external-rewrite"', value: "Old world" },
    { description: "a missing GET revision after a published PUT revision", revision: null, value: "New world" },
  ])("freezes the draft after $description", async ({ revision, value }) => {
    const { writes } = await open(PROPERTIES, json({ applied: ["PublicName"] }, '"published-write"'), () => json({ properties: PROPERTIES.map(property =>
      property.name === "PublicName" ? { ...property, value } : property,
    ) }, revision));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByRole("alert");
    expect(writes).toHaveLength(1);
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect((screen.getByDisplayValue("New world") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled).toBe(true);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining("unconfirmed"));
  });

  it("preserves explicit legacy receipt/readback compatibility when both revisions are absent", async () => {
    await open(PROPERTIES, json({ applied: ["PublicName"] }, null));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByText("No changes");
    expect(toasts.success).toHaveBeenCalledWith("Saved 1 setting.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("compares weak ETag receipts using the same opaque token as the canonical GET", async () => {
    const answer = new Response(JSON.stringify({ applied: ["PublicName"] }), { headers: { ETag: 'W/"published-write"' } });
    await open(PROPERTIES, answer, () => json({ properties: PROPERTIES.map(property => property.name === "PublicName" ? { ...property, value: "New world" } : property) }, '"published-write"'));
    fireEvent.change(screen.getByDisplayValue("Old world"), { target: { value: "New world" } });
    fireEvent.click((await review()).getByRole("button", { name: "Save 1 change" }));
    await screen.findByText("No changes");
    expect(toasts.success).toHaveBeenCalledWith("Saved 1 setting.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
