import { describe, it, expect } from "vitest";
import { runOperation, listOperations } from "@/lib/operations";
import { parseOperationsPoll } from "@/lib/operations-poll";
import { liveFileOperations, powerBlocker } from "@/lib/operation-ui";
describe("overview operation integration", () => {
  it("accepts its strict ledger row and leaves game power/file warnings available", async () => {
    await runOperation({ kind: "profile.overview", game: "minecraft", title: "Rendering Minecraft world overview" }, async op => {
      const rows = listOperations(["minecraft"]), row = rows.find(item => item.id === op.id)!;
      expect(row.resources).toEqual(["render:minecraft-overview"]); expect(row.holdsPower).toBe(false);
      expect(parseOperationsPoll({ serverNow: Date.now(), operations: [row], finished: [] })).not.toBeNull();
      expect(liveFileOperations([row])).toEqual([]); expect(powerBlocker([row], "minecraft")).toBeUndefined();
      expect(parseOperationsPoll({ serverNow: Date.now(), operations: [{ ...row, resources: ["unknown-render"] }], finished: [] })).toBeNull();
      op.step("Reading the generated result"); op.settle("Generated image read back"); op.fact({ label: "Overview", value: "Generated world overview published and read back" });
      return { value: undefined };
    });
  });
});
