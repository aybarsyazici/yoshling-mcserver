import { describe, it, expect } from "vitest";
import {
  classifyZipListing,
  safeName,
  saveTargetForUpload,
  worldTargetForUpload,
} from "../sdtd-upload-shape";

/**
 * Every case below is a refusal the world-upload route has to keep making, and each one
 * was added because its absence deleted something while reporting success.
 *
 * They are written as properties rather than as "what the code does today": the assertion
 * is always *the destination is not `GeneratedWorlds`/`Saves` itself*, or *a save that
 * cannot be located is refused rather than guessed*. A future rewrite of `safeName` is
 * free to produce different strings; it is not free to produce a destination that
 * `rm -rf`s a root.
 */

const WORLDS = "/sevendtd/GeneratedWorlds";
const SAVES = "/sevendtd/Saves";
const WORK = "/app/data/tmp/world-work-abc";

describe("classifyZipListing", () => {
  it("recognises a world map from any one of its markers", () => {
    for (const marker of ["dtm.raw", "biomes.png", "prefabs.xml", "splat3.png", "world.json"]) {
      expect(classifyZipListing(`  1024  01-01-2026 00:00  MyWorld/${marker}`)).toBe("world");
    }
  });

  it("recognises a save from main.ttw or players.xml", () => {
    expect(classifyZipListing("  1  01-01-2026 00:00  W/G/main.ttw")).toBe("save");
    expect(classifyZipListing("  1  01-01-2026 00:00  W/G/players.xml")).toBe("save");
  });

  it("is case-insensitive, because a zip made on Windows may not preserve case", () => {
    expect(classifyZipListing("  1  01-01-2026 00:00  MyWorld/DTM.RAW")).toBe("world");
    expect(classifyZipListing("  1  01-01-2026 00:00  W/G/Main.TTW")).toBe("save");
  });

  it("calls a zip with both kinds of marker a world", () => {
    // A world export can legitimately ship a players.xml; a save never ships dtm.raw.
    // Getting this the other way round would send a map into the Saves tree.
    const listing = "  1  01-01-2026 00:00  W/dtm.raw\n  1  01-01-2026 00:00  W/players.xml";
    expect(classifyZipListing(listing)).toBe("world");
  });

  it("returns null for anything else, which is what produces the 400", () => {
    expect(classifyZipListing("  1  01-01-2026 00:00  holiday-photos/beach.jpg")).toBeNull();
    expect(classifyZipListing("")).toBeNull();
  });
});

describe("safeName", () => {
  it("keeps ordinary world names intact, spaces and all", () => {
    // The live map is literally called "Reveo Valley".
    expect(safeName("Reveo Valley")).toBe("Reveo Valley");
    expect(safeName("Fresh2")).toBe("Fresh2");
    expect(safeName("my-world_v1.2")).toBe("my-world_v1.2");
  });

  it("strips path separators, so a name can never become a path", () => {
    expect(safeName("../etc")).not.toContain("/");
    expect(safeName("a/b")).toBe("ab");
  });

  it("can return an empty or dot-only string — which is why the callers re-check", () => {
    // Pinned deliberately: these two outputs are the *reason* the destination checks
    // exist, so a change that makes them harmless should have to update this test.
    expect(safeName("世界地図")).toBe("");
    expect(safeName("..")).toBe(".");
  });

  it("caps the length, so a 4 KB folder name cannot reach the filesystem", () => {
    expect(safeName("a".repeat(500)).length).toBe(60);
  });
});

describe("worldTargetForUpload", () => {
  it("names the world after the folder that held the markers", () => {
    const r = worldTargetForUpload({
      rootDir: `${WORK}/Reveo Valley`,
      workDir: WORK,
      uploadFilename: "download (3).zip",
      worldsDir: WORLDS,
    });
    expect(r).toEqual({ ok: true, name: "Reveo Valley", dest: `${WORLDS}/Reveo Valley` });
  });

  it("falls back to the zip's name when the markers sat at the zip root", () => {
    const r = worldTargetForUpload({
      rootDir: WORK,
      workDir: WORK,
      uploadFilename: "Wasteland Ridge.zip",
      worldsDir: WORLDS,
    });
    expect(r).toEqual({ ok: true, name: "Wasteland Ridge", dest: `${WORLDS}/Wasteland Ridge` });
  });

  it("refuses rather than resolving to GeneratedWorlds itself", () => {
    // The destination is `rm -rf`d before the move, so `dest === WORLDS` is "delete every
    // custom map on the box, including the live 417 MB one" — and it would have answered
    // `{"success":true}`.
    for (const [rootDir, uploadFilename] of [
      [WORK, "..zip"], // safeName("." ) -> "."  -> path.join(WORLDS, ".") === WORLDS
      [WORK, "世界地図.zip"], // -> ""            -> path.join(WORLDS, "") === WORLDS
      [WORK, ".zip"], // -> ""
      [`${WORK}/世界地図`, "ok.zip"], // the folder name is the unusable one
      [`${WORK}/..`, "ok.zip"],
    ] as const) {
      const r = worldTargetForUpload({ rootDir, workDir: WORK, uploadFilename, worldsDir: WORLDS });
      expect(r.ok, `${rootDir} / ${uploadFilename}`).toBe(false);
    }
  });

  it("never yields a destination outside GeneratedWorlds", () => {
    // Property form of the above: whatever comes out, its parent is the worlds dir.
    for (const name of ["a/../../etc", "....", "  ", "-", "..zip", "x".repeat(300), "C:\\win"]) {
      const r = worldTargetForUpload({
        rootDir: `${WORK}/${name}`,
        workDir: WORK,
        uploadFilename: "ok.zip",
        worldsDir: WORLDS,
      });
      if (r.ok) {
        expect(r.dest.startsWith(`${WORLDS}/`), name).toBe(true);
        expect(r.dest).not.toBe(WORLDS);
      }
    }
  });
});

describe("saveTargetForUpload", () => {
  it("places a save at Saves/<GameWorld>/<GameName>", () => {
    // The pair the server actually reads out of sdtdserver.xml, so this is the shape that
    // makes an uploaded save loadable at all.
    const r = saveTargetForUpload({
      rootDir: `${WORK}/Reveo Valley/Fresh3`,
      workDir: WORK,
      savesRoot: SAVES,
    });
    expect(r).toEqual({
      ok: true,
      world: "Reveo Valley",
      game: "Fresh3",
      dest: `${SAVES}/Reveo Valley/Fresh3`,
    });
  });

  it("ignores extra wrapping folders above the world", () => {
    const r = saveTargetForUpload({
      rootDir: `${WORK}/7dtd backup 2026/Reveo Valley/Fresh3`,
      workDir: WORK,
      savesRoot: SAVES,
    });
    expect(r.ok && r.dest).toBe(`${SAVES}/Reveo Valley/Fresh3`);
  });

  it("refuses a save whose markers sit at the zip root", () => {
    // This is the shape the sweep found on 2026-09-29: `main.ttw` and `players.xml` at
    // the top level. The old code `cp -a`'d them straight into `Saves/`, where no
    // GameWorld/GameName pair could ever point at them, and reported success.
    const r = saveTargetForUpload({ rootDir: WORK, workDir: WORK, savesRoot: SAVES });
    expect(r).toEqual({ ok: false, reason: "no-world-folder" });
  });

  it("refuses a save with only one folder, rather than inventing a world name", () => {
    // A guessed world name is a save the server will never find — indistinguishable from
    // the bug above, so it has to be a refusal and not a default.
    const r = saveTargetForUpload({ rootDir: `${WORK}/Fresh3`, workDir: WORK, savesRoot: SAVES });
    expect(r).toEqual({ ok: false, reason: "no-world-folder" });
  });

  it("refuses names that sanitise away to nothing", () => {
    expect(saveTargetForUpload({ rootDir: `${WORK}/世界/Fresh3`, workDir: WORK, savesRoot: SAVES }))
      .toMatchObject({ ok: false });
    expect(saveTargetForUpload({ rootDir: `${WORK}/Reveo Valley/世界`, workDir: WORK, savesRoot: SAVES }))
      .toMatchObject({ ok: false });
  });

  it("never yields a destination that is Saves/ or a world dir itself", () => {
    // Property: a successful result is always two levels below the saves root. Anything
    // shallower is `rm -rf` on somebody's progress.
    for (const rel of ["../x", "./y", "..", ".", "世界/Fresh", "Reveo Valley/..", "a/b/c/d"]) {
      const r = saveTargetForUpload({ rootDir: `${WORK}/${rel}`, workDir: WORK, savesRoot: SAVES });
      if (r.ok) {
        expect(r.dest, rel).toBe(`${SAVES}/${r.world}/${r.game}`);
        expect(r.dest).not.toBe(SAVES);
        expect(r.dest).not.toBe(`${SAVES}/${r.world}`);
      }
    }
  });
});
