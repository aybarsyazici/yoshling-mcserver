import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { copyTreeCounting, countTree } from "../backup-copy";

/**
 * This replaces `fs.cp(..., {recursive: true})` on the path that copies the world people
 * play on — 442,064 files of it — so it is the riskiest new code in this change and it gets
 * assertions against a real tree rather than a mock.
 *
 * What is pinned is the *contract*: the copy is complete, symlinks stay symlinks, the
 * reported count equals the count `countTree` predicted, and the last progress callback
 * carries the final figure. The throttling numbers deliberately are not pinned — they are a
 * tuning choice, not a property.
 */
describe("countTree / copyTreeCounting", () => {
  let root = "";
  let src = "";
  let dest = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "yoshling-copy-"));
    src = path.join(root, "src");
    dest = path.join(root, "dest");
    await mkdir(path.join(src, "map", "chunks"), { recursive: true });
    await mkdir(path.join(src, "empty"), { recursive: true });
    await writeFile(path.join(src, "world.ini"), "ini", "utf-8");
    for (let i = 0; i < 20; i++) {
      await writeFile(path.join(src, "map", "chunks", `chunk_${i}.bin`), `c${i}`, "utf-8");
    }
    await writeFile(path.join(src, "map", "map.bin"), "map", "utf-8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("counts every non-directory entry and nothing else", async () => {
    // 1 ini + 20 chunks + 1 map.bin = 22. `empty/`, `map/` and `map/chunks/` are not files.
    expect(await countTree(src)).toBe(22);
  });

  it("copies the whole tree, including empty directories", async () => {
    const result = await copyTreeCounting(src, dest, () => {});
    expect(result.files).toBe(22);
    expect(await readFile(path.join(dest, "world.ini"), "utf-8")).toBe("ini");
    expect(await readFile(path.join(dest, "map", "chunks", "chunk_19.bin"), "utf-8")).toBe("c19");
    // An empty directory carries meaning in a save tree; dropping it is a silent change.
    expect(await readdir(path.join(dest, "empty"))).toEqual([]);
  });

  it("reports the same total `countTree` predicted", async () => {
    const predicted = await countTree(src);
    const { files } = await copyTreeCounting(src, dest, () => {});
    // If these two ever disagree the progress row counts up to the wrong number, which is
    // worse than no progress at all — it reads as a copy that stalled short.
    expect(files).toBe(predicted);
  });

  it("recreates a symlink as a symlink rather than following it", async () => {
    await symlink(path.join(src, "world.ini"), path.join(src, "link.ini"));
    const { files } = await copyTreeCounting(src, dest, () => {});
    expect(files).toBe(23);
    // Followed, this would copy the target's *contents* into the archive and, on restore,
    // write through the link.
    expect(await readlink(path.join(dest, "link.ini"))).toBe(path.join(src, "world.ini"));
  });

  it("reports a monotonic count and ends on the final figure", async () => {
    const seen: number[] = [];
    const { files } = await copyTreeCounting(src, dest, (done) => seen.push(done), {
      everyFiles: 1,
      everyMs: 0,
    });
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    // The last call always carries the total, so the recorded progress cannot end on
    // whatever the throttle happened to have emitted.
    expect(seen[seen.length - 1]).toBe(files);
  });

  it("always calls back at least once, even for an empty tree", async () => {
    const lone = path.join(root, "lone");
    await mkdir(lone, { recursive: true });
    const seen: number[] = [];
    const { files } = await copyTreeCounting(lone, path.join(root, "lone-copy"), (d) =>
      seen.push(d)
    );
    expect(files).toBe(0);
    expect(seen).toEqual([0]);
  });

  /**
   * The fidelity property, and the one the first version of this module got wrong while a
   * comment claimed parity with `fs.cp`. Measured then: a 0700 source directory came out
   * 0755, because `mkdir` takes 0777 & ~umask and Node's `internal/fs/cp` follows its
   * `mkdir` with a `setDestMode`. File modes were never the problem — `copyFile` carries
   * them — which is exactly why the gap went unnoticed: every file in the archive looked
   * right.
   *
   * Asserted against `fs.cp` itself rather than against a literal, so the test says
   * "matches the thing it replaced" and cannot drift from what Node does.
   */
  it("preserves directory modes, as the `fs.cp` it replaced does", async () => {
    const { cp, chmod, stat } = await import("fs/promises");
    await mkdir(path.join(src, "private"), { recursive: true });
    await writeFile(path.join(src, "private", "f"), "x", "utf-8");
    await chmod(path.join(src, "private", "f"), 0o640);
    await chmod(path.join(src, "private"), 0o700);

    const viaCp = path.join(root, "viaCp");
    await cp(src, viaCp, { recursive: true });
    await copyTreeCounting(src, dest, () => {});

    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    expect(await mode(path.join(dest, "private"))).toBe(await mode(path.join(viaCp, "private")));
    expect(await mode(path.join(dest, "private"))).toBe(0o700);
    expect(await mode(path.join(dest, "private", "f"))).toBe(0o640);
  });

  it("counts nothing for a directory it cannot read, rather than throwing", async () => {
    expect(await countTree(path.join(root, "does-not-exist"))).toBe(0);
  });

  it("refuses an escaping top-level source before counting or creating a copy", async () => {
    const external = path.join(root, "outside");
    await mkdir(external);
    await writeFile(path.join(external, "fixture.txt"), "outside fixture");
    const alias = path.join(src, "escaping");
    await symlink(external, alias);
    await expect(countTree(alias, src)).rejects.toThrow("outside the configured game volume");
    await expect(copyTreeCounting(alias, dest, () => {}, { sourceRoot: src })).rejects.toThrow("outside the configured game volume");
    await expect(readdir(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses escaping nested aliases and leaves their fixture untouched", async () => {
    const external = path.join(root, "outside");
    await mkdir(external);
    const file = path.join(external, "fixture.txt");
    await writeFile(file, "outside fixture");
    await symlink(external, path.join(src, "escaping"));
    await expect(countTree(src)).rejects.toThrow("outside the configured game volume");
    await expect(copyTreeCounting(src, dest, () => {})).rejects.toThrow("outside the configured game volume");
    expect(await readFile(file, "utf-8")).toBe("outside fixture");
  });

  it("copies a contained source alias under the configured volume", async () => {
    const alias = path.join(src, "map-alias");
    await symlink("map", alias);
    expect(await countTree(alias, src)).toBe(21);
    const copied = await copyTreeCounting(alias, dest, () => {}, { sourceRoot: src });
    expect(copied.files).toBe(21);
    expect(await readFile(path.join(dest, "chunks", "chunk_19.bin"), "utf-8")).toBe("c19");
  });
});
