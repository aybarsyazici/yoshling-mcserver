// @vitest-environment jsdom
/**
 * **The backups list says which archive carries the mods.**
 *
 * `GET /api/server/backups` reporting `includesMods` is only useful if the page reads it,
 * and `docs/OPERATIONS.md` records why that needs its own assertion: *an assertion on a
 * route or a helper cannot fail when a component stops reading it.* The whole reason the
 * field exists is that the archive `install-modpack` takes before it deletes every jar and a
 * routine world-only backup sit in the same list under names that both end in `.tar.gz` —
 * so a user looking for the one that undoes a modpack apply has nothing else to go on.
 *
 * `GameBackups` has had no test of any kind. Only the edges are stubbed: `fetch`, the two
 * context hooks, and sonner's singleton.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { GameBackups } from "@/components/game-backups";
import { gamesState, installBrowserStubs, opsState } from "./helpers/dom";

vi.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {}, warning: () => {} },
}));
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState() }));
vi.mock("@/components/operations-provider", () => ({ useOperations: () => opsState() }));

beforeAll(() => {
  installBrowserStubs();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 } as const;

const WORLD_ONLY = {
  name: "world-2026-10-01T00-00-00.tar.gz",
  size: 173_283_913,
  createdAt: "2026-10-01T00:00:00Z",
  verifiable: true,
  automatic: false,
  includesMods: false,
};

const WITH_MODS = {
  name: "auto-before-modpack-2026-10-02T00-00-00.tar.gz",
  size: 178_000_000,
  createdAt: "2026-10-02T00:00:00Z",
  verifiable: true,
  automatic: false,
  includesMods: true,
};

function stubFetch(backups: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u === "/api/server/backups") return json(200, backups);
      // The header's own request. Deliberately answered, because the component swallows its
      // failure and a 404 here would hide a real break in the listing behind a silent one.
      if (u === "/api/server/backups?meta=1") {
        return json(200, {
          policy: { keep: 5, maxAgeDays: 0 },
          policyText: "keep the 5 newest",
          schedule: { enabled: false, everyHours: 24 },
          journal: [],
          canDownload: true,
        });
      }
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** The row for one archive, scoped by its own file name. */
function row(name: string): HTMLElement {
  const label = screen.getByText(name);
  const el = label.closest("div.flex.flex-wrap");
  if (!el) throw new Error(`no row around ${name}`);
  return el as HTMLElement;
}

async function renderList(backups: unknown[]) {
  stubFetch(backups);
  render(<GameBackups game="minecraft" />);
  for (const b of backups as { name: string }[]) {
    await waitFor(() => expect(screen.queryByText(b.name)).not.toBeNull(), WAIT);
  }
}

describe("the mods badge", () => {
  it("marks the archive that carries the mods, and only that one", async () => {
    await renderList([WITH_MODS, WORLD_ONLY]);
    expect(within(row(WITH_MODS.name)).queryByText(/mods incl\./)).not.toBeNull();
    expect(within(row(WORLD_ONLY.name)).queryByText(/mods incl\./)).toBeNull();
  });

  /**
   * The complement, and it is what stops "render the badge always" passing: a routine
   * backup is world-only and a "world only" badge on every one of them would be noise that
   * made the real signal invisible — the same argument the checksum badge is built on.
   */
  it("says nothing at all when no archive carries mods", async () => {
    await renderList([WORLD_ONLY]);
    expect(screen.queryByText(/mods incl\./)).toBeNull();
  });

  /**
   * An old server, or a tab held across the deploy that added the field. `undefined` must
   * render as absent rather than as a badge — the field is a claim about the archive's
   * contents, and a `?? true` anywhere here would make it a claim nothing checked.
   */
  it("says nothing when the server did not report the field", async () => {
    const { includesMods, ...noField } = WITH_MODS;
    void includesMods;
    await renderList([noField]);
    expect(screen.queryByText(/mods incl\./)).toBeNull();
  });

  it("explains what the badge means on hover", async () => {
    await renderList([WITH_MODS]);
    const badge = within(row(WITH_MODS.name)).getByText(/mods incl\./);
    expect(badge.getAttribute("title")).toMatch(/restoring it puts the installed jars back/);
  });
});
