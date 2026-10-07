import { describe, expect, it } from "vitest";
import { record } from "./helpers/record";

describe("single mod registry conclusions", () => {
  it("names a verified install without describing it as a pack", async () => {
    const result = await record({ kind: "mods.install", game: "minecraft", title: "Installing Waystones" }, async op => {
      op.step("Writing the mod");
      op.settle("Wrote the jar and inventory", { count: { done: 1, total: 1, noun: "mod" } });
      op.fact({ label: "Mod", value: "Waystones" });
      return { value: null };
    });
    expect(result.outcome).toBe("ok");
    expect(result.resources).toEqual(["files:minecraft"]);
    expect(result.summary).toContain("Installed Waystones");
    expect(result.summary).not.toMatch(/pack/i);
  });
  it("says a dependency refusal failed before installing anything", async () => {
    const result = await record({ kind: "mods.install", game: "minecraft", title: "Installing Waystones" }, async op => {
      op.reject("Balm could not be verified. Nothing was installed");
      return { value: null };
    });
    expect(result.outcome).toBe("failed");
    expect(result.summary).toContain("Balm could not be verified");
    expect(result.summary).not.toMatch(/modpack/i);
  });
});
