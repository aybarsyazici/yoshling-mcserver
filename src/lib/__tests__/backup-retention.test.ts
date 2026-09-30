import { describe, expect, it } from "vitest";
// Relative, not `@/lib/...`: matches `backup-names.test.ts`, so this also runs under a
// bare `npx vitest run` with no config at all.
import {
  DEFAULT_POLICY,
  describePolicy,
  selectForPruning,
  type BackupPolicy,
} from "../backup-retention";

/**
 * Retention is the only code in this repo whose *job* is to delete a user's backups, so
 * these assert the properties rather than the current arithmetic. Each one names the
 * failure it exists to prevent.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

/** `n` archives, newest first in the returned array, one day apart. */
function daily(n: number): { name: string; createdAtMs: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `world-${String(i).padStart(2, "0")}.tar.gz`,
    createdAtMs: NOW - i * DAY,
  }));
}

const keepOnly = (keep: number): BackupPolicy => ({ keep, maxAgeDays: 0 });

describe("selectForPruning — the newest archive is never a candidate", () => {
  /**
   * The brief's hard rule is "never delete the only archive"; this is the stronger form
   * of it, and the stronger form is the one worth pinning, because it holds for every
   * possible setting rather than only for a directory of size one.
   */
  it("deletes nothing when there is one archive, whatever the policy says", () => {
    for (const policy of [keepOnly(1), keepOnly(0), { keep: 0, maxAgeDays: 1 }]) {
      const s = selectForPruning(
        [{ name: "only.tar.gz", createdAtMs: NOW - 400 * DAY }],
        policy,
        { now: NOW }
      );
      expect(s.delete).toEqual([]);
      expect(s.keep).toBe(1);
    }
  });

  it("keeps the newest even when every archive is past the age limit", () => {
    const archives = daily(4).map((a) => ({ ...a, createdAtMs: a.createdAtMs - 365 * DAY }));
    const s = selectForPruning(archives, { keep: 10, maxAgeDays: 7 }, { now: NOW });
    expect(s.delete).toHaveLength(3);
    expect(s.delete).not.toContain("world-00.tar.gz");
    expect(s.keep).toBe(1);
  });

  it("cannot be made to empty the directory by a keep of 0", () => {
    const s = selectForPruning(daily(6), keepOnly(0), { now: NOW });
    expect(s.keep).toBeGreaterThanOrEqual(1);
    expect(s.delete).not.toContain("world-00.tar.gz");
  });
});

describe("selectForPruning — the keep-N boundary", () => {
  it("deletes nothing at exactly N", () => {
    expect(selectForPruning(daily(5), keepOnly(5), { now: NOW }).delete).toEqual([]);
  });

  /**
   * This used to assert `delete == ["world-05.tar.gz"]` at N+1 — i.e. that the count rule
   * deletes the oldest archive first. It was changed deliberately, not weakened: the
   * oldest archive is now exempt from the count rule, because on the measured archive set
   * the "oldest first" order is what made `keep` trim the history instead of the burst
   * (see the two cases in "the oldest archive survives the count rule" below). So at N+1
   * the only candidate is the exempt one and nothing is deleted; the count rule starts
   * biting at N+2, on the SECOND oldest.
   */
  it("deletes nothing at N+1, because the only candidate is the exempt oldest", () => {
    const s = selectForPruning(daily(6), keepOnly(5), { now: NOW });
    expect(s.delete).toEqual([]);
    expect(s.keep).toBe(6);
  });

  it("deletes the second oldest at N+2, keeping both ends", () => {
    const s = selectForPruning(daily(7), keepOnly(5), { now: NOW });
    expect(s.delete).toEqual(["world-05.tar.gz"]);
    expect(s.keep).toBe(6);
  });

  it("deletes nothing below N", () => {
    expect(selectForPruning(daily(3), keepOnly(5), { now: NOW }).delete).toEqual([]);
  });

  it("deletes nothing at all for an empty directory", () => {
    const s = selectForPruning([], keepOnly(5), { now: NOW });
    expect(s.delete).toEqual([]);
    expect(s.keep).toBe(0);
  });

  /**
   * The measured pile-up: five of the six 7 Days to Die archives on the box were written
   * between 13:33 and 13:41 on 2026-09-29, eight minutes apart, 304 MB each.
   *
   * This is why the rule is OR and not the conventional AND. Under "beyond N **and** older
   * than D days" none of these would have been touched — they were minutes old — so the
   * one accumulation that actually happened here would have gone unpruned. If someone
   * later "corrects" the rule to AND, this test is what says no.
   */
  it("prunes a burst written minutes apart, which an age-only rule would not", () => {
    const burst = Array.from({ length: 6 }, (_, i) => ({
      name: `7dtd-Reveo_Valley-${i}.tar.gz`,
      createdAtMs: NOW - i * 90_000,
    }));
    const s = selectForPruning(burst, { keep: 3, maxAgeDays: 30 }, { now: NOW });
    // Two, not three: the oldest of the six is exempt from the count rule. The property
    // this test exists for is unchanged — a burst inside the age window IS pruned, which
    // "beyond N AND older than D" would not do — and it is still the assertion that says
    // no if anyone converts the rule to AND, because AND would delete zero here.
    expect(s.delete).toHaveLength(2);
    expect(s.keep).toBe(4);
  });
});

/**
 * The defect these exist for, measured rather than imagined.
 *
 * `keep: N` only bounds a burst if the burst is bigger than N. On this box it was not.
 * Read inside `yoshling-web-1` on 2026-09-30: 7 Days to Die had six archives, one from
 * 2026-07-23 and **five written between 13:34:06 and 13:41:12 on 2026-09-29**; Minecraft
 * had five, of which three were from one afternoon. Running the count rule over exactly
 * those sets at the default `keep: 5` selected the 2026-07-23 archive and the 2026-05-29
 * archive — in each case the only restore point older than a day — and kept a pile of
 * near-identical copies of one moment. Run daily, `keep` days later the entire history is
 * gone, each step logged `outcome: "ok"`.
 *
 * The property: a count-rule prune can never collapse a world's history into one burst.
 */
describe("selectForPruning — the oldest archive survives the count rule", () => {
  /** The real 7DTD directory: 1 old archive + a 5-file burst 7 minutes wide. */
  const SEVEN_DTD = [
    { name: "7dtd-Reveo_Valley-2026-09-29T13-41-12.tar.gz", createdAtMs: Date.UTC(2026, 8, 29, 13, 41, 12) },
    { name: "7dtd-Reveo_Valley-2026-09-29T13-40-40.tar.gz", createdAtMs: Date.UTC(2026, 8, 29, 13, 40, 40) },
    { name: "7dtd-Reveo_Valley-2026-09-29T13-37-55.tar.gz", createdAtMs: Date.UTC(2026, 8, 29, 13, 37, 55) },
    { name: "7dtd-Reveo_Valley-2026-09-29T13-36-20.tar.gz", createdAtMs: Date.UTC(2026, 8, 29, 13, 36, 20) },
    { name: "7dtd-Reveo_Valley-2026-09-29T13-33-40.tar.gz", createdAtMs: Date.UTC(2026, 8, 29, 13, 33, 40) },
    { name: "7dtd-Reveo_Valley-2026-07-23T19-46-06.tar.gz", createdAtMs: Date.UTC(2026, 6, 23, 19, 46, 6) },
  ];

  it("does not delete the only restore point older than the burst", () => {
    const fresh = { name: "7dtd-Reveo_Valley-2026-09-30T02-00-00.tar.gz", createdAtMs: NOW };
    const s = selectForPruning([fresh, ...SEVEN_DTD], DEFAULT_POLICY, {
      now: NOW,
      protect: [fresh.name],
    });
    expect(s.delete).not.toContain("7dtd-Reveo_Valley-2026-07-23T19-46-06.tar.gz");
    // It still prunes — the point is which one it gives up.
    expect(s.delete).toEqual(["7dtd-Reveo_Valley-2026-09-29T13-33-40.tar.gz"]);
  });

  /**
   * The general form: repeated creates must not be able to erase a distinct old restore
   * point. Simulated as the scheduler would do it — create, prune, create, prune — which
   * is the sequence in which the daily-burst shape actually destroys history.
   */
  it("still holds after many rounds of create-then-prune", () => {
    let archives = [...SEVEN_DTD];
    const oldest = "7dtd-Reveo_Valley-2026-07-23T19-46-06.tar.gz";
    for (let round = 0; round < 40; round++) {
      const fresh = { name: `new-${String(round).padStart(3, "0")}.tar.gz`, createdAtMs: NOW + round * DAY };
      archives = [fresh, ...archives];
      const s = selectForPruning(archives, DEFAULT_POLICY, {
        now: NOW + round * DAY,
        protect: [fresh.name],
      });
      archives = archives.filter((a) => !s.delete.includes(a.name));
    }
    expect(archives.map((a) => a.name)).toContain(oldest);
    // And it did not simply refuse to prune: the directory is bounded.
    expect(archives.length).toBeLessThanOrEqual(DEFAULT_POLICY.keep + 1);
  });

  /**
   * The exemption is from the COUNT rule only. `maxAgeDays` is an operator saying "delete
   * anything past this date", and a silent "…except one" would make that a lie — so the
   * age rule can still take the oldest archive, while the newest-archive guarantee holds.
   */
  it("is not exempt from the age rule", () => {
    const archives = daily(4).map((a) => ({ ...a, createdAtMs: a.createdAtMs - 365 * DAY }));
    const s = selectForPruning(archives, { keep: 10, maxAgeDays: 7 }, { now: NOW });
    expect(s.delete).toContain("world-03.tar.gz");
    expect(s.keep).toBe(1);
  });
});

describe("selectForPruning — ordering", () => {
  it("returns the doomed names oldest first, so a partial failure loses the oldest", () => {
    const s = selectForPruning(daily(9), keepOnly(3), { now: NOW });
    // `world-08` is the oldest and exempt from the count rule, so the list starts at 07.
    expect(s.delete).toEqual([
      "world-07.tar.gz",
      "world-06.tar.gz",
      "world-05.tar.gz",
      "world-04.tar.gz",
      "world-03.tar.gz",
    ]);
  });

  it("is deterministic for archives written in the same second", () => {
    // Names carry a second-resolution timestamp, so two can tie. Without the name
    // tie-break, which one is deleted would depend on readdir order.
    const same = [
      { name: "b.tar.gz", createdAtMs: NOW },
      { name: "a.tar.gz", createdAtMs: NOW },
      { name: "c.tar.gz", createdAtMs: NOW },
    ];
    const first = selectForPruning(same, keepOnly(1), { now: NOW });
    const shuffled = selectForPruning([same[2], same[0], same[1]], keepOnly(1), { now: NOW });
    expect(first.delete).toEqual(shuffled.delete);
    // `c` sorts highest, so it is the "newest" survivor.
    expect(first.delete).not.toContain("c.tar.gz");
  });

  it("does not mutate its input", () => {
    const archives = daily(4);
    const snapshot = JSON.parse(JSON.stringify(archives));
    selectForPruning(archives, keepOnly(1), { now: NOW });
    expect(archives).toEqual(snapshot);
  });
});

describe("selectForPruning — the age rule", () => {
  it("is off by default, so a long-idle world keeps its whole history", () => {
    expect(DEFAULT_POLICY.maxAgeDays).toBe(0);
    const ancient = daily(4).map((a) => ({ ...a, createdAtMs: a.createdAtMs - 500 * DAY }));
    expect(selectForPruning(ancient, keepOnly(10), { now: NOW }).delete).toEqual([]);
  });

  it("deletes past the cutoff and keeps everything inside it", () => {
    const s = selectForPruning(daily(10), { keep: 100, maxAgeDays: 4 }, { now: NOW });
    // Days 0–4 are inside the cutoff; 5–9 are past it.
    expect(s.delete).toEqual([
      "world-09.tar.gz",
      "world-08.tar.gz",
      "world-07.tar.gz",
      "world-06.tar.gz",
      "world-05.tar.gz",
    ]);
  });

  it("treats an archive exactly at the cutoff as still inside it", () => {
    const archives = [
      { name: "new.tar.gz", createdAtMs: NOW },
      { name: "edge.tar.gz", createdAtMs: NOW - 7 * DAY },
    ];
    expect(selectForPruning(archives, { keep: 100, maxAgeDays: 7 }, { now: NOW }).delete).toEqual([]);
  });
});

describe("selectForPruning — protect", () => {
  it("never deletes a protected name, and reports that it held it back", () => {
    const s = selectForPruning(daily(6), keepOnly(1), {
      now: NOW,
      protect: ["world-03.tar.gz"],
    });
    expect(s.delete).not.toContain("world-03.tar.gz");
    expect(s.protected).toEqual(["world-03.tar.gz"]);
    // A protected archive still counts as kept, or the reported total would be wrong.
    // Three survive, not two: the newest, the protected one, and the exempt oldest.
    expect(s.keep).toBe(3);
  });

  it("protecting the newest is a no-op, because it was never a candidate", () => {
    const a = selectForPruning(daily(6), keepOnly(2), { now: NOW });
    const b = selectForPruning(daily(6), keepOnly(2), { now: NOW, protect: ["world-00.tar.gz"] });
    expect(b.delete).toEqual(a.delete);
    expect(b.protected).toEqual([]);
  });
});

describe("describePolicy", () => {
  it("does not mention an age limit that is switched off", () => {
    expect(describePolicy({ keep: 5, maxAgeDays: 0 })).toBe("keep the 5 newest");
  });

  it("mentions one that is on", () => {
    expect(describePolicy({ keep: 5, maxAgeDays: 30 })).toBe(
      "keep the 5 newest, and anything older than 30 days"
    );
  });

  it("reads properly at keep: 1, which is also where a clamped keep: 0 lands", () => {
    expect(describePolicy({ keep: 1, maxAgeDays: 0 })).toBe("keep only the newest");
  });
});
