import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyModpackToServer,
  applyOutcomeOf,
  importAndApply,
} from "@/lib/modpack-apply";

/**
 * **What the apply's response means — the one copy.**
 *
 * Two surfaces apply packs now: **Change pack** at the top of `/minecraft/mods` and
 * **Install to Server** on a saved set. The reasoning below is subtle enough that two
 * copies of it would drift, and this repo's standing example is the power control, which
 * reached three copies and two of them missed a fix.
 *
 * Each `describe` is a defect this has actually had:
 *
 * - `res.ok` as the verdict reported *"Installed 0/166 mods"* in a **green** toast for every
 *   pack whose rows carry no download source.
 * - A body with no counts opened the report as "Installed undefined of undefined mods".
 * - A request that gave up was rendered as a **destructive-red "Installed 0 of 0 mods"** —
 *   a failure headline for an apply that was succeeding at that moment, on exactly the runs
 *   long enough (up to 166 sequential Modrinth fetches, past a ~100 s origin timeout) to
 *   reach it.
 */

const CLEAN = { success: true, installed: 2, total: 2, errors: [], warnings: [], skipped: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyOutcomeOf", () => {
  it("stays quiet when every mod that belonged on the server is installed", () => {
    /**
     * Deliberately silent: the operation's own completion toast already carries the
     * sentence, derived server-side from the recorded count, and a dialog on every success
     * is how a report teaches people to dismiss it unread.
     */
    expect(applyOutcomeOf("Big Pack", CLEAN)).toEqual({ kind: "quiet" });
  });

  it("reports a shortfall", () => {
    const outcome = applyOutcomeOf("Big Pack", {
      installed: 1,
      total: 2,
      errors: ["Gone: no compatible version"],
      warnings: [],
      skipped: [],
      error: "Only 1 of 2 mods were installed.",
    });
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") throw new Error("unreachable");
    expect(outcome.report.installed).toBe(1);
    expect(outcome.report.total).toBe(2);
    expect(outcome.report.errors).toEqual(["Gone: no compatible version"]);
    expect(outcome.report.error).toBe("Only 1 of 2 mods were installed.");
    expect(outcome.report.packName).toBe("Big Pack");
  });

  it("reports an apply whose only news is the skips", () => {
    /**
     * `installed === total`, no errors, no warnings, HTTP 200 — everything went right and
     * 40 mods were left out. Without the `skipped.length` disjunct the one outcome the
     * client-only filter exists to report is the one outcome that reports nothing, and the
     * route's own tests stay green because its response is unchanged.
     */
    const outcome = applyOutcomeOf("Big Pack", {
      ...CLEAN,
      skipped: Array.from({ length: 40 }, (_, i) => ({
        name: `Client Mod ${i + 1}`,
        reason: "client-only",
      })),
    });
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") throw new Error("unreachable");
    expect(outcome.report.skipped).toHaveLength(40);
  });

  it("reports a warning on an otherwise clean apply", () => {
    const outcome = applyOutcomeOf("Big Pack", {
      ...CLEAN,
      warnings: ["2 of 45 mods in this pack have no download source"],
    });
    expect(outcome.kind).toBe("report");
  });

  it("refuses a body that is not an apply report, keeping the route's own message", () => {
    // A 403, or a 500 raised outside the operation. The message is the route's because it
    // is the only thing that says why; a friendlier local copy would drop that.
    expect(applyOutcomeOf("Big Pack", { error: "Forbidden" })).toEqual({
      kind: "error",
      message: "Forbidden",
    });
  });

  it("falls back to a stated sentence when even the error is missing", () => {
    expect(applyOutcomeOf("Big Pack", {})).toEqual({
      kind: "error",
      message: "Failed to install modpack",
    });
    expect(applyOutcomeOf("Big Pack", null).kind).toBe("error");
  });

  it("reads the 409 refusals, which carry counts and the sentence together", () => {
    /**
     * The all-client-only refusal answers `installed: 0, total: 0` **plus** the named
     * skips, which is enough for the shape check to open the report — and the headline
     * sentence saying why nothing happened travels in `error`.
     */
    const outcome = applyOutcomeOf("Client Pack", {
      installed: 0,
      total: 0,
      errors: [],
      warnings: [],
      skipped: [{ name: "Sodium", reason: "client-only" }],
      error: "All 2 mods are client-only, so there is nothing to install on a server.",
    });
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") throw new Error("unreachable");
    expect(outcome.report.error).toMatch(/nothing to install on a server/);
  });

  it("drops list members it cannot read rather than rendering undefined", () => {
    // Defensive on the wire shape: a skip with no `name` has nothing to render, and
    // `undefined — undefined` in a report row is worse than one fewer row.
    const outcome = applyOutcomeOf("Big Pack", {
      installed: 1,
      total: 2,
      errors: ["real", 7, null],
      warnings: "not an array",
      skipped: [{ name: "Sodium" }, { reason: "orphan" }, "nope", null],
    });
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") throw new Error("unreachable");
    expect(outcome.report.errors).toEqual(["real"]);
    expect(outcome.report.warnings).toEqual([]);
    expect(outcome.report.skipped).toEqual([{ name: "Sodium", reason: "" }]);
  });
});

describe("applyModpackToServer", () => {
  it("posts the modpack id and reads the body on a non-2xx too", async () => {
    /**
     * The route answers non-2xx when it could not install every mod, so the counts have to
     * be read on both paths. Trusting `res.ok` is the original defect.
     */
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return {
          ok: false,
          status: 500,
          json: async () => ({ installed: 1, total: 2, errors: ["x"], warnings: [], skipped: [] }),
        } as Response;
      })
    );

    const outcome = await applyModpackToServer({ modpackId: "pack-1", packName: "Big Pack" });
    expect(calls).toEqual([
      { url: "/api/mods/install-modpack", body: { modpackId: "pack-1" } },
    ]);
    expect(outcome.kind).toBe("report");
  });

  it("calls a request that gave up still-running, with no counts to render", async () => {
    /**
     * **The fix.** `modpacks.tsx` substituted `{installed: 0, total: 0}` here, which the
     * report dialog rendered in destructive red. Nothing on this path knows how far the
     * apply got, so the outcome carries no numbers at all — a shape that cannot be
     * mistaken for a failure.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    expect(await applyModpackToServer({ modpackId: "p", packName: "Big Pack" })).toEqual({
      kind: "still-running",
      packName: "Big Pack",
    });
  });

  it("treats an unreadable body as no counts, not as zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response)
    );
    const outcome = await applyModpackToServer({ modpackId: "p", packName: "Big Pack" });
    expect(outcome.kind).toBe("still-running");
  });
});

describe("importAndApply", () => {
  it("imports first and applies the id it got back", async () => {
    // `/api/mods/install-modpack` takes a `modpackId`, so applying something found on
    // Modrinth is genuinely two writes. One definition of the order, here.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        posts.push(u);
        if (u === "/api/modpacks/import") {
          return { ok: true, status: 200, json: async () => ({ id: "pack-9" }) } as Response;
        }
        return { ok: true, status: 200, json: async () => CLEAN } as Response;
      })
    );
    expect(await importAndApply({ modrinthId: "abc", packName: "Big Pack" })).toEqual({
      kind: "quiet",
    });
    expect(posts).toEqual(["/api/modpacks/import", "/api/mods/install-modpack"]);
  });

  it("does not apply when the import is refused", async () => {
    // The import is the first write. If it never landed there is nothing to roll back, and
    // "nothing was changed" is the fact that decides whether to retry.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        posts.push(String(url));
        return { ok: false, status: 403, json: async () => ({ error: "Forbidden" }) } as Response;
      })
    );
    expect(await importAndApply({ modrinthId: "abc", packName: "Big Pack" })).toEqual({
      kind: "error",
      message: "Forbidden",
    });
    expect(posts).toEqual(["/api/modpacks/import"]);
  });

  it("does not apply when the import answers 200 with no id", async () => {
    // A 200 whose body is not what this expects is still not a pack to apply, and
    // `install-modpack` with `modpackId: undefined` would 400 one step later with a
    // sentence about the wrong thing.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        posts.push(String(url));
        return { ok: true, status: 200, json: async () => ({ mods: [] }) } as Response;
      })
    );
    const outcome = await importAndApply({ modrinthId: "abc", packName: "Big Pack" });
    expect(outcome.kind).toBe("unconfirmed-import");
    expect(posts).toEqual(["/api/modpacks/import"]);
  });

  it("leaves a lost import response unconfirmed without applying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const outcome = await importAndApply({ modrinthId: "abc", packName: "Big Pack" });
    expect(outcome.kind).toBe("unconfirmed-import");
    if (outcome.kind !== "unconfirmed-import") throw new Error("unreachable");
    expect(outcome.message).not.toMatch(/Nothing was changed/);
    expect(outcome.message).toContain("No apply was requested");
    expect(outcome.message).toContain("check Saved sets");
  });
});
