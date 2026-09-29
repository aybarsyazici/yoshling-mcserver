import { describe, expect, it } from "vitest";
// Relative, not `@/lib/...`: this then runs under a bare `npx vitest run` with no
// config at all, which is what let it be watched failing before the harness landed.
import { findConflicts, type PzMap } from "../zomboid-maps";

const map = (name: string, cells: string[], extra: Partial<PzMap> = {}): PzMap => ({
  workshopId: "0",
  modId: "mod",
  name,
  cells,
  ...extra,
});

/**
 * The live shape, read off production 2026-09-29.
 *
 * `SZ_Checkpoint6` and `SZ_Riverside_Checkpoint_2` really do both ship cells 22_22,
 * 22_23, 23_22 and 23_23 — but `SZ_Checkpoint6` is named in `MAP_EXCLUDE`, so
 * `pz/search_folder.sh` logs `Excluding map SZ_Checkpoint6 (MAP_EXCLUDE)` on every boot
 * and it never reaches `Map=`. The card nonetheless put that pair at the top of its
 * conflict list, because it was reading cells alone.
 */
const CHECKPOINT6 = map("SZ_Checkpoint6", ["22_22", "22_23", "23_22", "23_23"]);
const RIVERSIDE_2 = map("SZ_Riverside_Checkpoint_2", ["22_22", "22_23", "23_22", "23_23"]);
const CHECKPOINT5 = map("SZ_Checkpoint5", ["31_31", "31_32"]);
const CROSSROADS = map("SZ_MuldraughCrossroads_Checkpoint", ["31_31", "31_32"]);

/** The 21 mod maps in `Map=`, minus the excluded one. */
const LIVE_ORDER = [
  "map_distanciado",
  "SZ_Checkpoint5",
  "SZ_MuldraughCrossroads_Checkpoint",
  "SZ_Riverside_Checkpoint_2",
  "Muldraugh, KY",
];

describe("findConflicts", () => {
  const installed = [CHECKPOINT6, RIVERSIDE_2, CHECKPOINT5, CROSSROADS];

  it("reports every overlap when no load order is supplied", () => {
    // No config yet: there is no order to judge against, and reporting every overlap
    // beats reporting none.
    const names = findConflicts(installed).map((c) => c.maps.slice().sort().join(" vs "));
    expect(names).toContain("SZ_Checkpoint6 vs SZ_Riverside_Checkpoint_2");
    expect(names).toContain("SZ_Checkpoint5 vs SZ_MuldraughCrossroads_Checkpoint");
  });

  it("drops a pair whose participant is not in the load order", () => {
    // The regression this locks: a map absent from `Map=` claims nothing in game, so it
    // cannot lose cells to anything. This assertion fails against the pre-2026-09-29
    // single-argument `findConflicts`, which had no way to know.
    const conflicts = findConflicts(installed, LIVE_ORDER);
    const names = conflicts.map((c) => c.maps.slice().sort().join(" vs "));
    expect(names).not.toContain("SZ_Checkpoint6 vs SZ_Riverside_Checkpoint_2");
    expect(names).toEqual(["SZ_Checkpoint5 vs SZ_MuldraughCrossroads_Checkpoint"]);
  });

  it("keeps the cells and the ordering of the conflicts it does report", () => {
    const [first] = findConflicts(installed, LIVE_ORDER);
    expect(first.cells).toEqual(["31_31", "31_32"]);
    // Sorted by how much ground is contested, which is what makes the list scannable.
    const many = findConflicts(
      [
        map("A", ["1_1", "1_2", "1_3"]),
        map("B", ["1_1", "1_2", "1_3"]),
        map("C", ["9_9"]),
        map("D", ["9_9"]),
      ],
      ["A", "B", "C", "D"]
    );
    expect(many.map((c) => c.cells.length)).toEqual([3, 1]);
  });

  it("does not invent a conflict from a map overlapping itself", () => {
    // Cells are merged per (workshop item, map name) by `scanMaps`, but two *different*
    // workshop items can ship the same map name — and one map cannot fight itself.
    const twice = [
      map("AZSpawn", ["5_5"], { workshopId: "111" }),
      map("AZSpawn", ["5_5"], { workshopId: "222" }),
    ];
    expect(findConflicts(twice, ["AZSpawn"])).toEqual([]);
  });

  it("treats an empty order as 'nothing is loaded', not as 'no filter'", () => {
    // `undefined` means "no order to judge against"; `[]` is a real, empty order. The
    // route passes `undefined` when the config is missing, precisely so these differ.
    expect(findConflicts(installed, [])).toEqual([]);
    expect(findConflicts(installed).length).toBeGreaterThan(0);
  });
});
