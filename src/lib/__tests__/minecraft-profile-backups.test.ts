import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
const f = vi.hoisted(() => ({ root: `${process.env.TMPDIR || "/tmp"}/profile-backups-${process.pid}-${Date.now()}`, legacy: false }));
vi.mock("../backup-store", () => ({ BACKUP_DIRS: { minecraft: f.root } }));
vi.mock("../minecraft-profile-store", () => ({ getMinecraftProfile: async (id: string) => ({ id, sourceKind: f.legacy ? "legacy" : "vanilla" }), getMinecraftDataRoot: vi.fn(), readMinecraftRuntime: vi.fn() }));
const { minecraftBackupDirectory, assertMinecraftArchiveProfile, minecraftBackupJournalScope } = await import("../minecraft-profile-backups");
const context = { profileId: "11111111-1111-4111-8111-111111111111", revision: "r", token: "t", root: "/minecraft", schemaReady: true };
beforeEach(async () => { f.legacy = false; await rm(f.root, { recursive: true, force: true }); await mkdir(f.root, { recursive: true }); });
afterEach(async () => await rm(f.root, { recursive: true, force: true }));
describe("profile backup ownership", () => {
  it("separates new profile archives", async () => expect(await minecraftBackupDirectory(context)).toContain(`/profiles/${context.profileId}`));
  it("retains existing archives for the adopted legacy profile", async () => { f.legacy = true; expect(await minecraftBackupDirectory(context)).toBe(f.root); });
  it("refuses another profile's manifest", async () => await expect(assertMinecraftArchiveProfile(context, { createdAt: "now", minecraftProfileId: "other" })).rejects.toThrow(/another/));
  it("refuses unowned archives in fresh profiles", async () => await expect(assertMinecraftArchiveProfile(context, null)).rejects.toThrow(/no profile identity/));
  it("allows legacy unowned archives only for adoption", async () => { f.legacy = true; await expect(assertMinecraftArchiveProfile(context, null)).resolves.toBeUndefined(); });
  it("does not allow a profile backup directory to alias another namespace", async () => {
    await mkdir(path.join(f.root, "outside")); await mkdir(path.join(f.root, "profiles"));
    await symlink(path.join(f.root, "outside"), path.join(f.root, "profiles", context.profileId));
    await expect(minecraftBackupDirectory(context)).rejects.toThrow(/separate/);
  });
  it("scopes journal history and includes untagged rows only for adoption", async () => {
    expect(await minecraftBackupJournalScope(context)).toEqual({ id: context.profileId, includeLegacy: false });
    f.legacy = true; expect(await minecraftBackupJournalScope(context)).toEqual({ id: context.profileId, includeLegacy: true });
  });
});
