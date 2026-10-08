import { describe, expect, it } from "vitest";
import { readMinecraftProfileWorldSettings, setMinecraftProfileWorldSettings, validateMinecraftProfileWorldSettings } from "@/lib/minecraft-profile-world-settings";

describe("profile world settings are explicit gameplay controls", () => {
  it.each(["online-mode", "server-port", "server-ip", "level-name", "rcon.password", "enable-rcon", "management-server-enabled", "arbitrary-key"])("refuses %s instead of allowing an override to change host identity/security", key => {
    expect(() => validateMinecraftProfileWorldSettings({ [key]: "fixture" })).toThrow("not an editable");
  });
  it.each([{ "max-players": "0" }, { "view-distance": "99" }, { difficulty: "unknown" }, { hardcore: "1" }, { motd: "first\nrcon.password=fixture" }, { motd: 2 }])("refuses invalid values %j", value => {
    expect(() => validateMinecraftProfileWorldSettings(value)).toThrow();
  });
  it("retains unrelated/locked bytes and uses canonical escaping on applied world keys", () => {
    const original = "# ordinary fixture\nonline-mode=true\nrcon.password=ordinary-placeholder\nmotd=Old\nlevel-type=minecraft\\:normal\n";
    const updated = setMinecraftProfileWorldSettings(original, { motd: " New ", "level-type": "minecraft:flat" });
    expect(updated.text).toContain("online-mode=true\nrcon.password=ordinary-placeholder");
    expect(readMinecraftProfileWorldSettings(updated.text)).toEqual({ motd: "New", "level-type": "minecraft:flat" });
    expect(updated.applied).toEqual(["motd", "level-type"]);
  });
});
