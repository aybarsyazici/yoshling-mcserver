import { describe, expect, it } from "vitest";
import manifest from "@/data/aion2/timers.json";
import { validateAionTimers } from "@/lib/aion2-timer-validation";

describe("reviewed timer configuration", () => {
  it("accepts the reviewed region-specific schedules", () => expect(validateAionTimers(manifest)).toEqual([]));
  it.each(["2026-02-30", "not-a-date", "2026-10-30"])("refuses invalid or reversed review periods %s", (date) => {
    const copy = structuredClone(manifest); copy.reviewedAt = date;
    expect(validateAionTimers(copy).length).toBeGreaterThan(0);
  });
  it("refuses an unknown zone instead of rendering a guessed offset", () => {
    const copy = structuredClone(manifest); copy.events[0].timeZone = "Europe/NotAZone";
    expect(validateAionTimers(copy).join(" ")).toContain("time zone");
  });
  it.each([24, -1, 1.5])("refuses invalid event hour %s", (hour) => {
    const copy = structuredClone(manifest); copy.events[0].hours = [hour];
    expect(validateAionTimers(copy).length).toBeGreaterThan(0);
  });
  it("refuses unknown sources and unsupported weekday values", () => {
    const copy = structuredClone(manifest); copy.events[0].sourceIds = ["missing"]; copy.events[0].weekdays = [7];
    expect(validateAionTimers(copy).length).toBeGreaterThan(1);
  });
  it("does not allow a fixed schedule to be invented for Gartua", () => {
    const copy = structuredClone(manifest), boss = copy.events.find((event) => event.id === "gartua")!;
    boss.hours = [12]; boss.timeZone = "UTC";
    expect(validateAionTimers(copy).join(" ")).toContain("invented fixed schedule");
  });
  it("requires a stable pinned source for every recurring schedule", () => {
    const copy = structuredClone(manifest); copy.events[0].sourceIds = ["shugo-eu"];
    expect(validateAionTimers(copy).join(" ")).toContain("stable pinned schedule");
  });
  it("rejects incomplete or malformed source hashes", () => {
    const copy = structuredClone(manifest), source = copy.sources.find(source => source.id === "meta-eu")!;
    source.sha256 = "invalid";
    expect(validateAionTimers(copy).join(" ")).toContain("fetch URL/hash");
  });
});
