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
import type { InventoryEntry, ModInventory } from "@/lib/mod-inventory";

const stub = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-games")>()),
  useGames: () => stub.games,
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
let inventory: ModInventory;
/** Answers for a second read, when a test needs the page to change underneath itself. */
let nextInventory: ModInventory | null = null;

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
function inv(mods: InventoryEntry[], over: Partial<ModInventory> = {}): ModInventory {
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
        const answer = fetches.length > 1 && nextInventory ? nextInventory : inventory;
        return json(200, answer);
      }
      return json(404, { error: `unstubbed ${u}` });
    })
  );
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

  it("shows all three rows as mods, with their provenance", async () => {
    inventory = inv([
      entry({ fileName: FABRIC, source: "manual" }),
      entry({ fileName: MINIMAP, name: "Xaero's Minimap", source: "pack" }),
      entry({ fileName: WORLDMAP, name: "Xaero's World Map", source: null }),
    ]);
    setup();
    render(<InstalledMods />);
    await waitFor(() => expect(text()).toContain("Xaero's World Map"), WAIT);
    expect(text()).toContain("Installed on its own");
    expect(text()).toContain("Pack");
    // A row written before the column existed is not labelled as either.
    expect(text()).toContain("source not recorded");
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
