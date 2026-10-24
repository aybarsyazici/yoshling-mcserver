import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import timerData from "@/data/aion2/timers.json";
import { aionTimers } from "@/lib/aion2-timers";
import type { AionRegion } from "@/lib/aion2-types";

// Calendar fixtures intentionally exercise Oct23 and the DST weekend. Give only
// this test copy a matching review window; production retains its actual review.
vi.mock("@/data/aion2/timers.json", async (original) => {
  const imported = await original<{ default: typeof import("@/data/aion2/timers.json") }>();
  const data = structuredClone(imported.default);
  data.reviewedAt = "2026-10-23";
  for (const source of data.sources) source.reviewedAt = "2026-10-23";
  return { default: data };
});

const original = structuredClone(timerData);
function timer(id: string, iso: string, current = true, region: AionRegion = "eu") {
  const value = aionTimers(region, new Date(iso), current).find((event) => event.id === id);
  expect(value).toBeDefined(); return value!;
}
function extendReviewForCalendarTest() {
  timerData.expiresAt = "2026-11-06";
  for (const source of timerData.sources) source.expiresAt = "2026-11-06";
}

beforeEach(() => Object.assign(timerData, structuredClone(original)));
afterEach(() => { Object.assign(timerData, structuredClone(original)); vi.unstubAllEnvs(); });

describe("EU event entry and play windows", () => {
  it("uses the next EU wall-clock rift and a separate ten-minute entry deadline", () => {
    expect(timer("spacetime-rift", "2026-10-23T08:59:59Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T09:00:00.000Z", windowEndsAt: null, timeZone: "Europe/Berlin" });
    expect(timer("spacetime-rift", "2026-10-23T09:00:00Z")).toMatchObject({ state: "entry-open", nextStartAt: "2026-10-23T09:00:00.000Z", windowEndsAt: "2026-10-23T09:10:00.000Z" });
    expect(timer("spacetime-rift", "2026-10-23T09:09:59.999Z").state).toBe("entry-open");
    expect(timer("spacetime-rift", "2026-10-23T09:10:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T12:00:00.000Z", windowEndsAt: null });
  });

  it("separates Shugo's three-minute admission from its maximum five-minute play window", () => {
    expect(timer("shugo-festival", "2026-10-23T09:59:59Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T10:00:00.000Z" });
    expect(timer("shugo-festival", "2026-10-23T10:00:00Z")).toMatchObject({ state: "entry-open", windowEndsAt: "2026-10-23T10:03:00.000Z" });
    expect(timer("shugo-festival", "2026-10-23T10:02:59.999Z").state).toBe("entry-open");
    expect(timer("shugo-festival", "2026-10-23T10:03:00Z")).toMatchObject({ state: "active", nextStartAt: "2026-10-23T10:00:00.000Z", windowEndsAt: "2026-10-23T10:08:00.000Z" });
    expect(timer("shugo-festival", "2026-10-23T10:08:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T11:00:00.000Z", windowEndsAt: null });
  });

  it("separates Invasion admission from its maximum ten-minute play window", () => {
    expect(timer("dimensional-invasion", "2026-10-23T10:29:59Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T10:30:00.000Z" });
    expect(timer("dimensional-invasion", "2026-10-23T10:30:00Z")).toMatchObject({ state: "entry-open", windowEndsAt: "2026-10-23T10:33:00.000Z" });
    expect(timer("dimensional-invasion", "2026-10-23T10:33:00Z")).toMatchObject({ state: "active", windowEndsAt: "2026-10-23T10:43:00.000Z" });
    expect(timer("dimensional-invasion", "2026-10-23T10:43:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T11:30:00.000Z", windowEndsAt: null });
  });

  it("does not claim start-only bosses or battles are currently active", () => {
    expect(timer("artifact-siege", "2026-10-24T18:59:59Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-24T19:00:00.000Z", windowEndsAt: null });
    expect(timer("artifact-siege", "2026-10-24T19:00:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-26T20:00:00.000Z", windowEndsAt: null });
    expect(timer("siege-executors", "2026-10-24T19:00:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-24T19:30:00.000Z", windowEndsAt: null });
    expect(timer("watcher-kaira", "2026-10-23T10:59:59Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-23T11:00:00.000Z", windowEndsAt: null });
  });

  it("selects Nahma on Friday/Sunday and siege events on Monday/Thursday/Saturday", () => {
    expect(timer("guardian-nahma", "2026-10-23T18:00:00Z").nextStartAt).toBe("2026-10-23T19:00:00.000Z");
    expect(timer("guardian-nahma", "2026-10-24T18:00:00Z").nextStartAt).toBe("2026-10-25T20:00:00.000Z");
    expect(timer("artifact-siege", "2026-10-23T18:00:00Z").nextStartAt).toBe("2026-10-24T19:00:00.000Z");
    expect(timer("siege-executors", "2026-10-25T12:00:00Z").nextStartAt).toBe("2026-10-26T20:30:00.000Z");
  });
});

describe("Berlin daylight saving and UTC resets", () => {
  it("keeps EU local event hours fixed while UTC shifts across October 25", () => {
    expect(timer("spacetime-rift", "2026-10-24T02:30:00Z").nextStartAt).toBe("2026-10-24T03:00:00.000Z");
    expect(timer("spacetime-rift", "2026-10-25T03:30:00Z").nextStartAt).toBe("2026-10-25T04:00:00.000Z");
    expect(timer("spacetime-rift", "2026-10-24T17:30:00Z").nextStartAt).toBe("2026-10-24T18:00:00.000Z");
    expect(timer("spacetime-rift", "2026-10-25T17:30:00Z").nextStartAt).toBe("2026-10-25T19:00:00.000Z");
  });

  it("keeps the daily reset at 07:00 UTC on both sides of the clock change", () => {
    expect(timer("daily-reset", "2026-10-24T06:30:00Z")).toMatchObject({ timeZone: "UTC", nextStartAt: "2026-10-24T07:00:00.000Z", state: "upcoming", windowEndsAt: null });
    expect(timer("daily-reset", "2026-10-25T06:30:00Z").nextStartAt).toBe("2026-10-25T07:00:00.000Z");
    expect(timer("daily-reset", "2026-10-25T07:00:00Z").nextStartAt).toBe("2026-10-26T07:00:00.000Z");
  });

  it("uses Wednesday 07:00 UTC for the weekly reset and rolls forward exactly at reset", () => {
    expect(timer("weekly-reset", "2026-10-23T12:00:00Z").nextStartAt).toBe("2026-10-28T07:00:00.000Z");
    // Extend only the test review window to exercise a subsequent Wednesday.
    extendReviewForCalendarTest();
    expect(timer("weekly-reset", "2026-10-28T06:59:59Z").nextStartAt).toBe("2026-10-28T07:00:00.000Z");
    expect(timer("weekly-reset", "2026-10-28T07:00:00Z").nextStartAt).toBe("2026-11-04T07:00:00.000Z");
  });

  it.each(["spacetime-rift", "shugo-festival", "dimensional-invasion"])("does not invent a duplicate %s occurrence during the repeated 02:00 hour", (id) => {
    expect(timer(id, "2026-10-25T00:40:00Z")).toMatchObject({ state: "unknown", nextStartAt: null, windowEndsAt: null });
    expect(timer(id, "2026-10-25T00:40:00Z").description).toContain("repeats");
  });

  it("resumes ordinary times after every possible repeated-hour window has ended", () => {
    expect(timer("spacetime-rift", "2026-10-25T01:10:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-25T04:00:00.000Z" });
    expect(timer("shugo-festival", "2026-10-25T01:08:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-25T02:00:00.000Z" });
    expect(timer("dimensional-invasion", "2026-10-25T01:43:00Z")).toMatchObject({ state: "upcoming", nextStartAt: "2026-10-25T02:30:00.000Z" });
  });

  it("uses event timezones independently of the server or viewer timezone", () => {
    vi.stubEnv("TZ", "Pacific/Honolulu");
    expect(timer("spacetime-rift", "2026-10-25T03:30:00Z").nextStartAt).toBe("2026-10-25T04:00:00.000Z");
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(timer("spacetime-rift", "2026-10-25T03:30:00Z").nextStartAt).toBe("2026-10-25T04:00:00.000Z");
  });
});

describe("review, region and live-state boundaries", () => {
  it.each(["nae", "naw", "la", "as"] as const)("does not substitute EU times for unreviewed region %s", (region) => {
    const values = aionTimers(region, new Date("2026-10-23T12:00:00Z"), true);
    expect(values).toHaveLength(10);
    for (const value of values) expect(value).toMatchObject({ region, state: "unknown", nextStartAt: null, windowEndsAt: null, timeZone: null });
    expect(values.find((event) => event.id === "spacetime-rift")!.description).toContain("EU times are not substituted");
  });

  it("withholds every scheduled/reset countdown when the knowledge gate is closed", () => {
    const values = aionTimers("eu", new Date("2026-10-23T10:01:00Z"), false);
    for (const value of values.filter((value) => value.kind !== "manual")) expect(value).toMatchObject({ state: "review-required", nextStartAt: null, windowEndsAt: null });
  });

  it.each(["2026-10-28T00:00:00Z", "2026-10-22T23:59:59Z"])("withholds predictions outside the reviewed period at %s", (now) => {
    for (const value of aionTimers("eu", new Date(now), true).filter((value) => value.kind !== "manual")) expect(value.state).toBe("review-required");
  });

  it("withholds an event when one of its source reviews has expired", () => {
    timerData.sources.find((source) => source.id === "shugo-entry")!.expiresAt = "2026-10-23";
    expect(timer("shugo-festival", "2026-10-23T10:01:00Z")).toMatchObject({ state: "review-required", nextStartAt: null });
    expect(timer("daily-reset", "2026-10-23T10:01:00Z").state).toBe("upcoming");
  });

  it("never creates a Gartua countdown from the current time or a guessed twelve-hour cycle", () => {
    for (const now of ["2026-10-23T00:00:00Z", "2026-10-23T12:00:00Z", "2026-10-25T01:30:00Z"]) {
      expect(timer("gartua", now)).toMatchObject({ kind: "manual", state: "unknown", nextStartAt: null, windowEndsAt: null, timeZone: null });
    }
    expect(timer("gartua", "2026-10-23T12:00:00Z").description).toContain("kill-dependent");
  });

  it("also expires manual Gartua report eligibility when its own source review expires", () => {
    timerData.sources.find(source => source.id === "gartua-reports")!.expiresAt = "2026-10-23";
    expect(timer("gartua", "2026-10-23T12:00:00Z")).toMatchObject({ state: "review-required", nextStartAt: null });
    expect(timer("gartua", "2026-10-28T12:00:00Z").state).toBe("review-required");
  });

  it("fails closed for an invalid clock without attempting timezone conversion", () => {
    const values = aionTimers("eu", new Date("invalid"), true);
    expect(values.filter((value) => value.kind !== "manual").every((value) => value.state === "review-required" && value.nextStartAt === null)).toBe(true);
  });

  it("exposes reviewed source links and labels without performing network requests", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const value of aionTimers("eu", new Date("2026-10-23T12:00:00Z"), true)) {
        expect(value.source).toMatch(/^https:\/\//); expect(value.sourceLabel).not.toBe("");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
