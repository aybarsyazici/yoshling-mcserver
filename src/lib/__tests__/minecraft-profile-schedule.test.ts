import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ selected: "a", args: [] as unknown[][], checks: 0, changeOnProbe: false, changeOnAdmission: false }));
vi.mock("../minecraft-active-profile", () => {
  class MinecraftActiveProfileError extends Error {}
  return { MinecraftActiveProfileError,
    minecraftActiveContext: async () => ({ profileId: f.selected, token: f.selected, root: `/minecraft/${f.selected}`, schemaReady: true }),
    assertMinecraftProfileCurrent: async (context: { profileId: string }) => { f.checks++; if (context.profileId !== f.selected) throw new MinecraftActiveProfileError("profile changed"); },
  };
});
vi.mock("../minecraft-profile-backups", () => ({ minecraftBackupDirectory: async (context: { profileId: string }) => `/backups/${context.profileId}` }));
vi.mock("../backup-store", () => ({ BACKUP_DIRS: { minecraft: "/backups/legacy", "7dtd": "/backups/sdtd", zomboid: "/backups/pz" }, listArchives: async () => [] }));
vi.mock("../game-manager", () => ({ getGameStatus: async (game: string) => {
  if (game !== "minecraft") return { status: "starting", players: { online: 1 } };
  if (f.changeOnProbe) f.selected = "b";
  return { status: "online", players: { online: 0 } };
} }));
vi.mock("../backup-create", () => ({ createBackup: async (...args: unknown[]) => {
  f.args.push(args);
  if (f.changeOnAdmission) f.selected = "b";
  const { assertMinecraftProfileCurrent } = await import("../minecraft-active-profile");
  if (args[2]) await assertMinecraftProfileCurrent(args[2] as never);
  return { backup: { name: "fixture" }, pruned: [] };
} }));
const { runScheduledBackups, scheduleState } = await import("../backup-schedule");
beforeEach(() => { f.selected = "a"; f.args = []; f.checks = 0; f.changeOnProbe = false; f.changeOnAdmission = false; });
describe("scheduled backups bind the profile they reviewed", () => {
  it("passes the captured profile into admitted creation", async () => {
    await runScheduledBackups();
    expect(f.args).toHaveLength(1); expect(f.args[0][2]).toMatchObject({ profileId: "a" });
  });
  it("skips when selection changes during the player probe", async () => {
    f.changeOnProbe = true; await runScheduledBackups(); expect(f.args).toEqual([]);
  });
  it("does not apply failure cooldown for a stale decision at admission", async () => {
    f.changeOnAdmission = true; await runScheduledBackups();
    expect(f.args[0][2]).toMatchObject({ profileId: "a" }); expect(scheduleState("minecraft").lastFailedAtMs).toBe(0);
  });
});
