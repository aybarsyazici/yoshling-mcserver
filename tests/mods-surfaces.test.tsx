// @vitest-environment jsdom
/**
 * The Minecraft mods page's write controls, rendered, for a MEMBER and for a MOD.
 *
 * This is `tests/power-surfaces.test.tsx` applied to the one page that never got the fix it
 * records. The power buttons' `can:` projection exists because *"a MEMBER pressed Power on
 * and got an unexplained 'Forbidden'"* — that is how it was reported — and `/minecraft/mods`
 * kept doing exactly that: Create Modpack, Edit, Install to Server, Delete, Remove, + Add to
 * Pack and Import were all live for a read-only account, and every one of them answered a
 * bare 403 with nothing on screen saying why. None of the four components read a session.
 *
 * Asserted through the **rendered DOM**, never by calling a helper, for the reason that file
 * gives: an assertion on `hasPermission` cannot fail when a component stops asking it, and a
 * component that stops asking is the only failure that has actually happened here.
 *
 * `tests/mods-can-route.test.ts` is the other half — that the route still *sends* the two
 * flags, derived from the real permission table. Neither file is sufficient alone: with
 * `useGames` stubbed here, a route that dropped `modsInstall` would leave every test in this
 * file green while hiding Install to Server from an admin.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_POWERS, NO_POWERS, gamesState, installBrowserStubs } from "./helpers/dom";
import type { GamesState } from "@/lib/use-games";

/**
 * `useGames` is replaced, not the components.
 *
 * It is the only thing any of these four learns a capability from, and it is a `fetch` loop.
 * Stubbing it is what makes the rest of each tree — the `can.modsRemove &&`, the prop
 * `ModBrowser` hands each card, the label — real code under test.
 */
const stub = vi.hoisted(() => ({ games: null as unknown }));
/**
 * A **partial** mock: only `useGames` is replaced.
 *
 * A whole-module factory is the obvious shape and it breaks here — the four components also
 * import `CAPABILITY_POLL_MS` from this module, and a factory that returns one export turns
 * every render into `No "CAPABILITY_POLL_MS" export is defined on the … mock`. Spreading the
 * real module keeps anything else it exports real, which is also the honest default: the only
 * thing this file has a reason to fake is the poll.
 */
vi.mock("@/lib/use-games", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-games")>()),
  useGames: () => stub.games,
}));

/**
 * `ModDetailDialog` is replaced by a stub, and it has to be.
 *
 * It is the one thing `mod-card.tsx` and `modpack-browser-modrinth.tsx` import that cannot be
 * loaded here: it pulls in `html-react-parser`, which `require()`s the ESM-only `domhandler`,
 * so on this project's Node 20.12 collecting the file dies with `ERR_REQUIRE_ESM` before a
 * single test runs — the same trap `vitest.config.mts` and the Prisma CLI note record.
 *
 * Replacing it costs this file nothing: it carries **no write control at all** (measured —
 * every `<Button>` in it is an external link to Source / Wiki / Issues / Discord, and its only
 * request is a GET to `/api/mods/detail`), so it is not a surface this file is about. It stays
 * mounted as an element so a card's click-through still renders.
 */
vi.mock("@/components/mod-detail-dialog", () => ({
  ModDetailDialog: ({ open }: { open: boolean }) => (open ? <div>mod detail</div> : null),
}));

/** `sonner` is a singleton that renders nowhere here; the toasts are read as data. */
const toasts: { kind: string; text: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.push({ kind: "success", text }),
    error: (text: string) => toasts.push({ kind: "error", text }),
    info: (text: string) => toasts.push({ kind: "info", text }),
    warning: (text: string) => toasts.push({ kind: "warning", text }),
  },
}));

import { InstalledMods } from "@/components/installed-mods";
import { ModBrowser } from "@/components/mod-browser";
import { ModpackBrowserModrinth } from "@/components/modpack-browser-modrinth";
import { Modpacks } from "@/components/modpacks";
import ModsPage from "@/app/minecraft/mods/page";

beforeAll(installBrowserStubs);
afterEach(() => {
  cleanup();
  toasts.length = 0;
  deletes.length = 0;
  vi.unstubAllGlobals();
});

/** Generous: a render, two effects and a stubbed fetch, plus a 300-400 ms search debounce. */
const WAIT = { timeout: 5000 } as const;

// ── the page's data, stubbed once for all four components ───────────────────

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

const INSTALLED = {
  id: "im1",
  modrinthId: "P7dR8mSH",
  slug: "fabric-api",
  name: "Fabric API",
  version: "0.100.0",
  fileName: "fabric-api-0.100.0.jar",
  mcVersion: "26.1.2",
  loader: "fabric",
  installedAt: "2026-10-01T00:00:00Z",
};

const PROJECT = {
  slug: "sodium",
  title: "Sodium",
  description: "A rendering engine",
  categories: ["optimization"],
  client_side: "required",
  server_side: "unsupported",
  project_type: "mod",
  downloads: 1_000_000,
  icon_url: null,
  project_id: "AANobbMI",
  author: "jellysquid3",
  versions: ["26.1.2"],
  follows: 1,
  date_created: "2020-01-01T00:00:00Z",
  date_modified: "2026-01-01T00:00:00Z",
  license: "LGPL",
  gallery: [],
};

const REMOTE_PACK = {
  project_id: "1KVo5zza",
  slug: "fabulously-optimized",
  title: "Fabulously Optimized",
  description: "A modpack",
  icon_url: null,
  downloads: 5_000_000,
  author: "someone",
  categories: ["optimization"],
};

/** Every DELETE the page sent, so "nothing was requested" is checkable. */
const deletes: string[] = [];
/** Set by the one test that needs a DELETE to be refused. */
let failDelete: { status: number; body: unknown } | null = null;
/** What the export endpoint answers with, for the Download All tests. */
let exportMods: unknown[] = [];

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function stubFetch() {
  failDelete = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "DELETE") {
        deletes.push(u);
        return failDelete ? json(failDelete.status, failDelete.body) : json(200, { success: true });
      }
      if (u === "/api/modpacks") return json(200, [PACK]);
      if (u === "/api/minecraft-versions") return json(200, { versions: ["26.1.2"] });
      if (u === "/api/mods/installed") return json(200, [INSTALLED]);
      if (u === "/api/mods/categories") return json(200, []);
      if (u.startsWith("/api/mods/search")) return json(200, { hits: [PROJECT], total_hits: 1 });
      if (u.startsWith("/api/modpacks/search"))
        return json(200, { hits: [REMOTE_PACK], total_hits: 1 });
      if (u.startsWith("/api/mods/dependencies")) return json(200, { dependencies: [] });
      if (u.endsWith("/export"))
        return json(200, {
          modpack: { name: "Big Pack", description: "", mcVersion: "26.1.2", loader: "fabric" },
          mods: exportMods,
        });
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

/** A `can` with only the keys this file varies set, the rest as a MEMBER's. */
function withCan(over: Partial<GamesState["can"]>): Partial<GamesState> {
  return { can: { ...NO_POWERS, ...over } };
}

function setup(over: Partial<GamesState>) {
  stubFetch();
  stub.games = gamesState(over);
}

/** Everything on screen, as one string. */
function text(): string {
  return document.body.textContent ?? "";
}

function button(name: string | RegExp): HTMLButtonElement | null {
  return screen.queryByRole("button", { name }) as HTMLButtonElement | null;
}

// ── the four surfaces ───────────────────────────────────────────────────────

interface Surface {
  /** The component file, which is also the key the drift guard at the bottom checks. */
  file: string;
  /** Where on `/minecraft/mods` a user meets it. */
  where: string;
  render(): void;
  /** Something the surface prints once its data has landed. */
  ready: string;
  /** Controls whose route checks `mods.install`. */
  install: string[];
  /** Controls whose route checks `mods.remove`. */
  remove: string[];
  /**
   * Controls that must stay visible for **everyone**, because their route refuses nobody.
   *
   * Export is the only one, and it is listed rather than quietly left out of the two arrays
   * above: `/api/modpacks/[id]/export` calls `denyGame` and no `hasPermission`, so it answers
   * a MEMBER — it hands back download links for the viewer's own launcher, which is the one
   * thing on this page a read-only account is meant to do. Hiding it would remove a working
   * capability under cover of a fix for refused ones, and this entry is what stops a later
   * pass "tidying" it into the gated set.
   */
  always: string[];
}

const SURFACES: Surface[] = [
  {
    file: "modpacks.tsx",
    where: "Modpacks › My Modpacks",
    render: () => void render(<Modpacks />),
    ready: "Big Pack",
    install: ["Create Modpack", "Install to Server"],
    // Edit opens one thing: a list with a Remove beside each mod.
    remove: ["Edit", "Delete"],
    always: ["Export"],
  },
  {
    file: "installed-mods.tsx",
    where: "Installed",
    render: () => void render(<InstalledMods />),
    ready: "Fabric API",
    install: [],
    remove: ["Remove"],
    always: [],
  },
  {
    file: "mod-card.tsx",
    // Rendered through its parent on purpose: `canAddToPack` is a required prop fed from
    // `ModBrowser`'s single `useGames()` (one poll, not one per card), so rendering the card
    // alone would test a boolean this file passed itself. Through the browser, the whole
    // chain — stubbed `can` → parent → prop → button — is under test, and a parent that
    // hardcoded `canAddToPack={true}` turns the MEMBER row below red.
    where: "Browse mods (via mod-browser.tsx)",
    render: () => void render(<ModBrowser />),
    ready: "Sodium",
    install: ["+ Add to Pack"],
    remove: [],
    always: [],
  },
  {
    file: "modpack-browser-modrinth.tsx",
    where: "Modpacks › Modrinth",
    render: () => void render(<ModpackBrowserModrinth onImported={() => {}} />),
    ready: "Fabulously Optimized",
    install: ["Import"],
    remove: [],
    always: [],
  },
];

describe.each(SURFACES)("$where ($file)", (surface) => {
  async function show(can: Partial<GamesState["can"]>) {
    setup(withCan(can));
    surface.render();
    await waitFor(() => expect(screen.queryByText(surface.ready)).not.toBeNull(), WAIT);
  }

  it("offers a MEMBER no control that would answer 403", async () => {
    // The test that would have caught the original power-button report, on this page.
    await show({});
    for (const name of [...surface.install, ...surface.remove]) {
      expect(button(name), `MEMBER must not be offered "${name}"`).toBeNull();
    }
  });

  it("offers a MOD every one of them", async () => {
    /**
     * The complement, and the reason the row above cannot be satisfied by a surface that
     * simply renders no buttons. MOD holds `mods.install` and `mods.remove` — it differs
     * from ADMIN in *scope*, not capability (`permissions.ts`), and the 2026-09-14 change
     * that made power MOD-usable exists because a trusted mod could not act.
     */
    await show(ALL_POWERS);
    for (const name of [...surface.install, ...surface.remove]) {
      expect(button(name), `MOD must be offered "${name}"`).not.toBeNull();
    }
  });

  it("keys the install controls on mods.install alone", async () => {
    // Independence, in one direction. Without this a single `can.modsInstall ||
    // can.modsRemove` passes both rows above while granting either capability both.
    await show({ modsInstall: true });
    for (const name of surface.install) expect(button(name)).not.toBeNull();
    for (const name of surface.remove) expect(button(name)).toBeNull();
  });

  it("keys the remove controls on mods.remove alone", async () => {
    await show({ modsRemove: true });
    for (const name of surface.remove) expect(button(name)).not.toBeNull();
    for (const name of surface.install) expect(button(name)).toBeNull();
  });

  it("leaves the controls its route does not refuse alone", async () => {
    await show({});
    for (const name of surface.always) {
      expect(button(name), `"${name}" is refused to nobody and must stay`).not.toBeNull();
    }
  });
});

// ── the drift guard: a fifth write surface must fail loudly ─────────────────

describe("every component that writes a mod or a modpack is in the table above", () => {
  it("finds no unlisted caller of a mods/modpacks write endpoint", () => {
    /**
     * The incident the power guards were built for was a *forgotten* surface, so the table is
     * checked against the tree rather than trusted. Keyed on the thing that makes a component
     * a write surface — a `fetch` to `/api/mods…` or `/api/modpacks…` with a write method —
     * rather than on whether it mentions `can`, because a new file that forgot the gate
     * entirely is exactly the case that must fail.
     *
     * `mod-browser.tsx` is deliberately absent: it sends no write of its own, it only feeds
     * `canAddToPack`, and the MEMBER row above is what proves what it feeds.
     */
    const dir = path.resolve(__dirname, "../src/components");
    const writers = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => {
        const flat = readFileSync(path.join(dir, f), "utf8").replace(/\s+/g, " ");
        const calls = [
          ...flat.matchAll(
            /fetch\(\s*(`[^`]*`|"[^"]*")\s*,\s*\{[^}]*method:\s*"(?:POST|PUT|PATCH|DELETE)"/g
          ),
        ];
        return calls.some((m) => /\/api\/mods|\/api\/modpacks/.test(m[1]));
      });
    // Sanity-check the pattern before trusting its verdict: one that matched nothing would
    // make this pass by finding no surfaces to miss.
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.sort()).toEqual(SURFACES.map((s) => s.file).sort());
  });
});

// ── the dependency scan says where it is, and cannot be started twice ───────

describe("removing a mod from a pack while the dependency scan runs", () => {
  /**
   * `checkDependentsAndRemove` asks `/api/mods/dependencies` once per *other* mod in the
   * pack, sequentially — 74 requests on a 75-mod pack, roughly 30 s — and there was no
   * feedback of any kind: the button stayed live, nothing moved, and a second click started a
   * second scan over the top of the first.
   *
   * Driven with a dependency endpoint that does not answer until the test lets it, so the
   * in-flight state is observable rather than raced.
   */
  /**
   * A **four**-mod pack, so removing one scans three others and the counter has somewhere to
   * go. With the two-mod fixture the scan is one request, so `0/1` is the only value the
   * button ever shows — and a version that never increments passes every assertion. That
   * mutant was applied and it survived; this fixture is what killed it.
   */
  const PACK4 = {
    ...PACK,
    mods: [
      { id: "m1", modrinthId: "a", slug: "sodium", name: "Sodium", versionId: null },
      { id: "m2", modrinthId: "b", slug: "lithium", name: "Lithium", versionId: null },
      { id: "m3", modrinthId: "c", slug: "iris", name: "Iris", versionId: null },
      { id: "m4", modrinthId: "d", slug: "ferrite", name: "Ferrite Core", versionId: null },
    ],
  };

  it("advances the count as each check lands, and locks every Remove until it is done", async () => {
    // One gate per dependency request, released one at a time, so each step of the counter is
    // a separate observation rather than a race.
    const gates: (() => void)[] = [];
    const next = () => {
      const g = gates.shift();
      if (!g) throw new Error("no pending dependency request to release");
      g();
    };

    stub.games = gamesState(withCan(ALL_POWERS));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/api/mods/dependencies")) {
          await new Promise<void>((r) => gates.push(r));
          return json(200, { dependencies: [] });
        }
        if (init?.method === "DELETE") {
          deletes.push(u);
          return json(200, { success: true });
        }
        if (u === "/api/modpacks") return json(200, [PACK4]);
        if (u === "/api/minecraft-versions") return json(200, { versions: ["26.1.2"] });
        return json(404, { error: `unstubbed ${u}` });
      })
    );

    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const removes = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: "Remove" });
      expect(found).toHaveLength(4);
      return found;
    }, WAIT);
    fireEvent.click(removes[0]);

    // In flight, nothing answered yet: three to check, none checked.
    await waitFor(() => expect(text()).toContain("Checking 0/3"), WAIT);
    // Every Remove is dead, not just the one that started it — a second click used to start a
    // second scan over the top of the first.
    expect(
      screen
        .getAllByRole("button", { name: /Checking|^Remove$/ })
        .every((b) => (b as HTMLButtonElement).disabled)
    ).toBe(true);
    // And the dialog says what the number counts, which a bare "0/3" does not.
    expect(text()).toMatch(/Checking which of the other mods in this pack need this one/);
    // Nothing has been deleted yet: the scan gates the DELETE.
    expect(deletes).toEqual([]);

    next();
    await waitFor(() => expect(text()).toContain("Checking 1/3"), WAIT);
    next();
    await waitFor(() => expect(text()).toContain("Checking 2/3"), WAIT);
    next();

    // Only now does the remove go out, and the scan state clears.
    await waitFor(() => expect(deletes).toHaveLength(1), WAIT);
    await waitFor(() => expect(text()).not.toContain("Checking"), WAIT);
    expect(deletes[0]).toContain("modId=m1");
  });
});

// ── a refused remove says so, and does not pretend it worked ───────────────

describe("a DELETE that the route refuses", () => {
  it("names the reason and leaves the mod in the pack", async () => {
    /**
     * `handleRemoveMod` had no `else` at all — unlike both of its siblings in the same file,
     * which read the body and say what happened — so a 403 or a 500 produced total silence.
     * It is worse than silence in the edit dialog: both callers pruned the row out of their
     * own copy *unconditionally*, so a refused remove made the mod disappear from a list it
     * was still in. That is this codebase's named defect class with the sign flipped —
     * reporting a change that did not happen.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    failDelete = { status: 403, body: { error: "Forbidden" } };

    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const removes = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: "Remove" });
      expect(found).toHaveLength(2);
      return found;
    }, WAIT);
    fireEvent.click(removes[0]);

    // The route's own message, not a generic one — it is the only thing that says why.
    await waitFor(() => expect(toasts).toEqual([{ kind: "error", text: "Forbidden" }]), WAIT);
    // And the row is still there: two mods went in, two are still listed.
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it("drops the row only when the route confirms it", async () => {
    // The complement: without it, "never prune" passes the test above.
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();

    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const removes = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: "Remove" });
      expect(found).toHaveLength(2);
      return found;
    }, WAIT);
    fireEvent.click(removes[0]);

    await waitFor(
      () => expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1),
      WAIT
    );
    expect(toasts).toEqual([]);
  });
});

// ── Download All does not claim an outcome it cannot see ────────────────────

describe("Download All", () => {
  /** Render, open Export with this mod list, and press Download All. */
  async function downloadAll(mods: unknown[]) {
    stub.games = gamesState(withCan(ALL_POWERS));
    exportMods = mods;
    stubFetch();
    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(button("Download All")).not.toBeNull(), WAIT);
    fireEvent.click(button("Download All")!);
    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
  }

  const WITH_URL = (name: string, id: string) => ({
    name,
    slug: name.toLowerCase(),
    modrinthId: id,
    fileName: `${name}.jar`,
    downloadUrl: `https://example.test/${name}.jar`,
    version: "1",
  });

  it("does not say the downloads started", async () => {
    /**
     * It was `toast.success("Starting download of N mods...")`, in green, for a loop that
     * synthesises up to 166 anchor clicks — a claim about what the browser did with them,
     * which this code cannot observe. The replacement states what it asked for and names the
     * per-mod Download links as the recovery, which is the only actionable half.
     */
    await downloadAll([WITH_URL("Sodium", "a"), WITH_URL("Lithium", "b")]);
    expect(toasts[0].kind).toBe("info");
    expect(toasts[0].text).not.toMatch(/Starting download/);
    expect(toasts[0].text).toContain("Requested 2 downloads");
    expect(toasts[0].text).toMatch(/Download link next to any mod that did not arrive/);
  });

  it("says download, singular, for one", async () => {
    await downloadAll([WITH_URL("Sodium", "a")]);
    expect(toasts[0].text).toContain("Requested 1 download.");
  });

  it("still refuses outright when no mod has a download link", async () => {
    // The pre-existing guarantee for the legacy `ModpackMod` rows that carry no
    // `downloadUrl`, re-pinned so the rewrite above cannot have merged the two cases: a
    // refusal must not become "Requested 0 downloads".
    await downloadAll([
      { name: "Sodium", slug: "sodium", modrinthId: "a", fileName: null, downloadUrl: null, version: null },
    ]);
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].text).toMatch(/nothing to download/);
  });
});

// ── the page does not advise destroying the save ───────────────────────────

describe("what the page says about applying a pack", () => {
  it("never tells anyone to delete the world folder", async () => {
    /**
     * Two copies of the same advice — the standing banner and the last paragraph of the
     * confirm dialog — told the operator to **delete the world folder** before switching
     * packs, on a page whose own install takes a world archive first precisely so the save
     * survives. `/api/mods/install-modpack` runs `tar -czf … -C MC_DIR world` before touching
     * a single jar, and refuses to continue if that fails.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);

    expect(text()).not.toMatch(/delete the world/i);
    expect(text()).not.toMatch(/deleting the world/i);

    // The confirm dialog is the other copy, and the one read immediately before the button.
    fireEvent.click(screen.getByRole("button", { name: "Install to Server" }));
    await waitFor(() => expect(screen.queryByText("Confirm Installation")).not.toBeNull(), WAIT);
    expect(text()).not.toMatch(/delete the world/i);
    expect(text()).not.toMatch(/deleting the world/i);
  });

  it("says what the install does to the mods and to the world, in both places", async () => {
    /**
     * The complement: deleting the sentence entirely would pass the test above. What replaces
     * it has to be the two facts that are checkable in the route — every installed jar is
     * removed (`installedMods.forEach(removeMod)`), and the rollback archive's only member is
     * `world`, so the mods folder is not in it.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);

    expect(text()).toMatch(/removes every mod currently\s+installed/);
    expect(text()).toMatch(/not the mods folder/);

    fireEvent.click(screen.getByRole("button", { name: "Install to Server" }));
    await waitFor(() => expect(screen.queryByText("Confirm Installation")).not.toBeNull(), WAIT);
    expect(text()).toMatch(/remove every mod currently installed/);
    expect(text()).toMatch(/not the mods folder/);
  });
});

// ── the page's own subtitle described a control that does not exist ─────────

describe("the mods page heading", () => {
  it("does not promise a one-click install", async () => {
    /**
     * The subtitle read "Search Modrinth, install with one click, and manage what's running."
     * Nothing on this page installs a single mod: `/api/mods/install` exists and has **no
     * caller anywhere in the tree** (measured), and the only thing that writes to the
     * server's mods folder is applying a whole pack — which is six clicks and a confirm
     * dialog, not one. Asserted on the rendered page rather than the string in the file,
     * because the subtitle is a prop and a prop can stop being passed.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    render(<ModsPage />);
    await waitFor(() => expect(screen.queryByText("Mods & modpacks")).not.toBeNull(), WAIT);
    expect(text()).not.toMatch(/one click/i);
    // And the complement, so deleting the subtitle outright does not pass: it still has to
    // say what the page does.
    expect(text()).toContain("Search Modrinth, group mods into packs, and see what is installed.");
  });
});
