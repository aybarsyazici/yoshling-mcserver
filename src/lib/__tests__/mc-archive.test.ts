import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { BadArchiveError } from "../backup-archive";
import {
  archiveMembersPresent,
  describeMembers,
  manifestIncludesMods,
  MC_ARCHIVE_MEMBERS,
  restoreMinecraftArchive,
} from "../mc-archive";

const execFileAsync = promisify(execFile);

/**
 * **Real `tar`, real directories, real renames.**
 *
 * The thing under test is a round trip, and the dangerous half of it is invisible to any
 * assertion on arguments: `/api/mods/install-modpack` now tars `world` **and** `mods`
 * before it deletes every installed jar, and the restore it is backed by extracted every
 * member into a staging dir, renamed **only** `world` into place, and `rm -rf`-ed the
 * staging dir in its `finally`. So a two-member archive would have restored, answered
 * `{success: true}`, and discarded the mods — this repo's named defect class, produced by
 * one half of a two-part fix.
 *
 * Nothing here is mocked for exactly that reason. A fake `tar` would have been perfectly
 * happy to "extract" whatever the test said it extracted, and the member that goes missing
 * does so between `tar -xzf` and `rename`. `backup-store.test.ts` and
 * `backup-copy.test.ts` already work against `mkdtemp` directories; this adds the archive.
 */
describe("restoreMinecraftArchive", () => {
  let box = "";
  /** Stands in for `MC_DIR` — the live game directory a restore writes into. */
  let mc = "";
  let backups = "";

  beforeEach(async () => {
    box = await mkdtemp(path.join(tmpdir(), "yoshling-mc-archive-"));
    mc = path.join(box, "minecraft");
    backups = path.join(box, "backups");
    await mkdir(mc, { recursive: true });
    await mkdir(backups, { recursive: true });
  });

  afterEach(async () => {
    await rm(box, { recursive: true, force: true });
  });

  /** A file at `mc/<relative>`, creating its parents. */
  async function put(relative: string, contents: string): Promise<void> {
    const target = path.join(mc, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf-8");
  }

  async function read(relative: string): Promise<string | null> {
    return readFile(path.join(mc, relative), "utf-8").catch(() => null);
  }

  /** The archive the create side writes: `tar -czf <archive> -C <mc> <members…>`. */
  async function tarUp(name: string, members: string[]): Promise<string> {
    const archive = path.join(backups, name);
    await execFileAsync("tar", ["-czf", archive, "-C", mc, ...members]);
    return archive;
  }

  function restore(archive: string) {
    return restoreMinecraftArchive({ archivePath: archive, mcDir: mc });
  }

  // ── the two-member round trip ─────────────────────────────────────────────

  /**
   * The whole point of the increment. Both members are swapped, and the assertion is on the
   * *bytes that came back*, not on which functions were called — dropping the `mods` swap
   * leaves `world` correct and the mods directory holding whatever was there when the apply
   * deleted it.
   */
  it("puts mods/ back as well as world/ from a two-member archive", async () => {
    await put("world/level.dat", "saved world");
    await put("world/region/r.0.0.mca", "chunks");
    await put("mods/fabric-api.jar", "fabric v1");
    await put("mods/xaeros-minimap.jar", "xaero v1");
    const archive = await tarUp("auto-before-modpack.tar.gz", ["world", "mods"]);

    // What a modpack apply does between the backup and the restore: every installed jar is
    // removed, and new ones are written in their place.
    await rm(path.join(mc, "mods"), { recursive: true, force: true });
    await put("mods/cobblemon.jar", "the pack's mod");
    await put("world/level.dat", "the world moved on");

    const { replaced } = await restore(archive);

    expect(replaced).toEqual(["world", "mods"]);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(await read("world/region/r.0.0.mca")).toBe("chunks");
    expect(await read("mods/fabric-api.jar")).toBe("fabric v1");
    expect(await read("mods/xaeros-minimap.jar")).toBe("xaero v1");
    // Replaced, not merged. `install-modpack`'s own comment names the shape: "A jar that
    // survives this loads alongside the new pack, so a failed removal has to be said out
    // loud" — a restore that merged would reintroduce exactly that, silently.
    expect(await read("mods/cobblemon.jar")).toBeNull();
    expect((await readdir(path.join(mc, "mods"))).sort()).toEqual([
      "fabric-api.jar",
      "xaeros-minimap.jar",
    ]);
  });

  // ── the legacy archive ────────────────────────────────────────────────────

  /**
   * Every Minecraft archive on the box is `tar -czf … -C MC_DIR world`, and routine backups
   * still are. A world-only restore must leave the live mods directory **exactly** as it
   * was: deleting it because the archive has nothing to put there would make the first
   * restore after this change wipe the mod set, which is the opposite of the fix.
   */
  it("restores a legacy one-member archive world-only and does not touch mods/", async () => {
    await put("world/level.dat", "saved world");
    const archive = await tarUp("world-2026-05-29T00-00-00.tar.gz", ["world"]);

    await put("world/level.dat", "the world moved on");
    await put("mods/fabric-api.jar", "installed right now");

    const { replaced } = await restore(archive);

    expect(replaced).toEqual(["world"]);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(await read("mods/fabric-api.jar")).toBe("installed right now");
  });

  it("restores a legacy archive onto a server with no mods directory at all", async () => {
    await put("world/level.dat", "saved world");
    const archive = await tarUp("world-legacy.tar.gz", ["world"]);
    await rm(path.join(mc, "world"), { recursive: true, force: true });

    const { replaced } = await restore(archive);

    expect(replaced).toEqual(["world"]);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(await readdir(mc)).toEqual(["world"]);
  });

  // ── the mods-only archive ─────────────────────────────────────────────────

  /**
   * `install-modpack` takes this shape on a server that has not generated a world yet:
   * there is still something to lose, because the jars are about to go and `removeMod`
   * deletes their `InstalledMod` rows with them. An archive the restore refused would be a
   * rollback point in name only.
   */
  it("restores a mods-only archive without inventing a world", async () => {
    await put("mods/fabric-api.jar", "fabric v1");
    const archive = await tarUp("auto-before-modpack.tar.gz", ["mods"]);
    await rm(path.join(mc, "mods"), { recursive: true, force: true });
    await put("mods/cobblemon.jar", "the pack's mod");

    const { replaced } = await restore(archive);

    expect(replaced).toEqual(["mods"]);
    expect(await read("mods/fabric-api.jar")).toBe("fabric v1");
    expect(await read("mods/cobblemon.jar")).toBeNull();
    expect(await readdir(mc)).toEqual(["mods"]);
  });

  // ── refusals, and what they cost ──────────────────────────────────────────

  /**
   * Reached by pointing a Minecraft restore at a 7 Days to Die or Project Zomboid bundle.
   * Neither writes a `world` or a `mods` member — 7DTD's are `Saves/`,
   * `GeneratedWorlds/`, `sdtdserver.xml`, `manifest.json`; PZ's are `Saves/`, `db/`,
   * `Server/`, `manifest.json`. The routes map `BadArchiveError` to **400** with the
   * sentence verbatim, because a valid gzip file that holds none of this is the user's
   * archive being wrong rather than the server breaking.
   */
  it("refuses an archive with neither member, having changed nothing", async () => {
    await put("world/level.dat", "the live world");
    await put("mods/fabric-api.jar", "the live jar");
    // The 7DTD bundle shape: `tar -czf … -C <work> .`
    const foreign = path.join(box, "work");
    await mkdir(path.join(foreign, "Saves"), { recursive: true });
    await writeFile(path.join(foreign, "manifest.json"), "{}", "utf-8");
    const archive = path.join(backups, "7dtd-Reveo_Valley.tar.gz");
    await execFileAsync("tar", ["-czf", archive, "-C", foreign, "."]);

    await expect(restore(archive)).rejects.toThrow(BadArchiveError);
    await expect(restore(archive)).rejects.toThrow(/no world folder and no mods folder/);
    // Nothing was renamed and nothing was deleted — the refusal is decided before the
    // first `rm`, which is the same ordering the checksum check one layer up relies on.
    expect(await read("world/level.dat")).toBe("the live world");
    expect(await read("mods/fabric-api.jar")).toBe("the live jar");
  });

  it("leaves no staging directory behind, on success or on refusal", async () => {
    await put("world/level.dat", "saved world");
    await put("mods/a.jar", "a");
    const good = await tarUp("good.tar.gz", ["world", "mods"]);
    await restore(good);
    expect((await readdir(mc)).sort()).toEqual(["mods", "world"]);

    const empty = path.join(box, "empty");
    await mkdir(empty, { recursive: true });
    await writeFile(path.join(empty, "nothing.txt"), "x", "utf-8");
    const bad = path.join(backups, "bad.tar.gz");
    await execFileAsync("tar", ["-czf", bad, "-C", empty, "."]);
    await expect(restore(bad)).rejects.toThrow(BadArchiveError);
    // The `.restore-*` dir is excluded from `listArchives` by name, but it lives inside the
    // game directory where Minecraft itself would see it.
    expect((await readdir(mc)).filter((e) => e.startsWith(".restore-"))).toEqual([]);
  });

  it("rejects when the archive is not a readable gzip stream, and changes nothing", async () => {
    await put("world/level.dat", "the live world");
    const truncated = path.join(backups, "truncated.tar.gz");
    await writeFile(truncated, "this is not gzip", "utf-8");

    await expect(restore(truncated)).rejects.toThrow();
    expect(await read("world/level.dat")).toBe("the live world");
    expect((await readdir(mc)).filter((e) => e.startsWith(".restore-"))).toEqual([]);
  });

  /**
   * World first, mods second, and it is not cosmetic: the world is the half the game cannot
   * start without, so if the process dies between the two renames that is the half that
   * landed. The order comes off `MC_ARCHIVE_MEMBERS`, which the create side also spreads
   * into its `tar` arguments.
   */
  it("replaces the members in MC_ARCHIVE_MEMBERS order", async () => {
    await put("world/level.dat", "w");
    await put("mods/a.jar", "a");
    const archive = await tarUp("both.tar.gz", ["mods", "world"]);
    const { replaced } = await restore(archive);
    // Asked for in the opposite order on the tar command line, and still world-first.
    expect(replaced).toEqual([...MC_ARCHIVE_MEMBERS]);
  });
});

describe("archiveMembersPresent", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "yoshling-mc-members-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers in MC_ARCHIVE_MEMBERS order, not in readdir order", async () => {
    // `mods` created first, so a `readdir`-based implementation would answer mods-first on
    // most filesystems — and the order is what the restore swaps in.
    await mkdir(path.join(dir, "mods"));
    await mkdir(path.join(dir, "world"));
    expect(await archiveMembersPresent(dir)).toEqual(["world", "mods"]);
  });

  it("lists only what is there", async () => {
    expect(await archiveMembersPresent(dir)).toEqual([]);
    await mkdir(path.join(dir, "world"));
    expect(await archiveMembersPresent(dir)).toEqual(["world"]);
    await mkdir(path.join(dir, "mods"));
    expect(await archiveMembersPresent(dir)).toEqual(["world", "mods"]);
  });

  /**
   * `tar -czf … world mods` exits non-zero on a member that is not a directory, and
   * `install-modpack` treats a failed tar as fatal and refuses the apply. So anything that
   * is not a directory has to be reported as absent rather than offered to `tar`.
   */
  it("ignores a plain file sitting where a directory should be", async () => {
    await writeFile(path.join(dir, "mods"), "someone left a file here", "utf-8");
    await mkdir(path.join(dir, "world"));
    expect(await archiveMembersPresent(dir)).toEqual(["world"]);
  });

  it("ignores names it does not know about", async () => {
    await mkdir(path.join(dir, "config"));
    await mkdir(path.join(dir, "logs"));
    expect(await archiveMembersPresent(dir)).toEqual([]);
  });

  /** A dangling symlink is not a directory, so it must not reach `tar` either. */
  it("ignores a symlink pointing at nothing", async () => {
    await symlink(path.join(dir, "gone"), path.join(dir, "mods"));
    expect(await archiveMembersPresent(dir)).toEqual([]);
  });
});

describe("manifestIncludesMods", () => {
  /**
   * **False, not unknown, for an archive with no `members`.** Not a guess: every Minecraft
   * archive written before 2026-10-02 was `-C MC_DIR world`, one member, and routine
   * backups still record `["world"]` explicitly. The listing says "mods incl." only when it
   * is true, so a wrong `true` here would tell someone a restore brings their jars back
   * when it would not.
   */
  it("is false for an archive that recorded no members", () => {
    expect(manifestIncludesMods(null)).toBe(false);
    expect(manifestIncludesMods(undefined)).toBe(false);
    expect(manifestIncludesMods({})).toBe(false);
  });

  it("is false for a world-only archive and true for one that carries mods", () => {
    expect(manifestIncludesMods({ members: ["world"] })).toBe(false);
    expect(manifestIncludesMods({ members: ["world", "mods"] })).toBe(true);
    expect(manifestIncludesMods({ members: ["mods"] })).toBe(true);
  });

  /** A manifest read off a sidecar is `JSON.parse` output — any shape is possible. */
  it("does not throw on a members field that is not an array", () => {
    expect(manifestIncludesMods({ members: "world,mods" } as never)).toBe(false);
  });
});

describe("describeMembers", () => {
  it("names each member in plain words", () => {
    expect(describeMembers(["world"])).toBe("the world folder");
    expect(describeMembers(["mods"])).toBe("the mods directory");
    expect(describeMembers(["world", "mods"])).toBe("the world folder and the mods directory");
  });

  it("says nothing rather than producing an empty clause", () => {
    expect(describeMembers([])).toBe("nothing");
  });
});
