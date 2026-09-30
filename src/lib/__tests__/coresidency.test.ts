import { describe, it, expect } from "vitest";
import {
  admitStart,
  assertSoleWorld,
  CoResidencyError,
  coResidency,
  perWorldCeiling,
  ramNote,
  ramUse,
  refuseCoResidency,
  runningWorlds,
} from "../coresidency";
import type { GameId } from "../games";

/**
 * What these tests are for
 * ------------------------
 * Only one world fits on this box (16 GB). `powerOn` evicts; nothing else did, and
 * **nothing anywhere reported** the two-worlds-at-once state. It happened: on
 * 2026-09-26 Project Zomboid was started on top of a 7 Days to Die that had been up two
 * days, and the box was 2.2 GB into swap when the state was found by accident. Forensics showed the cause was a hand-run `docker start`, not app code —
 * which is exactly why detection is the thing worth having. The app cannot prevent
 * every cause; it can refuse to be silent about the state.
 *
 * Every number below is a **measurement off the live box, 2026-09-30**, not a
 * plausible value:
 *   - `/proc/meminfo` MemTotal = 16382176 kB = 15.62 GB → `hostGb` 15.6,
 *     `maxGameGb()` = floor(15.62 - 2.5) = 13.
 *   - `docker-compose.yml`: minecraft `MEMORY: "4G"`, zomboid `MAX_MEMORY: "12288m"`
 *     (= 12 GB), sevendtd has no heap key at all (Unity native server).
 * So Minecraft + Project Zomboid co-resident is 16 GB of configured heap on a 15.6 GB
 * box, which is the swap event in arithmetic form.
 *
 * These assert **properties**, not current behaviour, because this repo has already
 * shipped one test that pinned a bug and turned a correct fix red. The properties:
 * co-residency is reported whenever more than one container is up; an unmetered world
 * is never counted as zero; and a start path either evicts or refuses, never silently
 * adds.
 */

/** A status snapshot of the shape `/api/games/status` returns, run-state only. */
function snapshot(up: GameId[]) {
  const all: GameId[] = ["minecraft", "7dtd", "zomboid"];
  return Object.fromEntries(
    all.map((g) => [g, { containerRunning: up.includes(g) }])
  ) as Record<GameId, { containerRunning: boolean }>;
}

describe("runningWorlds", () => {
  it("reads containerRunning, not status, and keeps GAME_LIST order", () => {
    // `containerRunning` on purpose: a container that is up but not answering RCON
    // still holds its memory. `status` would call that one "offline" and under-report
    // the very state this module exists to catch.
    expect(runningWorlds(snapshot(["zomboid", "minecraft"]))).toEqual(["minecraft", "zomboid"]);
    expect(runningWorlds(snapshot([]))).toEqual([]);
  });

  it("treats a missing or partial snapshot as nothing known, never as a claim", () => {
    expect(runningWorlds(null)).toEqual([]);
    expect(runningWorlds(undefined)).toEqual([]);
    expect(runningWorlds({ "7dtd": { containerRunning: true } })).toEqual(["7dtd"]);
  });
});

describe("coResidency", () => {
  it("says nothing when zero or one world is up", () => {
    expect(coResidency([])).toEqual({ running: [], coResident: false, message: null });
    expect(coResidency(["zomboid"])).toEqual({
      running: ["zomboid"],
      coResident: false,
      message: null,
    });
  });

  it("reports two worlds and names both", () => {
    const co = coResidency(["minecraft", "zomboid"]);
    expect(co.coResident).toBe(true);
    expect(co.running).toEqual(["minecraft", "zomboid"]);
    expect(co.message).toContain("Minecraft");
    expect(co.message).toContain("Project Zomboid");
    // The rule and the way out, in the project's voice: plain, no theatrical framing.
    expect(co.message).toMatch(/room for one/i);
    expect(co.message).toMatch(/stop all but one/i);
    // And no claim about the *effect*. Whether the box is swapping is a measurement this
    // function cannot take, and asserting it was the first draft's mistake.
    expect(co.message).not.toMatch(/swap/i);
  });

  it("reports three, so nothing assumes the box has exactly two worlds", () => {
    const co = coResidency(["minecraft", "7dtd", "zomboid"]);
    expect(co.coResident).toBe(true);
    expect(co.message).toContain("7 Days to Die");
    expect(co.message).toContain("Minecraft");
    expect(co.message).toContain("Project Zomboid");
  });

  it("orders the names the way the worlds are listed, whatever order it is handed", () => {
    expect(coResidency(["zomboid", "minecraft"]).running).toEqual(["minecraft", "zomboid"]);
  });
});

describe("ramUse", () => {
  const memoryGb = { minecraft: 4, "7dtd": null, zomboid: 12 };
  const hostGb = 15.6;

  it("reports 7 Days to Die as unmetered rather than as zero", () => {
    // The bug this is here for: `RamBudget` computed `memoryGb[activeGame] ?? 0`, and
    // 7DTD's heap figure is `null` **by design** — it is a Unity native server with no
    // JVM and no heap setting. So the one element on the landing page whose whole job
    // is making the box's RAM limit legible said "0 / 16 GB", i.e. idle, for the entire
    // time 7 Days to Die was the world holding the box.
    const use = ramUse({ running: ["7dtd"], memoryGb, hostGb });
    expect(use.unmetered).toEqual(["7dtd"]);
    expect(use.metered).toEqual([]);
    expect(use.meteredGb).toBe(0);
    // The distinction that makes 0 honest instead of wrong: 0 GB is *measured heap*,
    // and `incomplete` says the number is a floor, not the total.
    expect(use.incomplete).toBe(true);
  });

  it("sums every running world, not just the first", () => {
    const use = ramUse({ running: ["minecraft", "zomboid"], memoryGb, hostGb });
    expect(use.meteredGb).toBe(16);
    expect(use.metered).toEqual(["minecraft", "zomboid"]);
    expect(use.incomplete).toBe(false);
    // 16 GB of configured heap on a 15.62 GB box. This is the 2026-09-26 swap event.
    expect(use.overCommitted).toBe(true);
  });

  it("clamps the bar at 100% instead of overflowing it", () => {
    const use = ramUse({ running: ["minecraft", "zomboid"], memoryGb, hostGb });
    expect(use.pct).toBe(100);
  });

  it("is a percentage of the real host total, not of a constant", () => {
    const use = ramUse({ running: ["minecraft"], memoryGb, hostGb });
    // 4 / 15.6 = 25.6%
    expect(Math.round(use.pct)).toBe(26);
    expect(use.overCommitted).toBe(false);
  });

  it("counts a metered world alongside an unmetered one, and still flags the gap", () => {
    const use = ramUse({ running: ["7dtd", "zomboid"], memoryGb, hostGb });
    expect(use.meteredGb).toBe(12);
    expect(use.unmetered).toEqual(["7dtd"]);
    expect(use.incomplete).toBe(true);
    // 12 GB of heap plus an unbounded native server. Not provable from these numbers,
    // so it must not be claimed: `overCommitted` is about arithmetic we can do.
    expect(use.overCommitted).toBe(false);
  });

  it("does not divide by an unknown host total", () => {
    const use = ramUse({ running: ["zomboid"], memoryGb, hostGb: null });
    expect(use.pct).toBe(0);
    expect(use.meteredGb).toBe(12);
    expect(use.overCommitted).toBe(false);
  });

  it("is empty and quiet when nothing is running", () => {
    const use = ramUse({ running: [], memoryGb, hostGb });
    expect(use).toMatchObject({ meteredGb: 0, pct: 0, incomplete: false, overCommitted: false });
  });
});

describe("ramNote", () => {
  const memoryGb = { minecraft: 4, "7dtd": null, zomboid: 12 };
  const hostGb = 15.6;
  const note = (running: GameId[]) => ramNote(ramUse({ running, memoryGb, hostGb }));

  it("says all stopped when nothing is up", () => {
    expect(note([])).toMatch(/stopped/i);
  });

  it("never renders an unmetered world as a 0 GB allocation", () => {
    const text = note(["7dtd"]);
    expect(text).toContain("7 Days to Die");
    expect(text).not.toMatch(/\b0 GB\b/);
    expect(text).toMatch(/no heap setting|not metered|isn't metered/i);
  });

  it("names both worlds, the total, the rule and the remedy when two are up", () => {
    const text = note(["minecraft", "zomboid"]);
    expect(text).toContain("Minecraft");
    expect(text).toContain("Project Zomboid");
    expect(text).toContain("16 GB");
    // The rule and the way out, not a particular wording of them.
    expect(text).toMatch(/only one/i);
    expect(text).toMatch(/stop all but one/i);
  });

  it("states the over-commit as arithmetic, never as a predicted effect", () => {
    // "it is swapping" was the first draft of this sentence and of `coResidency`'s. It is
    // not something either can know: `-Xmx` is a reservation, and the 2026-09-26 incident
    // having swapped is one observation, not a rule. 16 GB of heap on a 15.6 GB box is a
    // fact; the kernel's response to it is not.
    const over = note(["minecraft", "zomboid"]);
    expect(over).toMatch(/more heap than the box has/i);
    expect(over).not.toMatch(/swap/i);
    // Two worlds whose combined metered heap fits: no over-commit claim at all.
    const fits = ramNote(
      ramUse({ running: ["minecraft", "zomboid"], memoryGb: { minecraft: 2, zomboid: 4 }, hostGb })
    );
    expect(fits).not.toMatch(/more heap than the box has/i);
    expect(fits).toMatch(/stop all but one/i);
  });

  it("states the one-at-a-time rule for a single running world", () => {
    expect(note(["zomboid"])).toMatch(/12 GB/);
  });
});

describe("perWorldCeiling", () => {
  const memoryGb = { minecraft: 4, "7dtd": null, zomboid: 12 };

  it("says the ceiling assumes the world is alone, because it does", () => {
    // `maxGameGb()` is MemTotal - HOST_RESERVE_GB and subtracts nothing for whatever
    // else is up, so offering 13 GB to Minecraft while Project Zomboid holds 12 is an
    // offer the box cannot honour. Saying so is the minimum; the honest figure is the
    // useful part.
    const c = perWorldCeiling({ maxGb: 13, forGame: "minecraft", running: ["zomboid"], memoryGb });
    expect(c.maxGb).toBe(13);
    expect(c.otherRunning).toEqual(["zomboid"]);
    expect(c.honestGb).toBe(1); // 13 - 12
    expect(c.note).toContain("Project Zomboid");
  });

  it("still states the assumption when the world really is alone", () => {
    // The note must NOT be conditional on the assumption already being broken. It is at
    // its most useful while someone is deciding how much heap to ask for — i.e. before
    // anything is wrong — and a caveat that only appears after the fact makes the ceiling
    // look unconditional for exactly the window that matters.
    const c = perWorldCeiling({ maxGb: 13, forGame: "minecraft", running: ["minecraft"], memoryGb });
    expect(c.otherRunning).toEqual([]);
    expect(c.honestGb).toBe(13);
    expect(c.note).toContain("13 GB");
    expect(c.note).toMatch(/only server running/i);
  });

  it("states it with nothing running at all", () => {
    const c = perWorldCeiling({ maxGb: 13, forGame: "minecraft", running: [], memoryGb });
    expect(c.honestGb).toBe(13);
    expect(c.note).toMatch(/only server running/i);
  });

  it("never reports a negative or zero headroom as a usable figure", () => {
    const c = perWorldCeiling({
      maxGb: 13,
      forGame: "7dtd",
      running: ["zomboid", "minecraft"],
      memoryGb,
    });
    // 13 - 12 - 4 = -3. A negative ceiling is not a number to render; the note is.
    expect(c.honestGb).toBe(0);
    expect(c.note).toMatch(/Minecraft|Project Zomboid/);
  });

  it("does not invent a headroom figure for an unmetered neighbour", () => {
    // 7DTD's usage is real and unknown. Subtracting 0 would claim the full 13 GB is
    // free, which is the same "unmetered read as zero" mistake as the RAM bar's.
    const c = perWorldCeiling({ maxGb: 13, forGame: "zomboid", running: ["7dtd"], memoryGb });
    expect(c.otherRunning).toEqual(["7dtd"]);
    expect(c.honestGb).toBeNull();
    expect(c.note).toContain("7 Days to Die");
  });

  it("says nothing at all when the ceiling itself is unknown", () => {
    // A sentence about a number we could not read is noise, and inventing a stand-in
    // number would be the failure mode this whole module is about.
    const c = perWorldCeiling({ maxGb: null, forGame: "minecraft", running: ["zomboid"], memoryGb });
    expect(c.honestGb).toBeNull();
    expect(c.note).toBeNull();
  });
});

describe("admitStart", () => {
  it("lets a start through when the box is empty", () => {
    expect(admitStart({ game: "zomboid", running: [], mayEvict: true })).toEqual({
      decision: "start",
      evict: [],
      message: null,
    });
  });

  it("evicts the other worlds when the caller is allowed to", () => {
    // This is `powerOn`'s contract, stated as data so a second start path cannot
    // implement a different one.
    const a = admitStart({ game: "minecraft", running: ["zomboid"], mayEvict: true });
    expect(a.decision).toBe("evict");
    expect(a.evict).toEqual(["zomboid"]);
    expect(a.message).toContain("Project Zomboid");
  });

  it("refuses, naming what is already up, when the caller may not evict", () => {
    // `/api/7dtd/update` is the case: it recreates the container with `START_MODE=3`
    // and `start: true`, so it boots 7 Days to Die. It holds the power resources, so it
    // cannot interleave — but it never evicted, so running it while Project Zomboid was
    // up put two worlds on the box and said nothing. Quietly stopping someone's world
    // in the middle of a "check for updates" is the wrong repair; refusing is right.
    const a = admitStart({ game: "7dtd", running: ["zomboid"], mayEvict: false });
    expect(a.decision).toBe("refuse");
    expect(a.evict).toEqual([]);
    expect(a.message).toContain("Project Zomboid");
    expect(a.message).toContain("7 Days to Die");
  });

  it("does not treat the requested world as something to evict or refuse over", () => {
    // Starting a world that is already up is a no-op, not co-residency, and both
    // `powerOn` and `powerOff` answer that case before admission specifically so it
    // holds no resources and pre-empts no backups.
    expect(admitStart({ game: "zomboid", running: ["zomboid"], mayEvict: false })).toEqual({
      decision: "start",
      evict: [],
      message: null,
    });
    expect(admitStart({ game: "zomboid", running: ["zomboid"], mayEvict: true }).decision).toBe(
      "start"
    );
  });

  it("names every other world, not just the first", () => {
    const a = admitStart({ game: "minecraft", running: ["7dtd", "zomboid"], mayEvict: false });
    expect(a.message).toContain("7 Days to Die");
    expect(a.message).toContain("Project Zomboid");
  });
});

describe("assertSoleWorld", () => {
  it("throws a CoResidencyError naming the blocker", () => {
    expect(() => assertSoleWorld({ game: "7dtd", running: ["zomboid"] })).toThrow(CoResidencyError);
    try {
      assertSoleWorld({ game: "7dtd", running: ["zomboid"], what: "The update" });
    } catch (e) {
      expect((e as Error).message).toContain("Project Zomboid");
      expect((e as Error).message).toContain("The update");
    }
  });

  it("is a no-op when this world is the only one up, or nothing is", () => {
    expect(() => assertSoleWorld({ game: "7dtd", running: [] })).not.toThrow();
    expect(() => assertSoleWorld({ game: "7dtd", running: ["7dtd"] })).not.toThrow();
  });
});

describe("refuseCoResidency", () => {
  // The Docker probe is injected, which is the only reason this is testable at all
  // without a running box — and is the seam `docs/OPERATIONS.md` names as what
  // `game-manager`'s eviction logic still lacks.
  it("probes every other world and throws when one is up", async () => {
    const asked: GameId[] = [];
    await expect(
      refuseCoResidency("7dtd", async (g) => {
        asked.push(g);
        return g === "zomboid";
      })
    ).rejects.toThrow(/Project Zomboid/);
    expect(asked).toContain("minecraft");
    expect(asked).toContain("zomboid");
    // Never the world being started: whether *it* is up is the caller's business, and
    // asking would make "already running" look like co-residency.
    expect(asked).not.toContain("7dtd");
  });

  it("resolves quietly when the box is otherwise empty", async () => {
    await expect(refuseCoResidency("7dtd", async () => false)).resolves.toBeUndefined();
  });

  it("treats a failed probe as not-running rather than refusing the operation", async () => {
    // A `docker inspect` that errors must not become a refusal: that would make an
    // unrelated Docker hiccup block the update path, and the guard's job is to catch a
    // world that is *observably* up.
    await expect(
      refuseCoResidency("7dtd", async () => {
        throw new Error("docker: no such container");
      })
    ).resolves.toBeUndefined();
  });
});
