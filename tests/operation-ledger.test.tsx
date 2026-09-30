// @vitest-environment jsdom
/**
 * The operation ledger, rendered.
 *
 * `tests/operations-summary.test.ts` and `tests/operations-outcome.test.ts` already cover
 * the *sentence* the server derives. This file covers the strip that has to show it, which
 * the suite's own note listed as unverified: *"the ledger, the toasts, the power bus and
 * the three power surfaces' actual rendering are unverified by this suite."*
 *
 * Every assertion here is a property the component was **built to fix**, and each one
 * names the measured failure it pins. In particular, nothing below asserts a Tailwind
 * class as a goal in itself: `docs/OPERATIONS.md` records that a colour token's contrast
 * is a measurement, not a derivation, so the properties worth pinning are "the severity is
 * carried by something other than colour" and "the per-second figure is not in the live
 * region" — both of which survive any restyle.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OPERATION_STALE_MS, formatElapsed } from "@/lib/operations-types";
import { installBrowserStubs, op, opsState, step, type OperationsStub } from "./helpers/dom";

const stub = vi.hoisted(() => ({ ops: null as unknown }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => stub.ops }));

import { OperationLedger } from "@/components/operation-ledger";

beforeAll(installBrowserStubs);
afterEach(cleanup);

/**
 * `elapsedMs` mirrors the real provider (`Date.now() + skew - startedAt`) rather than
 * returning a constant, because the ledger derives four separate things from the clock and
 * a constant would let a surface read the wrong record's elapsed time and still pass.
 */
function setup(over: Partial<OperationsStub> = {}) {
  stub.ops = opsState({
    elapsedMs: (o) => Math.max(0, Date.now() - o.startedAt),
    ...over,
  });
}

/** The expand/collapse control, which is also how we prove nothing was expanded. */
function toggle(): HTMLButtonElement {
  return screen.getByRole("button", { name: /operation steps/ }) as HTMLButtonElement;
}

const SINCE = 95_000;

/** A live Project Zomboid restart, 1m 35s in, mid-stop, with a detail on the wire. */
function liveRestart(over: Partial<ReturnType<typeof op>> = {}) {
  const now = Date.now();
  return op({
    id: "pz-restart",
    kind: "power",
    game: "zomboid",
    title: "Restarting Project Zomboid",
    action: "restart",
    holdsPower: true,
    resources: ["power"],
    startedAt: now - SINCE,
    heartbeatAt: now,
    steps: [
      step({
        id: "stop",
        kind: "running",
        label: "Stopping Project Zomboid",
        detail: "Asked the server to quit over RCON — waiting for it to exit",
        at: now - SINCE,
        game: "zomboid",
      }),
    ],
    ...over,
  });
}

// ── 1. how long it has been going, and why, WITHOUT expanding anything ──────

describe("a long operation explains itself while collapsed", () => {
  it("shows the elapsed time and the live step's detail with the panel shut", () => {
    /**
     * The founding complaint of this work, measured: on 2026-09-29 the owner pressed
     * Restart on Project Zomboid, watched it sit, and reported it as hung. The explanation
     * was on the wire the whole time — `narratedStop` sets the "Asked the server to quit
     * over RCON" detail before it blocks — but `lede()` returned only the step *label* and
     * the panel defaults collapsed, so the one sentence that would have made the wait a
     * non-event was an un-hinted click away.
     *
     * Both halves are asserted with `aria-expanded === "false"` checked in the same test,
     * because "visible somewhere in the DOM" is not the property; "visible without
     * expanding" is.
     */
    setup({ operations: [liveRestart()] });
    render(<OperationLedger />);

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // Twice on purpose — the visible line and the sr-only region. `getAllByText` rather
    // than `getByText` because that duplication is the design, not an ambiguity.
    expect(screen.getAllByText("Stopping Project Zomboid").length).toBe(2);
    expect(
      screen.getByText("Asked the server to quit over RCON — waiting for it to exit")
    ).toBeTruthy();
    // The clock, derived from `startedAt` rather than hardcoded, so the assertion tracks
    // the fixture.
    expect(screen.getByText(`+${formatElapsed(SINCE)}`)).toBeTruthy();
  });

  it("says out loud that the controls are locked, which is why the buttons are dead", () => {
    // The 2026-09-15 failure in one line: a six-minute apply with the power buttons
    // correctly locked and nothing anywhere saying why. Expanding reveals the sentence;
    // it must be there.
    setup({ operations: [liveRestart()] });
    render(<OperationLedger />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/server controls are locked until this finishes/i)).toBeTruthy();
  });

  it("prefers a recorded count to the churning log line", () => {
    /**
     * `install-modpack` sets a per-mod `detail` on every single mod, so `detail` is never
     * empty during the one operation that HAS a count — and with the old preference order
     * "42 of 166 mods" lost every time to a jar filename. A count is the only thing on this
     * line that answers "how much is left", which is the question the collapsed strip
     * exists to answer.
     */
    setup({
      operations: [
        op({
          id: "apply",
          kind: "mods.apply",
          game: "minecraft",
          title: "Installing a modpack",
          startedAt: Date.now() - 60_000,
          heartbeatAt: Date.now(),
          progress: { kind: "count", done: 42, total: 166, noun: "mods" },
          steps: [step({ label: "Downloading mods", detail: "sodium-fabric-0.6.jar" })],
        }),
      ],
    });
    render(<OperationLedger />);
    expect(screen.getByText("42 of 166 mods")).toBeTruthy();
    expect(screen.queryByText("sodium-fabric-0.6.jar")).toBeNull();
  });

  it("surfaces a warning fact while the operation is still running", () => {
    /**
     * Measured cost of withholding it: when Project Zomboid does not answer the save RCON,
     * `narratedStop` records "the world was not saved — the server did not answer" at about
     * second 1 and then blocks in `docker stop`. Gated on `endedAt`, the operator learned
     * the world had not been saved *after* the SIGKILL — i.e. after the only window in
     * which a human could have done anything about it.
     */
    setup({
      operations: [
        liveRestart({
          facts: [
            {
              label: "Save",
              value: "the world was not saved — the server did not answer",
              verdict: "warn",
              game: "zomboid",
            },
          ],
        }),
      ],
    });
    render(<OperationLedger />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByText("the world was not saved — the server did not answer")
    ).toBeTruthy();
  });

  it("attributes a fact to the world it is about, not to the operation's world", () => {
    /**
     * A hand-off is ONE operation whose `game` is the world coming **up**, and the warnings
     * it collects are about the world going **down**. Before `OperationFact.game` existed
     * the derived sentence read "Minecraft — started in 5m 04s, but **it** had to be killed
     * after 300s" while `docker events` showed Minecraft had only ever been started.
     * Printing the fact bare under a "Starting Minecraft" heading would have reintroduced
     * the same mix-up in a new place.
     */
    setup({
      operations: [
        op({
          id: "handoff",
          kind: "power",
          game: "minecraft",
          title: "Starting Minecraft",
          action: "start",
          holdsPower: true,
          resources: ["power"],
          startedAt: Date.now() - 60_000,
          heartbeatAt: Date.now(),
          steps: [step({ label: "Stopping Project Zomboid", game: "zomboid" })],
          facts: [
            // The 300s SIGKILL is the FALLBACK path today, not the normal one: since the
            // 2026-09-29 RCON `quit` fix a Project Zomboid stop is ~12s with exit code 0.
            // Kept as the fixture because it is the fact that actually caused the mix-up,
            // and it is still reachable for a server too wedged to answer RCON.
            { label: "Shutdown", value: "killed after 300s", verdict: "warn", game: "zomboid" },
          ],
        }),
      ],
    });
    render(<OperationLedger />);
    expect(screen.getByText("Project Zomboid: killed after 300s")).toBeTruthy();
  });
});

// ── 2. a failure is distinguishable without colour ──────────────────────────

describe("a settled failure", () => {
  function failed() {
    const now = Date.now();
    return op({
      id: "pz-fail",
      kind: "power",
      game: "zomboid",
      title: "Restarting Project Zomboid",
      startedAt: now - 60_000,
      heartbeatAt: now - 5_000,
      endedAt: now - 4_000,
      outcome: "failed",
      summary: "Project Zomboid — the restart failed: the container exited 1.",
      steps: [step({ kind: "failed", label: "Started the server", at: now - 10_000 })],
    });
  }

  function clean() {
    const now = Date.now();
    return op({
      id: "pz-ok",
      kind: "power",
      game: "zomboid",
      title: "Restarting Project Zomboid",
      startedAt: now - 20_000,
      heartbeatAt: now - 5_000,
      endedAt: now - 4_000,
      outcome: "ok",
      summary: "Project Zomboid — restarted in 12s.",
      steps: [step({ kind: "done", label: "Started the server", at: now - 10_000 })],
    });
  }

  it("is told apart by TEXT, not only by colour", () => {
    /**
     * Two non-colour channels, and the test insists on both because either alone is one
     * restyle away from being the only one. The strip's own note records that `text-chart-5`
     * measured **2.15:1** in Latte on this wash — below AA — for the single most important
     * sentence the feature produces, and that this was the one place in the app where
     * colour carried severity alone.
     *
     *  1. the summary sentence itself says what went wrong (it is server-derived, so it
     *     cannot claim more than was observed);
     *  2. a failure is the only outcome that gets an "Open the console" line — a named way
     *     forward, which is what the sentence is for.
     */
    setup({ finished: [failed()] });
    render(<OperationLedger />);
    expect(
      screen.getAllByText("Project Zomboid — the restart failed: the container exited 1.").length
    ).toBeGreaterThan(0);
    const toConsole = screen.getByRole("link", { name: "Open the console" });
    expect(toConsole.getAttribute("href")).toBe("/zomboid/server");
  });

  it("replaces the world glyph with a severity mark, which a clean finish does not get", () => {
    /**
     * The shape channel. `GameMark` is a hand-rolled `<svg>` with no `lucide` class; the
     * severity marks are lucide icons, so "the mark changed" is checkable without asserting
     * a colour. Stated as a *difference* against the clean case on purpose — asserting only
     * that the failed row has an `OctagonX` would pass just as well if every row had one.
     */
    setup({ finished: [failed()] });
    const bad = render(<OperationLedger />);
    expect(bad.container.querySelector("svg.lucide-octagon-x")).not.toBeNull();
    cleanup();

    setup({ finished: [clean()] });
    const good = render(<OperationLedger />);
    // The clean row keeps the world's own mark: no severity glyph of either kind.
    expect(good.container.querySelector("svg.lucide-octagon-x")).toBeNull();
    expect(good.container.querySelector("svg.lucide-triangle-alert")).toBeNull();
    expect(screen.queryByText("Open the console")).toBeNull();
  });

  it("marks a partial outcome as a warning, and keeps it distinguishable from a failure", () => {
    /**
     * `partial` is not `failed` and must not borrow its mark. It is also the NORMAL outcome
     * for several routine Project Zomboid operations (every PZ stop used to record a
     * `killed after 300s` warn), so conflating the two would cry wolf on the common path —
     * which `docs/OPERATIONS.md` calls out as the reason a summary template may never
     * branch on `outcome === "partial"` to make a specific claim.
     */
    const now = Date.now();
    setup({
      finished: [
        op({
          id: "pz-partial",
          kind: "mods.update",
          game: "zomboid",
          title: "Updating mods",
          startedAt: now - 60_000,
          heartbeatAt: now - 5_000,
          endedAt: now - 4_000,
          outcome: "partial",
          summary: "Mods updated — but Project Zomboid had to be killed after 300s.",
        }),
      ],
    });
    const r = render(<OperationLedger />);
    expect(r.container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
    expect(r.container.querySelector("svg.lucide-octagon-x")).toBeNull();
    // A partial is not a failure, so it gets no "Open the console" prompt.
    expect(screen.queryByText("Open the console")).toBeNull();
  });
});

// ── 3. the live region never re-announces a per-second figure ───────────────

describe("the screen-reader region", () => {
  it("is mounted even when nothing is running", () => {
    /**
     * A region created at the same moment as its content is the documented unreliable case
     * for `aria-live` — neither NVDA nor VoiceOver is required to announce it, and in
     * practice neither does. This component used to return `null` while idle, so pressing
     * Power on inserted a brand-new `role="status"` already containing its text; with every
     * start toast deliberately removed in favour of "the strip appearing IS the
     * announcement", a screen-reader user heard **nothing at all** until the next step
     * label swapped in.
     */
    setup();
    render(<OperationLedger />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("carries the world name even though the visible one is hidden below `sm`", () => {
    // The visible name is `hidden sm:inline` and every `GameMark` hard-codes `aria-hidden`,
    // so without this the region said "Stopping…" with no way to tell which of three
    // worlds it was on.
    setup({ operations: [liveRestart()] });
    render(<OperationLedger />);
    expect(screen.getByRole("status").textContent).toContain("Project Zomboid");
  });

  it("does not print the world name twice when the step label already contains it", () => {
    /**
     * `includes`, not `startsWith` — and that distinction WAS the bug. A settled summary
     * starts with the world's name so the old guard worked there, but a live lede is a step
     * label and every power label embeds the world mid-sentence ("Stopping Project
     * Zomboid"), so `startsWith` never fired and the region announced "Project Zomboid —
     * Stopping Project Zomboid" verbatim for the whole operation.
     */
    const spoken = (() => {
      setup({ operations: [liveRestart()] });
      render(<OperationLedger />);
      return screen.getByRole("status").textContent ?? "";
    })();
    expect(spoken).toBe("Stopping Project Zomboid");
    expect(spoken.match(/Project Zomboid/g)).toHaveLength(1);
  });

  it("keeps the per-second counter OUT of the announcement and aria-hidden on screen", () => {
    /**
     * A polite live region with no terminal state, containing a figure that changes once a
     * second, makes NVDA/VoiceOver read the whole sentence once a second indefinitely —
     * talking over the user's search for the Dismiss button that is the only escape.
     *
     * Both halves matter and are asserted together: the counter must be on screen (it is
     * the answer to "is this hung?") and must not be announced.
     */
    setup({ operations: [liveRestart()] });
    render(<OperationLedger />);
    const counter = screen.getByText(`+${formatElapsed(SINCE)}`);
    expect(counter.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("status").textContent).not.toMatch(/\d+s/);
  });

  it("announces a lost operation without the counting figure that is on screen", () => {
    /**
     * The worst case of the rule above: `lede`'s stale branch embeds
     * `formatElapsed(now - heartbeatAt)`. `announce()` states the same fact and stops.
     *
     * It also must NOT claim a failure — we know we stopped hearing from it, not that it
     * went wrong, and the operation may well have succeeded.
     */
    const now = Date.now();
    const silentFor = OPERATION_STALE_MS + 30_000;
    setup({ operations: [liveRestart({ heartbeatAt: now - silentFor })] });
    render(<OperationLedger />);
    const spoken = screen.getByRole("status").textContent ?? "";
    expect(spoken).toContain("lost contact with this operation");
    expect(spoken).not.toMatch(/\d+m \d+s/);
    expect(spoken).not.toMatch(/fail/i);
    // On screen the figure IS there, because a sighted reader is not re-read to.
    // Derived from the fixture, not typed in: a literal would silently stop matching the
    // moment `OPERATION_STALE_MS` moved, and pass again as soon as someone "fixed" it.
    expect(
      screen.getByText(`Restarting Project Zomboid — lost contact ${formatElapsed(silentFor)} ago. Check the console.`)
    ).toBeTruthy();
    // And a record we have lost contact with becomes dismissible, or the strip is a
    // surface you cannot close while the buttons stay dead.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});

// ── 4. nothing in it spins ──────────────────────────────────────────────────

describe("no indeterminate progress anywhere", () => {
  it("renders no spinner and no sweeping bar for a live operation", () => {
    /**
     * A sweeping bar and a `Loader2` animate identically whether the server is alive,
     * wedged or gone — which, in a codebase whose documented recurring defect is "reports
     * success after doing nothing", is that same defect at the animation layer. The only
     * thing allowed to move is the pip, and it moves only on an observed heartbeat, so its
     * *stillness* carries information.
     */
    setup({ operations: [liveRestart()] });
    const r = render(<OperationLedger />);
    fireEvent.click(toggle());
    expect(r.container.querySelector(".animate-spin")).toBeNull();
    expect(r.container.querySelector(".animate-pulse")).toBeNull();
    expect(r.container.querySelector("svg.lucide-loader-circle")).toBeNull();
    expect(r.container.querySelector("progress")).toBeNull();
    expect(r.container.querySelector('[role="progressbar"]')).toBeNull();
  });
});
