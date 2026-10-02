import { describe, expect, it } from "vitest";
import { record } from "./helpers/record";

/**
 * `concludeOperation` — the honesty contract.
 *
 * The documented recurring defect of this codebase is "reports success after doing
 * nothing or the wrong thing", and this function is the single place that is supposed to
 * make that impossible: the sentence no longer decides the colour, the recorded steps and
 * facts do. Every case below is a shape that has actually occurred on the box.
 */
describe("concludeOperation", () => {
  it("a clean run with evidence is ok", async () => {
    const rec = await record(
      { kind: "settings", game: "minecraft", title: "Changing a setting" },
      async (op) => {
        op.step("Patching compose");
        op.settle("Patched compose");
        return {
          facts: [
            { label: "Configured", value: "6G" },
            { label: "Container", value: "6G" },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("ok");
  });

  it("a genuine warn fact is partial, not ok", async () => {
    const rec = await record(
      { kind: "power", game: "zomboid", title: "Stopping the server", action: "stop" },
      async (op) => {
        op.step("Stopping");
        op.settle("Stopped");
        return {
          facts: [
            { label: "Power", value: "powered off" },
            { label: "Shutdown", value: "killed after 300s", verdict: "warn" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("partial");
  });

  it("a bad fact is failed even though nothing threw", async () => {
    // The shape that matters: the work "succeeded" and the read-back afterwards said
    // otherwise. A route cannot downgrade this, which is the point.
    const rec = await record(
      { kind: "backup.create", game: "7dtd", title: "Creating a backup" },
      async (op) => {
        op.step("Compressing");
        op.settle("Compressed");
        return {
          facts: [
            { label: "Size", value: "12 MB" },
            { label: "Archive", value: "not found after the move", verdict: "bad" as const },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("failed");
  });

  it("every step a noop is nothing", async () => {
    const rec = await record(
      { kind: "power", game: "minecraft", title: "Stopping the server", action: "stop" },
      async (op) => {
        op.step("Saving and stopping");
        op.settle("Minecraft was already stopped — nothing to save or stop", { kind: "noop" });
        return { facts: [{ label: "Power", value: "already stopped" }], value: null };
      }
    );
    expect(rec.outcome).toBe("nothing");
  });

  it("0 of a real total is nothing, even with other steps that did work", async () => {
    // The modpack apply that installed 0 of 166 and toasted green.
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Reading the pack");
        op.settle("Read the pack");
        op.step("Installing");
        op.settle("Installed 0 of 166 mods", {
          kind: "noop",
          count: { done: 0, total: 166, noun: "mods" },
        });
        return { facts: [{ label: "Mods", value: "0 installed" }], value: null };
      }
    );
    expect(rec.outcome).toBe("nothing");
  });

  it("a step that made real progress is never 'nothing', even if settled noop", async () => {
    // Pins the `madeProgress` guard. Without it, one step settling
    // "Installed 142 of 166" as a noop satisfied "every step is a noop" and the record
    // claimed 142 downloaded mods had changed nothing.
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Installing");
        op.settle("Installed 142 of 166 mods", {
          kind: "noop",
          count: { done: 142, total: 166, noun: "mods" },
        });
        return { facts: [{ label: "Mods", value: "142 installed" }], value: null };
      }
    );
    expect(rec.outcome).not.toBe("nothing");
    expect(rec.outcome).toBe("partial");
  });

  it("a noop step next to real progress does not erase the progress", async () => {
    // The second half of the same guard: a "Removed the current mods" step that settled
    // 0 of 3 followed by a full 166-mod install concluded `nothing`, and the summary read
    // "finished in 4m 12s, but nothing changed. 166 of 166 mods were installed."
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Removing the current mods");
        op.settle("Removed 0 of 3 mods", { kind: "noop", count: { done: 0, total: 3, noun: "mods" } });
        op.step("Installing");
        op.settle("Installed 166 of 166 mods", { count: { done: 166, total: 166, noun: "mods" } });
        return { facts: [{ label: "Mods", value: "166 installed" }], value: null };
      }
    );
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).not.toMatch(/nothing changed/i);
  });

  it("finishing without reading anything back is unverified, not ok", async () => {
    const rec = await record(
      { kind: "settings", game: "7dtd", title: "Changing a setting" },
      async (op) => {
        op.step("Writing the XML");
        op.settle("Wrote the XML");
        return { value: null };
      }
    );
    expect(rec.outcome).toBe("unverified");
  });

  it("a thrown error is failed whatever was recorded before it", async () => {
    const rec = await record(
      { kind: "backup.restore", game: "zomboid", title: "Restoring a backup" },
      async (op) => {
        op.step("Extracting");
        op.settle("Extracted");
        op.fact({ label: "Archive", value: "zomboid-yoshling.tar.gz" });
        throw new Error("cp: no space left on device");
      }
    );
    expect(rec.outcome).toBe("failed");
  });

  it("op.reject with no step open still fails, and does not read as unverified", async () => {
    // `/api/7dtd/reset` validates its input before opening a step. With nothing recorded
    // the record used to conclude `unverified`, so a *refused* request was told to go and
    // inspect a world list.
    const rec = await record(
      { kind: "world.reset", game: "7dtd", title: "Resetting the world" },
      async (op) => {
        op.reject("No world name was given");
        return { value: null };
      }
    );
    expect(rec.outcome).toBe("failed");
  });

  it("a backup a power operation ran through is failed, not a restore point", async () => {
    // Real pre-emption, not a stubbed flag: a live `backup.create` holds `files:zomboid`,
    // a power operation that *also* holds `files:zomboid` is admitted OVER it (by design —
    // Restart must never be blocked by a four-minute backup), and `admit()` marks the
    // backup.
    //
    // `admit()` used to set that flag with nothing anywhere reading it, so a backup a
    // Power off ran straight through still concluded `ok` and published
    // "Backup created — 198 MB, world map included." as a restore point, for an archive
    // taken across a save-and-shutdown boundary.
    //
    // The `resources` are given EXPLICITLY, and that is the point of this test rather than
    // an incidental detail. It first asserted pre-emption for a *Minecraft* power op over
    // a *Zomboid* backup, which passed only because `DEFAULT_RESOURCES.power` claimed
    // every file lane on the box — so starting one world destroyed another world's
    // backup. Narrowing that default was a fix, and this test turned it red: it had
    // pinned the bug rather than the property. What it should pin is a real hand-off,
    // where Project Zomboid is the *outgoing* world and its lane genuinely is taken.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedWork = new Promise<void>((r) => (reached = r));

    const backup = record(
      { kind: "backup.create", game: "zomboid", title: "Creating a backup" },
      async (op) => {
        op.step("Copying the world");
        reached();
        await gate;
        op.settle("Copied the world");
        return { facts: [{ label: "Size", value: "198 MB" }], value: null };
      }
    );
    await reachedWork;

    await record(
      {
        kind: "power",
        game: "minecraft",
        title: "Starting the server",
        action: "start",
        // What the real `powerOn` passes: its own lane plus every world it is about to
        // evict. Zomboid is being stopped, so its backup really is running across a
        // save-and-shutdown boundary.
        resources: ["power", "files:minecraft", "files:zomboid"],
      },
      async (op) => {
        op.step("Starting");
        op.settle("Started");
        return { facts: [{ label: "Power", value: "running" }], value: null };
      }
    );

    release();
    const rec = await backup;

    expect(rec.preempted).toBe(true);
    expect(rec.outcome).toBe("failed");
    expect(rec.summary).not.toMatch(/restore point/i);
  });

  it("a power operation on one world leaves another world's backup alone", () =>
    // The complement of the test above, and the one that was missing. Nothing pinned it,
    // which is why narrowing `DEFAULT_RESOURCES.power` looked like a regression instead
    // of the fix it was: the old default claimed every `files:` lane, so starting
    // Minecraft marked a Project Zomboid backup pre-empted and deleted a completed
    // 290 MiB archive. Observed on production during the 2026-09-29 exercise run — a
    // `power start zomboid` with `steps: []` holding all three lanes, and the
    // `backup.create 7dtd` it killed 105 s earlier.
    //
    // A backup is only collateral for a world the power operation actually touches.
    new Promise<void>(async (done) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const reachedWork = new Promise<void>((r) => (reached = r));

      const backup = record(
        { kind: "backup.create", game: "zomboid", title: "Creating a backup" },
        async (op) => {
          op.step("Copying the world");
          reached();
          await gate;
          op.settle("Copied the world");
          return { facts: [{ label: "Size", value: "198 MB" }], value: null };
        }
      );
      await reachedWork;

      // Minecraft starting with nothing to evict: its own lane only.
      await record(
        {
          kind: "power",
          game: "minecraft",
          title: "Starting the server",
          action: "start",
          resources: ["power", "files:minecraft"],
        },
        async (op) => {
          op.step("Starting");
          op.settle("Started");
          return { facts: [{ label: "Power", value: "running" }], value: null };
        }
      );

      release();
      const rec = await backup;

      expect(rec.preempted).toBeFalsy();
      expect(rec.outcome).toBe("ok");
      done();
    }));
});

/**
 * The modpack installer's step shapes, now that it is allowed to leave mods out.
 *
 * Driven through the real `runOperation` rather than asserted from the route, which needs
 * `auth()`, Prisma, a mods directory and Modrinth. What is under test is the thing the
 * route cannot see for itself: **what the registry concludes from the steps it records.**
 * Both of these were got wrong in the first draft of the filtering change, in opposite
 * directions, and neither would have shown up as a failing request.
 */
describe("install-modpack's step shapes after client-only filtering", () => {
  /**
   * The one that matters most. A pack where every server-side mod installed and the
   * client-only ones were left out is a clean success — `ok`, green.
   *
   * Settling the plan step `noop` because `plan.length < modpack.mods.length` would make
   * this `partial`, i.e. every correct apply of every real pack (30-50% client mods)
   * summarised as something having gone wrong. That is the backup-`noop` regression this
   * suite was created over, wearing new clothes.
   */
  it("concludes ok when the only shortfall is client-only mods", async () => {
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Checking which mods run on a server");
        op.settle("Checked which mods run on a server — 40 are client-only", {
          count: { done: 126, total: 166, noun: "to install" },
        });
        op.step("Downloading mods");
        // `total` is the server-side count, not the pack's row count — see
        // `serverModTotal`. 126 of 126 is the complete case.
        op.settle("Installed 126 of 126 mods", {
          kind: "done",
          count: { done: 126, total: 126, noun: "mods" },
        });
        return {
          facts: [
            { label: "Installed", value: "126 of 126" },
            // No `verdict: "warn"` on the skip fact, deliberately: a warn fact alone is
            // enough to force `partial`, so tagging a correct decision would repaint every
            // apply amber by a different route than the `noop` above.
            { label: "Skipped as client-only", value: "40 — Sodium, Iris Shaders" },
          ],
          value: null,
        };
      }
    );
    expect(rec.outcome).toBe("ok");
    expect(rec.summary).not.toMatch(/nothing changed|missing|partial/i);
  });

  /**
   * The refusal path: a pack where nothing runs on a server must not summarise as though
   * mods were attempted and lost.
   *
   * The route reaches here with "Read the modpack list" already settled at a **non-zero**
   * count, which is what makes this subtle. `concludeOperation` only reaches outcome
   * `nothing` through `zeroOfSomething`, and that rule is guarded by `!madeProgress` — so
   * a `noop` settle here falls through to the `partial` rule and summarises *"Installed 0
   * of 45 server mods; 45 failed."*, calling 45 client-only mods failures when not one was
   * attempted. The complement case below pins that reading, so the two cannot be confused
   * again.
   */
  it("concludes failed, with the reason, when no mod in the pack runs on a server", async () => {
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Reading the modpack list");
        op.settle("Read the modpack list: 45 mods", {
          count: { done: 45, total: 45, noun: "installable" },
        });
        op.step("Checking which mods run on a server");
        op.reject("No mod in this pack runs on a server");
        return { value: null };
      }
    );
    expect(rec.outcome).toBe("failed");
    // The summary has to carry the REASON, not just the failure: "installing a modpack
    // failed" with no cause is what sends someone to the container logs for a pack that
    // was simply client-side.
    expect(rec.summary).toMatch(/No mod in this pack runs on a server/);
  });

  /**
   * Why that branch is a `reject` and not a `noop` settle — the mis-marking it replaced,
   * pinned with the sentence it produces. Anyone "tidying" the refusal into a count-shaped
   * step gets this test's explanation rather than having to rediscover it.
   */
  it("would call untried client-only mods failures if the refusal were a noop count", async () => {
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Reading the modpack list");
        op.settle("Read the modpack list: 45 mods", {
          count: { done: 45, total: 45, noun: "installable" },
        });
        op.step("Checking which mods run on a server");
        op.settle("Checked which mods run on a server — none of them run on one", {
          kind: "noop",
          count: { done: 0, total: 45, noun: "server mods" },
        });
        return { value: null };
      }
    );
    // Not `nothing`: the earlier step's non-zero count sets `madeProgress`, which guards
    // the `zeroOfSomething` rule.
    expect(rec.outcome).toBe("partial");
    expect(rec.summary).toMatch(/45 failed/);
  });

  /**
   * The trap that produced the first draft's bug, stated directly: a second `settle` on a
   * closed step is silently discarded, so a corrective marking after a `done` settle does
   * nothing at all.
   */
  it("silently discards a second settle on an already-settled step", async () => {
    const rec = await record(
      { kind: "mods.apply", game: "minecraft", title: "Installing a modpack" },
      async (op) => {
        op.step("Checking which mods run on a server");
        op.settle("Checked which mods run on a server", {
          count: { done: 0, total: 45, noun: "to install" },
        });
        // Intended to mark the refusal. Records nothing — there is no live step left.
        op.settle("Nothing in this pack runs on a server", {
          kind: "noop",
          count: { done: 0, total: 45, noun: "server mods" },
        });
        return { value: null };
      }
    );
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0].kind).toBe("done");
    expect(rec.steps[0].label).toBe("Checked which mods run on a server");
    // The consequence, measured: a refusal that changed nothing reports that it finished
    // and could not be checked, and sends the reader to the installed-mods list.
    expect(rec.outcome).toBe("unverified");
    expect(rec.summary).toMatch(/nothing could be read back/);
  });
});
