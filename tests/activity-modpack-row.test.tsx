// @vitest-environment jsdom
/**
 * **The `apply_modpack` row, rendered.**
 *
 * `/api/mods/install-modpack` wrote no `Activity` row of its own until 2026-10-02 — its 166
 * `installMod` calls each wrote `install_mod`, so the durable log recorded every leaf and
 * not the act. Writing the row is only half of it: **both** `formatAction` implementations
 * in this app end in a `default` that renders an unhandled action as bare underscored
 * words, and that fallback has already produced three documented defects —
 * `backup_restore` as "backup restore", `backup_failed` as something that parses as the
 * *user* having failed, and `set_gamerule` as "set gamerule". So a new action that nobody
 * teaches the renderers appears as "apply modpack", on the row class that records the most
 * destructive thing the dashboard does.
 *
 * Asserted through the rendered DOM rather than by calling `formatAction`, which is not
 * exported: an assertion on a helper cannot fail when a component stops reading it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { installBrowserStubs } from "./helpers/dom";

import ActivityPage from "@/app/activity/page";

beforeAll(installBrowserStubs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 } as const;

function stubActivity(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => rows }) as Response)
  );
}

function row(details: Record<string, unknown>, action = "apply_modpack") {
  return {
    id: "a1",
    action,
    details: JSON.stringify(details),
    createdAt: "2026-10-02T09:30:00.000Z",
    user: { username: "Aybars", avatar: null },
  };
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("the shared activity log", () => {
  it("names the pack and the counts", async () => {
    stubActivity([
      row({
        game: "minecraft",
        packId: "pack-1",
        packName: "Vanilla Perfected",
        installed: 78,
        total: 81,
        mcVersion: "26.1.2",
        loader: "fabric",
      }),
    ]);
    render(<ActivityPage />);
    await waitFor(() => expect(screen.queryByText("Aybars")).not.toBeNull(), WAIT);

    expect(text()).toContain("applied the modpack Vanilla Perfected");
    // `installed` short of `total` is the durable record of a partial apply — the first
    // thing somebody debugging a world that no longer boots wants.
    expect(text()).toContain("(78 of 81 mods installed)");
    expect(text()).toContain("Minecraft");
    // And not the `default` fallback's bare underscored key.
    expect(text()).not.toMatch(/apply modpack/);
  });

  it("states the pack without counts when the row carried none", async () => {
    // `0 of 0` reads as a failed apply, so an absent count has to stay absent.
    stubActivity([row({ game: "minecraft", packName: "Old Pack" })]);
    render(<ActivityPage />);
    await waitFor(() => expect(screen.queryByText("Aybars")).not.toBeNull(), WAIT);
    expect(text()).toContain("applied the modpack Old Pack");
    expect(text()).not.toMatch(/0 of 0/);
    expect(text()).not.toMatch(/mods installed/);
  });

  it("gives it the mods glyph tinted for its world, not the neutral fallback", async () => {
    // `actionVisual` keys on `action.includes("mod")`, which `apply_modpack` satisfies —
    // checked rather than assumed, because a row with the neutral grey glyph reads as
    // something the log does not understand.
    stubActivity([row({ game: "minecraft", packName: "Vanilla Perfected" })]);
    render(<ActivityPage />);
    await waitFor(() => expect(screen.queryByText("Aybars")).not.toBeNull(), WAIT);
    const marks = [...document.querySelectorAll("li span[style]")].map((n) =>
      n.getAttribute("style")
    );
    expect(marks.some((s) => s?.includes("--mc"))).toBe(true);
  });
});

describe("the per-world recent-activity card", () => {
  it("has a label for the action, so the fallback cannot render the bare key", () => {
    /**
     * **A source-level check, and deliberately labelled as one.** `game-overview.tsx`'s
     * `formatAction` is a private map inside a component that renders charts, a console and
     * three power controls, and mounting the whole thing to read one string is a worse
     * trade than reading the map. The failure this guards is an *omission*, which a
     * source-level assertion does catch: with no entry the `default` renders "apply
     * modpack", exactly as it did for `backup_restore` and `backup_failed`.
     *
     * Pinned on the map entry rather than on the file mentioning the word, because the
     * action string also appears in nothing else there.
     */
    const source = readFileSync(
      path.join(__dirname, "..", "src", "components", "game-overview.tsx"),
      "utf-8"
    );
    expect(source).toMatch(/apply_modpack:\s*"applied a modpack"/);
  });
});
