// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import WhitelistPage from "@/app/whitelist/page";
import { installBrowserStubs } from "./helpers/dom";
const spies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), signOut: vi.fn(async () => {}) }));
vi.mock("sonner", () => ({ toast: spies }));
vi.mock("next-auth/react", () => ({ signOut: spies.signOut }));
beforeAll(installBrowserStubs);
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const SELF = "9007199254740993";
const FRIEND = "9007199254740995";
const NEW = "18446744073709551615";
const TAG = '"current-revision"';
const PAYLOAD = { users: [SELF, FRIEND], source: "file", labels: { [SELF]: "Shared display name", [FRIEND]: "Shared display name" }, selfId: SELF };
const json = (body: unknown, tag: string | null = TAG, status = 200) => new Response(JSON.stringify(body), { status, headers: tag ? { ETag: tag } : {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
type Answer = Response | Error | Promise<Response>;
function fetches(reads: Answer[] = [json(PAYLOAD)], writes: Answer[] = []) {
  const posted: { body: Record<string, unknown>; revision: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body); posted.push({ body, revision: new Headers(init.headers).get("If-Match") });
      const answer = writes.shift() ?? json({ success: true, users: body.users }, '"saved-revision"');
      if (answer instanceof Error) throw answer; return answer;
    }
    const answer = reads.shift() ?? json(PAYLOAD); if (answer instanceof Error) throw answer; return answer;
  }));
  return posted;
}
async function loaded() { render(<WhitelistPage />); await screen.findByRole("textbox", { name: "Discord user ID" }); }
const remove = (id: string) => fireEvent.click(screen.getByRole("button", { name: `Remove Discord ID ${id}` }));
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Whitelist" }));

describe("sign-in list reads", () => {
  it("offers no edits or loaded-empty claim while GET is pending", () => {
    fetches([new Promise<Response>(() => {})]); render(<WhitelistPage />);
    expect(screen.getByLabelText("Loading sign-in list")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save Whitelist" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/The draft is empty/)).toBeNull();
  });
  it.each([
    ["network", new Error("Disconnected")], ["HTTP", json(PAYLOAD, TAG, 403)],
    ["non-ID list", json({ ...PAYLOAD, users: ["Shared display name"] })],
    ["numeric ID", json({ ...PAYLOAD, users: [Number(SELF)] })],
    ["bad labels", json({ ...PAYLOAD, labels: { [SELF]: {} } })],
    ["unknown source", json({ ...PAYLOAD, source: "unknown" })],
    ["unknown self", json({ ...PAYLOAD, selfId: null })],
    ["missing revision", json(PAYLOAD, null)], ["invalid revision", json(PAYLOAD, "unquoted")],
  ] as [string, Answer][])("blocks edits after %s and can retry a verified read", async (_label, answer) => {
    const posts = fetches([answer, json(PAYLOAD)]); render(<WhitelistPage />); await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Save Whitelist" })).toBeNull(); expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry sign-in list" }));
    await screen.findByRole("textbox", { name: "Discord user ID" }); expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows separate exact IDs with duplicate labels without making names editable identity", async () => {
    fetches(); await loaded();
    expect(screen.getByText(SELF)).toBeDefined(); expect(screen.getByText(FRIEND)).toBeDefined();
    expect(screen.getAllByText(/Shared display name/)).toHaveLength(2);
    expect(screen.getByText(/display labels only/)).toBeDefined();
  });
  it("explains seed precedence using IDs", async () => {
    fetches([json({ ...PAYLOAD, source: "env" })]); await loaded();
    expect(screen.getByText(/These IDs come from the deployment sign-in seed/)).toBeDefined();
  });
});

describe("exact Discord IDs", () => {
  it("keeps decimal strings beyond Number precision and posts IDs with their own revision", async () => {
    const posts = fetches(); await loaded();
    const input = screen.getByRole("textbox", { name: "Discord user ID" }) as HTMLInputElement;
    expect(input.type).toBe("text"); fireEvent.change(input, { target: { value: ` ${NEW} ` } }); fireEvent.keyDown(input, { key: "Enter" });
    save(); await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ body: { users: [SELF, FRIEND, NEW] }, revision: TAG });
    expect(spies.success).toHaveBeenCalledWith("Sign-in list saved and verified.");
  });
  it.each(["Shared display name", "someone#1234", "@friend", "9007199254740993e0", "0012345", "18446744073709551616", "-1"])("refuses %s without changing the list", async (value) => {
    const posts = fetches(); await loaded(); fireEvent.change(screen.getByRole("textbox", { name: "Discord user ID" }), { target: { value } }); fireEvent.click(screen.getByRole("button", { name: "Add ID" }));
    expect(spies.error).toHaveBeenCalledWith(expect.stringContaining("exact decimal Discord user ID"));
    save(); await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].body.users).toEqual([SELF, FRIEND]);
  });
  it("blocks Add/Remove/Enter while a save is awaiting its receipt", async () => {
    const pending = deferred<Response>(); const posts = fetches(undefined, [pending.promise]); await loaded(); save();
    expect((screen.getByRole("button", { name: `Remove Discord ID ${FRIEND}` }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: NEW } }); fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => pending.resolve(json({ success: true, users: [SELF, FRIEND] }, '"new"')));
    expect(posts[0].body.users).toEqual([SELF, FRIEND]); expect(screen.queryByText(NEW)).toBeNull();
  });
});

describe("deliberate policy changes", () => {
  it("sends nothing until an empty-list confirmation and does not sign out the still-allowed actor", async () => {
    const posts = fetches(); await loaded(); remove(FRIEND); remove(SELF); save();
    const dialog = await screen.findByRole("dialog"); expect(dialog.textContent).toContain("opens sign-in to anyone"); expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save empty list" }));
    await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].body).toEqual({ users: [], confirmEmpty: true });
    expect(spies.signOut).not.toHaveBeenCalled();
  });
  it("confirms self removal and signs out only after canonical persisted receipt", async () => {
    const pending = deferred<Response>(); const posts = fetches(undefined, [pending.promise]); await loaded(); remove(SELF); save();
    const dialog = await screen.findByRole("dialog"); expect(dialog.textContent).toContain("another allowed admin"); expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and sign out" }));
    expect(spies.signOut).not.toHaveBeenCalled();
    await act(async () => pending.resolve(json({ success: true, users: [FRIEND] }, '"saved"')));
    expect(posts[0]).toEqual({ body: { users: [FRIEND], confirmSelfRemoval: true }, revision: TAG });
    expect(spies.signOut).toHaveBeenCalledTimes(1); expect(spies.signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
  it("cancels self removal without a write or sign-out", async () => {
    const posts = fetches(); await loaded(); remove(SELF); save(); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(posts).toEqual([]); expect(spies.signOut).not.toHaveBeenCalled();
  });
  it.each([
    new Error("lost receipt"), json({ error: "not verified" }, null, 500),
    json({ success: true, users: [SELF, FRIEND] }, '"unexpected"'),
    json({ success: true, users: [FRIEND] }, null),
  ])("never signs out or reports success from an unconfirmed self removal", async (answer) => {
    fetches(undefined, [answer]); await loaded(); remove(SELF); save(); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save and sign out" }));
    await screen.findByRole("alert"); expect(spies.signOut).not.toHaveBeenCalled(); expect(spies.success).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(expect.stringContaining("result is unconfirmed"));
  });
  it("keeps a saved self removal distinct from an unconfirmed sign-out request", async () => {
    spies.signOut.mockRejectedValueOnce(new Error("sign-out network lost")); fetches(); await loaded(); remove(SELF); save(); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save and sign out" }));
    await screen.findByRole("alert"); expect(spies.success).toHaveBeenCalledTimes(1); expect(spies.info).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("removed from the saved list");
  });
  it("handles server confirmation codes without guessing success", async () => {
    const posts = fetches(undefined, [json({ code: "confirm_self_removal", error: "confirm" }, null, 409)]); await loaded(); save();
    const dialog = await screen.findByRole("dialog"); expect(dialog.textContent).toContain("Remove your own Discord ID");
    expect(posts).toHaveLength(1); expect(spies.success).not.toHaveBeenCalled(); expect(spies.signOut).not.toHaveBeenCalled();
  });
  it("blocks a stale draft and adopts the new read revision before another save", async () => {
    const posts = fetches([json(PAYLOAD), json(PAYLOAD, '"new-read"')], [json({ stale: true, error: "File changed. Reload." }, null, 409)]);
    await loaded(); save(); await screen.findByRole("alert"); expect(spies.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry sign-in list" })); await screen.findByRole("button", { name: "Save Whitelist" }); save();
    await waitFor(() => expect(posts).toHaveLength(2)); expect(posts[1].revision).toBe('"new-read"');
  });
  it("advances to the response revision after a confirmed save", async () => {
    const posts = fetches(); await loaded(); save(); await waitFor(() => expect(spies.success).toHaveBeenCalledTimes(1)); save();
    await waitFor(() => expect(posts).toHaveLength(2)); expect(posts[1].revision).toBe('"saved-revision"');
  });
});

it.each([null, 'W/"proxy-body"'])("uses the source revision when the proxy ETag is %s", async (etag) => {
  const headers = new Headers({ "X-File-Revision": '"source-policy"' }); if (etag) headers.set("ETag", etag);
  const writes: Headers[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PUT") { writes.push(new Headers(init.headers)); return new Response(JSON.stringify({ success: true, users: [SELF, FRIEND] }), { headers: { "X-File-Revision": '"saved-policy"' } }); }
    return new Response(JSON.stringify(PAYLOAD), { headers });
  }));
  await loaded(); save(); await waitFor(() => expect(spies.success).toHaveBeenCalled());
  expect(writes[0].get("X-Expected-File-Revision")).toBe('"source-policy"'); expect(writes[0].get("If-Match")).toBe('"source-policy"');
});
it("accepts a weakened legacy ETag when no custom source revision is present", async () => {
  const posts = fetches([json(PAYLOAD, 'W/"source-policy"')]); await loaded(); save();
  await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].revision).toBe('"source-policy"');
});
