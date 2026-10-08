import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * **A routine Minecraft backup, written by real `tar` and read back out of the archive.**
 *
 * Added alongside the change that gave `install-modpack`'s pre-apply archive a second
 * member, because the thing that needed defending was the one that did **not** change:
 * routine backups stay world-only. They run on a schedule against a world measured at
 * 217 MB, so quietly folding an unchanged mods directory into every one of them would grow
 * every archive and the retention pressure with it, for a copy of something nothing is
 * about to delete.
 *
 * The assertion is on `tar -tzf`, not on the argv the route passed — the archive's contents
 * are the claim the manifest makes, and `GET /api/server/backups` answers `includesMods`
 * off the manifest without ever opening the tar. The two disagreeing is precisely the state
 * that would tell someone a restore brings their jars back when it would not.
 */

const DIRS = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const root = `${base}/yoshling-create-mc-${process.pid}-${Date.now()}`;
  return { root, mc: `${root}/minecraft`, backups: `${root}/backups` };
});

/** Minecraft is `exited exit=0` on this box most of the time; `true` exercises the flush. */
let serverRunning = false;
const sendCommand = vi.fn(async () => "");

vi.mock("@/lib/game-manager", () => ({
  RUNTIME: {
    minecraft: { dir: DIRS.mc },
    "7dtd": { dir: `${DIRS.root}/sevendtd` },
    zomboid: { dir: `${DIRS.root}/zomboid` },
  },
  containerIsRunning: vi.fn(async () => serverRunning),
}));
vi.mock("@/lib/rcon", () => ({ sendCommand }));
vi.mock("@/lib/telnet", () => ({ sdtdSaveWorld: vi.fn(async () => {}) }));
vi.mock("@/lib/zomboid", () => ({
  pzSave: vi.fn(async () => {}),
  savePaths: vi.fn(async () => ({ name: "servertest", world: "", db: "", serverDir: "" })),
}));

vi.mock("@/lib/backup-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup-store")>();
  return {
    ...actual,
    BACKUP_DIRS: {
      minecraft: DIRS.backups,
      "7dtd": `${DIRS.root}/backups-7dtd`,
      zomboid: `${DIRS.root}/backups-zomboid`,
    },
  };
});

const journalled: { game: string; event: string }[] = [];
vi.mock("@/lib/backup-log", () => ({
  recordBackupEvent: vi.fn(async (game: string, event: string) => {
    journalled.push({ game, event });
  }),
}));

const { createBackup } = await import("@/lib/backup-create");

beforeEach(async () => {
  vi.clearAllMocks();
  serverRunning = false;
  journalled.length = 0;
  await rm(DIRS.root, { recursive: true, force: true });
  await mkdir(DIRS.mc, { recursive: true });
});

afterEach(async () => {
  await rm(DIRS.root, { recursive: true, force: true });
});

async function put(relative: string, contents: string): Promise<void> {
  const target = path.join(DIRS.mc, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf-8");
}

/** The archive's top-level member names, read out of the archive itself. */
async function members(name: string): Promise<string[]> {
  const { stdout } = await execFileAsync("tar", ["-tzf", path.join(DIRS.backups, name)]);
  return [
    ...new Set(
      stdout
        .split("\n")
        .filter(Boolean)
        .map((entry) => entry.replace(/^\.\//, "").split("/")[0])
    ),
  ].sort();
}

async function manifest(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(DIRS.backups, `${name}.manifest.json`), "utf-8")
  ) as Record<string, unknown>;
}

describe("a routine Minecraft backup", () => {
  it("archives actual world files when world is a contained alias", async () => {
    await put("contained-world/level.dat", "saved world fixture");
    await symlink("contained-world", path.join(DIRS.mc, "world"));
    const { backup } = await createBackup("minecraft", { userId: "u1", name: "Tester" });
    const extracted = path.join(DIRS.root, "readback");
    await mkdir(extracted);
    await execFileAsync("tar", ["-xzf", path.join(DIRS.backups, backup.name), "-C", extracted]);
    expect(await readFile(path.join(extracted, "world", "level.dat"), "utf-8")).toBe("saved world fixture");
    expect(await members(backup.name)).toEqual(["world"]);
  });

  it("refuses an out-of-volume world alias before publishing an archive", async () => {
    const external = path.join(DIRS.root, "outside");
    await mkdir(external);
    await writeFile(path.join(external, "fixture.txt"), "outside fixture");
    await symlink(external, path.join(DIRS.mc, "world"));
    await expect(createBackup("minecraft", { userId: "u1", name: "Tester" })).rejects.toThrow(
      "outside the configured game volume"
    );
    expect(await readFile(path.join(external, "fixture.txt"), "utf-8")).toBe("outside fixture");
    expect(await readdir(DIRS.backups).catch(() => [])).toEqual([]);
  });

  it("refuses escaping links within a world before publishing an archive", async () => {
    await put("world/level.dat", "saved world");
    const external = path.join(DIRS.root, "outside.txt");
    await writeFile(external, "outside fixture");
    await symlink(external, path.join(DIRS.mc, "world", "escaping.txt"));
    await expect(createBackup("minecraft", { userId: "u1", name: "Tester" })).rejects.toThrow(
      "outside the configured game volume"
    );
    expect(await readFile(external, "utf-8")).toBe("outside fixture");
    expect(await readdir(DIRS.backups).catch(() => [])).toEqual([]);
  });

  it("archives world/ and nothing else, even with a full mods directory on disk", async () => {
    await put("world/level.dat", "saved world");
    await put("mods/fabric-api.jar", "a jar nothing is about to delete");
    await put("logs/latest.log", "noise");

    const { backup } = await createBackup("minecraft", { userId: "u1", name: "Tester" });

    expect(await members(backup.name)).toEqual(["world"]);
    expect(backup.size).toBeGreaterThan(0);
  });

  /**
   * The drift guard, and the reason the member list is one variable in `createMinecraft`
   * rather than two literals: the listing reads `members` off the manifest and never opens
   * the tar, so the two are only ever as honest as the thing that writes both.
   */
  it("records exactly the members the archive turned out to hold", async () => {
    await put("world/level.dat", "saved world");
    await put("mods/fabric-api.jar", "a jar");

    const { backup } = await createBackup("minecraft", { userId: "u1", name: "Tester" });

    const m = await manifest(backup.name);
    expect(m.members).toEqual(["world"]);
    expect(m.members).toEqual(await members(backup.name));
  });

  it("seals the archive with a checksum and its byte count", async () => {
    await put("world/level.dat", "saved world");
    const { backup } = await createBackup("minecraft", { userId: "u1", name: "Tester" });
    const m = await manifest(backup.name);
    expect(String(m.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(m.archiveBytes).toBe(backup.size);
    // A stopped server's files are already at rest, which is the best case for a backup —
    // `flushed: true` with no RCON call, not `false`.
    expect(m.flushed).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(journalled).toEqual([{ game: "minecraft", event: "create" }]);
  });

  it("flushes and pauses autosave when the server is up, and resumes it", async () => {
    serverRunning = true;
    await put("world/level.dat", "saved world");
    await createBackup("minecraft", { userId: "u1", name: "Tester" });
    expect(sendCommand.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "save-off",
      "save-all flush",
      "save-on",
    ]);
  });

  /**
   * `tar -czf … -C MC_DIR world` exits non-zero when there is no world, and the `catch`
   * deletes the truncated archive and its sidecar — so the listing cannot offer it as a
   * restore point. Kept here because it is the behaviour the pre-apply archive's
   * `archiveMembersPresent` probe exists to avoid reaching.
   */
  it("writes nothing at all when there is no world", async () => {
    await put("mods/fabric-api.jar", "a jar");
    await expect(createBackup("minecraft", { userId: "u1", name: "Tester" })).rejects.toThrow();
    const { readdir } = await import("fs/promises");
    expect(await readdir(DIRS.backups).catch(() => [])).toEqual([]);
  });
});

/**
 * **A destructive operation must not prune the safety nets it is not responsible for.**
 *
 * `sealArchive` runs `applyRetention` by default, which is correct for a scheduled backup.
 * Increment 3 routed the modpack apply's pre-apply archive through it to gain a manifest and a
 * journal entry — and silently gained the pruning too, so pressing **Apply** would delete other
 * archives beyond `keep`. Its own brief said not to change retention behaviour; a reviewer
 * caught it. The archive is a side effect of a different operation and has no business
 * enforcing a retention policy.
 */
describe("sealArchive's prune option", () => {
  it("is opt-out, and the modpack apply opts out", async () => {
    const src = await readFile(
      new URL("../../app/api/mods/install-modpack/route.ts", import.meta.url),
      "utf-8"
    );
    // The call, and the opt-out inside it — not merely both strings present somewhere.
    const call = src.slice(src.indexOf("sealArchive(op, {"));
    const body = call.slice(0, call.indexOf("});"));
    expect(body).toContain("prune: false");
  });

  it("still prunes by default, so routine backups are unchanged", async () => {
    const src = await readFile(new URL("../backup-create.ts", import.meta.url), "utf-8");
    // `opts.prune === false` and nothing looser: `!opts.prune` would turn an omitted option
    // into no-pruning and quietly stop every scheduled backup from retaining.
    expect(src).toContain("opts.prune === false");
    expect(src).not.toMatch(/if \(!opts\.prune\)/);
  });
});

vi.mock("@/lib/minecraft-active-profile", async () => {
  const { legacyMinecraftContextMock } = await import("./fixtures/legacy-minecraft-context");
  return legacyMinecraftContextMock(() => DIRS.mc);
});
