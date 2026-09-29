import { describe, it, expect } from "vitest";
import { evictionIndex, finishedTtlFor } from "@/lib/operations";

/**
 * The ring evicted the success the user was watching.
 *
 * With twenty non-clean records held, a newly-pushed `ok` was the only clean one, so
 * `findIndex(e => e.outcome === "ok")` selected it and its own `push` spliced it out.
 * Measured on production 2026-09-29: a memory change that really recreated a container
 * and a restart that really cycled one both left no record at all.
 */
describe("evictionIndex", () => {
  const at = (n: number) => 1_000_000 + n * 1000;

  it("never evicts the incoming clean record when every other slot is a failure", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => ({ outcome: "failed" as const, endedAt: at(i) })),
      { outcome: "ok" as const, endedAt: at(100) },
    ];
    const victim = evictionIndex(entries, at(100));
    expect(victim).not.toBe(entries.length - 1);
    // No clean record is older than the incoming one, so it falls back to the oldest slot.
    expect(victim).toBe(0);
  });

  it("prefers the oldest clean record over any failure", () => {
    const entries = [
      { outcome: "failed" as const, endedAt: at(1) },
      { outcome: "ok" as const, endedAt: at(2) },
      { outcome: "partial" as const, endedAt: at(3) },
      { outcome: "nothing" as const, endedAt: at(4) },
      { outcome: "ok" as const, endedAt: at(9) },
    ];
    expect(evictionIndex(entries, at(9))).toBe(1);
  });

  it("counts a no-op as clean, so a ring of no-ops does not starve a success", () => {
    const entries = [
      { outcome: "nothing" as const, endedAt: at(1) },
      { outcome: "failed" as const, endedAt: at(2) },
      { outcome: "ok" as const, endedAt: at(7) },
    ];
    expect(evictionIndex(entries, at(7))).toBe(0);
  });

  it("falls back to the oldest entry by endedAt when nothing clean is older", () => {
    const entries = [
      { outcome: "failed" as const, endedAt: at(5) },
      { outcome: "partial" as const, endedAt: at(2) },
      { outcome: "unverified" as const, endedAt: at(8) },
    ];
    expect(evictionIndex(entries, at(8))).toBe(1);
  });

  it("returns -1 for an empty ring rather than 0, so the caller cannot splice nothing", () => {
    expect(evictionIndex([], at(1))).toBe(-1);
  });
});

describe("finishedTtl", () => {
  it("gives a no-op the clean TTL, not the six-hour failure TTL", () => {
    // Eight of twenty slots on the live box were `nothing` records being kept for six
    // hours each — ordinary clicks on an already-running world's card.
    expect(finishedTtlFor("nothing")).toBe(finishedTtlFor("ok"));
  });

  it("still keeps non-clean records far longer than clean ones", () => {
    expect(finishedTtlFor("failed")).toBeGreaterThan(finishedTtlFor("ok"));
    expect(finishedTtlFor("partial")).toBeGreaterThan(finishedTtlFor("ok"));
    expect(finishedTtlFor("unverified")).toBeGreaterThan(finishedTtlFor("ok"));
  });
});
