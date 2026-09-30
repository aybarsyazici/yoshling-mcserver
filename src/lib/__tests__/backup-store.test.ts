import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { BACKUP_DIRS, listArchives } from "../backup-store";

/**
 * `listArchives` is what feeds retention and the schedule, so what it *excludes* is as
 * load-bearing as what it returns. Every non-archive that has ever lived in these
 * directories is represented below: a `.manifest.json` sidecar, a `.work-*` staging dir and
 * a `.restore-*` staging dir. Handing any of those to `selectForPruning` would put a
 * half-written staging directory in the running for "the archive we keep".
 */
describe("listArchives", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "yoshling-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function archive(name: string, mtimeSeconds: number): Promise<void> {
    const p = path.join(dir, name);
    await writeFile(p, "x", "utf-8");
    await utimes(p, mtimeSeconds, mtimeSeconds);
  }

  it("returns only .tar.gz files, newest first", async () => {
    await archive("a.tar.gz", 1_000_000);
    await archive("b.tar.gz", 3_000_000);
    await archive("c.tar.gz", 2_000_000);
    const names = (await listArchives(dir)).map((a) => a.name);
    expect(names).toEqual(["b.tar.gz", "c.tar.gz", "a.tar.gz"]);
  });

  it("excludes the manifest sidecar", async () => {
    await archive("a.tar.gz", 1_000_000);
    await writeFile(path.join(dir, "a.tar.gz.manifest.json"), "{}", "utf-8");
    expect((await listArchives(dir)).map((a) => a.name)).toEqual(["a.tar.gz"]);
  });

  it("excludes the staging directories a create and a restore leave behind", async () => {
    await archive("a.tar.gz", 1_000_000);
    await mkdir(path.join(dir, ".work-2026-09-30T12-00-00"), { recursive: true });
    await mkdir(path.join(dir, ".restore-1759000000000"), { recursive: true });
    expect((await listArchives(dir)).map((a) => a.name)).toEqual(["a.tar.gz"]);
  });

  /**
   * `/api/7dtd/reset` writes its safety snapshot to `backups-7dtd/presreset/`, deliberately
   * out of the listing: that tar has no manifest and its members are rooted at `<world>/`,
   * so restoring it would wipe `Saves/` and then find no `Saves/` in the archive to put
   * back. Not recursing is therefore load-bearing twice over — those files must never be a
   * prune candidate, and they must never be what resets the schedule's clock.
   */
  it("does not recurse, so the reset route's presreset snapshots stay out", async () => {
    await archive("a.tar.gz", 1_000_000);
    await mkdir(path.join(dir, "presreset"), { recursive: true });
    await archive(path.join("presreset", "presreset-Reveo_Valley-x.tar.gz"), 9_000_000);
    expect((await listArchives(dir)).map((a) => a.name)).toEqual(["a.tar.gz"]);
  });

  it("reports size and mtime, which is the clock retention orders by", async () => {
    await writeFile(path.join(dir, "a.tar.gz"), "12345", "utf-8");
    await utimes(path.join(dir, "a.tar.gz"), 1_700_000, 1_700_000);
    const [a] = await listArchives(dir);
    expect(a.size).toBe(5);
    expect(a.createdAtMs).toBe(1_700_000_000);
  });

  /**
   * A world nobody has ever backed up has no directory at all, and that is a state, not an
   * error: the schedule reads this to answer "when did we last back up" and must get
   * "never" rather than a rejected promise on the very first tick after a deploy.
   */
  it("lists empty for a directory that does not exist", async () => {
    expect(await listArchives(path.join(dir, "nope"))).toEqual([]);
  });
});

describe("BACKUP_DIRS", () => {
  /**
   * Read off the box on 2026-09-30 inside `yoshling-web-1`; these three paths are where the
   * 15 existing archives actually are. They were three separate constants in three route
   * files before, which is how one of them gets changed alone.
   */
  it("matches the directories the existing archives are in", () => {
    expect(BACKUP_DIRS).toEqual({
      minecraft: "/app/data/backups",
      "7dtd": "/app/data/backups-7dtd",
      zomboid: "/app/data/backups-zomboid",
    });
  });
});
