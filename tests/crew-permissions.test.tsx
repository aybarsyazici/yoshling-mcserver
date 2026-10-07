// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CrewList, type CrewMember } from "@/components/crew-list";
import UsersPage from "@/app/users/page";
import { installBrowserStubs } from "./helpers/dom";
const mocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn(), users: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "self", role: "ADMIN" } }) }));
vi.mock("@/lib/db", () => ({ db: { user: { findMany: mocks.users } } }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled }: { value: string; disabled: boolean; onValueChange(v: string): void }) =>
    <select aria-label="Role" disabled={disabled} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option>ADMIN</option><option>MOD</option><option>MEMBER</option>
    </select>,
  SelectContent: () => null, SelectItem: () => null, SelectTrigger: () => null, SelectValue: () => null,
}));
beforeAll(installBrowserStubs);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const member: CrewMember = { id: "target", username: "Friend", avatar: null, role: "MOD", games: ["zomboid"], createdAt: "2026-01-01" };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const chip = (name: string) => screen.getByRole("button", { name: `${name} access for Friend` }) as HTMLButtonElement;
function view(over: Partial<CrewMember> = {}) { render(<CrewList members={[{ ...member, ...over }]} canManage selfId="self" />); }

describe("canonical Crew permissions", () => {
  it("keeps stored grants in the server page when ADMIN has effective all-world access", async () => {
    mocks.users.mockResolvedValue([{ ...member, role: "ADMIN", games: "zomboid", createdAt: new Date("2026-01-01") }]);
    const page = await UsersPage();
    expect(page.props.children[1].props.members[0].games).toEqual(["zomboid"]);
    render(page);
    expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("true");
    vi.stubGlobal("fetch", vi.fn(async () => json({ user: { id: "target", role: "MOD", games: ["zomboid"] } })));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "MOD" } });
    await waitFor(() => expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("false"));
    expect(chip("7 Days to Die").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Project Zomboid").getAttribute("aria-pressed")).toBe("true");
  });
  it("serializes the role and grant controls for one row and uses canonical saved grants", async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => pending.promise); vi.stubGlobal("fetch", fetcher);
    view(); fireEvent.click(chip("Minecraft"));
    expect(chip("Project Zomboid").disabled).toBe(true);
    expect((screen.getByLabelText("Role") as HTMLSelectElement).disabled).toBe(true);
    expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip("Project Zomboid"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(json({ user: { id: "target", role: "MOD", games: ["minecraft", "zomboid"] } })));
    expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("Project Zomboid"));
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).games).toEqual(["minecraft"]);
  });
  it("does not replace stored grants with ADMIN effective grants after promotion/demotion", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      return json({ user: { id: "target", role: body.role ?? "MOD", games: body.games ?? ["zomboid"] } });
    }));
    view(); fireEvent.change(screen.getByLabelText("Role"), { target: { value: "ADMIN" } });
    await waitFor(() => expect(chip("Minecraft").disabled).toBe(true));
    await waitFor(() => expect((screen.getByLabelText("Role") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "MOD" } });
    await waitFor(() => expect(chip("Minecraft").disabled).toBe(false));
    expect(chip("7 Days to Die").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip("Minecraft"));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toEqual({ games: ["zomboid", "minecraft"] });
  });
  it("reconciles an ambiguous network result before enabling another write", async () => {
    const read = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "PUT") throw new Error("lost reply"); return read.promise; }));
    view(); fireEvent.click(chip("Minecraft"));
    await waitFor(() => expect(mocks.info).toHaveBeenCalled());
    expect(chip("Minecraft").disabled).toBe(true);
    await act(async () => read.resolve(json([{ ...member, games: "minecraft,zomboid" }])));
    expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Minecraft").disabled).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it("keeps a definite authorization refusal distinct from a lost result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Forbidden" }, 403)));
    view(); fireEvent.click(chip("Minecraft"));
    await screen.findByRole("alert");
    expect(mocks.error).toHaveBeenCalledWith("Forbidden"); expect(mocks.info).not.toHaveBeenCalled();
    expect(chip("Minecraft").disabled).toBe(true); expect(screen.queryByLabelText("Role")).toBeNull();
  });
  it("locks an unconfirmed row until canonical permissions can be retried", async () => {
    const fetcher = vi.fn(async () => json({ error: "unavailable" }, 503)); vi.stubGlobal("fetch", fetcher);
    view(); fireEvent.click(chip("Minecraft"));
    await screen.findByRole("alert");
    expect(chip("Minecraft").disabled).toBe(true);
    fetcher.mockResolvedValue(json([{ ...member, games: "zomboid" }]));
    fireEvent.click(screen.getByRole("button", { name: "Retry permissions" }));
    await waitFor(() => expect(chip("Minecraft").disabled).toBe(false));
    expect(chip("Minecraft").getAttribute("aria-pressed")).toBe("false");
  });
});
