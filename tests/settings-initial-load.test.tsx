// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import MinecraftSettings from "@/app/minecraft/settings/page";
import SevenDtdSettings from "@/app/7dtd/settings/page";
import { installBrowserStubs } from "./helpers/dom";

vi.mock("@/components/memory-card", () => ({ MemoryCard: () => null }));
vi.mock("@/components/mc-game-rules", () => ({ McGameRules: () => null }));
vi.mock("@/components/mc-bans-card", () => ({ McBansCard: () => null }));
vi.mock("@/components/sdtd-all-settings", () => ({ SdtdAllSettings: () => null }));
vi.mock("@/components/sdtd-world-upload", () => ({ SdtdWorldUpload: () => null }));
vi.mock("@/components/sdtd-maintenance", () => ({ SdtdMaintenance: () => null }));
vi.mock("@/components/photo-footer", () => ({ PhotoFooter: () => null }));
vi.mock("@/components/motion", () => ({ Reveal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

beforeAll(installBrowserStubs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const WAIT = { timeout: 5000 };
const OP = { uuid: "fixture-op", name: "ExistingOp", level: 4, bypassesPlayerLimit: false };
const PLAYER = { uuid: "fixture-player", name: "ExistingPlayer" };
const CONFIG = { mcVersion: "26.1.2", modLoader: "fabric" };
const SDTD = { serverName: "Existing world", password: "fixture-lock", maxPlayers: 12, sandboxCode: "ABCD", sandboxCodeSource: "file" };

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Answer = Response | Error | Promise<Response>;
function fetches(overrides: Record<string, Answer[]> = {}, putAnswer: Answer = response({})) {
  const defaults: Record<string, Response> = {
    "/api/settings": response(CONFIG),
    "/api/minecraft-versions": response({ versions: [CONFIG.mcVersion] }),
    "/api/server/properties": response({}),
    "/api/server/ops": response([OP]),
    "/api/server/mc-whitelist": response([PLAYER]),
    "/api/7dtd/config": response(SDTD),
  };
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes.push({ url, body: JSON.parse(init.body as string) });
      if (putAnswer instanceof Error) throw putAnswer;
      return putAnswer;
    }
    const answer = overrides[url]?.shift() ?? defaults[url];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error(`Unexpected request: ${url}`);
    return answer;
  }));
  return writes;
}

function card(title: string) {
  const element = screen.getByText(title).closest("[data-slot='card']");
  if (!element) throw new Error(`Missing card: ${title}`);
  return within(element as HTMLElement);
}

const LISTS = [
  { title: "Operators (ops.json)", url: "/api/server/ops", save: "Save Ops", add: "Add Op", retry: "Retry operators", existing: OP, empty: "No operators", remove: "Remove operator ExistingOp" },
  { title: "MC Whitelist (whitelist.json)", url: "/api/server/mc-whitelist", save: "Save Whitelist", add: "Add Player", retry: "Retry Minecraft whitelist", existing: PLAYER, empty: "No players whitelisted", remove: "Remove whitelisted player ExistingPlayer" },
];

describe.each(LISTS)("$title initial read", (list) => {
  it("disables Save, Add and keyboard additions while the initial GET is pending", () => {
    const writes = fetches({ [list.url]: [new Promise<Response>(() => {})] });
    render(<MinecraftSettings />);
    const panel = card(list.title);
    expect((panel.getByRole("button", { name: list.save }) as HTMLButtonElement).disabled).toBe(true);
    expect((panel.getByRole("button", { name: list.add }) as HTMLButtonElement).disabled).toBe(true);
    const input = panel.getByPlaceholderText("Minecraft username") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "NewPlayer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(panel.getByRole("button", { name: list.save }));
    expect(panel.queryByText("NewPlayer")).toBeNull();
    expect(panel.queryByText(list.empty)).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each([
    ["network failure", new Error("Network unavailable")],
    ["denied response containing an array", response([], 403)],
    ["non-array response", response({})],
    ["malformed entry", response([null])],
  ] as [string, Answer][])("keeps writes disabled after %s", async (_label, answer) => {
    const writes = fetches({ [list.url]: [answer] });
    render(<MinecraftSettings />);
    const panel = card(list.title);
    await waitFor(() => expect(panel.queryByRole("alert")).not.toBeNull(), WAIT);
    expect((panel.getByRole("button", { name: list.save }) as HTMLButtonElement).disabled).toBe(true);
    expect((panel.getByRole("button", { name: list.add }) as HTMLButtonElement).disabled).toBe(true);
    expect(panel.queryByText(list.empty)).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: list.save }));
    expect(writes).toEqual([]);
    // This resource's failure does not disable the independently loaded list.
    const other = LISTS.find((entry) => entry.url !== list.url)!;
    await waitFor(() => expect((card(other.title).getByRole("button", { name: other.save }) as HTMLButtonElement).disabled).toBe(false), WAIT);
  });

  it("retries the failed read, then preserves the fetched entries when adding and saving", async () => {
    const writes = fetches({ [list.url]: [response({ error: "Read interrupted" }, 502), response([list.existing])] });
    render(<MinecraftSettings />);
    const panel = card(list.title);
    await waitFor(() => expect(panel.queryByText("Read interrupted")).not.toBeNull(), WAIT);
    fireEvent.click(panel.getByRole("button", { name: list.retry }));
    await waitFor(() => expect((panel.getByRole("button", { name: list.save }) as HTMLButtonElement).disabled).toBe(false), WAIT);
    expect(panel.queryByRole("alert")).toBeNull();
    fireEvent.change(panel.getByPlaceholderText("Minecraft username"), { target: { value: "NewPlayer" } });
    fireEvent.click(panel.getByRole("button", { name: list.add }));
    fireEvent.click(panel.getByRole("button", { name: list.save }));
    await waitFor(() => expect(writes).toHaveLength(1), WAIT);
    expect(writes[0].url).toBe(list.url);
    expect(writes[0].body).toEqual([list.existing, expect.objectContaining({ name: "NewPlayer" })]);
  });

  it("allows an intentionally empty list only after a successful GET", async () => {
    const writes = fetches({ [list.url]: [response([])] });
    render(<MinecraftSettings />);
    const panel = card(list.title);
    await waitFor(() => expect((panel.getByRole("button", { name: list.save }) as HTMLButtonElement).disabled).toBe(false), WAIT);
    expect(panel.queryByText(list.empty)).not.toBeNull();
    fireEvent.click(panel.getByRole("button", { name: list.save }));
    await waitFor(() => expect(writes).toEqual([{ url: list.url, body: [] }]), WAIT);
  });

  it("disables removal while the current list is being saved", async () => {
    let resolveWrite!: (value: Response) => void;
    fetches({}, new Promise<Response>((resolve) => { resolveWrite = resolve; }));
    render(<MinecraftSettings />);
    const panel = card(list.title);
    await waitFor(() => expect((panel.getByRole("button", { name: list.save }) as HTMLButtonElement).disabled).toBe(false), WAIT);
    fireEvent.click(panel.getByRole("button", { name: list.save }));
    expect((panel.getByRole("button", { name: list.remove }) as HTMLButtonElement).disabled).toBe(true);
    resolveWrite(response({}));
    await waitFor(() => expect((panel.getByRole("button", { name: list.remove }) as HTMLButtonElement).disabled).toBe(false), WAIT);
  });
});

describe("Minecraft version initial read", () => {
  it("allows the first Save from a verified deployment initializer without guessing defaults", async () => {
    const initial = {
      id: "main", mcVersion: "1.21.11", modLoader: "neoforge", maxMemory: "3G",
      worldVersion: null, initialized: false,
    };
    const writes = fetches({
      "/api/settings": [response(initial)],
      "/api/minecraft-versions": [response({ versions: [initial.mcVersion] })],
    }, response({ success: true }));
    render(<MinecraftSettings />);
    const save = screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await waitFor(() => expect(save.disabled).toBe(false), WAIT);
    expect(writes).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([{
      url: "/api/settings", body: { mcVersion: initial.mcVersion, modLoader: initial.modLoader },
    }]), WAIT);
    await waitFor(() => expect(save.disabled).toBe(false), WAIT);
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it.each([
    ["null response", response(null)],
    ["missing loader", response({ mcVersion: CONFIG.mcVersion })],
    ["empty version", response({ mcVersion: "", modLoader: CONFIG.modLoader })],
    ["network failure", new Error("Network unavailable")],
  ] as [string, Answer][])("does not use a default version after %s", async (_label, answer) => {
    const writes = fetches({ "/api/settings": [answer] });
    render(<MinecraftSettings />);
    await screen.findByRole("button", { name: "Retry server version" });
    const save = screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(writes).toEqual([]);
  });

  it("leaves an accepted identical-config repair's outcome to the operation ledger", async () => {
    const writes = fetches({}, response({ success: true }));
    render(<MinecraftSettings />);
    const save = screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), WAIT);
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([{ url: "/api/settings", body: CONFIG }]), WAIT);
    await waitFor(() => expect(save.disabled).toBe(false), WAIT);
    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("cannot apply a fallback version after a denied read, then saves the reloaded version", async () => {
    const writes = fetches({ "/api/settings": [response(CONFIG, 403), response(CONFIG)] });
    render(<MinecraftSettings />);
    await screen.findByRole("button", { name: "Retry server version" });
    const save = screen.getByRole("button", { name: "Save & Restart Server" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry server version" }));
    await waitFor(() => expect(save.disabled).toBe(false), WAIT);
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([{ url: "/api/settings", body: CONFIG }]), WAIT);
  });
});

describe("7DTD quick settings initial read", () => {
  it("shows no editable fallback form while the read is pending", () => {
    const writes = fetches({ "/api/7dtd/config": [new Promise<Response>(() => {})] });
    render(<SevenDtdSettings />);
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByDisplayValue("Yoshling 7DTD")).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each([
    ["network failure", new Error("Network unavailable")],
    ["role refusal", response({ error: "Reading these settings needs the moderator role." }, 403)],
    ["denied response containing config", response(SDTD, 403)],
    ["missing password", response({ serverName: "Existing world", maxPlayers: 12, sandboxCode: "ABCD" })],
    ["non-numeric player count", response({ ...SDTD, maxPlayers: "12" })],
    ["missing sandbox code", response({ ...SDTD, sandboxCode: null })],
  ] as [string, Answer][])("does not offer Save after %s", async (_label, answer) => {
    const writes = fetches({ "/api/7dtd/config": [answer] });
    render(<SevenDtdSettings />);
    await screen.findByRole("button", { name: "Retry 7DTD settings" });
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByDisplayValue("Yoshling 7DTD")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Load the current settings");
    expect(writes).toEqual([]);
  });

  it("retries and saves the loaded password, player count and sandbox code with a changed name", async () => {
    const writes = fetches({ "/api/7dtd/config": [response({ error: "Read interrupted" }, 502), response(SDTD)] });
    render(<SevenDtdSettings />);
    await screen.findByText("Read interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Retry 7DTD settings" }));
    await screen.findByDisplayValue(SDTD.serverName);
    fireEvent.change(screen.getByDisplayValue(SDTD.serverName), { target: { value: "Renamed world" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(writes).toEqual([{
      url: "/api/7dtd/config",
      body: { serverName: "Renamed world", password: SDTD.password, maxPlayers: SDTD.maxPlayers, sandboxCode: SDTD.sandboxCode },
    }]), WAIT);
  });

  it("reports a network failure while saving instead of rejecting silently", async () => {
    fetches({}, new Error("Network unavailable"));
    render(<SevenDtdSettings />);
    await screen.findByRole("button", { name: "Save settings" });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Failed to save 7DTD settings."), WAIT);
  });
});
