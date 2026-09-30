// @vitest-environment jsdom
/**
 * The three power surfaces, rendered.
 *
 * `tests/operation-ui.test.ts` already covers `powerState()` thoroughly — and that is
 * exactly the gap this file exists to close. The suite's own note admitted it:
 * *"`powerState()` covers the logic those surfaces share; it does not prove any surface
 * uses it."* A shared helper existing is not evidence that three components call it, and
 * the measured incident is precisely that they did not: the power control drifted into
 * three copies (`game-controls.tsx`, `mission-control.tsx`, `game-overview.tsx`), and
 * **two of them missed both** the `a7d76b8` running-but-unreachable recovery fix and the
 * `can:` permission projection. So on a wedged container the page every world *opens on*
 * offered "Power on" — a `docker start` against an already-running container, i.e. a
 * silent no-op that toasted success — and hid the Restart that is the documented way out.
 *
 * Everything here is therefore asserted through the **rendered DOM**, never by calling
 * the helper: an assertion on `powerState()` cannot fail when a component stops calling
 * it, which is the one failure that actually happened.
 *
 * jsdom is scoped to this file (the pragma above) rather than switched on globally, so the
 * pure-logic tests keep running under `environment: "node"`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GAMES, type GameId } from "@/lib/games";
import { slowestStopSeconds, spellSeconds } from "@/lib/operation-ui";
import {
  ALL_POWERS,
  NO_POWERS,
  WEDGED_FOR_MS,
  gamesState,
  installBrowserStubs,
  op,
  opsState,
  step,
  worlds,
  type OperationsStub,
} from "./helpers/dom";
import type { GameSnapshot, GamesState } from "@/lib/use-games";

/**
 * The two polling hooks are replaced, not the components.
 *
 * `useGames` and `useOperations` are the only two things these components learn the world
 * from, and both are `fetch` loops. Stubbing them is what makes the *rest* of each tree —
 * the branch on `containerUp`, the label, the `disabled`, the reason sentence — real code
 * under test rather than a re-implementation.
 */
const stub = vi.hoisted(() => ({ games: null as unknown, ops: null as unknown }));
vi.mock("@/lib/use-games", () => ({ useGames: () => stub.games }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => stub.ops }));

import { GameControls } from "@/components/game-controls";
import { GameOverview } from "@/components/game-overview";
import { MissionControl } from "@/components/mission-control";

beforeAll(installBrowserStubs);
afterEach(cleanup);

const GAME: GameId = "zomboid";
const NAME = GAMES[GAME].name;

interface Surface {
  /** The component file, which is also the key the drift guard at the bottom checks. */
  file: string;
  /** Where a user meets it. */
  route: string;
  render(): void;
  /**
   * Whether a Restart *control* lives on this surface.
   *
   * `/home`'s world card has none — it is a compact card (Power + Manage) and the
   * documented recovery path is one click away behind Manage. That is asserted rather than
   * assumed, in "a wedged world always has a route to Restart" below, because "the useful
   * action is reachable" is the property; "there is a button in this exact panel" is markup.
   */
  restartControl: boolean;
  /**
   * Whether the surface carries a standing reason/consequence line next to the controls.
   *
   * `/home` deliberately has none per card (the cards are `items-stretch`, so a sentence on
   * one of three unbalances the row) — it states the consequence in the confirm dialog
   * instead, which every surface does and which is tested separately for all three.
   */
  reasonLine: boolean;
  /**
   * Whether this surface prints `power.heading` ("Not responding" / "Starting…" /
   * "Running" / "Stopped").
   *
   * `/home`'s card prints a `StatusPill` driven by the raw `snapshot.status` instead, so a
   * wedged container reads "Stopped" there beside a "Power off" button. That pairing is
   * self-contradictory and it is the surviving half of the `a7d76b8` gap — reported, not
   * fixed here (this workstream may not touch application code). The states table below
   * therefore asserts the heading only where one is rendered, and the *label* — which all
   * three do share — everywhere.
   */
  heading: boolean;
}

const SURFACES: Surface[] = [
  {
    file: "game-controls.tsx",
    route: "/{game}/server",
    render: () => void render(<GameControls game={GAME} />),
    restartControl: true,
    reasonLine: true,
    heading: true,
  },
  {
    file: "game-overview.tsx",
    route: "/{game}",
    render: () => void render(<GameOverview game={GAME} />),
    restartControl: true,
    reasonLine: true,
    heading: true,
  },
  {
    file: "mission-control.tsx",
    route: "/home",
    // One world's access, so there is exactly one card and therefore exactly one power
    // button to query — the shape a MOD granted only Project Zomboid actually sees.
    render: () => void render(<MissionControl access={[GAME]} />),
    restartControl: false,
    reasonLine: false,
    heading: false,
  },
];

function setup(games: Partial<GamesState>, ops: Partial<OperationsStub> = {}) {
  stub.games = gamesState(games);
  stub.ops = opsState(ops);
}

/** The one power button. Matched on the role, not on a class or a test id. */
function powerButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /Power on|Power off|Starting…|Stopping…|Restarting…|Working…/,
  }) as HTMLButtonElement;
}

function restartButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: /^Restart/ }) as HTMLButtonElement | null;
}

/** Everything the surface renders, as one string, for "does it say X anywhere". */
function text(): string {
  return document.body.textContent ?? "";
}

// ── 1. the four states, on every surface ────────────────────────────────────

interface StateCase {
  name: string;
  snapshot: Partial<GameSnapshot>;
  /** The power button's text. The whole `a7d76b8` fix lives in this column. */
  label: string;
  /** `power.heading`, where the surface prints one. */
  heading: string;
  /** Is the container up, i.e. must Restart be a live control? */
  containerUp: boolean;
}

const STATES: StateCase[] = [
  {
    name: "stopped",
    snapshot: { status: "offline" },
    label: "Power on",
    heading: "Stopped",
    containerUp: false,
  },
  {
    name: "running",
    snapshot: { status: "online", containerRunning: true, startedAtMs: Date.now() - 3_600_000 },
    label: "Power off",
    heading: "Running",
    containerUp: true,
  },
  {
    // Up but not answering, and young enough that patience is the right advice.
    name: "starting (up, silent, young)",
    snapshot: { status: "offline", containerRunning: true, startedAtMs: Date.now() - 30_000 },
    label: "Power off",
    heading: "Starting…",
    containerUp: true,
  },
  {
    /**
     * The state the whole fix is about: the container is up, the game has not answered for
     * longer than any boot takes, and `docker start` can do nothing. Seen for real on
     * 2026-09-22 when Project Zomboid's game loop wedged.
     */
    name: "wedged (up, silent, past 12 minutes)",
    snapshot: {
      status: "offline",
      containerRunning: true,
      startedAtMs: Date.now() - WEDGED_FOR_MS,
    },
    label: "Power off",
    heading: "Not responding",
    containerUp: true,
  },
];

describe.each(SURFACES)("$route ($file)", (surface) => {
  describe.each(STATES)("$name", (state) => {
    it("offers the power action that can actually do something", () => {
      setup({ games: worlds({ [GAME]: state.snapshot }) });
      surface.render();
      /**
       * Would have failed before the fix on **two of the three surfaces**, for the two
       * silent-container rows: `game-overview` and `mission-control` both branched on
       * `isOnline`, so a container that was up but mute read `false` and they rendered
       * "Power on". Pressing it ran `docker start` on an already-started container —
       * accepted, no-op, reported as success.
       */
      expect(powerButton().textContent).toBe(state.label);
    });

    it("never offers Power on for a container that is already up", () => {
      // The same guarantee stated as the thing that must never happen, because the row
      // above would still pass if `label` were mechanically copied from the component.
      setup({ games: worlds({ [GAME]: state.snapshot }) });
      surface.render();
      if (state.containerUp) expect(text()).not.toContain("Power on");
    });

    it("keeps Restart live exactly while the container is up", () => {
      setup({ games: worlds({ [GAME]: state.snapshot }) });
      surface.render();
      const restart = restartButton();
      if (!surface.restartControl) {
        // Documented above: `/home`'s card has no Restart. Pin the absence so that if one
        // is ever added, the table entry has to be updated with it.
        expect(restart).toBeNull();
        return;
      }
      if (state.containerUp) {
        /**
         * Would have failed before the fix on `game-overview`, which rendered Restart as
         * `{isOnline && …}` — so the one state that needs it most (up, wedged, not
         * answering) was the one state that hid it. Both the useful action and the honest
         * label were missing at the same time, on the more obvious of the two pages.
         */
        expect(restart).not.toBeNull();
        expect(restart!.disabled).toBe(false);
      } else {
        // Restart cannot help a container that is not there. Absent or disabled; never a
        // live control that would 409 or no-op.
        expect(restart === null || restart.disabled).toBe(true);
      }
    });

    it("states the container's condition honestly, where it states one", () => {
      setup({ games: worlds({ [GAME]: state.snapshot }) });
      surface.render();
      if (!surface.heading) return;
      /**
       * Would have failed before the fix on `game-overview`: it had no "Not responding"
       * case at all, so it collapsed "up but not answering" into "Starting…" with no
       * upper bound and a wedged world read as still booting, for ever.
       */
      // `getAllByText`: the heading and the `StatusPill` beside it both read "Stopped" /
      // "Running" in the two reachable states, which is them AGREEING. Asserting a single
      // match would make that agreement a failure.
      expect(screen.getAllByText(state.heading).length).toBeGreaterThan(0);
    });
  });

  // ── 2. a world must not report another world's activity as its own ────────

  it("does not claim this world is working while a DIFFERENT world starts", () => {
    /**
     * `busy` locks the buttons globally — one world at a time, so someone else's start is
     * our business. `ownBusy` is the only thing that may claim *this* world is doing
     * something. Conflating them made the Project Zomboid page read "Working…", wear the
     * "Booting" pill and animate a blue Power Core while **Minecraft** was starting and PZ
     * was stopped. (`docs/OPERATIONS.md` records that the same expression pre-dated the
     * registry, in `08abbc8`; the registry only made it visible by naming the blocker.)
     */
    const handoff = op({
      id: "mc-start",
      kind: "power",
      game: "minecraft",
      title: "Starting Minecraft",
      action: "start",
      holdsPower: true,
      resources: ["power", "files:minecraft", "files:7dtd", "files:zomboid"],
      startedAt: Date.now() - 40_000,
      heartbeatAt: Date.now(),
      steps: [step({ label: "Starting Minecraft", game: "minecraft" })],
    });
    setup({ games: worlds({ [GAME]: { status: "offline" } }) }, { operations: [handoff] });
    surface.render();

    // Locked — that half is correct and must stay.
    expect(powerButton().disabled).toBe(true);
    // But nothing here may say THIS world is the one working.
    expect(powerButton().textContent).toBe("Power on");
    expect(text()).not.toContain("Working…");
    expect(text()).not.toContain("Stopping…");
    // And the lock is attributed to the world that actually holds it.
    expect(text()).toContain("Minecraft is starting up");
    if (surface.heading) expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  });

  it("does claim this world is working when the operation is about this world", () => {
    // The complement, so the test above cannot be satisfied by a surface that simply never
    // reports any activity. A hand-off *away* from us is a stop here, not a start: the
    // operation's own action is `start` (of the other world) while the step is ours.
    const handoff = op({
      id: "mc-start",
      kind: "power",
      game: "minecraft",
      title: "Starting Minecraft",
      action: "start",
      holdsPower: true,
      resources: ["power", "files:minecraft", "files:7dtd", "files:zomboid"],
      startedAt: Date.now() - 40_000,
      heartbeatAt: Date.now(),
      steps: [step({ label: `Saving ${NAME}`, game: GAME })],
    });
    setup(
      { games: worlds({ [GAME]: { status: "online", containerRunning: true } }) },
      { operations: [handoff] }
    );
    surface.render();
    expect(powerButton().textContent).toBe("Stopping…");
  });

  // ── 3. a disabled control states a reason ────────────────────────────────

  it("tells a read-only viewer why the controls are dead", () => {
    /**
     * A MEMBER pressing Power on and getting an unexplained "Forbidden" is exactly how the
     * `can:` flags were originally reported — and `mission-control`'s cards read `can`
     * **nowhere**, so all three of its buttons looked live and each answered with a bare
     * 403. A disabled control that does not say why is the same failure as a silent
     * operation.
     */
    setup({ can: NO_POWERS, games: worlds({ [GAME]: { status: "offline" } }) });
    surface.render();
    expect(powerButton().disabled).toBe(true);
    expect(text()).toContain("Ask an admin for Mod access");
  });

  it("says what pressing the power button will do, where a standing reason line exists", () => {
    // The reason line is never empty — it is either the block or the consequence. A surface
    // that only explained the blocked case would leave the hand-off unannounced, and the
    // hand-off is the case whose consequence is someone else's disconnection.
    setup({
      can: ALL_POWERS,
      games: worlds({ [GAME]: { status: "offline" }, minecraft: { status: "online" } }),
    });
    surface.render();
    expect(powerButton().disabled).toBe(false);
    if (!surface.reasonLine) return;
    expect(text()).toContain("Minecraft is running. Starting this one stops it first.");
  });

  it("names the hand-off consequence BEFORE sending anything", async () => {
    /**
     * The universal half of the rule above, and the one `/home` carries instead of a
     * standing sentence: every surface confirms first. The `fetch` spy is the load-bearing
     * assertion — `mission-control`'s pre-empt check used to `return` ahead of the hand-off
     * confirm, so with Project Zomboid online and players on it, starting Minecraft during a
     * Minecraft backup showed a dialog about the backup, never the "Players … will be
     * disconnected" one, **and evicted Project Zomboid anyway**. A dialog that appears while
     * the request has already gone out is not a confirmation.
     */
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      setup({
        can: ALL_POWERS,
        games: worlds({ [GAME]: { status: "offline" }, minecraft: { status: "online" } }),
      });
      surface.render();
      fireEvent.click(powerButton());
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain("Minecraft");
      expect(dialog.textContent).toMatch(/disconnect/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── a wedged world always has a route to Restart ────────────────────────────

describe("the documented way out of a wedged container is always reachable", () => {
  it.each(SURFACES)("$route offers Restart, or a link to where it is", (surface) => {
    /**
     * The property, rather than "there is a button in this panel". `powerReason` names
     * Restart as the way out of a wedged container, so every surface that can show a
     * wedged container has to lead somewhere that has one. `/home`'s compact card does it
     * with its Manage link.
     */
    setup({
      games: worlds({
        [GAME]: { status: "offline", containerRunning: true, startedAtMs: Date.now() - WEDGED_FOR_MS },
      }),
    });
    surface.render();
    if (surface.restartControl) {
      expect(restartButton()).not.toBeNull();
      return;
    }
    const manage = screen.getByRole("link", { name: /Manage/ });
    // `/zomboid` is `game-overview`, which this same file proves offers Restart.
    expect(manage.getAttribute("href")).toBe(GAMES[GAME].base);
  });
});

// ── the drift guard: a fourth surface must fail loudly ──────────────────────

describe("every component that derives a power state is in the table above", () => {
  it("finds no unlisted caller of powerState()", () => {
    /**
     * The actual incident was a *forgotten* surface, so the table has to be checked
     * against the tree rather than trusted. Without this, adding a fourth power surface —
     * or splitting one out of an existing file — reproduces the original bug with a green
     * suite, because nothing here would know it existed.
     *
     * Deliberately keyed on `powerState(` rather than on the import: a file that imports
     * the helper and does not call it renders no power state, and a file that calls it is
     * a power surface whatever it chooses to import.
     */
    const dir = path.resolve(__dirname, "../src/components");
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => readFileSync(path.join(dir, f), "utf8").includes("powerState("));
    expect(callers.sort()).toEqual(SURFACES.map((s) => s.file).sort());
  });
});

// ── the hand-off confirm states how long it takes, from a measurement ───────

describe("the hand-off confirm", () => {
  /**
   * "Takes about a minute." was hardcoded here for every hand-off on a box where the Project
   * Zomboid stop measured 5m 03s — the owner clicked, read "about a minute", and watched it
   * sit for five. The replacement then asserted PZ "does not shut down when asked, so this
   * waits out its five minute timeout", written in the same session that made PZ exit in
   * ~12s over RCON: wrong by ~25x, and stating a *mechanism* that had just been removed.
   *
   * So the assertion is that the phrase is a FUNCTION of `GameMeta.stopSeconds`, computed
   * from the table rather than typed in here — which is the only form that survives the next
   * re-measurement. A literal expectation would be the third version of the same mistake.
   *
   * Both directions, because the two outgoing worlds have different measured stops and the
   * dialog picks its wording from them: pinning one would leave the branch untested.
   *
   * (`docs/OPERATIONS.md` is explicit that the ledger itself never predicts a duration —
   * "Real counts only, never a predicted total". This dialog, before the work starts, is the
   * one place the app does say how long to expect, and it is the place that has been wrong.)
   */
  it.each(["minecraft", "7dtd"] as GameId[])(
    "derives the stop duration from %s's measured stopSeconds",
    async (outgoing) => {
      setup({
        games: worlds({ [GAME]: { status: "offline" }, [outgoing]: { status: "online" } }),
      });
      render(<MissionControl access={[GAME, outgoing]} />);

      // The outgoing world is online, so its own button reads "Power off" — leaving exactly
      // one "Power on", which is this world's. No class or test id needed to find the card.
      fireEvent.click(screen.getByRole("button", { name: "Power on" }));

      const dialog = await screen.findByRole("dialog");
      const stopSecs = slowestStopSeconds([outgoing]);
      expect(dialog.textContent).toContain(`takes about ${spellSeconds(stopSecs)}`);
      /**
       * And it must not explain *how* the stop works. A duration is a measurement and can
       * be re-measured; a mechanism is a claim about code, and the one that was written
       * here ("waits out its five minute timeout") had been deleted from the driver in the
       * same session it was written.
       */
      expect(dialog.textContent).not.toMatch(/timeout/i);
      expect(dialog.textContent).not.toMatch(/does not shut down/i);
    }
  );
});
