import { describe, expect, it } from "vitest";
import { buildConfigChangeReview } from "@/lib/config-change-review";
import { NEXT_WORLD_LABEL } from "@/lib/live-settings";
import { CREATION_ONLY_NOTE } from "@/lib/sandbox-lua";

const minecraft = { game: "minecraft" as const, endpoint: "/api/server/properties" };
const zomboid = { game: "zomboid" as const, endpoint: "/api/zomboid/config" };
const sandbox = {
  game: null,
  endpoint: "/api/zomboid/sandbox?scope=world",
  restartNote: "Restart Project Zomboid to apply.",
};

function property(name: string, value: string, help = "Setting help") {
  return { name, value, help };
}

describe("configuration change review", () => {
  it("reviews only changed loaded settings in file order, even across a partial draft", () => {
    const properties = [
      property("difficulty", "normal"),
      property("motd", "Hello"),
      property("max-players", "20"),
      property("missing", "Keep this"),
    ];
    expect(buildConfigChangeReview(properties, {
      "max-players": "25",
      difficulty: "normal",
      motd: "Welcome",
      unloaded: "Ignore this",
    }, minecraft)).toEqual([
      { name: "motd", before: "Hello", after: "Welcome", secret: false, effect: null },
      { name: "max-players", before: "20", after: "25", secret: false, effect: null },
    ]);
  });

  it("keeps exact file changes rather than treating numeric or whitespace edits as unchanged", () => {
    const properties = [property("MaxPlayers", "20"), property("PublicName", "Yoshling")];
    const rows = buildConfigChangeReview(properties, {
      MaxPlayers: "020",
      PublicName: " Yoshling ",
    }, zomboid);
    expect(rows.map((row) => [row.before, row.after])).toEqual([
      ["20", "020"],
      ["Yoshling", " Yoshling "],
    ]);
  });

  it("ignores inherited draft keys and leaves the loaded snapshot and draft untouched", () => {
    const properties = Object.freeze([Object.freeze(property("MaxPlayers", "20"))]);
    const inherited = Object.freeze(Object.create({ MaxPlayers: "99" }) as Record<string, string>);
    expect(buildConfigChangeReview(properties, inherited, zomboid)).toEqual([]);
    const draft = Object.freeze({ MaxPlayers: "25" });
    expect(buildConfigChangeReview(properties, draft, zomboid)).toHaveLength(1);
    expect(properties[0].value).toBe("20");
    expect(draft.MaxPlayers).toBe("25");
  });

  it("shows empty values explicitly without losing zero, false, or whitespace strings", () => {
    const properties = [
      property("motd", ""), property("server-ip", "127.0.0.1"),
      property("zero", "1"), property("boolean", "true"), property("spaces", ""),
    ];
    const rows = buildConfigChangeReview(properties, {
      motd: "Welcome", "server-ip": "", zero: "0", boolean: "false", spaces: " ",
    }, minecraft);
    expect(rows.map((row) => [row.before, row.after])).toEqual([
      ["(empty)", "Welcome"], ["127.0.0.1", "(empty)"],
      ["1", "0"], ["true", "false"], ["(empty)", " "],
    ]);
  });

  it.each(["ServerPassword", "rcon.PASSWD", "DiscordToken", "auth.SECRET"])(
    "masks both sides of %s and omits secret-bearing help from the returned record",
    (name) => {
      const before = "original-private-value";
      const after = "replacement-private-value";
      const rows = buildConfigChangeReview([property(name, before, before)], { [name]: after }, zomboid);
      expect(rows).toEqual([{ name, before: "Hidden", after: "Hidden", secret: true, effect: null }]);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(before);
      expect(serialized).not.toContain(after);
    }
  );

  it("masks an empty secret when it is added or removed, and omits an unchanged secret", () => {
    expect(buildConfigChangeReview([
      property("Password", ""), property("DiscordToken", "old-token"), property("Secret", "same-secret"),
    ], { Password: "new-password", DiscordToken: "", Secret: "same-secret" }, zomboid)).toEqual([
      { name: "Password", before: "Hidden", after: "Hidden", secret: true, effect: null },
      { name: "DiscordToken", before: "Hidden", after: "Hidden", secret: true, effect: null },
    ]);
  });

  it("does not hide ordinary PZ settings whose name contains pass", () => {
    expect(buildConfigChangeReview([property("SafehouseAllowTrepass", "true")], {
      SafehouseAllowTrepass: "false",
    }, zomboid)).toEqual([
      { name: "SafehouseAllowTrepass", before: "true", after: "false", secret: false, effect: null },
    ]);
  });

  it.each([
    { context: minecraft, name: "level-seed" },
    { context: minecraft, name: "initial-enabled-packs" },
    { context: { game: "7dtd" as const, endpoint: "/api/7dtd/config/all" }, name: "GameWorld" },
    { context: { game: "7dtd" as const, endpoint: "/api/7dtd/config/all" }, name: "gamename" },
    { context: zomboid, name: "ResetID" },
  ])("uses the existing next-world contract before a general restart note ($name)", ({ context, name }) => {
    const [row] = buildConfigChangeReview([property(name, "old")], { [name]: "new" }, {
      ...context, restartNote: "Restart to apply.",
    });
    expect(row.effect).toBe(NEXT_WORLD_LABEL);
  });

  it.each(["StartYear", "StartMonth", "StartDay", "StartTime"])(
    "uses the sandbox creation-only explanation for %s with no live game identity",
    (name) => {
      const [row] = buildConfigChangeReview([property(name, "1")], { [name]: "2" }, sandbox);
      expect(row.effect).toBe(CREATION_ONLY_NOTE);
    }
  );

  it("keeps sandbox and INI effect contracts separate even if a game identity is provided", () => {
    const rows = buildConfigChangeReview([property("ResetID", "1"), property("ServerPlayerID", "old")], {
      ResetID: "2", ServerPlayerID: "new",
    }, { game: "zomboid", endpoint: "/api/zomboid/sandbox?scope=mods" });
    expect(rows.map((row) => row.effect)).toEqual([null, null]);
    const [ini] = buildConfigChangeReview([property("StartYear", "1993")], { StartYear: "1994" }, zomboid);
    expect(ini.effect).toBeNull();
  });

  it("carries a panel restart note for normal options and unknown game identities", () => {
    const [pz] = buildConfigChangeReview([property("DayLength", "3")], { DayLength: "4" }, sandbox);
    expect(pz.effect).toBe(sandbox.restartNote);
    const [unknown] = buildConfigChangeReview([property("CustomOption", "old")], { CustomOption: "new" }, {
      game: null, endpoint: "/api/custom-config", restartNote: "Restart this service to apply.",
    });
    expect(unknown.effect).toBe("Restart this service to apply.");
  });

  it.each(["ServerPlayerID", "RCONPort", "defaultport"])(
    "names the required restart for PZ INI %s without claiming a live reload for other settings",
    (name) => {
      const rows = buildConfigChangeReview([property(name, "old"), property("MaxPlayers", "20")], {
        [name]: "new", MaxPlayers: "25",
      }, zomboid);
      expect(rows.map((row) => row.effect)).toEqual(["Needs a restart to take effect.", null]);
    }
  );

  it("does not apply a PZ restart rule to other games or claim an effect without evidence", () => {
    const [mc] = buildConfigChangeReview([property("ServerPlayerID", "old")], { ServerPlayerID: "new" }, minecraft);
    expect(mc.effect).toBeNull();
    const [unknown] = buildConfigChangeReview([property("level-seed", "old")], { "level-seed": "new" }, {
      game: null, endpoint: "/api/custom-config",
    });
    expect(unknown.effect).toBeNull();
  });
});
