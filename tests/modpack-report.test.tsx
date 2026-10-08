// @vitest-environment jsdom
/**
 * **The modpack apply's report dialog, rendered.**
 *
 * `modpacks.tsx` had **no test of any kind**, which left the whole UI half of the
 * client-only filter unverified — and the filter's entire justification is that the user
 * can *see* the decision and disagree with it. An adversarial recheck produced two
 * surviving mutants in this file alone:
 *
 *  1. `|| skipped.length > 0` removed from the condition that opens the dialog. A clean
 *     apply of a real pack is exactly the case where `missing`, `failures` and `warnings`
 *     are all empty and 40 mods were nonetheless held back — so the one outcome the filter
 *     exists to report becomes the one outcome that reports nothing. Nothing else notices:
 *     the route's response is unchanged and still 200, and `install-modpack`'s own tests
 *     pass.
 *  2. the entire skipped-rendering block deleted. The condition is untouched, so the dialog
 *     still opens and the title still counts — verified, the shortfall test below stays
 *     green under that mutation — and the names are simply gone.
 *
 * Both are DOM-level by nature, and `docs/OPERATIONS.md` records why that matters: an
 * assertion on a route or a helper cannot fail when a component stops reading it.
 *
 * The toast is mocked because the component uses `sonner`'s singleton; everything else —
 * the dialog, the shape check, the `missing` arithmetic — is the real component.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ALL_POWERS, gamesState, installBrowserStubs } from "./helpers/dom";

/**
 * `can` is stubbed, and these tests are about the report rather than the gate.
 *
 * Every test in this file has to get as far as pressing **Install to Server**, which is now
 * gated on `can.modsInstall` — so without this the component's own
 * `useGames()` poll would have to land through the `fetch` stub below before the button
 * existed, adding an async precondition to nine tests that are about a dialog. Whether the
 * button is *there* for a given role is `tests/mods-surfaces.test.tsx`'s subject, and it
 * asserts it through the real projection.
 *
 * Mocked at the module boundary, not by widening the fetch stub, so a `can` that stops
 * being read cannot be papered over here.
 *
 * A **partial** mock — only `useGames` is replaced. `modpacks.tsx` also imports
 * `CAPABILITY_POLL_MS` from the same module, and a whole-module factory returning one export
 * makes every render throw `No "CAPABILITY_POLL_MS" export is defined on the … mock`.
 */
vi.mock("@/lib/use-games", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-games")>()),
  useGames: () => gamesState({ can: ALL_POWERS }),
}));

import { Modpacks } from "@/components/modpacks";

const toasts: { kind: string; text: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.push({ kind: "success", text }),
    error: (text: string) => toasts.push({ kind: "error", text }),
    info: (text: string) => toasts.push({ kind: "info", text }),
    warning: (text: string) => toasts.push({ kind: "warning", text }),
  },
}));

beforeAll(() => {
  installBrowserStubs();
});
afterEach(() => {
  cleanup();
  toasts.length = 0;
  vi.unstubAllGlobals();
});

/**
 * Generous, because nothing here is slow — a render, two effects and a stubbed fetch — so
 * the only way the default 1 s deadline is missed is a starved machine, where the failure
 * says nothing about the component.
 */
const WAIT = { timeout: 5000 } as const;

const PACK = {
  id: "pack-1",
  name: "Big Pack",
  description: "",
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00Z",
  targetMcVersion: null,
  targetLoader: null,
  mods: [
    { id: "m1", modrinthId: "a", slug: "sodium", name: "Sodium", versionId: null },
    { id: "m2", modrinthId: "b", slug: "lithium", name: "Lithium", versionId: null },
  ],
};

/** Every POST the component made, so a test can prove the apply was actually requested. */
let posts: string[] = [];

/**
 * The route's answer to the apply, with everything else on the page stubbed to something
 * boring. `status` defaults to 200 because the interesting mutant is about a **clean**
 * apply — the shape where nothing is wrong and 40 mods were still held back.
 */
function stubFetch(reply: { status?: number; body: unknown }) {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") posts.push(u);
      if (u === "/api/minecraft/active-profile") return json(200, {});
      if (u === "/api/modpacks") return json(200, [PACK]);
      if (u === "/api/minecraft-versions") return json(200, { versions: ["26.1.2"] });
      if (u === "/api/mods/install-modpack") return json(reply.status ?? 200, reply.body);
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "X-Minecraft-Context": "legacy@0" } });
}

/** Render, click Install, confirm. Leaves whatever the component decided on screen. */
async function applyPack(reply: { status?: number; body: unknown }) {
  stubFetch(reply);
  render(<Modpacks />);
  await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Install to Server" }));
  await waitFor(() => expect(screen.queryByText("Confirm Installation")).not.toBeNull(), WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Yes, replace all mods" }));
  await waitFor(() => expect(posts).toEqual(["/api/mods/install-modpack"]), WAIT);
}

/** The report dialog's own title, which is the thing that is or is not on screen. */
function reportTitle(): HTMLElement | null {
  return screen.queryByText(/^Installed \d+ of \d+ mods$/);
}

/**
 * Queries scoped to the report dialog.
 *
 * Necessary rather than tidy: the pack card behind the dialog lists every mod in the pack
 * as a badge, so an unscoped `getByText("Sodium")` matches the card *and* the skip row and
 * throws "found multiple elements" — a failure that says nothing about what is being
 * asserted. Scoping also means "the name appears once" below is a claim about the report
 * rather than about the page.
 */
function report() {
  const title = reportTitle();
  if (!title) throw new Error("the report dialog is not open");
  const content = title.closest("[data-slot='dialog-content']");
  if (!content) throw new Error("the report title is not inside a dialog");
  return { el: content as HTMLElement, q: within(content as HTMLElement) };
}

// ── mutant 9: the dialog has to open for a skip-only outcome ────────────────

describe("the report opens for an apply whose only news is the skips", () => {
  /**
   * **The mutant.** 42 rows, 40 client-only, 2 installed — `installed === total`, no
   * errors, no warnings, HTTP 200. Everything went right, and 40 mods were left out.
   *
   * Without `|| skipped.length > 0` the condition is false on every count, the dialog never
   * mounts, and the apply that *did the filtering* is the only one that never mentions it.
   */
  it("opens on a clean 200 with skips and nothing else", async () => {
    const skipped = Array.from({ length: 40 }, (_, i) => ({
      name: `Client Mod ${i + 1}`,
      reason: "client-only — this build declares `client_only`, which has no server support",
    }));
    await applyPack({
      body: { success: true, installed: 2, total: 2, errors: [], warnings: [], skipped },
    });

    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    const { q } = report();
    expect(q.getByText("Installed 2 of 2 mods")).toBeDefined();
    expect(q.getByText("40 client-only mods skipped")).toBeDefined();
    // The names, not just the count — a count alone cannot be checked against Modrinth.
    expect(q.getByText("Client Mod 1")).toBeDefined();
    expect(q.getByText("Client Mod 40")).toBeDefined();
  });

  /**
   * The complement, and it is what stops "always open the dialog" passing the test above.
   * A pack with nothing held back and nothing wrong must stay silent: the operation's own
   * completion toast already says what happened, and a dialog on every success is how a
   * report teaches people to dismiss it unread.
   */
  it("stays shut for an apply with no skips, no failures and no warnings", async () => {
    await applyPack({
      body: { success: true, installed: 2, total: 2, errors: [], warnings: [], skipped: [] },
    });
    // Nothing to wait for, so give the render a tick to prove the absence is settled.
    await new Promise((r) => setTimeout(r, 20));
    expect(reportTitle()).toBeNull();
    // And no outcome toast either — the ledger's own summary carries that sentence, and
    // the two used to fire together for exactly the non-clean outcomes.
    expect(toasts).toEqual([]);
  });

  it("opens on a shortfall, which is the path that always worked", async () => {
    await applyPack({
      status: 500,
      body: {
        success: false,
        installed: 1,
        total: 2,
        errors: ["Gone: no compatible version"],
        warnings: [],
        skipped: [],
        error: "Only 1 of 2 mods were installed.",
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    const { q } = report();
    expect(q.getByText("Installed 1 of 2 mods")).toBeDefined();
    expect(q.getByText("Only 1 of 2 mods were installed.")).toBeDefined();
    expect(q.getByText("1 mod failed")).toBeDefined();
    expect(q.getByText("Gone: no compatible version")).toBeDefined();
  });

  /**
   * The 409 refusals answer `installed: 0, total: 0` **plus** the named skips, which is
   * enough for the shape check to open the dialog — and the headline sentence saying why
   * nothing happened travels in `error`, which is the part that got dropped before
   * `InstallReport.error` existed.
   */
  it("opens on the all-client-only refusal and shows its sentence", async () => {
    await applyPack({
      status: 409,
      body: {
        installed: 0,
        total: 0,
        errors: [],
        warnings: [],
        skipped: [
          { name: "Sodium", reason: "client-only — this build declares `client_only`" },
          { name: "Iris", reason: "client-only — this build declares `singleplayer_only`" },
        ],
        error:
          'All 2 mods in "Big Pack" are client-only, so there is nothing to install on a ' +
          "server. Nothing was changed. This is a client-side pack — use the Export option " +
          "to install it in your own launcher.",
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    const { q } = report();
    expect(q.getByText(/use the Export option/)).toBeDefined();
    expect(q.getByText("2 client-only mods skipped")).toBeDefined();
    expect(q.getByText("Sodium")).toBeDefined();
  });

  /**
   * A response that is not an apply report at all — a 403, or a 500 from outside the
   * operation — has no counts, so the dialog must not open with "Installed undefined of
   * undefined mods". Trusting `res.ok` alone is what reported "Installed 0/166 mods" in a
   * green toast.
   */
  it("toasts the error and opens nothing when the body carries no counts", async () => {
    await applyPack({ status: 403, body: { error: "Forbidden" } });
    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0]).toEqual({ kind: "error", text: "Forbidden" });
    expect(reportTitle()).toBeNull();
  });
});

// ── the title's colour is a claim about the count ───────────────────────────

describe("the report title is only destructive when nothing was installed", () => {
  /**
   * **A mutation survived the first version of this file**: hard-coding
   * `className="text-destructive"` on the title left every test green, because nothing
   * asserted the colour of a *successful* report.
   *
   * It matters for the reason `docs/OPERATIONS.md` sets out about `.op-warn`: the colour is
   * a claim, and this repo has already shipped the mistake once — a `noop` step painted
   * every clean backup amber with "part of it is missing. This is not a restore point."
   * A 142-of-166 apply in failure red teaches people that red means nothing.
   */
  function titleClasses(): string {
    const title = reportTitle();
    if (!title) throw new Error("the report dialog is not open");
    return title.className;
  }

  it("is not destructive when mods were installed", async () => {
    await applyPack({
      status: 500,
      body: {
        success: false,
        installed: 1,
        total: 2,
        errors: ["Gone: no compatible version"],
        warnings: [],
        skipped: [],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    expect(titleClasses()).not.toMatch(/text-destructive/);
  });

  it("is destructive when the apply installed nothing", async () => {
    // The complement, so "never destructive" does not pass the row above.
    await applyPack({
      status: 500,
      body: {
        success: false,
        installed: 0,
        total: 2,
        errors: ["a: failed", "b: failed"],
        warnings: [],
        skipped: [],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    expect(titleClasses()).toMatch(/text-destructive/);
  });
});

// ── mutant 10: the skipped block itself ─────────────────────────────────────

/**
 * **The mutant: the whole skipped-rendering block deleted.**
 *
 * The condition that opens the dialog is a separate edit, so under this one the dialog opens
 * exactly as before and every assertion about the title, the error box and the failure list
 * keeps passing. What goes is the one thing the filter is accountable through.
 */
describe("the skipped block names each mod and the reason it was held back", () => {
  it("renders one row per skip, with the declaration that decided it", async () => {
    await applyPack({
      status: 500,
      body: {
        success: false,
        installed: 1,
        total: 2,
        errors: ["Gone: no compatible version"],
        warnings: [],
        skipped: [
          {
            name: "Sodium",
            reason:
              "client-only — this build declares `client_only`, which has no server support",
          },
          {
            name: "Iris",
            reason: "client-only — Modrinth lists this project as server-side unsupported",
          },
        ],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    const { q } = report();

    expect(q.getByText("2 client-only mods skipped")).toBeDefined();
    expect(q.getByText("Sodium")).toBeDefined();
    expect(q.getByText("Iris")).toBeDefined();
    // The reason, which is what tells a correct skip from a broken one. Rendered in its own
    // span beside the name, so matched on the text node rather than the whole row.
    expect(
      q.getByText(/this build declares `client_only`, which has no server support/)
    ).toBeDefined();
    expect(q.getByText(/Modrinth lists this project as server-side unsupported/)).toBeDefined();
  });

  it("is bordered in an accent the dialog actually defines", async () => {
    /**
     * **This block's own comment said the colour was the claim, and the colour did not
     * render.** `border-[var(--tint)]/30` resolves against a custom property that is only
     * ever set by an inline style on a *page wrapper* — and a dialog portals into
     * `document.body`, outside it. An undefined custom property inside `color-mix` is an
     * invalid value and CSS drops the whole declaration, so the "nothing went wrong here"
     * border has been no border at all since the accent was added. Fixed by setting
     * `--tint` on the dialog; pinned here, because nothing else can notice a colour that
     * silently does not apply.
     */
    await applyPack({
      body: {
        success: true,
        installed: 1,
        total: 1,
        errors: [],
        warnings: [],
        skipped: [{ name: "Sodium", reason: "client-only" }],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    expect(report().el.style.getPropertyValue("--tint")).toBe("var(--mc)");
  });

  /** Singular when there is one, because "1 client-only mods skipped" is the small
   * wrongness that makes everything beside it read as careless. */
  it("says mod, not mods, for a single skip", async () => {
    await applyPack({
      body: {
        success: true,
        installed: 1,
        total: 1,
        errors: [],
        warnings: [],
        skipped: [{ name: "Sodium", reason: "client-only" }],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    expect(report().q.getByText("1 client-only mod skipped")).toBeDefined();
  });

  /**
   * **The skips appear once, and not in the amber channel.**
   *
   * They used to arrive in `warnings` as well as in `skipped`, so the same correct decision
   * rendered twice in one dialog — once in `chart-5` (the warning colour, under no heading)
   * and once in the world's accent under a heading whose own comment said nothing went
   * wrong. The colour is a claim, and a large pack is 30-50% client mods, so that amber
   * block fired on every correct install.
   *
   * Asserted as "the name occurs exactly once in the dialog", which is what a reader sees,
   * rather than on a class name.
   */
  it("shows a skipped mod exactly once, never also as a warning", async () => {
    await applyPack({
      body: {
        success: true,
        installed: 1,
        total: 1,
        errors: [],
        warnings: [],
        skipped: [{ name: "Sodium", reason: "client-only — this build declares `client_only`" }],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    expect(report().el.textContent?.match(/Sodium/g)).toHaveLength(1);
  });

  /**
   * A genuine warning still renders, so the amber channel is not simply dead. `warnings`
   * carries the things that do want looking at — rows with no download source, an
   * `environment` value this app cannot read, a jar installed with no checksum.
   */
  it("still renders a real warning beside the skips", async () => {
    await applyPack({
      body: {
        success: true,
        installed: 1,
        total: 1,
        errors: [],
        warnings: [
          "Modrinth reported 1 `environment` value this app does not recognise " +
            "(`client_or_server_prefers_server` on FromTheFuture).",
        ],
        skipped: [{ name: "Sodium", reason: "client-only" }],
      },
    });
    await waitFor(() => expect(reportTitle()).not.toBeNull(), WAIT);
    const { q } = report();
    expect(q.getByText(/does not recognise/)).toBeDefined();
    expect(q.getByText("1 client-only mod skipped")).toBeDefined();
  });
});
