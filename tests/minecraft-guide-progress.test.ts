import { describe, expect, it, vi } from "vitest";
import { MINECRAFT_GUIDE_CHAPTER_IDS, defaultMinecraftGuideProgress, minecraftGuideStorageKey, parseMinecraftGuideProgress, saveMinecraftGuideProgress, type MinecraftGuideProgress } from "@/lib/minecraft-guide-progress";
const progress = (over: Partial<MinecraftGuideProgress> = {}): MinecraftGuideProgress => ({ version: 1, current: "mods", completed: ["play", "welcome", "profiles", "welcome"], ...over });
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
describe("Minecraft guide progress validation", () => {
  it("defines the canonical chapter order and returns independent defaults", () => {
    expect(MINECRAFT_GUIDE_CHAPTER_IDS).toEqual(["welcome", "profiles", "play", "mods", "backups", "settings", "covers", "server"]);
    const first = defaultMinecraftGuideProgress(), second = defaultMinecraftGuideProgress();
    expect(first).toEqual({ version: 1, current: "welcome", completed: [] }); first.completed.push("mods"); expect(second.completed).toEqual([]);
  });
  it.each([null, "", "not json", "null", "[]", "1", '"welcome"', "{}", JSON.stringify({ version: 2, current: "mods", completed: [] }), JSON.stringify({ version: "1", current: "mods", completed: [] }), JSON.stringify({ version: 1, current: "unknown", completed: [] }), JSON.stringify({ version: 1, current: "mods", completed: ["unknown"] }), JSON.stringify({ version: 1, current: "mods", completed: ["welcome", 1] }), JSON.stringify({ version: 1, current: ["mods"], completed: [] }), JSON.stringify({ version: 1, current: "mods", completed: "welcome" })])("uses a safe default for malformed or unknown records %j", raw => {
    expect(parseMinecraftGuideProgress(raw)).toEqual(defaultMinecraftGuideProgress());
  });
  it("rejects oversized input before parsing and accepts the exact limit", () => {
    const raw = JSON.stringify(progress());
    expect(parseMinecraftGuideProgress(raw.padEnd(2048))).toEqual({ version: 1, current: "mods", completed: ["welcome", "profiles", "play"] });
    expect(parseMinecraftGuideProgress(raw.padEnd(2049))).toEqual(defaultMinecraftGuideProgress());
  });
  it("deduplicates completed IDs into canonical order without mutating the input", () => {
    const input = progress(), before = structuredClone(input);
    expect(parseMinecraftGuideProgress(JSON.stringify(input))).toEqual({ version: 1, current: "mods", completed: ["welcome", "profiles", "play"] }); expect(input).toEqual(before);
  });
  it("retains every known current chapter, including its exact lowercase identity", () => {
    for (const id of MINECRAFT_GUIDE_CHAPTER_IDS) expect(parseMinecraftGuideProgress(JSON.stringify(progress({ current: id }))).current).toBe(id);
    expect(parseMinecraftGuideProgress(JSON.stringify(progress({ current: "MODS" as never })))).toEqual(defaultMinecraftGuideProgress());
  });
  it("persists only progress fields and drops unrelated input metadata", () => {
    const storage = memoryStorage(); const input = { ...progress(), unrelated: "fixture-only" };
    expect(saveMinecraftGuideProgress(storage, "user-one", input)).toBe(true);
    expect(storage.values.get(minecraftGuideStorageKey("user-one"))).toBe('{"version":1,"current":"mods","completed":["welcome","profiles","play"]}');
  });
});
describe("Minecraft guide local storage receipts", () => {
  it("round trips a canonical record with an exact readback", () => {
    const storage = memoryStorage(), input = progress();
    expect(saveMinecraftGuideProgress(storage, "user-one", input)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledOnce(); expect(storage.getItem).toHaveBeenCalledWith(minecraftGuideStorageKey("user-one"));
    expect(parseMinecraftGuideProgress(storage.values.get(minecraftGuideStorageKey("user-one"))!)).toEqual({ version: 1, current: "mods", completed: ["welcome", "profiles", "play"] });
    expect(input.completed).toEqual(["play", "welcome", "profiles", "welcome"]);
  });
  it("scopes v1 records to each exact user without key collisions", () => {
    const storage = memoryStorage(); const users = ["user-one", "user-two", "a:b", "a%3Ab", "a/b", " a/b "];
    expect(new Set(users.map(minecraftGuideStorageKey)).size).toBe(users.length);
    expect(minecraftGuideStorageKey("user-one")).toContain("minecraft-guide:v1:");
    expect(saveMinecraftGuideProgress(storage, users[0], progress())).toBe(true); expect(saveMinecraftGuideProgress(storage, users[1], progress({ current: "backups", completed: [] }))).toBe(true);
    expect(parseMinecraftGuideProgress(storage.getItem(minecraftGuideStorageKey(users[0]))).current).toBe("mods"); expect(parseMinecraftGuideProgress(storage.getItem(minecraftGuideStorageKey(users[1]))).current).toBe("backups");
  });
  it.each(["", "  ", "x".repeat(257), "bad\nidentity", "\u0000"])("refuses an invalid user identity without a write %j", user => {
    const storage = memoryStorage(); expect(saveMinecraftGuideProgress(storage, user, progress())).toBe(false); expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("refuses invalid progress without replacing an existing valid record", () => {
    const storage = memoryStorage(); expect(saveMinecraftGuideProgress(storage, "user-one", progress())).toBe(true); storage.setItem.mockClear();
    expect(saveMinecraftGuideProgress(storage, "user-one", { version: 2, current: "mods", completed: [] } as never)).toBe(false); expect(storage.setItem).not.toHaveBeenCalled();
    expect(parseMinecraftGuideProgress(storage.getItem(minecraftGuideStorageKey("user-one"))).current).toBe("mods");
  });
  it("returns false when storage refuses the write", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error("quota"); }) };
    expect(saveMinecraftGuideProgress(storage, "user-one", progress())).toBe(false); expect(storage.getItem).not.toHaveBeenCalled();
  });
  it("returns false when the published value cannot be read", () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn(() => { throw new Error("blocked"); }) };
    expect(saveMinecraftGuideProgress(storage, "user-one", progress())).toBe(false); expect(storage.setItem).toHaveBeenCalledOnce();
  });
  it.each([null, "", JSON.stringify(defaultMinecraftGuideProgress()), '{"current":"mods","completed":["welcome","profiles","play"],"version":1}'])("requires exact serialized readback after publication %j", value => {
    const storage = { setItem: vi.fn(), getItem: vi.fn(() => value) };
    expect(saveMinecraftGuideProgress(storage, "user-one", progress())).toBe(false); expect(storage.setItem).toHaveBeenCalledOnce();
  });
});
