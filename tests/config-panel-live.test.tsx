// @vitest-environment jsdom
/**
 * The settings panel, rendered, for the one property the pure suite cannot prove:
 * **that the panel actually uses the comparison, and that a stopped server never wears
 * amber.**
 *
 * `src/lib/__tests__/live-settings.test.ts` pins the comparison itself thoroughly, and
 * that is exactly the gap this file closes — `docs/OPERATIONS.md` records the measured
 * version of this lesson for the power control: a shared helper existing is not evidence
 * that a component calls it, and the three copies that did not call it are what shipped a
 * "Power on" button for an already-running container. So everything here is asserted
 * through the DOM.
 *
 * jsdom is scoped to this file by the pragma above; the pure-logic suites keep running
 * under `environment: "node"`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigPanel } from "@/components/config-panel";
import { installBrowserStubs } from "./helpers/dom";
import type { LiveSettings } from "@/lib/live-settings";

beforeAll(() => {
  installBrowserStubs();
  // `motion` measures keyframes by scrolling the element into view, and jsdom has no
  // `scrollTo` — without this every expand prints a stack trace that buries a real
  // failure. Stubbed here rather than in `tests/helpers/dom.ts`, which another workstream
  // owns this round.
  // Assigned unconditionally: jsdom *does* define `scrollTo`, as a stub that logs
  // "Not implemented" — so a `if (!window.scrollTo)` guard here silently does nothing.
  window.scrollTo = (() => {}) as typeof window.scrollTo;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The shapes the two real endpoints answer with: the .ini read, and `?live=`. */
const PROPERTIES = [
  { name: "MaxPlayers", value: "32", help: "" },
  { name: "PVP", value: "true", help: "" },
  { name: "ResetID", value: "7", help: "" },
  { name: "DiscordToken", value: "", help: "" },
];

function stubFetch(live: LiveSettings | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/games/status")) {
        return { ok: true, json: async () => (live ? { live } : {}) } as Response;
      }
      return { ok: true, json: async () => ({ properties: PROPERTIES }) } as Response;
    })
  );
}

async function openPanel(live: LiveSettings | null) {
  stubFetch(live);
  render(
    <ConfigPanel
      tint="var(--pz)"
      endpoint="/api/zomboid/config"
      subtitle="Every option in the server .ini"
      restartNote="Restart Project Zomboid to apply."
      groupOrder={["Server"]}
      groupOf={() => "Server"}
    />
  );
  fireEvent.click(screen.getByText("All settings"));
  await waitFor(() => expect(screen.getByText(/Max Players/)).toBeTruthy());
}

const READ_AT = 1_700_000_000_000;

describe("a server that cannot be asked wears no amber", () => {
  /**
   * The failure this guard exists to prevent is specific: two of the three worlds are
   * stopped at any moment, so if "could not ask" rendered like "does not match", the normal
   * state of this page would be a wall of false warnings — worse than not having the
   * feature. `.op-warn` is the amber token (see `docs/OPERATIONS.md` on why that class and
   * not `text-chart-5`), so its absence is the assertion.
   */
  it("says why it could not compare, and renders nothing amber", async () => {
    await openPanel({
      game: "zomboid",
      available: false,
      reason: "Project Zomboid is stopped, so there is nothing to compare these against.",
      values: {},
      readAt: READ_AT,
    });

    expect(screen.getByText(/is stopped, so there is nothing to compare/)).toBeTruthy();
    expect(document.querySelectorAll(".op-warn")).toHaveLength(0);
    expect(screen.queryByText(/^running:/)).toBeNull();
  });

  it("renders nothing about the live server when the request itself failed", async () => {
    await openPanel(null); // `?live=` answered without a `live` field → null
    expect(document.querySelectorAll(".op-warn")).toHaveLength(0);
    expect(screen.queryByText(/compare/)).toBeNull();
  });
});

describe("a value the server is not running is named, with the live value", () => {
  it("shows the running value on the field and names the key in the summary", async () => {
    await openPanel({
      game: "zomboid",
      available: true,
      // PVP agrees once the boolean is folded; MaxPlayers is the saved-but-not-running one.
      values: { MaxPlayers: "16", PVP: "True", ResetID: "4389967" },
      readAt: READ_AT,
    });

    expect(screen.getByText("running: 16")).toBeTruthy();
    // The restart note rides the warning, because restarting is what makes it true.
    expect(screen.getByText(/MaxPlayers.*Restart Project Zomboid to apply/)).toBeTruthy();
    expect(document.querySelectorAll(".op-warn").length).toBeGreaterThan(0);
  });

  it("stays quiet about the keys that agree", async () => {
    await openPanel({
      game: "zomboid",
      available: true,
      values: { MaxPlayers: "32", PVP: "True" },
      readAt: READ_AT,
    });

    expect(screen.queryByText(/^running:/)).toBeNull();
    expect(document.querySelectorAll(".op-warn")).toHaveLength(0);
    expect(screen.getByText(/match what the server is running/)).toBeTruthy();
  });

  /**
   * An edit you have not saved is not a claim about the server.
   *
   * The comparison must read the value the route last confirmed (`p.value`), not the draft:
   * comparing the draft would light an amber "not running on the server" the moment anyone
   * typed, before anything had been written anywhere — which is a warning about the user's
   * own keystroke dressed as a fact about the game. The "changed" dot already says that.
   */
  it("does not warn about an edit that has not been saved yet", async () => {
    await openPanel({
      game: "zomboid",
      available: true,
      values: { MaxPlayers: "32", PVP: "True" },
      readAt: READ_AT,
    });

    const input = screen.getByDisplayValue("32") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });

    await waitFor(() => expect(screen.getByText("1 changed")).toBeTruthy());
    expect(screen.queryByText(/^running:/)).toBeNull();
    expect(document.querySelectorAll(".op-warn")).toHaveLength(0);
  });

  /**
   * The two honesty labels, on the page rather than only in the model. `ResetID` is
   * reported by the live server and still cannot be compared (it belongs to the world that
   * exists); `DiscordToken` is one of the 7 `.ini` keys `showoptions` measurably omits.
   * Both must say so — silence is how someone concludes the comparison covers everything.
   */
  it("labels the keys it cannot compare rather than omitting them", async () => {
    await openPanel({
      game: "zomboid",
      available: true,
      values: { MaxPlayers: "32", PVP: "True", ResetID: "4389967" },
      readAt: READ_AT,
    });

    expect(screen.getByText("applies to the next world")).toBeTruthy();
    expect(screen.getByText("not reported")).toBeTruthy();
  });
});
