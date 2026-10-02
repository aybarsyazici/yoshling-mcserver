import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { reconcileMods, type InstalledModRow } from "@/lib/mod-inventory";

/**
 * **The inventory, checked against a real directory.**
 *
 * `/api/mods/installed` was `db.installedMod.findMany()` and there was no `readdir`
 * anywhere in the mod code, so "what is installed" was the app's memory of its own writes.
 * Production happens to agree today (3 rows, 3 jars) — but nothing had ever looked, so
 * "they agree" was not a thing anybody could know.
 *
 * **Real files in a temp directory, not a mocked `fs`.** The failure this reconcile exists
 * to catch *is* the difference between what the database says and what `readdir` returns,
 * and a faked `readdir` is a second place to write down the answer being tested. The
 * Minecraft backup suite uses real `tar` in a temp dir for the same reason.
 */

const ROOT = path.join(
  (process.env.TMPDIR || "/tmp").replace(/\/+$/, ""),
  `yoshling-mod-inventory-${process.pid}-${Date.now()}`
);
const MODS = path.join(ROOT, "mods");

/** The three jars on production, measured 2026-10-02. */
const FABRIC = "fabric-api-0.149.1+26.1.2.jar";
const MINIMAP = "xaerominimap-fabric-26.1.2-25.3.14.jar";
const WORLDMAP = "xaeroworldmap-fabric-26.1.2-1.40.18.jar";

function row(over: Partial<InstalledModRow> & { fileName: string }): InstalledModRow {
  return {
    id: `row-${over.fileName}`,
    modrinthId: "P7dR8mSH",
    slug: "fabric-api",
    name: over.fileName.replace(/-.*/, ""),
    version: "1.0.0",
    mcVersion: "26.1.2",
    loader: "fabric",
    installedBy: "u1",
    installedAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

async function jar(name: string, contents = "pretend bytes"): Promise<void> {
  await writeFile(path.join(MODS, name), contents, "utf-8");
}

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(MODS, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("the all-agree case", () => {
  it("reports exactly three matched and nothing else", async () => {
    await jar(FABRIC);
    await jar(MINIMAP);
    await jar(WORLDMAP);
    const inv = await reconcileMods(
      [row({ fileName: FABRIC }), row({ fileName: MINIMAP }), row({ fileName: WORLDMAP })],
      MODS
    );

    // The names, not the count. Production's three jars are the case this started from and
    // "3" would be satisfied by a reconcile that compared nothing.
    expect(inv.matched.sort()).toEqual([FABRIC, MINIMAP, WORLDMAP].sort());
    expect(inv.untracked).toEqual([]);
    expect(inv.missing).toEqual([]);
    expect(inv.ignored).toEqual([]);
    expect(inv.modsDirPresent).toBe(true);
    expect(inv.mods).toHaveLength(3);
    expect(inv.mods.every((m) => m.state === "matched")).toBe(true);
  });

  it("keeps the row order it was given, so the newest-first query still reads that way", async () => {
    await jar(FABRIC);
    await jar(MINIMAP);
    const inv = await reconcileMods([row({ fileName: MINIMAP }), row({ fileName: FABRIC })], MODS);
    expect(inv.mods.map((m) => m.fileName)).toEqual([MINIMAP, FABRIC]);
  });
});

describe("a jar on disk with no row", () => {
  it("is reported, and named", async () => {
    await jar(FABRIC);
    await jar("someone-dropped-this-in.jar");
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);

    expect(inv.untracked).toEqual(["someone-dropped-this-in.jar"]);
    expect(inv.matched).toEqual([FABRIC]);
    expect(inv.missing).toEqual([]);

    // And it is in the one list the UI renders, carrying its own state — a group a
    // surface has to cross-reference against a second array is a group that gets dropped.
    const entry = inv.mods.find((m) => m.fileName === "someone-dropped-this-in.jar");
    expect(entry?.state).toBe("untracked");
    expect(entry?.name).toBe("someone-dropped-this-in.jar");
    // No row, so there is nothing to remove by id — the surface has to be able to tell.
    expect(entry?.id).toBe(null);
    expect(entry?.source).toBe(null);
    expect(entry?.installedAt).toBe(null);
    // It is a real file, so it has a real size.
    expect(entry?.sizeBytes).toBeGreaterThan(0);
  });

  it("names every one of them when a whole mod set arrived with no inventory", async () => {
    // The state `/api/server/backups` leaves behind when it restores a `mods` member from
    // an archive whose manifest carried no `installedMods` — the jars are back and nothing
    // in the database names them. The route's own comment points here for the recovery.
    await jar(FABRIC);
    await jar(MINIMAP);
    await jar(WORLDMAP);
    const inv = await reconcileMods([], MODS);
    expect(inv.untracked.sort()).toEqual([FABRIC, MINIMAP, WORLDMAP].sort());
    expect(inv.matched).toEqual([]);
    expect(inv.mods).toHaveLength(3);
  });

  /**
   * `readdir` order is unspecified, and a listing that reorders between two reads looks like
   * something changed.
   *
   * **The reader is injected rather than trusted.** This test used to create three jars and
   * assert the sorted order back — and it was vacuous on every machine it ran on: APFS returns
   * a small directory in lexicographic order already, so deleting the `.sort()` left it green.
   * Production is **ext4**, where the order is hash-derived. The one filesystem the bug would
   * show on was the one no test ran on, which is the whole failure mode in miniature.
   */
  it("sorts them, so two readings of the same directory agree", async () => {
    await jar("zz.jar");
    await jar("aa.jar");
    await jar("mm.jar");

    // Deliberately reversed, so the assertion is about this module's sort and not the host's.
    const unsorted: typeof readdir = (async (dir: string, options?: unknown) => {
      const real = await readdir(dir, options as never);
      return (real as unknown[]).slice().reverse();
    }) as typeof readdir;

    const inv = await reconcileMods([], MODS, { readdirImpl: unsorted });
    expect(inv.untracked).toEqual(["aa.jar", "mm.jar", "zz.jar"]);
  });

  /** The same property for `ignored`, which the band renders in the order given. Same
   *  vacuousness on APFS, same injected reader. */
  it("sorts the non-jar files too", async () => {
    await writeFile(path.join(MODS, "zz.txt"), "x", "utf-8");
    await writeFile(path.join(MODS, "aa.cfg"), "x", "utf-8");
    const unsorted: typeof readdir = (async (dir: string, options?: unknown) => {
      const real = await readdir(dir, options as never);
      return (real as unknown[]).slice().reverse();
    }) as typeof readdir;
    const inv = await reconcileMods([], MODS, { readdirImpl: unsorted });
    expect(inv.ignored).toEqual(["aa.cfg", "zz.txt"]);
  });

  /** And the injected reader really is reaching the code — otherwise the test above is still
   *  measuring the filesystem. */
  it("reads through the injected reader, so the test above means what it says", async () => {
    await jar("only.jar");
    let called = 0;
    const counting: typeof readdir = (async (dir: string, options?: unknown) => {
      called += 1;
      return readdir(dir, options as never);
    }) as typeof readdir;

    await reconcileMods([], MODS, { readdirImpl: counting });
    expect(called).toBe(1);
  });
});

describe("a row whose jar is gone", () => {
  it("is reported, and named", async () => {
    await jar(FABRIC);
    const inv = await reconcileMods(
      [row({ fileName: FABRIC }), row({ fileName: MINIMAP, name: "Xaero's Minimap" })],
      MODS
    );

    expect(inv.missing).toEqual([MINIMAP]);
    expect(inv.matched).toEqual([FABRIC]);
    expect(inv.untracked).toEqual([]);

    const entry = inv.mods.find((m) => m.fileName === MINIMAP);
    expect(entry?.state).toBe("missing");
    // The mod's **name**, so the sentence on screen is about a mod and not only a path.
    expect(entry?.name).toBe("Xaero's Minimap");
    // There is still a row, so the entry can still be cleared from the database.
    expect(entry?.id).toBe(`row-${MINIMAP}`);
    expect(entry?.sizeBytes).toBe(null);
  });

  it("reports both directions at once, each named", async () => {
    // What a `mods.apply` racing an install actually leaves: a jar nobody planned plus a
    // row whose file the apply's `removeMod` deleted.
    await jar(FABRIC);
    await jar("stranger.jar");
    const inv = await reconcileMods(
      [row({ fileName: FABRIC }), row({ fileName: WORLDMAP })],
      MODS
    );
    expect(inv.matched).toEqual([FABRIC]);
    expect(inv.untracked).toEqual(["stranger.jar"]);
    expect(inv.missing).toEqual([WORLDMAP]);
  });
});

describe("the three groups and the one list cannot disagree", () => {
  /**
   * The groups are **derived** from `mods` rather than accumulated beside it, and this is
   * the assertion that keeps them that way: a surface reading `untracked` and a surface
   * filtering `mods` must get the same answer, or one of them is quietly wrong.
   */
  it("every group is exactly the file names of the entries in that state", async () => {
    await jar(FABRIC);
    await jar("stranger.jar");
    const inv = await reconcileMods(
      [row({ fileName: FABRIC }), row({ fileName: WORLDMAP })],
      MODS
    );
    const named = (state: string) =>
      inv.mods.filter((m) => m.state === state).map((m) => m.fileName);
    expect(inv.matched).toEqual(named("matched"));
    expect(inv.untracked).toEqual(named("untracked"));
    expect(inv.missing).toEqual(named("missing"));
    expect(inv.matched.length + inv.untracked.length + inv.missing.length).toBe(inv.mods.length);
  });
});

describe("a missing mods directory is nothing installed, not an error", () => {
  it("answers rather than throwing, and says the directory is not there", async () => {
    await rm(MODS, { recursive: true, force: true });
    const inv = await reconcileMods([], MODS);
    expect(inv.modsDirPresent).toBe(false);
    expect(inv.mods).toEqual([]);
    expect(inv.matched).toEqual([]);
    expect(inv.untracked).toEqual([]);
    expect(inv.totalBytes).toBe(0);
  });

  it("still reconciles the rows against it — they are missing, not invisible", async () => {
    await rm(MODS, { recursive: true, force: true });
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);
    expect(inv.missing).toEqual([FABRIC]);
    expect(inv.mods[0].state).toBe("missing");
  });

  it("does not swallow a directory it simply could not read", async () => {
    // ENOENT means "no mods yet". Anything else means "we could not look", and answering
    // "nothing installed" to that would report every installed mod as missing and every
    // jar as absent — the read-nothing-report-success shape this repo keeps paying for.
    // A path whose *parent* is a file gives ENOTDIR, which is not ENOENT.
    const notADir = path.join(ROOT, "a-file");
    await writeFile(notADir, "x", "utf-8");
    await expect(reconcileMods([], path.join(notADir, "mods"))).rejects.toThrow();
  });
});

describe("what is in the directory but is not a mod", () => {
  it("is listed as ignored rather than called an untracked mod", async () => {
    await jar(FABRIC);
    await writeFile(path.join(MODS, ".DS_Store"), "junk", "utf-8");
    await jar("turned-off.jar.disabled");
    await mkdir(path.join(MODS, "a-subdirectory"));
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);

    expect(inv.untracked).toEqual([]);
    expect(inv.ignored).toEqual([".DS_Store", "a-subdirectory", "turned-off.jar.disabled"]);
    // Nothing in `ignored` reaches the list the UI renders as mods.
    expect(inv.mods.map((m) => m.fileName)).toEqual([FABRIC]);
  });

  it("counts a jar whatever case its extension is in", async () => {
    await jar("Shouty.JAR");
    const inv = await reconcileMods([], MODS);
    expect(inv.untracked).toEqual(["Shouty.JAR"]);
    expect(inv.ignored).toEqual([]);
  });

  it("does not count a directory that happens to end in .jar", async () => {
    // `isFile()`, not a name test: a directory named `x.jar` is not a mod the server loads
    // and `stat`ing it for a size would report the directory's own inode size as a jar's.
    await mkdir(path.join(MODS, "extracted.jar"));
    const inv = await reconcileMods([], MODS);
    expect(inv.untracked).toEqual([]);
    expect(inv.ignored).toEqual(["extracted.jar"]);
  });
});

describe("provenance", () => {
  it("carries source and versionId through", async () => {
    await jar(FABRIC);
    await jar(MINIMAP);
    const inv = await reconcileMods(
      [
        row({ fileName: FABRIC, source: "pack", versionId: "AbCd1234" }),
        row({ fileName: MINIMAP, source: "manual", versionId: null }),
      ],
      MODS
    );
    expect(inv.mods.map((m) => [m.source, m.versionId])).toEqual([
      ["pack", "AbCd1234"],
      ["manual", null],
    ]);
  });

  it("reads a row written before the column as not recorded", async () => {
    // The three rows on production predate `source`; the migration backfills them to
    // `manual`, but a row restored from an archive carries none and must not be labelled.
    await jar(FABRIC);
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);
    expect(inv.mods[0].source).toBe(null);
  });

  it("refuses to pass a value it does not understand through to the surface", async () => {
    // The column is a nullable TEXT, so it can hold anything. "not recorded" is a better
    // answer than printing a word the UI has no label for.
    await jar(FABRIC);
    const inv = await reconcileMods(
      [row({ fileName: FABRIC, source: "curseforge" })],
      MODS
    );
    expect(inv.mods[0].source).toBe(null);
  });

  it("resolves the installer's name when the caller supplies the map", async () => {
    await jar(FABRIC);
    await jar(MINIMAP);
    const inv = await reconcileMods(
      [row({ fileName: FABRIC, installedBy: "u1" }), row({ fileName: MINIMAP, installedBy: "u9" })],
      MODS,
      { actorNames: { u1: "Aybars" } }
    );
    expect(inv.mods[0].installedByName).toBe("Aybars");
    // An id that did not resolve says nothing about who, rather than printing a cuid.
    expect(inv.mods[1].installedByName).toBe(null);
    expect(inv.mods[1].installedBy).toBe("u9");
  });

  it("sends installedAt as ISO, so the client needs no date parsing", async () => {
    await jar(FABRIC);
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);
    expect(inv.mods[0].installedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("sizes and hashes", () => {
  it("stats every jar that is there, always", async () => {
    await jar(FABRIC, "0123456789");
    await jar("stranger.jar", "012345678901234");
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);
    expect(inv.mods.find((m) => m.fileName === FABRIC)?.sizeBytes).toBe(10);
    expect(inv.mods.find((m) => m.fileName === "stranger.jar")?.sizeBytes).toBe(15);
    // The total is over the jars on disk, including the untracked one — it is the size of
    // the directory, which is what somebody asking "how big is this" means.
    expect(inv.totalBytes).toBe(25);
  });

  it("hashes nothing unless asked", async () => {
    await jar(FABRIC);
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS);
    expect(inv.hashed).toBe(false);
    expect(inv.mods[0].sha512).toBe(null);
  });

  it("hashes the bytes that are actually on disk when asked", async () => {
    await jar(FABRIC, "the real bytes");
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS, { hash: true });
    expect(inv.hashed).toBe(true);
    expect(inv.mods[0].sha512).toBe(
      createHash("sha512").update("the real bytes").digest("hex")
    );
  });

  it("gives two copies of one mod under two names the same digest", async () => {
    // The thing a hash can prove with no published reference to compare against: the two
    // writers name files differently (`installMod` uses Modrinth's filename, the Technic
    // path writes `<slug>.jar`), so the same mod can land twice under two names.
    await jar(FABRIC, "identical");
    await jar("fabric-api.jar", "identical");
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS, { hash: true });
    const digests = inv.mods.map((m) => m.sha512);
    expect(digests[0]).toBe(digests[1]);
    expect(digests[0]).not.toBe(null);
  });

  it("does not hash a missing file, and does not fail because of it", async () => {
    const inv = await reconcileMods([row({ fileName: FABRIC })], MODS, { hash: true });
    expect(inv.mods[0].state).toBe("missing");
    expect(inv.mods[0].sha512).toBe(null);
    expect(inv.mods[0].sizeBytes).toBe(null);
  });

  it("measures a jar two rows both name exactly once, and bills it once", async () => {
    // Two rows naming one file is a state the database permits. Both are matched, both
    // report the jar's size, and the directory total counts it once.
    await jar(FABRIC, "0123456789");
    const inv = await reconcileMods(
      [row({ id: "a", fileName: FABRIC }), row({ id: "b", fileName: FABRIC })],
      MODS
    );
    expect(inv.mods.map((m) => m.state)).toEqual(["matched", "matched"]);
    expect(inv.mods.map((m) => m.sizeBytes)).toEqual([10, 10]);
    expect(inv.totalBytes).toBe(10);
    expect(inv.untracked).toEqual([]);
  });

  it("keeps a jar it could not stat in the list rather than calling it missing", async () => {
    // `readdir` said it is there. A dangling symlink is listed and cannot be stat'd, and
    // downgrading its state on the strength of a failed `stat` would make a broken link
    // look like a mod somebody deleted — two different problems with two different fixes.
    await symlink(path.join(ROOT, "nowhere.jar"), path.join(MODS, "dangling.jar"));
    const inv = await reconcileMods([], MODS);
    expect(inv.untracked).toEqual(["dangling.jar"]);
    expect(inv.mods[0].sizeBytes).toBe(null);
    expect(inv.totalBytes).toBe(0);
  });
});
