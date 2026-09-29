import { describe, it, expect } from "vitest";
import {
  POWER_RESOURCES,
  evictionIndex,
  finishedTtlFor,
  runOperation,
  type OperationResource,
} from "@/lib/operations";

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

/**
 * What admission does to a backup that is already running.
 *
 * `admit()` marks every live operation sharing a resource `preempted`, and the three
 * backup-create routes throw on that flag and delete their own archive. So the set of
 * resources a power operation declares decides which finished archives survive it.
 * Measured on production 2026-09-29, with `power` declaring every world's file lane:
 * a `start zomboid` that changed nothing at all destroyed a 304 MB 7 Days to Die
 * archive, and two more (~600 MB) went the same way earlier that afternoon while 7DTD
 * had been `Exited (0)` for two minutes and nothing had opened its files.
 */
describe("what a power operation pre-empts", () => {
  /** A fake backup that parks until released, and reports what it saw. */
  function parkedBackup(game: "minecraft" | "7dtd" | "zomboid") {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: { preempted?: boolean } = {};
    const done = runOperation(
      { kind: "backup.create", game, title: "Creating a backup" },
      async (op) => {
        await gate;
        seen.preempted = op.preempted;
        return { value: null };
      }
    );
    return { release, seen, done };
  }

  async function powerStart(
    game: "minecraft" | "7dtd" | "zomboid",
    resources?: OperationResource[]
  ) {
    await runOperation(
      { kind: "power", game, action: "start", title: `Starting ${game}`, resources },
      async () => ({ value: null })
    );
  }

  it("leaves a backup of a world it does not touch alone", async () => {
    const backup = parkedBackup("7dtd");
    await powerStart("zomboid");
    backup.release();
    await backup.done;
    expect(backup.seen.preempted).toBe(false);
  });

  it("still pre-empts a backup of the world it is about to stop", async () => {
    const backup = parkedBackup("zomboid");
    await powerStart("zomboid");
    backup.release();
    await backup.done;
    expect(backup.seen.preempted).toBe(true);
  });

  it("pre-empts everything when a caller really does declare the whole box", async () => {
    // `/api/7dtd/update`, `/api/7dtd/reset` and the Workshop seed pass POWER_RESOURCES
    // explicitly and must keep the broad lock.
    const backup = parkedBackup("7dtd");
    await powerStart("zomboid", POWER_RESOURCES);
    backup.release();
    await backup.done;
    expect(backup.seen.preempted).toBe(true);
  });

  it("pre-empts nothing when the start refuses before touching anything", async () => {
    // `powerOn`'s two already-running branches now answer with `resources: []`, so a
    // start that changes nothing — including the one that *fails* — cannot invalidate a
    // backup. The failing branch is the one that was still doing damage after `powerOff`
    // had been fixed the same way.
    const backup = parkedBackup("7dtd");
    await expect(
      runOperation(
        {
          kind: "power",
          game: "zomboid",
          action: "start",
          title: "Starting Project Zomboid",
          resources: [],
        },
        async (op) => {
          op.step("Checking Project Zomboid");
          op.reject("Project Zomboid is already running but not answering");
          throw new Error("Project Zomboid is already running — it just isn't responding yet.");
        }
      )
    ).rejects.toThrow(/already running/);
    backup.release();
    await backup.done;
    expect(backup.seen.preempted).toBe(false);
  });
});
