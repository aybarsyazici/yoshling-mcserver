// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileBrowser } from "@/components/file-browser";
import { installBrowserStubs } from "./helpers/dom";
vi.mock("@/lib/use-games", () => ({ useGames: () => ({ can: { settings: true, settingsEdit: true, filesDelete: true } }), CAPABILITY_POLL_MS: 30000 }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
beforeAll(installBrowserStubs);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const item = { name: "yoshling.ini", path: "yoshling.ini", isDirectory: false, size: 10 };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const roots = [{ key: "config", label: "Config" }, { key: "all", label: "All" }];

describe("file identity across delayed reads", () => {
  it("discards a Config read that completes after switching to All", async () => {
    const read = deferred<Response>(); const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "PUT") { writes.push(JSON.parse(init.body)); return json({}); }
      return String(url).includes("action=read") ? read.promise : json({ items: [item] });
    }));
    render(<FileBrowser endpoint="/api/zomboid/files" roots={roots} />);
    fireEvent.click(await screen.findByRole("button", { name: "yoshling.ini" }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await act(async () => read.resolve(json({ content: "CONFIG BYTES" })));
    expect(screen.queryByText("CONFIG BYTES")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(writes).toEqual([]);
  });
  it("discards stale directory listings after a root switch", async () => {
    const list = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("root=config") ? list.promise : json({ items: [{ ...item, name: "all.txt", path: "all.txt" }] })));
    render(<FileBrowser endpoint="/api/zomboid/files" roots={roots} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByRole("button", { name: "all.txt" });
    await act(async () => list.resolve(json({ items: [item] })));
    expect(screen.queryByRole("button", { name: "yoshling.ini" })).toBeNull();
  });
  it("saves only the root and endpoint that admitted the editor", async () => {
    const writes: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "PUT") { writes.push({ url: String(url), body: JSON.parse(init.body) }); return json({}); }
      return json(String(url).includes("action=read") ? { content: "INI" } : { items: [item] });
    }));
    render(<FileBrowser endpoint="/api/zomboid/files" roots={roots} />);
    fireEvent.click(await screen.findByRole("button", { name: "yoshling.ini" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "CHANGED" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes).toEqual([{ url: "/api/zomboid/files", body: { path: "yoshling.ini", content: "CHANGED", root: "config" } }]));
  });
  it("ignores an old endpoint read when the browser is rebound", async () => {
    const read = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("action=read") ? read.promise : json({ items: [item] })));
    const view = render(<FileBrowser endpoint="/api/first/files" />);
    fireEvent.click(await screen.findByRole("button", { name: "yoshling.ini" }));
    view.rerender(<FileBrowser endpoint="/api/second/files" />);
    await act(async () => read.resolve(json({ content: "OLD ENDPOINT" })));
    expect(screen.queryByText("OLD ENDPOINT")).toBeNull();
  });
});
