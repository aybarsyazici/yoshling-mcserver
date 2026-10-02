// @vitest-environment jsdom
/**
 * The Minecraft game-rule panel, rendered, for the three properties no pure test reaches.
 *
 * `src/lib/__tests__/mc-gamerules.test.ts` pins the parsing and the control decision, and
 * `mc-gamerules-route.test.ts` pins the route — and that is exactly the gap this file closes,
 * because the lesson `docs/OPERATIONS.md` records is that **a shared helper existing is not
 * evidence a component calls it**. The three copies of the power control that did not call it
 * are what shipped a "Power on" button for an already-running container.
 *
 * So the three things asserted here are all things the component alone can get wrong:
 *
 * 1. the row shows the server's read-back and **never** the value that was clicked;
 * 2. a value a number input cannot display gets a text input and a working Set button;
 * 3. the error box shows the route's own sentence rather than an invented one.
 *
 * jsdom is scoped to this file by the pragma above.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McGameRules } from "@/components/mc-game-rules";
import { installBrowserStubs } from "./helpers/dom";

const toasts: { kind: string; text: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.push({ kind: "success", text }),
    error: (text: string) => toasts.push({ kind: "error", text }),
    warning: (text: string) => toasts.push({ kind: "warning", text }),
  },
}));

beforeAll(() => {
  installBrowserStubs();
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  // base-ui's `Switch` forwards a click by constructing `new PointerEvent('click')`, and jsdom
  // does not define that constructor — without this every toggle throws an uncaught
  // `ReferenceError: PointerEvent is not defined` instead of failing an assertion. `MouseEvent`
  // is a sufficient stand-in: the only properties base-ui reads off it are the modifier keys.
  // Local to this file rather than in `tests/helpers/dom.ts`, which another workstream owns
  // this round.
  if (!("PointerEvent" in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;
  }
});
afterEach(() => {
  cleanup();
  toasts.length = 0;
  vi.unstubAllGlobals();
});

/**
 * An explicit, generous window for every `waitFor`.
 *
 * Nothing in this file is slow — a render, an effect and a stubbed fetch — so the only way
 * the default 1 s deadline is missed is a starved machine, where the failure says nothing
 * about the component. The wall clock is not the subject of any test here.
 */
const WAIT = { timeout: 5000 } as const;

type GetBody = { status?: number; body: unknown };
type PutBody = { status?: number; body: unknown };

/** The GET answer, then one PUT answer per write the test performs. */
function stubFetch(get: GetBody, puts: PutBody[] = []) {
  const queue = [...puts];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const r = init?.method === "PUT" ? (queue.shift() ?? { body: {} }) : get;
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => r.body,
      } as Response;
    })
  );
}

async function panel(get: GetBody, puts: PutBody[] = []) {
  stubFetch(get, puts);
  render(<McGameRules tint="var(--mc)" />);
  await waitFor(() => expect(screen.queryByText("Game rules")).not.toBeNull(), WAIT);
}

describe("the row shows what the server said, never what was clicked", () => {
  it("renders the route's read-back after a write", async () => {
    await panel(
      { body: { rules: [{ id: "mob_griefing", value: "true" }], unread: [], discovered: 1 } },
      [{ body: { success: true, rule: "mob_griefing", value: "false", previous: "true", changed: true } }]
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.queryByText(/The server reports false/)).not.toBeNull(), WAIT);
  });

  /**
   * The fix for `data.value ?? value`.
   *
   * That fallback sat **directly under** a comment saying the rendered value is never the one
   * that was typed. On a 200 whose body carried no `value` the row would have displayed "The
   * server reports <what you clicked>" — manufacturing the exact confirmation the route makes
   * a second RCON query to avoid. The row must say it is unconfirmed instead.
   */
  it("says unconfirmed, not 'the server reports <what you clicked>', on a 200 with no value", async () => {
    await panel(
      { body: { rules: [{ id: "mob_griefing", value: "true" }], unread: [], discovered: 1 } },
      [{ body: { success: true, rule: "mob_griefing", changed: true } }]
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.queryByText(/unconfirmed/)).not.toBeNull(), WAIT);
    expect(screen.queryByText(/The server reports/)).toBeNull();
    expect(toasts.filter((t) => t.kind === "success")).toEqual([]);
  });

  it("snaps the control back to the truth when the server declined the write", async () => {
    // The route's 502 carries the value the rule is actually at, so a refused write must not
    // leave the switch showing the position it was dragged to.
    await panel(
      { body: { rules: [{ id: "pvp", value: "true" }], unread: [], discovered: 1 } },
      [{ status: 502, body: { error: "pvp is still true — the server did not take false.", value: "true" } }]
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText(/did not take false/)).not.toBeNull(), WAIT);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
});

describe("a value a number input cannot show", () => {
  /**
   * The dead end: `<input type="number">` with a non-numeric value renders **empty**, and the
   * Set button only appears when the draft differs from the live value — which it did not,
   * because the draft *was* the live value. A rule you could neither read nor write, looking
   * like a rule with no value.
   */
  it("renders in a text input, showing the real value", async () => {
    await panel({
      body: { rules: [{ id: "modded_mode", value: "sometimes" }], unread: [], discovered: 1 },
    });
    const input = screen.getByDisplayValue("sometimes") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
  });

  it("can be edited and submitted", async () => {
    await panel(
      { body: { rules: [{ id: "modded_mode", value: "sometimes" }], unread: [], discovered: 1 } },
      [{ body: { success: true, rule: "modded_mode", value: "always", previous: "sometimes", changed: true } }]
    );
    fireEvent.change(screen.getByDisplayValue("sometimes"), { target: { value: "always" } });
    // The Set button exists only because the draft now differs from the live value — which was
    // impossible while the input could not display the live value in the first place.
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(screen.queryByText(/The server reports always/)).not.toBeNull(), WAIT);
  });

  it("still uses a number input for an integer rule", async () => {
    await panel({
      body: { rules: [{ id: "random_tick_speed", value: "3" }], unread: [], discovered: 1 },
    });
    expect((screen.getByDisplayValue("3") as HTMLInputElement).getAttribute("type")).toBe("number");
  });
});

describe("the error box", () => {
  it("shows the route's own sentence for a short read, not an invented one", async () => {
    // The 502 the floor produces. The panel must not round it to "this server has no game
    // rules", which is how `zomboid-quick-settings.tsx` recorded this failure mode.
    const error =
      'Read 1 game rule out of the server\'s 5082-character reply to "help gamerule", which ' +
      'mentions "gamerule" 116 times.';
    await panel({ status: 502, body: { error } });
    await waitFor(() => expect(screen.queryByText(error)).not.toBeNull(), WAIT);
  });

  it("shows the route's 403 instead of claiming the read needs admin access", async () => {
    // There used to be a 403 override here reading "Reading the game rules needs admin or mod
    // access", written when the GET required `settings.read`. It does not any more, so the
    // only 403 left is `gameGate`'s — and the override would have named the wrong reason.
    await panel({ status: 403, body: { error: "No access to this server" } });
    await waitFor(() => expect(screen.queryByText("No access to this server")).not.toBeNull(), WAIT);
    expect(screen.queryByText(/needs admin or mod access/)).toBeNull();
  });

  it("surfaces a warning alongside the rules it did read", async () => {
    await panel({
      body: {
        rules: [{ id: "pvp", value: "true" }],
        unread: ["mob_griefing"],
        discovered: 2,
        warning: "The server's reply is exactly 4096 characters…",
      },
    });
    // `waitFor`, not a bare `queryByText`. `panel()` only awaits the "Game rules" heading,
    // which renders before the fetched body is applied, so a synchronous query here races the
    // second render pass — this test failed once in a full-suite run and passed alone and in
    // three subsequent full runs, which is the signature. Its siblings in this file all await
    // their post-condition; this one did not.
    await waitFor(() => expect(screen.queryByText(/exactly 4096 characters/)).not.toBeNull(), WAIT);
    expect(screen.queryByText(/mob_griefing/)).not.toBeNull();
  });
});
