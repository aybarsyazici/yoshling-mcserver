import { describe, expect, it } from "vitest";
import { record } from "./helpers/record";

describe("modpack summaries use recorded lifecycle", () => {
  it("says the server is starting again after a verified restart, without asking for another", async () => {
    const result = await record({ kind: "mods.apply", game: "minecraft", title: "Installing a modpack", resources: ["power", "files:minecraft"] }, async op => {
      op.step("Installing mods");
      op.settle("Installed 2 mods", { count: { done: 2, total: 2, noun: "mods" } });
      op.fact({ label: "Server", value: "starting again" });
      op.fact({ label: "Power", value: "running" });
      return { value: null };
    });
    expect(result.outcome).toBe("ok");
    expect(result.summary).toContain("Minecraft is starting again");
    expect(result.summary).not.toContain("Restart Minecraft");
  });
  it("states a deliberately stopped server remains off", async () => {
    const result = await record({ kind: "mods.apply", game: "minecraft", title: "Installing a modpack", resources: ["power", "files:minecraft"] }, async op => {
      op.step("Installing mods");
      op.settle("Installed 2 mods", { count: { done: 2, total: 2, noun: "mods" } });
      op.fact({ label: "Server", value: "left powered off" });
      op.fact({ label: "Power", value: "powered off" });
      return { value: null };
    });
    expect(result.outcome).toBe("ok");
    expect(result.summary).toContain("Minecraft is powered off");
    expect(result.summary).not.toContain("Restart Minecraft");
  });
  it("makes a partial install's stopped state visible alongside the failed count", async () => {
    const result = await record({ kind: "mods.apply", game: "minecraft", title: "Installing a modpack", resources: ["power", "files:minecraft"] }, async op => {
      op.step("Installing mods");
      op.settle("Installed 1 of 2 mods", { count: { done: 1, total: 2, noun: "mods" } });
      op.fact({ label: "Server", value: "left powered off" });
      op.fact({ label: "Power", value: "powered off" });
      op.fact({ label: "Failed", value: "one download failed", verdict: "warn" });
      return { value: null };
    });
    expect(result.outcome).toBe("partial");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("Minecraft is powered off");
  });

  it("reports the final power observation when an operation fails after starting", async () => {
    const result = await record({ kind: "mods.apply", game: "minecraft", title: "Installing", resources: ["power", "files:minecraft"] }, async op => {
      op.step("Starting the server");
      op.fact({ label: "Power", value: "running" });
      op.fact({ label: "Power", value: "powered off" });
      throw new Error("The server exited before the final check");
    });
    expect(result.outcome).toBe("failed");
    expect(result.summary).toContain("Minecraft is powered off");
    expect(result.summary).not.toContain("Minecraft is running");
  });
});
