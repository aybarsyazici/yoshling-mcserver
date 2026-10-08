import { describe, it, expect } from "vitest";
import { minecraftProfilePackBuilds } from "../minecraft-profile-sources";
import type { ModrinthVersion } from "../modrinth";
const build = (id: string, date: string, mcVersion = "1.20.1"): ModrinthVersion => ({ id, project_id: "pack", name: `Friends ${id}`, version_number: id, game_versions: [mcVersion], loaders: ["forge"], date_published: date, downloads: 0, dependencies: [], files: [{ filename: "friends.mrpack", primary: true, url: "https://cdn.modrinth.com/friends", size: 100, hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) } }] });
describe("published profile pack choices", () => {
  it("keeps all declared targets independent of the active server and sorts newest first", () => {
    const choices = minecraftProfilePackBuilds("pack", [build("old", "2025-01-01"), build("new", "2026-01-01", "1.21.1")]);
    expect(choices.map(choice => choice.id)).toEqual(["new", "old"]); expect(choices[1]).toMatchObject({ mcVersions: ["1.20.1"], loaders: ["forge"], supported: true });
  });
  it("does not offer an unverified download as supported", () => {
    const value = build("old", "2025-01-01"); value.files[0].hashes.sha512 = "";
    expect(minecraftProfilePackBuilds("pack", [value])[0]).toMatchObject({ supported: false, reason: expect.any(String) });
  });
  it("rejects a foreign project's build or incomplete metadata", () => {
    expect(() => minecraftProfilePackBuilds("other", [build("old", "2025-01-01")])).toThrow(/incomplete/);
    expect(() => minecraftProfilePackBuilds("pack", [{ ...build("old", "2025-01-01"), date_published: "unknown" }])).toThrow(/incomplete/);
  });
});
