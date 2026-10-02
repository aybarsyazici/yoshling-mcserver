import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
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
