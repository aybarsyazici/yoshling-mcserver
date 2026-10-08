import type { MinecraftProfileRequest } from "@/hooks/use-minecraft-profile-request";
// @vitest-environment jsdom
/**
 * **Change pack: the version comparison, shown before anything is applied.**
 *
 * The old route to changing the server's mod set was Modpacks tab → Modrinth sub-tab →
 * Import (which writes a `Modpack` row) → back to My Modpacks → Install to Server →
 * confirm. Six steps, and the one fact that decides whether any of it can work — which
 * Minecraft version the pack is built for — arrived at the *end*, as a 409 in a toast that
 * lives four seconds. COBBLEVERSE publishes only MC 1.21.1 and `Hoplite` only up to
 * 1.21.11, so on this 26.1.2 server that refusal is the **normal** outcome and it was being
 * delivered as a surprise. Production has nine `Modpack` rows for six distinct packs,
 * three of them `(re-imported)` duplicates: that is what a flow where looking and taking
 * are the same act produces.
 *
 * So this file is about three claims, each of which the old flow could not make:
 *
 *  1. the comparison is on screen *before* the button, and the button is refused when the
 *     two sides disagree;
 *  2. reviewing a pack **writes nothing**;
 *  3. a request that gives up is not reported as a failed apply.
 *
 * It is also where `change-pack-dialog.tsx`'s gate is pinned — `tests/mods-surfaces.test.tsx`
 * defers it here (`COVERED_ELSEWHERE`) because its Apply button only exists after a pack has
 * been chosen and a preview has landed, and for a MEMBER the choose control is itself hidden,
 * so a row in that file's uniform table would pass because the flow never started.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_POWERS, NO_POWERS, gamesState, installBrowserStubs } from "./helpers/dom";
import type { GamesState } from "@/lib/use-games";
import type { ProvenanceCounts } from "@/lib/mod-provenance";

const stub = vi.hoisted(() => ({ games: null as unknown }));
vi.mock("@/lib/use-games", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-games")>()),
  useGames: () => stub.games,
}));

/**
 * The former html-react-parser import required this stub on Node 20.12. The dialog
 * now loads in its own security suite; this stub isolates pack changes from the
 * independent description fetch and rendering flow.
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

import { ChangePackDialog } from "@/components/change-pack-dialog";

const activeRequest: MinecraftProfileRequest = { request: (...args) => fetch(...args), contextReady: true, contextError: null, contextToken: "legacy@0" };

beforeAll(installBrowserStubs);
afterEach(() => {
  cleanup();
  toasts.length = 0;
  posts.length = 0;
  gets.length = 0;
  vi.unstubAllGlobals();
});

/** Generous: a render, a 400 ms search debounce, and two stubbed round trips. */
const WAIT = { timeout: 5000 } as const;

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

/** The production reading, measured 2026-10-02: 3 jars, all installed one at a time. */
const COUNTS: ProvenanceCounts = {
  jars: 3,
  fromPack: 0,
  ownInstall: 3,
  unrecorded: 0,
  untracked: 0,
  missing: 0,
};

/** A compatible preview: a 26.1.2 Fabric build on a 26.1.2 Fabric server. */
const MATCHING = {
  modrinthId: REMOTE_PACK.project_id,
  versionId: "vvvv1111",
  versionNumber: "6.6.0",
  needs: { mcVersion: "26.1.2", loader: "fabric" },
  server: { mcVersion: "26.1.2", loader: "fabric" },
  compatibility: { ok: true, mcVersionMatches: true, loaderMatches: true },
  matchedServerVersion: true,
  modCount: 42,
  unpinnedCount: 0,
  publishedMcVersions: ["26.1.2", "26.1.1"],
};

/**
 * COBBLEVERSE's shape: publishes only MC 1.21.1, against a server set to 26.1.2. This is
 * the real refusal on this box, not an invented edge case.
 */
const MISMATCHED = {
  ...MATCHING,
  needs: { mcVersion: "1.21.1", loader: "fabric" },
  compatibility: { ok: false, mcVersionMatches: false, loaderMatches: true },
  matchedServerVersion: false,
  modCount: 168,
  unpinnedCount: 18,
  publishedMcVersions: ["1.21.1"],
};

/** Every GET and every POST the dialog made, so "nothing was written" is checkable. */
const gets: string[] = [];
const posts: string[] = [];

let preview: unknown = MATCHING;
let previewStatus = 200;
/** What `POST /api/mods/install-modpack` answers. `"throw"` models a dead request. */
let applyReply: { status?: number; body: unknown } | "throw" = {
  body: { success: true, installed: 42, total: 42, errors: [], warnings: [], skipped: [] },
};
let importReply: { status?: number; body: unknown } = { body: { id: "pack-9", mods: [] } };

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function setup(over: Partial<GamesState> = {}) {
  stub.games = gamesState({ can: ALL_POWERS, ...over });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posts.push(u);
        if (u === "/api/modpacks/import") {
          return json(importReply.status ?? 200, importReply.body);
        }
        if (u === "/api/mods/install-modpack") {
          if (applyReply === "throw") throw new TypeError("Failed to fetch");
          return json(applyReply.status ?? 200, applyReply.body);
        }
        return json(404, { error: `unstubbed POST ${u}` });
      }
      gets.push(u);
      if (u.startsWith("/api/modpacks/search")) {
        return json(200, {
          hits: [REMOTE_PACK],
          total_hits: 1,
          filter: { mcVersion: "26.1.2", loader: "fabric" },
        });
      }
      if (u.startsWith("/api/modpacks/preview")) return json(previewStatus, preview);
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(name: string | RegExp): HTMLButtonElement | null {
  return screen.queryByRole("button", { name }) as HTMLButtonElement | null;
}

function open(over: Partial<GamesState> = {}, counts: ProvenanceCounts = COUNTS) {
  setup(over);
  render(
    <ChangePackDialog request={activeRequest}
      open
      onOpenChange={() => {}}
      counts={counts}
      onApplied={() => {}}
    />
  );
}

/** Render, find the pack, choose it, and wait for its preview to land. */
async function review(over: Partial<GamesState> = {}, counts: ProvenanceCounts = COUNTS) {
  open(over, counts);
  await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Choose this pack" }));
  await waitFor(() => expect(text()).toMatch(/This pack needs/), WAIT);
}

/** The comparison block's own verdict tone, so it is read off the element not the prose. */
function comparisonTone(): string | null {
  return document.querySelector("[data-comparison]")?.getAttribute("data-comparison") ?? null;
}

afterEach(() => {
  preview = MATCHING;
  previewStatus = 200;
  applyReply = {
    body: { success: true, installed: 42, total: 42, errors: [], warnings: [], skipped: [] },
  };
  importReply = { body: { id: "pack-9", mods: [] } };
});

// ── the comparison, before the button ──────────────────────────────────────

describe("the version comparison is on screen before anything is applied", () => {
  it("states what the pack needs beside what the server runs", async () => {
    await review();
    expect(text()).toMatch(/This pack needs/);
    expect(text()).toMatch(/Minecraft 26\.1\.2 · fabric/);
    expect(text()).toMatch(/The server runs/);
    expect(text()).toMatch(/These match, so this pack can be applied/);
    expect(comparisonTone()).toBe("ok");
  });

  it("refuses the apply when the pack is for another Minecraft version", async () => {
    /**
     * The whole point. Before this, the only way to learn COBBLEVERSE cannot run here was
     * to import it (another `Modpack` row) and press Install to Server, which answered a
     * 409 in a toast.
     */
    preview = MISMATCHED;
    await review();
    expect(comparisonTone()).toBe("bad");
    expect(text()).toMatch(/cannot be applied/);
    expect(text()).toMatch(/built for Minecraft 1\.21\.1/);
    expect(text()).toMatch(/the server is set to 26\.1\.2/);
    // The versions it *does* publish, because "it needs 1.21.1" invites "then which build
    // should I pick" and often the answer is "there is none for this server".
    expect(text()).toMatch(/publishes builds for 1\.21\.1/);

    const apply = button("Apply this pack");
    expect(apply).not.toBeNull();
    expect(apply!.disabled).toBe(true);
  });

  it("sends no write while a pack is being reviewed", async () => {
    // Reviewing writes nothing — not a `Modpack` row, not an `Activity` row. Looking at a
    // pack and taking one used to be the same act, which is how six packs became nine rows.
    preview = MISMATCHED;
    await review();
    expect(posts).toEqual([]);
    expect(gets.some((u) => u.startsWith("/api/modpacks/preview"))).toBe(true);
  });

  it("declines to compare at all when the server has no version recorded", async () => {
    /**
     * A fresh install with no `ServerConfig` row. "Not reported" is its own answer: an
     * absent reading rendered as a disagreement is the mistake every settings surface in
     * this app is built to avoid — and rendering it as agreement would be worse.
     */
    preview = { ...MATCHING, server: null, compatibility: null };
    await review();
    expect(comparisonTone()).toBe("muted");
    expect(text()).toMatch(/no version recorded yet, so there is nothing to compare/);
    expect(text()).not.toMatch(/These match/);
    expect(button("Apply this pack")!.disabled).toBe(true);
  });

  it("allows the apply when the two sides agree", async () => {
    // The complement: "always disabled" would pass both refusal tests above.
    await review();
    expect(button("Apply this pack")!.disabled).toBe(false);
  });
});

// ── the accent reaches into the portal ─────────────────────────────────────

describe("the world's accent", () => {
  it("is defined on the dialog itself, not inherited", async () => {
    /**
     * **A dialog renders through a portal into `document.body`**, and `--tint` is only ever
     * set by an inline style on a page wrapper (`grep '"--tint"' src`) — so inside a dialog
     * it is undefined, and `color-mix(in oklab, var(--tint) …)` with an undefined custom
     * property is an invalid value that CSS drops the whole declaration for.
     *
     * That was already live before this page was rebuilt: the apply report's skipped-mods
     * block carried `border-[var(--tint)]/30` with a comment explaining that the colour was
     * the claim, and it had been bordered in nothing since the accent was added. Asserted
     * on the element, because nothing else can notice a colour that silently does not
     * apply.
     */
    open();
    await waitFor(
      () => expect(document.querySelector("[data-slot='dialog-content']")).not.toBeNull(),
      WAIT
    );
    const content = document.querySelector("[data-slot='dialog-content']") as HTMLElement;
    expect(content.style.getPropertyValue("--tint")).toBe("var(--mc)");
  });
});

// ── what the review says about the pack and about the server ───────────────

describe("the review states what is knowable and declines what is not", () => {
  it("names the resolved build and the mod count", async () => {
    await review();
    expect(text()).toContain("6.6.0");
    expect(text()).toContain("42 mods");
  });

  it("says when the build is not for this server's version", async () => {
    // Explains a version the user did not pick: the resolver falls back to the newest build
    // when the server's version has no release, which is how a re-import "repair" produced
    // a pack pinned to 26.3 on a 26.1.2 server.
    preview = MISMATCHED;
    await review();
    expect(text()).toMatch(/newest build; it has none for this server/);
  });

  it("says how much of the pack carries no pinned version", async () => {
    // 566 of 569 production `ModpackMod` rows are unpinned, so an apply installs the newest
    // matching build rather than what the author shipped. Stated, not silently true.
    preview = MISMATCHED;
    await review();
    expect(text()).toMatch(/18 of its 168 mods carry no pinned version/);
  });

  it("does not claim a client-only count it has not measured", async () => {
    /**
     * A large pack is 30-50% client mods, and the only way to know how many is to read every
     * mod's Modrinth build — which is what the apply itself does, over up to 166 sequential
     * requests. A number here would be either that work done in a dialog or an invention.
     */
    await review();
    expect(text()).toMatch(/decided during the apply/);
    expect(text()).not.toMatch(/\d+ client-only/);
  });

  it("counts what the apply would remove, including the mods added by hand", async () => {
    // "This will remove every mod currently installed" is true and says nothing about
    // whether that is three jars or eighty-one, or how many somebody put there by hand.
    await review();
    expect(text()).toMatch(/The 3 jars this dashboard installed/);
    expect(text()).toMatch(/including the 3 mods added one at a time/);
    expect(text()).toMatch(/are removed first/);
  });

  /**
   * **The apply deletes rows, not the directory.** It loops `InstalledMod` and calls
   * `removeMod` per row, so a jar with no row is left exactly where it is. The copy said
   * "All N jars in the mods folder are removed first" over a count that *includes* the
   * untracked ones, promising a clean-out it does not perform — and then the pack boots
   * alongside the survivors with nothing having said so.
   *
   * The default fixture has `untracked: 0`, which is why the assertion above could not tell
   * the two versions apart.
   */
  it("does not promise to remove jars it has no row for", async () => {
    await review({}, { ...COUNTS, jars: 5, untracked: 2, ownInstall: 3 });
    // Three, not five.
    expect(text()).toMatch(/The 3 jars this dashboard installed/);
    expect(text()).not.toMatch(/All 5 jars/);
    // And the two survivors are named as such, since they will load alongside the pack.
    expect(text()).toMatch(/2 jars it has no record of/);
    expect(text()).toMatch(/stay where they are/);
  });

  it("says that applying also saves the pack", async () => {
    // It does: `/api/mods/install-modpack` takes a `modpackId`, so applying a Modrinth pack
    // is genuinely import-then-apply. Nine production rows is what not saying it looks like.
    await review();
    expect(text()).toMatch(/also saves this pack under Saved sets/);
  });
});

// ── the gate ───────────────────────────────────────────────────────────────

describe("a MEMBER", () => {
  /**
   * **A mutation survived the first version of this block, and the fix was in the
   * component.**
   *
   * `Choose this pack` was gated on `can.modsInstall` too, so removing the gate from
   * `Apply this pack` changed nothing a test could see: the MEMBER case never reached the
   * step Apply is on, and the assertion passed because the flow never started. A vacuous
   * pass on a gate is worse than no test, because it reads as coverage.
   *
   * Choosing is a **read** — it fetches `GET /api/modpacks/preview`, which deliberately
   * answers a MEMBER — so it is ungated now and the Apply gate is observable. The control
   * that keeps a read-only account out of this dialog altogether is `Change pack` on the
   * page, pinned in `tests/mods-surfaces.test.tsx`.
   */
  it("can review a pack and is offered no apply", async () => {
    await review({ can: NO_POWERS });
    expect(text()).toMatch(/This pack needs/);
    expect(button("Apply this pack")).toBeNull();
  });

  it("is told why, rather than shown a dead control", async () => {
    // "A MEMBER pressed Power on and got an unexplained Forbidden" is how the original
    // capability projection was reported. A review that simply ends is the same shape.
    await review({ can: NO_POWERS });
    expect(text()).toMatch(/can look at packs but not change what is installed/);
  });

  it("is offered no Import either, because that one writes", async () => {
    // `POST /api/modpacks/import` checks `mods.install`. The two controls in this component
    // are gated differently on purpose, so both directions are pinned.
    open({ can: NO_POWERS });
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    expect(button("Import")).toBeNull();
    expect(button("Choose this pack")).not.toBeNull();
  });

  it("still sees the pack list, which is a read", async () => {
    open({ can: NO_POWERS });
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    expect(text()).toContain("Fabulously Optimized");
  });
});

describe("a MOD at the review", () => {
  it("is offered the apply, and no explanation of why not", async () => {
    // The complement of the MEMBER rows: without it, hiding Apply from everybody passes
    // all of them.
    await review();
    expect(button("Apply this pack")).not.toBeNull();
    expect(text()).not.toMatch(/can look at packs but not change/);
  });
});

// ── the apply ──────────────────────────────────────────────────────────────

describe("applying", () => {
  it("imports and then applies, in that order", async () => {
    await review();
    fireEvent.click(button("Apply this pack")!);
    await waitFor(() => expect(posts).toHaveLength(2), WAIT);
    expect(posts).toEqual(["/api/modpacks/import", "/api/mods/install-modpack"]);
  });

  it("does not apply when the import fails, and says nothing was changed", async () => {
    // The import is the first write. If it never landed there is nothing to roll back, and
    // that is the fact which decides whether to retry.
    importReply = { status: 500, body: { error: "Modrinth timed out" } };
    await review();
    fireEvent.click(button("Apply this pack")!);
    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0]).toEqual({ kind: "error", text: "Modrinth timed out" });
    expect(posts).toEqual(["/api/modpacks/import"]);
  });

  it("opens the report when mods were held back", async () => {
    applyReply = {
      body: {
        success: true,
        installed: 2,
        total: 2,
        errors: [],
        warnings: [],
        skipped: [{ name: "Sodium", reason: "client-only — this build declares `client_only`" }],
      },
    };
    await review();
    fireEvent.click(button("Apply this pack")!);
    await waitFor(() => expect(text()).toContain("Installed 2 of 2 mods"), WAIT);
    expect(text()).toContain("1 client-only mod skipped");
    expect(text()).toContain("Sodium");
  });

  it("reports a request that gave up as still running, with no counts", async () => {
    /**
     * **The bug this closes.** Up to 166 sequential Modrinth fetches runs far past
     * Cloudflare's ~100 s origin timeout, so a *successful* large apply ends with the
     * browser's `fetch` rejecting. `modpacks.tsx` substituted `{installed: 0, total: 0}`
     * there and the report dialog rendered a **destructive-red "Installed 0 of 0 mods"** —
     * a failure headline for an apply that was succeeding at that moment, on exactly the
     * runs long enough to reach it.
     */
    applyReply = "throw";
    await review();
    fireEvent.click(button("Apply this pack")!);
    await waitFor(() => expect(text()).toMatch(/Install result unconfirmed/), WAIT);
    expect(text()).toContain("Install result unconfirmed · Fabulously Optimized");
    expect(text()).not.toMatch(/Installed 0 of 0 mods/);
    expect(text()).not.toMatch(/Installed \d+ of \d+ mods/);
    // And it says what to do, which is the actionable half: the work is still going.
    expect(text()).toMatch(/may still be running on the server/);
    expect(text()).toMatch(/don’t start it again|don't start it again/);
  });
});

// ── what the sheet does to the page behind it ───────────────────────────────

describe("after an apply", () => {
  it("closes, and tells the page to re-read rather than what landed", async () => {
    /**
     * The list behind this is a **reading** of the mods directory. It must not be handed
     * the apply's own counts: an apply that installed 142 of 166 leaves 24 rows the
     * reconcile will report as `missing`, and an install that landed inside the apply's
     * window shows up as `untracked`. Both are exactly what the page exists to show, and
     * both are invisible if the dialog says what happened instead of the page looking.
     */
    const applied = vi.fn();
    const openChanges: boolean[] = [];
    setup();
    render(
      <ChangePackDialog request={activeRequest}
        open
        onOpenChange={(v) => openChanges.push(v)}
        counts={COUNTS}
        onApplied={applied}
      />
    );
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Choose this pack" }));
    await waitFor(() => expect(text()).toMatch(/This pack needs/), WAIT);
    fireEvent.click(button("Apply this pack")!);

    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1), WAIT);
    expect(openChanges).toContain(false);
  });

  it("does not re-read when the apply was never requested", async () => {
    // The complement: calling `onApplied` unconditionally would pass the row above and
    // make every refused apply look like something changed.
    importReply = { status: 403, body: { error: "Forbidden" } };
    const applied = vi.fn();
    setup();
    render(
      <ChangePackDialog request={activeRequest} open onOpenChange={() => {}} counts={COUNTS} onApplied={applied} />
    );
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Choose this pack" }));
    await waitFor(() => expect(text()).toMatch(/This pack needs/), WAIT);
    fireEvent.click(button("Apply this pack")!);

    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("reopening the sheet", () => {
  /** A controlled wrapper, so the sheet can be closed and opened again. */
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>reopen</button>
        <ChangePackDialog request={activeRequest}
          open={open}
          onOpenChange={setOpen}
          counts={COUNTS}
          onApplied={() => {}}
        />
      </>
    );
  }

  it("starts at the search rather than at the last review", async () => {
    // Otherwise reopening lands on step two of the previous visit, showing a comparison for
    // a pack somebody has since changed their mind about — and the Apply beside it still
    // works.
    setup();
    render(<Harness />);
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Choose this pack" }));
    await waitFor(() => expect(text()).toMatch(/This pack needs/), WAIT);

    fireEvent.click(button("Cancel")!);
    await waitFor(() => expect(text()).not.toMatch(/This pack needs/), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));

    await waitFor(() => expect(button("Choose this pack")).not.toBeNull(), WAIT);
    expect(text()).not.toMatch(/This pack needs/);
    expect(button("Apply this pack")).toBeNull();
  });
});

// ── the preview's own failures ──────────────────────────────────────────────

describe("a pack whose preview cannot be read", () => {
  it("shows the route's reason and says nothing was changed", async () => {
    previewStatus = 404;
    preview = { error: "Modrinth lists no versions for this modpack, so there is nothing to apply." };
    open();
    await waitFor(() => expect(screen.queryByText(REMOTE_PACK.title)).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Choose this pack" }));
    await waitFor(() => expect(text()).toMatch(/Modrinth lists no versions/), WAIT);
    expect(text()).toMatch(/Nothing has been changed on the server/);
    // No Apply at all: there is nothing to apply, so offering it would be a broken button.
    expect(button("Apply this pack")).toBeNull();
    expect(posts).toEqual([]);
  });
});
