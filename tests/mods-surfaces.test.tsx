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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * The former html-react-parser import required a stub on Node 20.12. Description
 * rendering now has its own real-component security suite. This stub keeps these
 * permission/control tests focused, while retaining the card's click-through surface.
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

import { MC_ARCHIVE_MEMBERS } from "@/lib/mc-archive";
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
  fetched.length = 0;
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

/**
 * `/api/mods/installed` answers a **reconcile**, not a row list — one entry per row and
 * per jar, with the three groups named. This file only varies capabilities, so the
 * clean all-agree shape is what it stubs; the reconcile itself is pinned by
 * `src/lib/__tests__/mod-inventory.test.ts` and its drift rendering by
 * `tests/installed-mods-reconcile.test.tsx`.
 */
const INSTALLED = {
  /**
   * `pack` and `server` ride along in the same response, which is what lets the page's
   * header and its list be two readers of one reading. `null` here is production's state
   * today: three mods, each installed on its own, no pack ever applied from the dashboard.
   */
  pack: null,
  server: { mcVersion: "26.1.2", loader: "fabric" },
  mods: [
    {
      id: "im1",
      modrinthId: "P7dR8mSH",
      slug: "fabric-api",
      name: "Fabric API",
      version: "0.100.0",
      fileName: "fabric-api-0.100.0.jar",
      mcVersion: "26.1.2",
      loader: "fabric",
      source: "manual",
      versionId: "vvvv1111",
      installedBy: "u1",
      installedByName: "Tester",
      installedAt: "2026-10-01T00:00:00Z",
      state: "matched",
      sizeBytes: 2048,
      sha512: null,
    },
  ],
  matched: ["fabric-api-0.100.0.jar"],
  untracked: [],
  missing: [],
  ignored: [],
  modsDirPresent: true,
  hashed: false,
  totalBytes: 2048,
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
/** Every URL the page asked for, so "that surface was not mounted" is checkable. */
const fetched: string[] = [];
/** Set by the one test that needs a DELETE to be refused. */
let failDelete: { status: number; body: unknown } | null = null;
/** What `GET /api/modpacks` answers. Varied by the saved-set legibility tests. */
let packs: unknown[] = [PACK];
/** What the export endpoint answers with, for the Download All tests. */
let exportMods: unknown[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "X-Minecraft-Context": "legacy@0" } });
}

function stubFetch() {
  failDelete = null;
  packs = [PACK];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      fetched.push(u);
      if (init?.method === "DELETE") {
        deletes.push(u);
        return failDelete ? json(failDelete.status, failDelete.body) : json(200, { success: true });
      }
      if (u === "/api/minecraft/active-profile") return json(200, {});
      if (u === "/api/minecraft/profiles") return json(200, { profiles: [], runtime: { selectedProfileId: null, appliedProfileId: null, verified: false, state: "legacy", revision: "legacy@0" }, requiresAdoption: true, capabilities: { read: true, manage: false, start: false, switch: false } });
      if (u === "/api/modpacks") return json(200, packs);
      if (u === "/api/minecraft-versions") return json(200, { versions: ["26.1.2"] });
      if (u.startsWith("/api/mods/installed")) return json(200, INSTALLED);
      if (u === "/api/mods/categories") return json(200, []);
      if (u.startsWith("/api/mods/search")) return json(200, { hits: [PROJECT], total_hits: 1 });
      if (u.startsWith("/api/modpacks/search"))
        return json(200, { hits: [REMOTE_PACK], total_hits: 1 });
      if (u.startsWith("/api/mods/dependencies")) return json(200, { dependencies: [] });
      if (u.endsWith("/export"))
        return json(200, {
          modpack: { name: "Big Pack", description: "", mcVersion: "26.1.2", loader: "fabric" },
          mods: exportMods,
          complete: exportMods.every((m) => typeof (m as { downloadUrl?: unknown }).downloadUrl === "string"),
          unresolved: exportMods.filter((m) => !(m as { downloadUrl?: unknown }).downloadUrl).map((m) => ({ name: (m as { name: string }).name, reason: "No compatible download" })),
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
    install: ["Create a set", "Install to Server"],
    // Edit opens one thing: a list with a Remove beside each mod.
    remove: ["Edit", "Delete"],
    always: ["Export"],
  },
  {
    file: "installed-mods.tsx",
    where: "the installed list (the page's spine)",
    render: () => void render(<InstalledMods />),
    ready: "Fabric API",
    /**
     * **Both of these moved here**, and the test moved with them rather than being deleted.
     *
     * `Add a mod` was the "Browse mods" tab and `Change pack` was two clicks inside the
     * "Modpacks" tab's Modrinth sub-tab. Searching Modrinth is an action, not a place, so
     * both are now buttons on this surface — and both open a dialog whose writes check
     * `mods.install` (`POST /api/mods/install` and `POST /api/mods/install-modpack` +
     * `/api/modpacks/import`). A MEMBER shown either gets a dialog it cannot use.
     */
    install: ["Add a mod", "Change pack"],
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
    // Both install-capability controls on a search card. The label changed from
    // "+ Add to Pack" to "Add to pack" in the same batch (CLAUDE.md's copy rule), and
    // "Install" is the new primary action — which the increment that added it left ungated,
    // so it is pinned here from both directions.
    install: ["Add to pack", "Install"],
    remove: [],
    always: [],
  },
  {
    file: "modpack-browser-modrinth.tsx",
    where: "Saved sets › Import a pack from Modrinth",
    render: () => void render(<ModpackBrowserModrinth onImported={() => {}} />),
    ready: "Fabulously Optimized",
    // Default mode. The same `can.modsInstall` gates the `Choose this pack` label this
    // component shows when the Change pack sheet passes `onChoose` — one boolean, two
    // labels — and that mode is pinned in `tests/change-pack-dialog.test.tsx`, which is
    // where the stepped flow behind it is driven.
    install: ["Import"],
    remove: [],
    always: [],
  },
];

/**
 * Write surfaces whose gate is pinned in **another** file, because reaching their control
 * takes more than a render.
 *
 * The drift guard below checks this list against the tree too, so a forgotten surface still
 * fails loudly — what this buys is that a stepped flow does not have to be squeezed into the
 * uniform `describe.each` above and asserted vacuously. `change-pack-dialog.tsx`'s Apply
 * button only exists after a pack has been chosen and its preview has landed, and for a
 * MEMBER the choose control is itself hidden — so a MEMBER row here would pass because the
 * flow never started, which is not the same claim as "the gate works".
 *
 * `by` is asserted to exist, so "covered elsewhere" is checkable rather than declared.
 */
const COVERED_ELSEWHERE: { file: string; by: string }[] = [
  { file: "change-pack-dialog.tsx", by: "tests/change-pack-dialog.test.tsx" },
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
  /**
   * The incident the power guards were built for was a *forgotten* surface, so the table is
   * checked against the tree rather than trusted. Keyed on the thing that makes a component
   * a write surface rather than on whether it mentions `can`, because a new file that forgot
   * the gate entirely is exactly the case that must fail.
   *
   * **Two ways to be a writer, and the second one was added with the shared applier.** A
   * literal `fetch("/api/mods…", {method: "POST"})` is the obvious one. But the modpack
   * apply now lives in `src/lib/modpack-apply.ts` — it has two callers and the reasoning in
   * it is subtle enough that two copies would drift — so a component can write without a
   * `fetch` of its own anywhere in it. Matching only the literal would have let a new
   * surface call `applyModpackToServer` with no gate and no row in this table, which is
   * precisely the hole this guard exists to close, in a new shape.
   *
   * `mod-browser.tsx` is deliberately absent: it sends no write of its own, it only feeds
   * `canAddToPack`/`canInstall` to the cards, and the MEMBER row above is what proves what
   * it feeds. `add-mod-dialog.tsx` is absent for the same reason — it mounts `ModBrowser`
   * and writes nothing itself.
   */
  function writeSurfaces(): string[] {
    const dir = path.resolve(__dirname, "../src/components");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => {
        const flat = readFileSync(path.join(dir, f), "utf8").replace(/\s+/g, " ");
        const calls = [
          ...flat.matchAll(
            /(?:fetch|request|activeRequest)\(\s*(`[^`]*`|"[^"]*")\s*,\s*\{[^}]*method:\s*"(?:POST|PUT|PATCH|DELETE)"/g
          ),
        ];
        if (calls.some((m) => /\/api\/mods|\/api\/modpacks/.test(m[1]))) return true;
        // The shared applier. `ApplyReportDialog` imports only the *type* from it, which
        // this deliberately does not match — rendering a report is not writing.
        return /import\s*\{[^}]*\b(?:applyModpackToServer|importAndApply)\b[^}]*\}\s*from\s*"@\/lib\/modpack-apply"/.test(
          flat
        );
      });
  }

  it("finds no unlisted caller of a mods/modpacks write endpoint", () => {
    const writers = writeSurfaces();
    // Sanity-check the pattern before trusting its verdict: one that matched nothing would
    // make this pass by finding no surfaces to miss.
    expect(writers.length).toBeGreaterThan(0);
    const known = [...SURFACES.map((s) => s.file), ...COVERED_ELSEWHERE.map((c) => c.file)];
    expect(writers.sort()).toEqual(known.sort());
  });

  it("catches a writer that goes through the shared applier rather than fetch", () => {
    /**
     * The complement, and it is what stops the second predicate being dead code: with only
     * the `fetch` pattern, `change-pack-dialog.tsx` — which applies packs and nothing else
     * — is invisible to this guard. Asserted on the real file so that moving its write back
     * to an inline `fetch`, or the applier being renamed, both still leave it detected.
     */
    const flat = readFileSync(
      path.resolve(__dirname, "../src/components/change-pack-dialog.tsx"),
      "utf8"
    ).replace(/\s+/g, " ");
    expect(flat).not.toMatch(/(?:fetch|request|activeRequest)\([^)]*,\s*\{[^}]*method:\s*"POST"/);
    expect(writeSurfaces()).toContain("change-pack-dialog.tsx");
  });

  it("names a real test file for every surface it defers", () => {
    // "Covered elsewhere" has to be checkable, or it becomes the way to silence this guard.
    for (const { file, by } of COVERED_ELSEWHERE) {
      expect(
        existsSync(path.resolve(__dirname, "..", by)),
        `${file} claims to be covered by ${by}, which does not exist`
      ).toBe(true);
    }
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
    const bulk = button("Download All") as HTMLButtonElement;
    if (mods.some((m) => !(m as { downloadUrl?: unknown }).downloadUrl)) { expect(bulk.disabled).toBe(true); fireEvent.click(bulk); return; }
    fireEvent.click(bulk);
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
    expect(toasts).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Sodium: No compatible download");
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
     * it has to be the facts that are checkable in the route — every installed jar is removed
     * (`installedMods.forEach(removeMod)`), and the rollback archive is taken first.
     *
     * **This test used to pin `/not the mods folder/`, and that claim went stale within the
     * week.** It was true on 2026-09-30: the pre-apply archive was `tar -czf … -C MC_DIR
     * world`. On 2026-10-02 `install-modpack` started tarring
     * `archiveMembersPresent(MC_DIR)` — `world` **and** `mods` — and
     * `restoreMinecraftArchive` renames both back (`src/lib/mc-archive.ts`,
     * `MC_ARCHIVE_MEMBERS = ["world", "mods"]`). So the page was understating its own safety
     * net, telling an operator their jars are not recoverable when they are, immediately
     * before the button that deletes every one of them — and this assertion was holding that
     * wrong sentence in place.
     *
     * Updated rather than dropped, and pinned against the module that decides it: the two
     * members are read out of `MC_ARCHIVE_MEMBERS` so a future change to what an archive
     * holds reddens this instead of quietly making the copy wrong again.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);

    expect(MC_ARCHIVE_MEMBERS).toEqual(["world", "mods"]);
    expect(text()).toMatch(/removes every mod currently\s+installed/);
    expect(text()).toMatch(/archives the world\s+folder and the mods directory first/);
    expect(text()).toMatch(/restoring that archive\s+puts both back/);
    // And the stale claim is gone, in both places.
    expect(text()).not.toMatch(/not the mods folder/);

    fireEvent.click(screen.getByRole("button", { name: "Install to Server" }));
    await waitFor(() => expect(screen.queryByText("Confirm Installation")).not.toBeNull(), WAIT);
    expect(text()).toMatch(/remove every mod currently installed/);
    expect(text()).toMatch(/archives the world folder and the\s+mods directory first/);
    expect(text()).not.toMatch(/not the mods folder/);
  });
});

// ── the page's own subtitle described a control that does not exist ─────────

describe("the mods page heading", () => {
  it("does not promise a one-click install", async () => {
    /**
     * The subtitle read "Search Modrinth, install with one click, and manage what's running."
     * At the time nothing on this page installed a single mod: `/api/mods/install` existed
     * with **no caller anywhere in the tree** (measured), and the only thing that wrote to
     * the server's mods folder was applying a whole pack — six clicks and a confirm dialog,
     * not one.
     *
     * The route has a caller since 2026-10-02 (the Install button on each search result),
     * so the subtitle names installing again — but still not as "one click", because an
     * install can open a client-only confirm dialog and the claim was never about the
     * number. Asserted on the rendered page rather than the string in the file, because the
     * subtitle is a prop and a prop can stop being passed.
     *
     * The heading is **"Mods"**, not "Mods & modpacks": the page is one surface now and the
     * saved sets are a section inside it, so an ampersand in the title would be naming the
     * old tab split.
     */
    stub.games = gamesState(withCan(ALL_POWERS));
    stubFetch();
    render(<ModsPage />);
    await waitFor(
      () => expect(screen.queryByRole("heading", { level: 1, name: "Mods" })).not.toBeNull(),
      WAIT
    );
    expect(text()).not.toMatch(/one click/i);
    // And the complement, so deleting the subtitle outright does not pass: it still has to
    // say what the page does.
    expect(text()).toContain(
      "Search Modrinth, install a mod or a whole pack, and see what is on the server."
    );
  });
});

// ── the page is one surface, not three tabs ────────────────────────────────

describe("the shape of /minecraft/mods", () => {
  async function page(can: Partial<GamesState["can"]> = ALL_POWERS) {
    setup(withCan(can));
    render(<ModsPage />);
    await waitFor(
      () => expect(screen.queryByRole("heading", { level: 1, name: "Mods" })).not.toBeNull(),
      WAIT
    );
  }

  it("has no tabs, and opens on what is on the server", async () => {
    /**
     * It was **Browse mods / Installed / Modpacks**, with the last holding two sub-tabs.
     * Two of the three were inert until 2026-10-02 — you could not install from Browse and
     * could not add from Installed — and all the power sat in a nested sub-tab, with the
     * install instructions living in the *collection's* empty state. The page opens on the
     * reading of the mods directory now, and the searches are actions.
     */
    await page();
    await waitFor(() => expect(screen.queryByText("Fabric API")).not.toBeNull(), WAIT);
    for (const tab of ["Browse mods", "Installed", "Modpacks", "My Modpacks", "Modrinth"]) {
      expect(button(tab), `"${tab}" should no longer be a tab`).toBeNull();
    }
    expect(button("Add a mod")).not.toBeNull();
    expect(button("Change pack")).not.toBeNull();
  });

  it("keeps a home for the saved sets, below", async () => {
    // Nine production rows including three duplicates and one named `a` — not deleted and
    // not hidden, just no longer the page's spine.
    await page();
    expect(screen.queryByRole("heading", { level: 2, name: "Saved sets" })).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
  });

  it("does not mount the Modrinth pack search until it is asked for", async () => {
    /**
     * It owns a debounced `/api/modpacks/search` loop and a capability poll, and the
     * primary route to a Modrinth pack is the Change pack sheet at the top — so running a
     * second search on page load for a surface described as secondary is work nobody asked
     * for. Checked on the request, not on the markup: a mounted-but-hidden component still
     * polls.
     */
    await page();
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
    expect(fetched.filter((u) => u.startsWith("/api/modpacks/search"))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Import a pack from Modrinth" }));
    await waitFor(
      () => expect(fetched.some((u) => u.startsWith("/api/modpacks/search"))).toBe(true),
      WAIT
    );
  });

  it("keeps the photo footer with its caption", async () => {
    // CLAUDE.md: the MC mods page keeps this one. Pinned so a redesign does not quietly
    // drop it, and so nobody adds one to the PZ pages to "fix the inconsistency".
    await page();
    expect(text()).toContain("approves of your mod list");
  });
});

// ── the saved sets are made legible rather than tidied away ────────────────

describe("what a saved set says about itself", () => {
  const pack = (over: Record<string, unknown>) => ({ ...PACK, ...over });

  async function show(rows: unknown[]) {
    setup(withCan(ALL_POWERS));
    packs = rows;
    render(<Modpacks />);
    await waitFor(() => expect(screen.queryByText("Big Pack")).not.toBeNull(), WAIT);
  }

  it("says when no mod in the set records a version", async () => {
    /**
     * **566 of 569 production `ModpackMod` rows carry no `versionId`.** That is not
     * cosmetic: with no pin, applying a set installs each mod's *newest* matching build
     * rather than the one the pack shipped, so two applies of the same set a month apart
     * put different jars on the server. Pinning them is a later increment; saying so stops
     * "apply the pack" reading as reproducible when it is not.
     */
    await show([PACK]);
    expect(text()).toContain("No mod in this set records a version");
    expect(text()).toMatch(/installs the newest matching build/);
  });

  it("counts the unpinned ones when only some are", async () => {
    await show([
      pack({
        mods: [
          { id: "m1", modrinthId: "a", slug: "sodium", name: "Sodium", versionId: "v1" },
          { id: "m2", modrinthId: "b", slug: "lithium", name: "Lithium", versionId: null },
        ],
      }),
    ]);
    expect(text()).toContain("1 of 2 mods record no version");
  });

  it("says nothing about pins when every mod has one", async () => {
    // The complement: an unconditional note would make a fully pinned set read as a
    // problem, which is the "absent reading shown as a disagreement" trap in reverse.
    await show([
      pack({
        mods: [{ id: "m1", modrinthId: "a", slug: "sodium", name: "Sodium", versionId: "v1" }],
      }),
    ]);
    expect(text()).not.toMatch(/record no version/);
    expect(text()).not.toMatch(/No mod in this set records a version/);
  });

  it("says when the set records no target Minecraft version", async () => {
    // Production has a set named `a` with four mods and no target version, and the card
    // said nothing about it — so the one fact that decides what Apply would do was absent
    // exactly where it was missing. The apply falls back to `ServerConfig`, so this is not
    // broken; it was unstated.
    await show([pack({ targetMcVersion: null })]);
    expect(text()).toContain("no version recorded");
  });

  it("names the version when the set records one", async () => {
    await show([pack({ targetMcVersion: "26.1.2" })]);
    expect(text()).toContain("MC 26.1.2");
    expect(text()).not.toContain("no version recorded");
  });
});

/**
 * **Before the first `/api/games/status` reply, nothing writable may be on screen.**
 *
 * `useGames` has to guess until the route answers, and the two mods flags guess `false`
 * deliberately — they guard writes that delete a pack or replace every jar on the server, so a
 * control that is live for a moment and then dead is the defect rather than the cure.
 * Settings and privileged file navigation also start false after F28. They require
 * privileged reads, so the former guess of true offered links that only refused.
 *
 * This is here because flipping the initial values to `true` left all 1190 tests green: every
 * surface test above sets `can` directly, so none of them ever observes the pre-fetch state. A
 * MEMBER would have been shown all six write controls for the length of one round trip — the
 * exact defect this file exists to prevent, in the window nothing was looking at.
 */
describe("the state before the capability check returns", () => {
  it("waits for a successful capability read before offering writes or privileged settings", () => {
    // `readFileSync` + `path`, which this file already imports for the drift guard above.
    const source = readFileSync(
      path.join(__dirname, "..", "src", "lib", "use-games.ts"),
      "utf-8"
    );
    const init = source.slice(source.indexOf("useState({"), source.indexOf("});", source.indexOf("useState({")));
    // Pinned on the exact initialiser, not on the file containing the strings somewhere:
    // `modsInstall: false` appears in the type and in the merge too.
    expect(init).toMatch(/modsInstall:\s*false/);
    expect(init).toMatch(/modsRemove:\s*false/);
    expect(init).toMatch(/settings:\s*false/);
    expect(init).toMatch(/start:\s*false/);
  });
});
