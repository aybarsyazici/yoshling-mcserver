// @vitest-environment jsdom
/**
 * **What the mod browser says it is showing you, and how it is widened.**
 *
 * The search was unfiltered by Minecraft version and loader unless a modpack was selected, so
 * the default grid — every card now carrying an Install button — listed mods for every version
 * and loader Modrinth publishes, against a server running one of them, with nothing on screen
 * saying so. The route now defaults the facet; this file pins the three things the page then
 * owes the user:
 *
 * 1. it **states** the filter, from the route's own `filter` field rather than from the request
 *    it made;
 * 2. widening is a control, not an omission, and pressing it really does re-search with `any`;
 * 3. an empty result under that filter **names** the filter, because "No mods found" under a
 *    version facet nobody asked for is the most confusing state this page can reach.
 *
 * `ModCard` is stubbed to isolate searches from card controls and description requests.
 * Its behavior has separate coverage. The former html-react-parser import also required
 * this isolation on Node 20.12; the description renderer no longer imports it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModBrowser } from "@/components/mod-browser";
import { installBrowserStubs } from "./helpers/dom";

vi.mock("@/components/mod-card", () => ({
  ModCard: ({ mod }: { mod: { title: string } }) => <div data-testid="mod">{mod.title}</div>,
}));

beforeAll(() => {
  installBrowserStubs();
});
afterEach(() => {
  cleanup();
  searches.length = 0;
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 } as const;

/** Every `/api/mods/search` URL the browser requested, in order. */
const searches: string[] = [];

const SODIUM = {
  project_id: "AANobbMI",
  slug: "sodium",
  title: "Sodium",
  description: "",
  author: "jellysquid3",
  categories: [],
  downloads: 1,
  icon_url: null,
};

/**
 * One search reply per request, consumed in order; the last one repeats.
 *
 * Repeating matters because the component debounces and re-runs `search(0)` whenever its
 * dependencies change, so the number of requests is not something a test should have to
 * predict — only their *contents* are the subject.
 */
function stubFetch(replies: unknown[]) {
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith("/api/mods/search")) {
        searches.push(u);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return json(200, next);
      }
      if (u === "/api/mods/categories") return json(200, []);
      if (u === "/api/modpacks") return json(200, []);
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const FILTERED = {
  hits: [SODIUM],
  total_hits: 1,
  offset: 0,
  limit: 20,
  filter: { mcVersion: "26.1.2", loader: "fabric" },
};

const WIDENED = {
  hits: [SODIUM],
  total_hits: 4321,
  offset: 0,
  limit: 20,
  filter: { mcVersion: null, loader: null },
};

/** The most recent search URL's query parameters. */
function lastQuery(): URLSearchParams {
  expect(searches.length).toBeGreaterThan(0);
  return new URL(searches[searches.length - 1], "http://localhost").searchParams;
}

// ── stating the filter ───────────────────────────────────────────────────────

describe("the browser states which version it is showing mods for", () => {
  /**
   * The default request carries **no** `version` and **no** `loader`. That omission is the
   * contract with the route: it applies the server's own values, and the page does not keep a
   * second copy of them to drift against the first.
   */
  it("asks for no version, and reports the one the route applied", async () => {
    stubFetch([FILTERED]);
    render(<ModBrowser />);
    await waitFor(() => expect(searches.length).toBeGreaterThan(0), WAIT);

    expect(lastQuery().get("version")).toBeNull();
    expect(lastQuery().get("loader")).toBeNull();
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for: MC 26\.1\.2 \/ fabric/)).not.toBeNull(),
      WAIT
    );
  });

  /**
   * **Nothing is claimed without evidence.** A response with no `filter` — an older or cached
   * shape — must leave the page silent rather than asserting a version it cannot know was
   * applied. This is the complement that stops "always render the badge" passing the tests
   * above.
   */
  it("claims nothing when the response carries no filter", async () => {
    stubFetch([{ hits: [SODIUM], total_hits: 1, offset: 0, limit: 20 }]);
    render(<ModBrowser />);
    await waitFor(() => expect(screen.queryAllByTestId("mod").length).toBe(1), WAIT);
    expect(screen.queryByText(/Showing mods for/)).toBeNull();
  });
});

// ── widening, deliberately ───────────────────────────────────────────────────

describe("widening is a control the user presses", () => {
  it("re-searches with version=any and loader=any", async () => {
    stubFetch([FILTERED, WIDENED]);
    render(<ModBrowser />);
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for: MC 26\.1\.2/)).not.toBeNull(),
      WAIT
    );

    fireEvent.click(screen.getByRole("button", { name: "show all versions" }));

    await waitFor(() => expect(lastQuery().get("version")).toBe("any"), WAIT);
    expect(lastQuery().get("loader")).toBe("any");
    // And the statement follows the request rather than leading it.
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for every Minecraft version/)).not.toBeNull(),
      WAIT
    );
  });

  /** And back again, so widening is not a one-way door. */
  it("narrows back to the server's version", async () => {
    stubFetch([FILTERED, WIDENED, FILTERED]);
    render(<ModBrowser />);
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for: MC 26\.1\.2/)).not.toBeNull(),
      WAIT
    );
    fireEvent.click(screen.getByRole("button", { name: "show all versions" }));
    await waitFor(() => expect(lastQuery().get("version")).toBe("any"), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "only this server's version" }));
    await waitFor(() => expect(lastQuery().get("version")).toBeNull(), WAIT);
  });

  /**
   * With no `ServerConfig` row the route answers `filter: {mcVersion: null}` without anybody
   * having widened. Two things follow, and they share one mount because they are two readings
   * of the same state: the page still **says** it is unfiltered rather than silently dropping
   * the badge, and it offers no narrow-back control — there is no version to narrow back to,
   * and a button that would change nothing is worse than no button because it reads as broken.
   */
  it("states an unfiltered search and offers no narrow-back when nothing was widened", async () => {
    stubFetch([WIDENED]);
    render(<ModBrowser />);
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for every Minecraft version/)).not.toBeNull(),
      WAIT
    );
    expect(screen.queryByText(/Showing mods for: MC/)).toBeNull();
    expect(screen.queryByRole("button", { name: "only this server's version" })).toBeNull();
  });
});

// ── the empty result ─────────────────────────────────────────────────────────

describe("an empty result names the filter that produced it", () => {
  const NOTHING = {
    hits: [],
    total_hits: 0,
    offset: 0,
    limit: 20,
    filter: { mcVersion: "26.1.2", loader: "fabric" },
  };

  it("names the version and loader, and offers the way out", async () => {
    stubFetch([NOTHING]);
    render(<ModBrowser />);
    // Waited on the **badge**, not on "No mods found": the empty-state block is also what the
    // very first render shows, before any response has arrived, so waiting for it would assert
    // against a page that has not been told anything yet. (Found by writing it the other way.)
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for: MC 26\.1\.2/)).not.toBeNull(),
      WAIT
    );
    expect(screen.getByText("No mods found")).toBeDefined();

    expect(screen.getByText(/Nothing matched this search for MC 26\.1\.2 \/ fabric\./)).toBeDefined();
    // The pre-existing copy blamed the modpack filter, which is not what is filtering here.
    expect(screen.queryByText(/remove the modpack filter/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show mods for all versions" }));
    await waitFor(() => expect(lastQuery().get("version")).toBe("any"), WAIT);
  });

  /**
   * The complement: with no facet applied, an empty result is about the search terms and
   * there is nothing to widen. Offering "show all versions" there would promise a change it
   * cannot make.
   */
  it("offers nothing to widen when no version facet was applied", async () => {
    stubFetch([{ hits: [], total_hits: 0, offset: 0, limit: 20, filter: { mcVersion: null, loader: null } }]);
    render(<ModBrowser />);
    await waitFor(
      () => expect(screen.queryByText(/Showing mods for every Minecraft version/)).not.toBeNull(),
      WAIT
    );
    expect(screen.getByText("No mods found")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show mods for all versions" })).toBeNull();
    expect(screen.queryByText(/Nothing matched this search for/)).toBeNull();
  });
});
