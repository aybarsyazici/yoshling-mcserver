import { describe, expect, it } from "vitest";
import { minecraftJoinTarget, parseJoinInfo } from "@/lib/join-info";

describe("player-safe join evidence", () => {
  it.each(["26.1.2", "1.21.4", "1.21.5-rc1", "25w10a"])("accepts exact %s targets and projects only client fields", mcVersion => {
    expect(minecraftJoinTarget({ mcVersion, loader: "fabric", secret: "fixture-only" })).toEqual({ mcVersion, loader: "fabric" });
  });
  it.each([null, {}, { mcVersion: "LATEST", loader: "fabric" }, { mcVersion: "SNAPSHOT", loader: "fabric" }, { mcVersion: "26.1.2" }, { mcVersion: "26.1.2", loader: "" }, { mcVersion: 26.1, loader: "fabric" }])("rejects aliases and incomplete targets", target => {
    expect(minecraftJoinTarget(target)).toBeNull();
  });
  const checked = { game: "minecraft", targetStatus: "checked", target: { mcVersion: "26.1.2", loader: "fabric" }, checkedAt: 123 };
  it("accepts checked target and explicit unknown independently", () => {
    expect(parseJoinInfo(checked, "minecraft")).toEqual(checked);
    const unknown = { game: "zomboid", targetStatus: "unknown", target: null, checkedAt: 123 };
    expect(parseJoinInfo(unknown, "zomboid")).toEqual(unknown);
  });
  it.each([
    { ...checked, game: "zomboid" }, { ...checked, target: null }, { ...checked, checkedAt: "123" },
    { ...checked, checkedAt: Infinity }, { ...checked, checkedAt: 0 }, { ...checked, targetStatus: "unknown" },
  ])("rejects mismatched, malformed and contradictory receipts", value => {
    expect(parseJoinInfo(value, "minecraft")).toBeNull();
  });
});
