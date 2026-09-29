import { describe, expect, it } from "vitest";
import { record } from "./helpers/record";

/**
 * `summarize` — the one sentence the ledger AND the completion toast both show.
 *
 * The toast shows nothing else, so a wrong sentence here is the whole of what a user is
 * told. Three separate blockers came out of this function, all of the same shape: a
 * branch keyed on the operation-wide `outcome` making a specific factual claim its own
 * facts did not support. `docs/OPERATIONS.md` states the rule — select on the fact you
 * are actually about — and these tests are that rule, executable.
 */
describe("summarize: a clean backup of a stopped server", () => {
  /**
   * The exact shape the three backup routes record when the world is already down, which
   * on this box is the NORMAL case: Minecraft and 7 Days to Die are both usually stopped.
   *
   * The regression this pins: the flush step was settled `noop` ("nothing to flush, the
   * server is stopped"), `concludeOperation` turns any `noop` into `partial`, and the
   * `partial` branch of `backup.create` then printed "but part of it is missing. This is
   * not a restore point." in amber — for a flawless archive, on the everyday path. The
   * routes now settle that step `done`, because a stopped server's files are already at
   * rest, which is the BEST case for a backup and not a shortfall.
   */
  it("is ok and is described as a restore point", async () => {
    const rec = await record(
      { kind: "backup.create", game: "minecraft", title: "Creating a backup" },
      async (op) => {
        op.step("Flushing the world to disk");
        // `done`, not `noop` — this is the line the fix changed.
        op.settle("The server is stopped — its files are already at rest");
        op.step("Compressing the archive");
        op.settle("Wrote the archive — 217 MB");
        return {
          facts: [
            { label: "Size", value: "217 MB" },
            { label: "World map", value: "included" },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("ok");
    expect(rec.summary).toBe("Backup created — 217 MB, world map included.");
    expect(rec.summary).not.toMatch(/not a restore point/i);
    expect(rec.summary).not.toMatch(/part of it is missing/i);
  });

  /**
   * The other half of the same fix, and the reason it cannot be left to route authors.
   *
   * A `partial` with NO warn fact has no evidence that anything is missing, so the
   * sentence must not say anything is. Before this, the fallback string
   * "part of it is missing" fired whenever `warnText` was empty — which is precisely the
   * noop-step case above. Pinning it here means the honesty of the sentence no longer
   * depends on every future route author remembering not to use `noop`.
   */
  it("a partial with no warn fact does not claim the archive is incomplete", async () => {
    const rec = await record(
      { kind: "backup.create", game: "7dtd", title: "Creating a backup" },
      async (op) => {
        op.step("Flushing the saves to disk");
        op.settle("Nothing to flush", { kind: "noop" });
        op.step("Compressing the archive");
        op.settle("Wrote the archive — 480 MB");
        return {
          facts: [
            { label: "Size", value: "480 MB" },
            { label: "World map", value: "included" },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).not.toMatch(/not a restore point/i);
    expect(rec.summary).not.toMatch(/part of it is missing/i);
    expect(rec.summary).toContain("480 MB");
  });

  it("a genuinely map-less archive IS called out as not a restore point", async () => {
    // The claim is allowed — required, even — when a fact actually supports it. A 4 MB
    // config-only archive looks entirely plausible in the backups list and is the one
    // thing you cannot restore a world from.
    // The Project Zomboid route's real sequence, which matters: a lone noop step would
    // make the whole operation conclude `nothing` and short-circuit before the
    // `backup.create` branch is ever reached. The config copy really does happen.
    const rec = await record(
      { kind: "backup.create", game: "zomboid", title: "Creating a backup" },
      async (op) => {
        op.step("Copying the world");
        op.settle("No world on disk yet — nothing to copy", { kind: "noop" });
        op.step("Copying the server config");
        op.settle("Copied the server config", { count: { done: 4, noun: "files" } });
        op.step("Compressing the archive");
        op.settle("Wrote the archive — 4 MB");
        return {
          facts: [
            { label: "Size", value: "4 MB" },
            { label: "World map", value: "not included", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/world map isn't in it/i);
    expect(rec.summary).toMatch(/not a restore point/i);
  });
});

describe("summarize: a hand-off names the world the fact is about", () => {
  /**
   * Today's blocker, and the rule `docs/OPERATIONS.md` records for it.
   *
   * A hand-off is ONE operation whose `game` is the world coming UP; it records a
   * `Shutdown` fact about the world going DOWN. Before `OperationFact.game` existed the
   * summary took the name from `entry.game` and produced, verbatim on production,
   * "Minecraft — started in 5m 04s, but it had to be killed after 300s" — for a Minecraft
   * that `docker events` shows was only ever started, and booted in 450 ms. It blamed the
   * arriving world for the departing world's SIGKILL and handed it the five minutes the
   * other world spent refusing to exit, sending anyone reading it to the wrong container.
   */
  it("attributes the kill to the outgoing world, not the arriving one", async () => {
    const rec = await record(
      { kind: "power", game: "7dtd", title: "Starting the server", action: "start" },
      async (op) => {
        op.step("Saving Project Zomboid", { game: "zomboid" });
        op.settle("Saved Project Zomboid");
        op.step("Stopping Project Zomboid", { game: "zomboid" });
        op.settle("Stopped Project Zomboid");
        op.step("Starting 7 Days to Die", { game: "7dtd" });
        op.settle("Started 7 Days to Die");
        return {
          facts: [
            { label: "Power", value: "running" },
            {
              label: "Shutdown",
              value: "killed after 300s",
              verdict: "warn" as const,
              game: "zomboid" as const,
            },
          ],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/Switched to 7 Days to Die/);
    expect(rec.summary).toMatch(/Project Zomboid had to be killed after 300s/);
    // The precise failure: the arriving world must not be the thing that was killed.
    expect(rec.summary).not.toMatch(/7 Days to Die had to be killed/);
    expect(rec.summary).not.toMatch(/7 Days to Die — started in .*killed/);
  });

  it("falls back to the step tags when the fact carries no world", async () => {
    // The steps have always been tagged per world and have always been right; only the
    // derived sentence was wrong. A fact without a `game` must still not blame the
    // arriving world.
    const rec = await record(
      { kind: "power", game: "minecraft", title: "Starting the server", action: "start" },
      async (op) => {
        op.step("Stopping Project Zomboid", { game: "zomboid" });
        op.settle("Stopped Project Zomboid");
        op.step("Starting Minecraft", { game: "minecraft" });
        op.settle("Started Minecraft");
        return {
          facts: [
            { label: "Power", value: "running" },
            { label: "Shutdown", value: "killed after 300s", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/Project Zomboid had to be killed after 300s/);
    expect(rec.summary).not.toMatch(/Minecraft had to be killed/);
  });

  it("a clean hand-off credits the switch, and says the other world stopped first", async () => {
    const rec = await record(
      { kind: "power", game: "zomboid", title: "Starting the server", action: "start" },
      async (op) => {
        op.step("Stopping 7 Days to Die", { game: "7dtd" });
        op.settle("Stopped 7 Days to Die");
        op.step("Starting Project Zomboid", { game: "zomboid" });
        op.settle("Started Project Zomboid");
        return {
          facts: [
            { label: "Power", value: "running" },
            // A clean stop records `Shutdown` too — with NO verdict. Read unconditionally
            // this produced "but it had to be exited cleanly (code 0)".
            { label: "Shutdown", value: "exited cleanly (code 0)" },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("ok");
    expect(rec.summary).toMatch(/Switched to Project Zomboid/);
    expect(rec.summary).toMatch(/7 Days to Die stopped first/);
    expect(rec.summary).not.toMatch(/had to be exited cleanly/);
  });
});

describe("summarize: no template makes a claim its facts do not support", () => {
  /**
   * Every Project Zomboid stop used to record `Shutdown: killed after 300s` as a warn, so
   * EVERYTHING that stops PZ concluded `partial`. Each of the three cases below is a
   * `partial` branch that then fired for a reason that had nothing to do with it.
   */
  it("a restore that IS restarting the world does not say it stayed powered off", async () => {
    const rec = await record(
      { kind: "backup.restore", game: "zomboid", title: "Restoring a backup" },
      async (op) => {
        op.step("Replacing the save");
        op.settle("Replaced the save");
        return {
          facts: [
            { label: "Archive", value: "zomboid-yoshling.tar.gz" },
            // `withGameStopped` records this specifically to answer "is the world coming
            // back?", and it is the ONLY thing that may decide that clause.
            { label: "Server", value: "starting again" },
            { label: "Shutdown", value: "killed after 300s", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).toMatch(/The server is starting again/);
    expect(rec.summary).not.toMatch(/stayed powered off/);
    // The unrelated warn still has to be said — as its own clause, not as the verdict.
    expect(rec.summary).toMatch(/killed after 300s/);
  });

  it("a restore that really did leave the world down says so", async () => {
    const rec = await record(
      { kind: "backup.restore", game: "zomboid", title: "Restoring a backup" },
      async (op) => {
        op.step("Replacing the save");
        op.settle("Replaced the save");
        return {
          facts: [
            { label: "Archive", value: "zomboid-yoshling.tar.gz" },
            { label: "Server", value: "left stopped" },
          ],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/stayed powered off/);
    expect(rec.summary).not.toMatch(/starting again/);
  });

  it("a successful memory change does not claim the values disagree", async () => {
    // It said "The configured and running values disagree" while quoting two identical
    // values — inverting the one read-back the docs call never-wrong, next to a green
    // toast from the same request saying the opposite.
    const rec = await record(
      { kind: "settings", game: "zomboid", title: "Changing the memory setting" },
      async (op) => {
        op.step("Recreating the container");
        op.settle("Recreated the container");
        return {
          facts: [
            { label: "Setting", value: "Memory" },
            { label: "Configured", value: "12288m" },
            // No verdict: compose and the container agree. The `warn` is added by
            // `recordEnvApplied` if and only if they differ.
            { label: "Container", value: "12288m" },
            { label: "Shutdown", value: "killed after 300s", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).not.toMatch(/disagree/);
    expect(rec.summary).toMatch(/12288m/);
    expect(rec.summary).toMatch(/killed after 300s/);
  });

  it("a genuinely mismatched setting DOES say the values disagree", async () => {
    const rec = await record(
      { kind: "settings", game: "minecraft", title: "Changing the memory setting" },
      async (op) => {
        op.step("Recreating the container");
        op.settle("Recreated the container");
        return {
          facts: [
            { label: "Configured", value: "6G" },
            { label: "Container", value: "4G", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/disagree/);
  });

  it("a fully successful 89-mod update keeps its count instead of reporting the SIGKILL", async () => {
    // The flagship operation summarised as the bare fragment "killed after 300s. The
    // container is up…", losing the count and reading as a failure.
    const rec = await record(
      { kind: "mods.update", game: "zomboid", title: "Updating the mods" },
      async (op) => {
        op.step("Downloading from Steam");
        op.settle("Downloaded 89 of 89 mods", { count: { done: 89, total: 89, noun: "mods" } });
        return {
          facts: [
            { label: "Power", value: "running" },
            { label: "Shutdown", value: "killed after 300s", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).toMatch(/89 mods updated/);
    expect(rec.summary).toMatch(/the server is back up/);
    // It must not be reduced to the unrelated warn.
    expect(rec.summary).not.toMatch(/^killed after 300s/);
  });

  it("a short download reports how many failed", async () => {
    const rec = await record(
      { kind: "mods.update", game: "zomboid", title: "Updating the mods" },
      async (op) => {
        op.step("Downloading from Steam");
        op.settle("Downloaded 88 of 89 mods", {
          count: { done: 88, total: 89, noun: "mods" },
        });
        return { facts: [{ label: "Power", value: "running" }], value: null };
      }
    );
    expect(rec.summary).toMatch(/Downloaded 88 of 89 mods — 1 failed/);
  });
});

describe("summarize: failures", () => {
  it("names where the power was left, because nothing revives Project Zomboid", async () => {
    const rec = await record(
      { kind: "backup.restore", game: "zomboid", title: "Restoring a backup" },
      async (op) => {
        op.step("Replacing the save");
        op.fact({ label: "Power", value: "powered off" });
        throw new Error("tar: unexpected end of file");
      }
    );
    expect(rec.outcome).toBe("failed");
    expect(rec.summary).toMatch(/Project Zomboid is powered off/);
  });

  it("does not state the power twice when the reason already names it", async () => {
    // "…is already running — it just isn't responding yet. Use Restart if it stays that
    // way. Project Zomboid is still running." says the same thing twice and reads as a
    // contradiction. Observed twice on the live box, and that string is also the toast.
    const rec = await record(
      { kind: "power", game: "zomboid", title: "Starting the server", action: "start" },
      async (op) => {
        op.step("Starting");
        op.fact({ label: "Power", value: "still running" });
        throw new Error(
          "Project Zomboid is already running — it just isn't responding yet. Use Restart if it stays that way."
        );
      }
    );
    expect(rec.summary).toMatch(/already running/);
    expect(rec.summary).not.toMatch(/Project Zomboid is still running\./);
    // And no doubled period from the error's own trailing one.
    expect(rec.summary).not.toMatch(/\.\./);
  });

  it("a modpack failure does not send you to the power page", async () => {
    // A modpack install does not touch power, and telling someone to check it is noise
    // pointing at the wrong page.
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Installing");
        throw new Error("no download source for 224 mods");
      }
    );
    expect(rec.summary).not.toMatch(/power state/i);
  });

  it("falls back to the bad fact when nothing threw", async () => {
    // "the operation failed" was the whole sentence when a read-back said
    // `not found after the move` — the most useful thing anyone could have been told.
    const rec = await record(
      { kind: "backup.create", game: "7dtd", title: "Creating a backup" },
      async (op) => {
        op.step("Moving the archive");
        op.settle("Moved the archive");
        return {
          facts: [{ label: "Archive", value: "not found after the move", verdict: "bad" as const }],
          value: null,
        };
      }
    );
    expect(rec.summary).toMatch(/not found after the move/);
    expect(rec.summary).not.toMatch(/the operation failed/);
  });
});

describe("summarize: nothing happened", () => {
  it("a power request against a world already in that state says so plainly", async () => {
    // Before the guard in `powerOff`, this case read the PREVIOUS run's `State.ExitCode`
    // and fabricated a save, a stop and a `Shutdown` verdict — a 135 ms operation claiming
    // "killed after 300s" — plus a durable Activity row for work that never happened.
    const rec = await record(
      { kind: "power", game: "minecraft", title: "Stopping the server", action: "stop" },
      async (op) => {
        op.step("Saving and stopping");
        op.settle("Minecraft was already stopped — nothing to save or stop", { kind: "noop" });
        return { facts: [{ label: "Power", value: "already stopped" }], value: null };
      }
    );
    expect(rec.outcome).toBe("nothing");
    expect(rec.summary).toBe("Nothing to do — Minecraft was already already stopped.");
    expect(rec.summary).not.toMatch(/killed after/);
  });

  it("never prints a count against an unknown total", async () => {
    // "0 of undefined files" is the kind of sentence that makes a reader distrust
    // everything else on the row.
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Installing");
        op.settle("Installed nothing", { kind: "noop", count: { done: 0, noun: "mods" } });
        return { value: null };
      }
    );
    expect(rec.summary).not.toMatch(/undefined/);
  });
});
