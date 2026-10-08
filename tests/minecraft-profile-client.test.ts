import { describe, expect, it } from "vitest";
import { isMinecraftProfile, parseMinecraftProfiles, parseMinecraftProfileDetail, parseProfileWorldSettings, profileSourceLabel, profileLastPlayed } from "@/lib/minecraft-profiles-client";
import { profileFixture, profilesFixture, secondProfile, worldSettingsFixture } from "./helpers/minecraft-profiles";

describe("client profile admission", () => {
  it("accepts exact vanilla and modded targets without changing data", () => { const value = profilesFixture(); expect(parseMinecraftProfiles(value)).toBe(value); expect(isMinecraftProfile(secondProfile)).toBe(true); });
  it.each([null, [], {}, { profiles: [] }, profilesFixture({ capabilities: { read: true } as never }), profilesFixture({ profiles: [profileFixture(), profileFixture()] }), profilesFixture({ runtime: { ...profilesFixture().runtime, appliedProfileId: "missing" } })])("refuses incomplete or ambiguous collection %j", value => expect(parseMinecraftProfiles(value)).toBeNull());
  it.each([
    { id: "../world" }, { name: "" }, { status: "online" }, { revision: -1 }, { revision: 1.5 }, { createdAt: "unknown" }, { lastPlayedAt: "not a date" }, { modCount: -1 },
    { target: { ...secondProfile.target, mcVersion: "" } }, { target: { ...secondProfile.target, loader: "unknown" } }, { target: { ...secondProfile.target, javaVariant: "latest" } },
    { coverUrl: "https://outside.example/world.png" }, { coverUrl: "/api/minecraft/profiles/p1/cover-extra" }, { coverUrl: "/api/minecraft/profiles/p2/cover" },
  ])("refuses invalid profile field %j", over => expect(isMinecraftProfile(profileFixture(over as never))).toBe(false));
  it("admits only the profile's own authenticated cover URL", () => expect(isMinecraftProfile(profileFixture({ coverUrl: "/api/minecraft/profiles/p1/cover?revision=2" }))).toBe(true));
  it("binds detail to the requested ID", () => { const list = profilesFixture(); expect(parseMinecraftProfileDetail({ profile: secondProfile, runtime: list.runtime, capabilities: list.capabilities }, "p1")).toBeNull(); });
  it.each([{ profileId: "other" }, { properties: { difficulty: 3 } }, { editableKeys: ["difficulty", "difficulty"] }, { worldGenerated: "false" }])("refuses incomplete settings %j", over => expect(parseProfileWorldSettings(worldSettingsFixture(over as never), "p2")).toBeNull());
  it("admits sparse fresh settings without inventing values for allowed or locked keys", () => { const value = worldSettingsFixture({ properties: {}, editableKeys: ["difficulty", "level-seed"], lockedKeys: ["rcon.password"] }); expect(parseProfileWorldSettings(value, "p2")).toBe(value); expect(value.properties).toEqual({}); });
  it("keeps creation-only seed strings exact", () => { const settings = worldSettingsFixture(); expect(parseProfileWorldSettings(settings, "p2")?.properties["level-seed"]).toBe("1234567890123456789"); });
  it("uses canonical pack title and distinguishes unplayed from last updated", () => { expect(profileSourceLabel(secondProfile)).toBe("Adventure Published Pack"); expect(profileLastPlayed(secondProfile)).toBe("Not recorded"); });
});
