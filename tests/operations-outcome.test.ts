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
    // a power operation is admitted OVER it (by design — Restart must never be blocked by
    // a four-minute backup), and `admit()` marks the backup.
    //
    // `admit()` used to set that flag with nothing anywhere reading it, so a backup a
    // Power off ran straight through still concluded `ok` and published
    // "Backup created — 198 MB, world map included." as a restore point, for an archive
    // taken across a save-and-shutdown boundary.
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
      { kind: "power", game: "minecraft", title: "Starting the server", action: "start" },
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
});
