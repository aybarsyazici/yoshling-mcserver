// @vitest-environment jsdom
/**
 * The bans card, rendered.
 *
 * `src/lib/__tests__/mc-bans.test.ts` and `tests/mc-bans-route.test.ts` cover the module and
 * the endpoint. Neither can see the two defects below, because both are in what the card
 * *decides* about a response it reads correctly:
 *
 *  1. **It disabled every control when either ban file was malformed**, including when the
 *     server was running and the route takes the RCON path and never opens a file. So an
 *     unparseable `banned-players.json` — the state an older install leaves behind — removed
 *     the one working way to ban somebody, and the notice beside the dead buttons asserted
 *     that bans could not be changed while they could. That is the shape `can: {}` was added
 *     to remove from the power controls, inverted: not an enabled button that will refuse,
 *     but a disabled one that would have worked.
 *  2. **A successful player ban cleared the IP field** (and vice versa), so a half-typed
 *     address vanished in the moment the operator was told everything had gone right.
 *
 * Both are DOM-level by nature, and `docs/OPERATIONS.md` records why that matters: an
 * assertion on a helper cannot fail when a component stops calling it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McBansCard } from "@/components/mc-bans-card";
import { installBrowserStubs } from "./helpers/dom";

beforeAll(() => {
  installBrowserStubs();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The GET body shape, with the fields each test cares about overridden. */
function bans(over: Record<string, unknown> = {}) {
  return {
    players: [],
    ips: [],
    unreadable: { players: 0, ips: 0 },
    malformed: { players: false, ips: false },
    running: true,
    path: "rcon",
    live: { players: "read", ips: "read" },
    drift: { players: { notEnforced: [], extraLive: 0 }, ips: { notEnforced: [], extraLive: 0 } },
    ...over,
  };
}

const entry = (name: string) => ({
  uuid: "11111111-2222-3333-4444-555555555555",
  name,
  created: "2026-10-01 12:00:00 +0000",
  createdIso: "2026-10-01T12:00:00.000Z",
  source: "Rcon",
  expires: "forever",
  reason: "Griefing",
});

/** Every mutation request the card made. */
let calls: { url: string; method: string; body?: unknown }[] = [];

function stubFetch(get: Record<string, unknown>, mutation?: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "GET") return { ok: true, json: async () => get } as Response;
      const body = mutation ?? { success: true, verified: true, message: "Banned." };
      return { ok: body.error === undefined, json: async () => body } as Response;
    })
  );
}

async function mount(get: Record<string, unknown>, mutation?: Record<string, unknown>) {
  stubFetch(get, mutation);
  render(<McBansCard />);
  await waitFor(() => expect(screen.getByText(/Banned players/)).toBeTruthy());
}

const banPlayerButton = () =>
  screen.getByRole("button", { name: /Ban player/ }) as HTMLButtonElement;
const banIpButton = () =>
  screen.getByRole("button", { name: /Ban address/ }) as HTMLButtonElement;
const playerField = () => screen.getByPlaceholderText("Minecraft username") as HTMLInputElement;
const ipField = () => screen.getByPlaceholderText("203.0.113.4") as HTMLInputElement;

// ── 1. what a malformed file is allowed to disable ───────────────────────────

describe("a malformed ban file only blocks the path that goes through it", () => {
  /**
   * The regression, as directly as it can be stated: server up, players file unparseable,
   * and the Ban button must still work — because the route will send `ban Notch` over RCON
   * and never look at the file.
   */
  it("keeps the controls live on the RCON path", async () => {
    await mount(bans({ path: "rcon", malformed: { players: true, ips: false } }));

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    expect(banPlayerButton().disabled).toBe(false);

    fireEvent.click(banPlayerButton());
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      kind: "player",
      target: "Notch",
    });
  });

  /** And it says the true thing about the file rather than the false thing about the button. */
  it("explains what an unparseable file costs on the RCON path, without claiming bans are blocked", async () => {
    await mount(bans({ path: "rcon", malformed: { players: true, ips: false } }));

    // `getByText` on the file name alone matches the card title too, so anchor on the notice.
    expect(screen.getByText(/isn't valid JSON, so the/)).toBeTruthy();
    expect(screen.queryByText(/can't be changed until/i)).toBeNull();
    expect(screen.queryByText(/blocked until it's fixed/)).toBeNull();
    // The real consequence: the list on screen is short, and a stop would lose the bans.
    expect(screen.getByText(/Bans still work/)).toBeTruthy();
  });

  it("does block the file path, which is the case where the claim is true", async () => {
    await mount(bans({ path: "file", running: false, malformed: { players: true, ips: false } }));

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    expect(banPlayerButton().disabled).toBe(true);
    expect(screen.getByText(/blocked until it's fixed/)).toBeTruthy();
  });

  /**
   * Per kind: the two files fail independently, and a broken `banned-players.json` says
   * nothing about whether an address can be banned. The route already behaves this way, so
   * disabling both halves made the card refuse something the endpoint would have done.
   */
  it("blocks only the half whose file is broken", async () => {
    await mount(bans({ path: "file", running: false, malformed: { players: true, ips: false } }));

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    fireEvent.change(ipField(), { target: { value: "203.0.113.4" } });
    expect(banPlayerButton().disabled).toBe(true);
    expect(banIpButton().disabled).toBe(false);
  });

  /** `refuse` is the one state that really does stop both kinds. */
  it("blocks both kinds when the container is up and silent", async () => {
    await mount(bans({ path: "refuse" }));

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    fireEvent.change(ipField(), { target: { value: "203.0.113.4" } });
    expect(banPlayerButton().disabled).toBe(true);
    expect(banIpButton().disabled).toBe(true);
  });

  /**
   * The Enter key is a second way into the same request, and `disabled` on a button does not
   * disable the field beside it. Without the same guard on `onKeyDown`, the path that is
   * certain to be refused stayed reachable by the quickest input there is.
   */
  it("ignores Enter in a field whose half is blocked", async () => {
    await mount(bans({ path: "refuse" }));

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    fireEvent.keyDown(playerField(), { key: "Enter" });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

// ── 2. a successful ban clears only its own field ────────────────────────────

describe("a successful ban clears only the field it came from", () => {
  it("leaves a half-typed address alone when a player ban succeeds", async () => {
    await mount(bans(), { success: true, verified: true, message: "Banned Notch." });

    fireEvent.change(playerField(), { target: { value: "Notch" } });
    fireEvent.change(ipField(), { target: { value: "203.0.113." } });
    fireEvent.click(banPlayerButton());

    await waitFor(() => expect(playerField().value).toBe(""));
    expect(ipField().value).toBe("203.0.113.");
  });

  it("and the other way round", async () => {
    await mount(bans(), { success: true, verified: true, message: "Banned 203.0.113.4." });

    fireEvent.change(playerField(), { target: { value: "Notc" } });
    fireEvent.change(ipField(), { target: { value: "203.0.113.4" } });
    fireEvent.click(banIpButton());

    await waitFor(() => expect(ipField().value).toBe(""));
    expect(playerField().value).toBe("Notc");
  });
});

// ── 3. the drift copy ────────────────────────────────────────────────────────

describe("the card reports what was compared", () => {
  /**
   * The copy used to assert one cause — "The files were changed while it was up" — for every
   * entry in `notEnforced`. `banDrift` produces them several ways: a file edit behind a
   * running server, an entry whose uuid the game cannot use, a name the server resolves to a
   * different canonical spelling. A sentence that names the wrong cause sends the reader to
   * fix the wrong thing.
   */
  it("names the drift without asserting a single cause for it", async () => {
    await mount(
      bans({
        players: [entry("Notch")],
        drift: {
          players: { notEnforced: ["Notch"], extraLive: 0 },
          ips: { notEnforced: [], extraLive: 0 },
        },
      })
    );

    expect(screen.getByText(/on disk but/)).toBeTruthy();
    expect(screen.getByText("Notch", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText(/Most often/)).toBeTruthy();
    expect(screen.queryByText(/In effect:/)).toBeNull();
  });

  /**
   * "Answered with something unreadable" is its own state. The server is demonstrably up and
   * answering, so "the ban list couldn't be read" with no further detail reads as a fault in
   * the server rather than in the parser — and the earlier version could not tell the two
   * apart at all, because it only had `drift === null`.
   */
  it("distinguishes an unreadable reply from a server that never answered", async () => {
    await mount(
      bans({ live: { players: "unreadable", ips: "read" }, drift: { players: null, ips: null } })
    );
    expect(screen.getByText(/came back in a form this page couldn't read/)).toBeTruthy();

    cleanup();
    await mount(
      bans({ live: { players: "unreachable", ips: "unreachable" }, drift: { players: null, ips: null } })
    );
    expect(screen.getByText(/ban list couldn't be read, so nothing below/)).toBeTruthy();
  });

  /**
   * The green line speaks for the whole card, so one readable list out of two does not earn
   * it: a player list that checked out says nothing about the IP bans listed underneath.
   */
  it("withholds the in-effect line when only one of the two lists was compared", async () => {
    await mount(
      bans({
        players: [entry("Notch")],
        live: { players: "read", ips: "unreadable" },
        drift: { players: { notEnforced: [], extraLive: 0 }, ips: null },
      })
    );
    expect(screen.queryByText(/In effect:/)).toBeNull();
  });

  it("shows the in-effect line when both lists were compared and agree", async () => {
    await mount(bans({ players: [entry("Notch")] }));
    expect(screen.getByText(/In effect:/)).toBeTruthy();
  });
});
