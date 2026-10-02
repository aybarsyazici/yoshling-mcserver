// @vitest-environment jsdom
/**
 * **The Installed tab, rendered against a reconcile that disagrees with itself.**
 *
 * `tests/mods-surfaces.test.tsx` renders this component too, but only to check which
 * *controls* a role is offered, and it stubs the clean all-agree case. This file is about
 * the thing the endpoint was changed for: when the database and the mods folder differ,
 * does the page **say so, and name the files**.
 *
 * Named, specifically. The failure mode a counts-only summary has is that it is not
 * actionable: "2 untracked jars" sends somebody to the file browser to guess which two,
 * and the only reason to take the reading at all is to be told. So every assertion here is
 * on the file name appearing on screen, not on a number.
 *
 * `src/lib/__tests__/mod-inventory.test.ts` pins the reconcile itself over real files and
 * `mods-installed-route.test.ts` pins the route; neither can tell whether the answer is
 * rendered.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_POWERS, NO_POWERS, gamesState, installBrowserStubs } from "./helpers/dom";
import type { GamesState } from "@/lib/use-games";
import type { AppliedPack } from "@/lib/modpack-applied";
import type { InstalledReading, InventoryEntry } from "@/lib/mod-inventory";

const stub = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-games")>()),
  useGames: () => stub.games,
}));

/**
 * The surface mounts the two Modrinth searches as dialogs. Both reach `ModDetailDialog`,
 * which pulls in `html-react-parser` → the ESM-only `domhandler`, so on this project's
 * Node 20.12 collecting the file dies with `ERR_REQUIRE_ESM` before a test runs. Stubbed
 * for the same reason as in `tests/mods-surfaces.test.tsx`; it carries no write control.
 */
vi.mock("@/components/mod-detail-dialog", () => ({
  ModDetailDialog: ({ open }: { open: boolean }) => (open ? <div>mod detail</div> : null),
}));

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

beforeAll(installBrowserStubs);
afterEach(() => {
  cleanup();
  toasts.length = 0;
  fetches.length = 0;
  deletes.length = 0;
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 } as const;

/** The three jars on production, measured 2026-10-02. */
const FABRIC = "fabric-api-0.149.1+26.1.2.jar";
const MINIMAP = "xaerominimap-fabric-26.1.2-25.3.14.jar";
const WORLDMAP = "xaeroworldmap-fabric-26.1.2-1.40.18.jar";

/** Every URL the component asked for, so `?hash=1` and the re-read are checkable. */
const fetches: string[] = [];
const deletes: string[] = [];
/** What the next `GET /api/mods/installed` answers. Replaced per test. */
let inventory: InstalledReading;
/** Answers for a second read, when a test needs the page to change underneath itself. */
let nextInventory: InstalledReading | null = null;

function entry(over: Partial<InventoryEntry> & { fileName: string }): InventoryEntry {
  return {
    id: `row-${over.fileName}`,
    name: "Fabric API",
    version: "0.149.1+26.1.2",
    mcVersion: "26.1.2",
    loader: "fabric",
    modrinthId: "P7dR8mSH",
    slug: "fabric-api",
    source: "manual",
    versionId: null,
    installedBy: "u1",
    installedByName: "Aybars",
    installedAt: "2026-10-01T00:00:00.000Z",
    state: "matched",
    sizeBytes: 2_097_152,
    sha512: null,
    ...over,
  };
}

/** A reconcile built from its entries, the way the route derives the groups from them. */
function inv(mods: InventoryEntry[], over: Partial<InstalledReading> = {}): InstalledReading {
  const named = (state: InventoryEntry["state"]) =>
    mods.filter((m) => m.state === state).map((m) => m.fileName);
  return {
    mods,
    matched: named("matched"),
    untracked: named("untracked"),
    missing: named("missing"),
    ignored: [],
    modsDirPresent: true,
    hashed: mods.some((m) => m.sha512 != null),
    totalBytes: mods.reduce((n, m) => n + (m.sizeBytes ?? 0), 0),
    // Production's state today: no pack has ever been applied from the dashboard, and the
    // server is configured for 26.1.2 Fabric.
    pack: null,
    server: { mcVersion: "26.1.2", loader: "fabric" },
    ...over,
  };
}

/** A recorded `apply_modpack`, as `/api/mods/installed` projects it. */
function applied(over: Partial<AppliedPack> = {}): AppliedPack {
  return {
    packId: "pack-1",
    name: "Vanilla Perfected",
    appliedAt: "2026-09-30T10:00:00.000Z",
    appliedByName: "Aybars",
    installed: 2,
    total: 2,
    mcVersion: "26.1.2",
    loader: "fabric",
    ...over,
  };
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function setup(over: Partial<GamesState> = {}) {
  stub.games = gamesState({ can: ALL_POWERS, ...over });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "DELETE") {
        deletes.push(u);
        return json(200, { success: true });
      }
      fetches.push(u);
      if (u.startsWith("/api/mods/installed")) {
        const reads = fetches.filter((f) => f.startsWith("/api/mods/installed")).length;
        const answer = reads > 1 && nextInventory ? nextInventory : inventory;
        return json(200, answer);
      }
      // What the Add-a-mod dialog's search needs. Stubbed so that *whether it was asked
      // for* is a fact this file can read — the dialog must not run a debounced Modrinth
      // search behind a page nobody has opened it on.
      if (u === "/api/mods/categories") return json(200, []);
      if (u === "/api/modpacks") return json(200, []);
      if (u.startsWith("/api/mods/search")) {
        return json(200, { hits: [], total_hits: 0, filter: { mcVersion: "26.1.2", loader: "fabric" } });
      }
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

/** How many times the page has read the mods directory. */
function reads(): number {
  return fetches.filter((f) => f.startsWith("/api/mods/installed")).length;
}

function text(): string {
  return document.body.textContent ?? "";
}

/**
 * The text inside one drift band, and **this scoping is load-bearing**.
 *
 * A mutant that replaced every band's file-name chips with `"2 file(s)"` passed the entire
 * suite, because each row prints its own `fileName` a few pixels below and
 * `document.body.textContent` cannot tell the two apart. "The band names the file" has to
 * be asserted against the band.
 */
function band(kind: string): string | null {
  const el = document.querySelector(`[data-band="${kind}"]`);
  return el ? (el.textContent ?? "") : null;
}

/**
 * The text inside one provenance group, and the scoping is load-bearing for the same
 * reason as `band()`.
 *
 * The provenance claim is carried by the **grouping** rather than by a badge on every row —
 * "which of these did the pack put there and which did we add ourselves" is the question
 * `InstalledMod.source` finally answers, and four identical-looking pills would bury it. So
 * the assertion has to be "this mod is inside the From-a-pack section", which
 * `document.body.textContent` cannot express: a heading and a row a few pixels below it are
 * the same string to it. `data-group` is what makes a section findable. **If you add a
 * group, give it a `kind`.**
 */
function group(kind: string): string | null {
  const el = document.querySelector(`[data-group="${kind}"]`);
  return el ? (el.textContent ?? "") : null;
}

/** The pack strip at the top of the page: server state, not a library item. */
function packHeader(): string | null {
  const el = document.querySelector("[data-pack-header]");
  return el ? (el.textContent ?? "") : null;
}

function button(name: string | RegExp): HTMLButtonElement | null {
  return screen.queryByRole("button", { name }) as HTMLButtonElement | null;
}

afterEach(() => {
  nextInventory = null;
});

describe("a jar on disk that no row claims", () => {
  it("is reported and named", async () => {
    inventory = inv([
      entry({ fileName: FABRIC }),
      entry({
        fileName: "nobody-installed-me.jar",
        id: null,
        name: "nobody-installed-me.jar",
        state: "untracked",
        version: null,
        mcVersion: null,
        loader: null,
        source: null,
        installedBy: null,
        installedByName: null,
        installedAt: null,
      }),
    ]);
    setup();
    render(<InstalledMods />);

    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    // The name, **inside the band** — the whole point of the band. Asserted on
    // `band()` rather than on the page, because the row below prints the same string.
    expect(band("untracked")).toContain("nobody-installed-me.jar");
    // and only the one that drifted: the matched jar is not named as a problem.
    expect(band("untracked")).not.toContain(FABRIC);
    expect(text()).toMatch(/not in this list/i);
    // And the verdict line stops claiming the two sides agree.
    expect(text()).toMatch(/disagree/i);
    expect(text()).not.toMatch(/nothing else is there/i);
  });

  it("offers no Remove for it, because there is no row to delete", async () => {
    inventory = inv([
      entry({
        fileName: "nobody-installed-me.jar",
        id: null,
        name: "nobody-installed-me.jar",
        state: "untracked",
      }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("nobody-installed-me.jar"), WAIT);
    expect(button(/^Remove$/)).toBeNull();
    // Named recovery instead of a dead control.
    expect(text()).toMatch(/file browser/i);
  });
});

describe("a row whose jar is gone", () => {
  it("is reported and named, by mod name and by file name", async () => {
    inventory = inv([
      entry({ fileName: FABRIC }),
      entry({
        fileName: MINIMAP,
        name: "Xaero's Minimap",
        state: "missing",
        sizeBytes: null,
      }),
    ]);
    setup();
    render(<InstalledMods />);

    await waitFor(() => expect(text()).toContain("Xaero's Minimap"), WAIT);
    expect(band("missing")).toContain(MINIMAP);
    expect(band("missing")).not.toContain(FABRIC);
    expect(text()).toMatch(/no jar on disk/i);
    expect(text()).toMatch(/will not load/i);
  });

  it("labels its button as clearing the record, not removing a file", async () => {
    inventory = inv([entry({ fileName: MINIMAP, state: "missing", sizeBytes: null })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain(MINIMAP), WAIT);
    expect(button(/Clear entry/)).not.toBeNull();
  });

  it("stops the verdict line claiming the two sides agree", async () => {
    // Pinned from *this* direction as well as the untracked one. A verdict that only
    // consults `untracked` passes every other test in this file and then tells somebody
    // whose mod will not load that everything on the list has its jar on disk.
    inventory = inv([entry({ fileName: MINIMAP, state: "missing", sizeBytes: null })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain(MINIMAP), WAIT);
    expect(text()).not.toMatch(/nothing else is there/i);
    expect(text()).toMatch(/disagree/i);
    expect(text()).toMatch(/1 missing jar/);
  });
});

describe("the all-agree case", () => {
  it("says the two sides agree and raises no band", async () => {
    inventory = inv([
      entry({ fileName: FABRIC }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap" }),
      entry({ fileName: WORLDMAP, name: "Xaero's World Map" }),
    ]);
    setup();
    render(<InstalledMods />);

    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(text()).toMatch(/nothing else is there/i);
    // The complement of every band above: with nothing wrong, none of them render. Without
    // this, "always show the untracked band" passes every other test in this file.
    expect(band("untracked")).toBeNull();
    expect(band("missing")).toBeNull();
    expect(band("twins")).toBeNull();
    expect(band("no-dir")).toBeNull();
    expect(band("ignored")).toBeNull();
    expect(text()).not.toMatch(/not in this list/i);
    expect(text()).not.toMatch(/no jar on disk/i);
    expect(text()).not.toMatch(/disagree/i);
    expect(text()).toContain("3 jars in the mods folder");
  });

  it("shows all three rows as mods, each in its provenance group", async () => {
    /**
     * **Provenance, per row, asserted inside the group that makes the claim.**
     *
     * This used to check that the page text contained the three chip labels — "Pack",
     * "Installed on its own", "source not recorded" — which is satisfied by a page that
     * renders all three strings somewhere and attaches them to the wrong rows. The claim
     * that matters is *which* mod is in which group, and that is only expressible against
     * the group element.
     */
    inventory = inv([
      entry({ fileName: FABRIC, source: "manual" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", source: "pack" }),
      entry({ fileName: WORLDMAP, name: "Xaero's World Map", source: null }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Xaero's World Map"), WAIT);

    expect(group("pack")).toContain("Xaero's Minimap");
    expect(group("pack")).not.toContain("Fabric API");
    expect(group("manual")).toContain("Fabric API");
    expect(group("manual")).not.toContain("Xaero's Minimap");
    // A row written before the column existed is in neither, and is not labelled as either.
    expect(group("unrecorded")).toContain("Xaero's World Map");
    expect(group("unrecorded")).not.toContain("Fabric API");

    // The headings say what each group means, so the distinction is readable without
    // knowing the data model.
    expect(group("pack")).toMatch(/From a pack/);
    expect(group("manual")).toMatch(/Added one at a time/);
    expect(group("unrecorded")).toMatch(/No record of how these arrived/);
  });

  it("raises no group for a provenance nothing has", async () => {
    // The complement: rendering all five headings unconditionally passes every assertion
    // above, and tells somebody with three hand-installed mods that a pack put some there.
    inventory = inv([entry({ fileName: FABRIC, source: "manual" })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(group("manual")).toContain("Fabric API");
    expect(group("pack")).toBeNull();
    expect(group("unrecorded")).toBeNull();
    expect(group("missing")).toBeNull();
    expect(group("untracked")).toBeNull();
  });

  it("counts where the jars came from in one sentence", async () => {
    // The measured split, which nothing in this app could state before `source` existed:
    // after an apply, the only record of the difference was in whoever had been watching.
    inventory = inv([
      entry({ fileName: FABRIC, source: "manual" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", source: "pack" }),
      entry({ fileName: WORLDMAP, name: "Xaero's World Map", source: "pack" }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(text()).toMatch(/3 jars in the mods folder/);
    expect(text()).toMatch(/2 from a pack/);
    expect(text()).toMatch(/1 added one at a time/);
  });

  it("names who added it and when", async () => {
    inventory = inv([entry({ fileName: FABRIC, installedByName: "Aybars" })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(text()).toContain("Added by Aybars");
    // Day/month order is the runner's locale, so the assertion is on the parts, not the
    // arrangement — `toLocaleDateString` gives `1 Oct 2026` here and `Oct 1, 2026` in a
    // `en-US` environment, and pinning either would make this file fail on a laptop.
    expect(text()).toMatch(/Oct/);
    expect(text()).toMatch(/2026/);
  });

  it("says nothing about who when the name did not resolve", async () => {
    inventory = inv([entry({ fileName: FABRIC, installedByName: null, installedBy: "u-gone" })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(text()).not.toContain("u-gone");
    expect(text()).not.toMatch(/Added by/);
  });
});

describe("problems come first", () => {
  it("puts the drifted rows above the clean ones however they arrived", async () => {
    inventory = inv([
      entry({ fileName: FABRIC, name: "Fabric API" }),
      entry({ fileName: "stranger.jar", id: null, name: "stranger.jar", state: "untracked" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", state: "missing", sizeBytes: null }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);

    const states = [...document.querySelectorAll("li[data-state]")].map((n) =>
      n.getAttribute("data-state")
    );
    expect(states).toEqual(["missing", "untracked", "matched"]);
  });
});

describe("an empty server", () => {
  it("says there is no mods folder rather than treating it as a fault", async () => {
    inventory = inv([], { modsDirPresent: false });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toMatch(/no mods folder/i), WAIT);
    expect(text()).toMatch(/Nothing is wrong/i);
    expect(text()).toContain("No mods installed");
    // Not a drift band: nothing is missing and nothing is untracked.
    expect(band("missing")).toBeNull();
    expect(band("untracked")).toBeNull();
  });

  /**
   * **"Nothing is wrong" was printed unconditionally**, so with rows in the database and no
   * directory the page said it directly underneath a `missing` band reading "The server will
   * not load it". Every row is missing in that state — the folder they name is not there — so
   * the reassurance is exactly backwards. Reassurance has to be conditional on there being
   * nothing to reassure about.
   */
  it("does not reassure when rows are expecting the folder that is absent", async () => {
    inventory = inv([entry({ fileName: MINIMAP, state: "missing", sizeBytes: null })], {
      modsDirPresent: false,
    });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toMatch(/no mods folder/i), WAIT);

    expect(text()).not.toMatch(/Nothing is wrong/i);
    // And it says why, rather than only withholding the reassurance.
    expect(text()).toMatch(/1 mod on this list expects it/i);
    expect(band("missing")).not.toBeNull();
  });
});

describe("what is in the folder but is not a mod", () => {
  it("names those files too, and does not call them untracked mods", async () => {
    inventory = inv([entry({ fileName: FABRIC })], {
      ignored: [".DS_Store", "turned-off.jar.disabled"],
    });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(band("ignored")).toContain(".DS_Store");
    expect(band("ignored")).toContain("turned-off.jar.disabled");
    expect(band("untracked")).toBeNull();
    // and the agreement line still holds: a `.DS_Store` is not a disagreement.
    expect(text()).toMatch(/nothing else is there/i);
  });
});

describe("hashing is something the page asks for", () => {
  it("does not ask on load, and asks when the button is pressed", async () => {
    inventory = inv([entry({ fileName: FABRIC })]);
    nextInventory = inv([entry({ fileName: FABRIC, sha512: "a".repeat(128) })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(fetches).toEqual(["/api/mods/installed"]);

    fireEvent.click(button(/Hash the jars/)!);
    await waitFor(() => expect(fetches).toContain("/api/mods/installed?hash=1"), WAIT);
    await waitFor(() => expect(text()).toContain("sha512 aaaaaaaaaaaaaaaa"), WAIT);
  });

  it("names the two files when the same bytes are on disk twice", async () => {
    // What a digest can prove with no published reference: the two writers name files
    // differently, so one mod can land twice — and Fabric loading a mod twice is a crash.
    const same = "b".repeat(128);
    inventory = inv([
      entry({ fileName: FABRIC, sha512: same }),
      entry({ fileName: "fabric-api.jar", id: null, name: "fabric-api.jar", state: "untracked", sha512: same }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toMatch(/same bytes/i), WAIT);
    expect(band("twins")).toContain(FABRIC);
    expect(band("twins")).toContain("fabric-api.jar");
  });

  it("raises nothing when every digest is different", async () => {
    inventory = inv([
      entry({ fileName: FABRIC, sha512: "c".repeat(128) }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", sha512: "d".repeat(128) }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(text()).not.toMatch(/same bytes/i);
  });
});

describe("no row is busy until one is being removed", () => {
  /**
   * **A mutation survived the first version of this**, and the fix was to make the state
   * visible rather than to add an assertion.
   *
   * `removing` is `null` when nothing is being removed, and an untracked entry's `id` is
   * also `null` — so a bare `removing === mod.id` is `true` for **every** untracked row.
   * The expression is guarded with `mod.id != null &&`, but with the only consequence being
   * a label inside a button that is *itself* gated on `mod.id`, dropping the guard changed
   * nothing any test could see. A guard nothing can observe is a comment, not a guard. The
   * row carries `data-busy` now, so it is pinned.
   */
  it("leaves an untracked row not busy", async () => {
    inventory = inv([
      entry({ fileName: FABRIC }),
      entry({
        fileName: "stranger.jar",
        id: null,
        name: "stranger.jar",
        state: "untracked",
      }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("stranger.jar"), WAIT);
    const rows = [...document.querySelectorAll("li[data-state]")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("data-busy"))).toEqual([null, null]);
  });

  it("marks exactly the row whose remove is in flight", async () => {
    // The complement: `data-busy={undefined}` always would pass the row above. Driven with
    // a DELETE that does not answer until the test lets it, so the in-flight state is
    // observable rather than raced.
    inventory = inv([
      entry({ fileName: FABRIC, name: "Fabric API" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap" }),
    ]);
    stub.games = gamesState({ can: ALL_POWERS });
    // A gate the test releases, so "this row is busy" is a separate observation rather
    // than a race against a resolved promise. An array rather than a `let`, because a
    // closure assignment is invisible to TypeScript's narrowing and `release?.()` then
    // reads as a call on `never`.
    const gates: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === "DELETE") {
          deletes.push(u);
          await new Promise<void>((r) => gates.push(r));
          return json(200, { success: true });
        }
        fetches.push(u);
        return json(200, inventory);
      })
    );

    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    await waitFor(() => {
      const busy = [...document.querySelectorAll("li[data-busy='true']")];
      expect(busy).toHaveLength(1);
      expect(busy[0].textContent).toContain("Fabric API");
    }, WAIT);
    // And only that row: the other one must not read as busy because `removing` is set.
    expect(document.querySelectorAll("li[data-busy='true']")).toHaveLength(1);
    gates.shift()?.();
  });
});

// ── Add a mod is an action, not a place ────────────────────────────────────

describe("the mod search", () => {
  it("does not run until Add a mod is pressed", async () => {
    /**
     * It was the page's **first and default tab** — "Browse mods" — and until 2026-10-02 it
     * could not install anything, so the page opened on a debounced Modrinth search whose
     * only outcome was adding a mod to a list. Searching is an action now, so the request
     * only happens when somebody asks for one.
     */
    inventory = inv([entry({ fileName: FABRIC })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(fetches.filter((u) => u.startsWith("/api/mods/search"))).toEqual([]);

    fireEvent.click(button("Add a mod")!);
    await waitFor(
      () => expect(fetches.some((u) => u.startsWith("/api/mods/search"))).toBe(true),
      WAIT
    );
  });

  it("re-reads the directory when the dialog closes", async () => {
    /**
     * An install happens inside the dialog and the list outside is a **reading** of the
     * directory — it must not be told what landed, it has to look. Same argument as the
     * per-row remove, which re-reads rather than splicing: an install whose row was created
     * and whose write failed shows up as `missing`, and assuming would hide exactly that.
     */
    inventory = inv([entry({ fileName: FABRIC })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(reads()).toBe(1);

    fireEvent.click(button("Add a mod")!);
    await waitFor(
      () => expect(document.querySelector("[data-slot='dialog-content']")).not.toBeNull(),
      WAIT
    );
    // The dialog's own close control — its accessible name comes from the `sr-only` span.
    // Scoped by role rather than by text because the page behind the dialog still carries
    // the words "Add a mod" on the button that opened it, and `queryByText` throws on two
    // matches rather than returning either.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(reads()).toBe(2), WAIT);
  });
});

describe("a remove re-reads the directory instead of assuming", () => {
  it("re-reconciles after a successful delete", async () => {
    // A `removeMod` whose `unlink` hit ENOENT deletes the row and leaves the jar, which the
    // next reconcile reports as untracked. Splicing the row out of local state would hide
    // exactly that — on the page whose job is not to assume the two sides agree.
    inventory = inv([entry({ fileName: FABRIC })]);
    nextInventory = inv([
      entry({ fileName: FABRIC, id: null, name: FABRIC, state: "untracked" }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);

    fireEvent.click(button(/^Remove$/)!);
    await waitFor(() => expect(deletes).toEqual([`/api/mods/row-${FABRIC}`]), WAIT);
    await waitFor(() => expect(fetches).toHaveLength(2), WAIT);
    await waitFor(() => expect(text()).toMatch(/not in this list/i), WAIT);
  });
});

// ── the pack, as a header ───────────────────────────────────────────────────

describe("the pack strip states server state, not a library item", () => {
  it("names the pack a recorded apply names, with when and by whom", async () => {
    inventory = inv([entry({ fileName: FABRIC, source: "pack" })], { pack: applied() });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(packHeader()).toContain("Vanilla Perfected"), WAIT);
    expect(packHeader()).toMatch(/Applied/);
    expect(packHeader()).toMatch(/by Aybars/);
    // The counts the apply itself reported, which are a different claim from the counts on
    // disk — and the only place a shortfall survives once the ledger record has aged out.
    expect(packHeader()).toMatch(/2 of 2 mods installed/);
  });

  it("says no pack has been applied rather than naming one", async () => {
    // Production's state today: three mods, each installed on its own.
    inventory = inv([entry({ fileName: FABRIC, source: "manual" })]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(packHeader()).toContain("No pack applied");
    expect(packHeader()).toMatch(/added on its own, not by a pack/);
  });

  it("reports pack jars with no recorded apply as exactly that", async () => {
    /**
     * The third state, and the one worth keeping: jars put there by an apply that predates
     * the record. "No pack" would be false and a pack name would be invented, so it says
     * what is known — some jars came from an apply, and nothing here knows which pack.
     */
    inventory = inv([
      entry({ fileName: FABRIC, source: "pack" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", source: "pack" }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    expect(packHeader()).toContain("A pack was applied, but not from here");
    expect(packHeader()).toMatch(/2 jars on this server/);
    expect(packHeader()).toMatch(/no record of which pack or when/);
    expect(packHeader()).not.toContain("No pack applied");
  });

  it("reports a pack built for a Minecraft version the server no longer runs", async () => {
    /**
     * Real drift and previously invisible: the version dropdown can be changed after a pack
     * is applied and the jars do not move with it.
     */
    inventory = inv([entry({ fileName: FABRIC, source: "pack" })], {
      pack: applied({ mcVersion: "1.21.1" }),
      server: { mcVersion: "26.1.2", loader: "fabric" },
    });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(packHeader()).toContain("Vanilla Perfected"), WAIT);
    expect(packHeader()).toMatch(/applied for Minecraft 1\.21\.1/);
    expect(packHeader()).toMatch(/the server is set to 26\.1\.2/);
  });

  it("says nothing about versions when the two agree", async () => {
    // The complement: an always-rendered note would make every healthy server read as
    // drifted — the "absent reading shown as a disagreement" trap, in reverse.
    inventory = inv([entry({ fileName: FABRIC, source: "pack" })], { pack: applied() });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(packHeader()).toContain("Vanilla Perfected"), WAIT);
    expect(packHeader()).not.toMatch(/applied for Minecraft/);
  });

  it("says nothing about versions when the server records none", async () => {
    inventory = inv([entry({ fileName: FABRIC, source: "pack" })], {
      pack: applied({ mcVersion: "1.21.1" }),
      server: null,
    });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(packHeader()).toContain("Vanilla Perfected"), WAIT);
    expect(packHeader()).not.toMatch(/applied for Minecraft/);
  });

  it("offers no Remove pack, because nothing removes a set as one operation", async () => {
    /**
     * Deliberately absent, and pinned so it does not get added by reflex. N client-side
     * DELETEs would be a bulk destructive action with no rollback archive, no operation
     * record and a partial-failure state this page could not report — this project's named
     * defect class. Per-row Remove is the way out; Change pack replaces the set.
     */
    inventory = inv([entry({ fileName: FABRIC, source: "pack" })], { pack: applied() });
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(packHeader()).toContain("Vanilla Perfected"), WAIT);
    expect(button(/Remove pack/i)).toBeNull();
    expect(button("Change pack")).not.toBeNull();
  });
});

describe("a MEMBER", () => {
  it("sees the reconcile and no destructive control", async () => {
    inventory = inv([
      entry({ fileName: FABRIC }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", state: "missing", sizeBytes: null }),
    ]);
    setup({ can: NO_POWERS });
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Fabric API"), WAIT);
    // The reading is a read: a read-only account is told the truth about the server.
    expect(band("missing")).toContain(MINIMAP);
    expect(button(/^Remove$/)).toBeNull();
    expect(button(/Clear entry/)).toBeNull();
    // and the read-only controls stay.
    expect(button(/Re-check/)).not.toBeNull();
  });
});
