import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { BadArchiveError } from "../backup-archive";
import { sha256File, shortHash, verifyArchive, integrityFact } from "../backup-integrity";

/**
 * Real files in a temp dir, not a mocked `fs`. The whole point of the checksum is that it
 * reads the bytes that are actually there, so mocking the read would test nothing — and
 * it stays inside the suite's rule of no Docker, no network and no running server.
 */
describe("verifyArchive", () => {
  let dir = "";
  const GOOD = "good.tar.gz";
  const CORRUPT = "corrupt.tar.gz";
  let goodHash = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "yoshling-integrity-"));
    await writeFile(path.join(dir, GOOD), "pretend this is 304 MB of gzip", "utf-8");
    await writeFile(path.join(dir, CORRUPT), "pretend this is 304 MB of grip", "utf-8");
    goodHash = await sha256File(path.join(dir, GOOD));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts an archive whose bytes match what was recorded", async () => {
    const r = await verifyArchive(dir, GOOD, { sha256: goodHash, archiveBytes: 30 });
    expect(r.state).toBe("verified");
  });

  /**
   * The case this exists for: a file whose gzip stream would still open, whose contents
   * are not what was backed up. `tar` alone would not have noticed — and the refusal has to
   * arrive *before* anything is deleted, which is why the routes call this ahead of
   * `withGameStopped` rather than inside it.
   */
  it("refuses an archive whose bytes differ, with a BadArchiveError", async () => {
    await expect(verifyArchive(dir, CORRUPT, { sha256: goodHash })).rejects.toThrow(
      BadArchiveError
    );
  });

  it("says what it compared, so the message is actionable rather than just a refusal", async () => {
    const err = await verifyArchive(dir, CORRUPT, { sha256: goodHash }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(BadArchiveError);
    expect(err?.message).toContain(shortHash(goodHash));
    expect(err?.message).toContain("Nothing was changed");
  });

  /**
   * A truncation is caught without hashing anything, which matters for a 305 MB file: the
   * size is free and the hash is a second of I/O.
   */
  it("refuses a size mismatch before it reads the file", async () => {
    await expect(
      verifyArchive(dir, GOOD, { sha256: goodHash, archiveBytes: 999_999 })
    ).rejects.toThrow(/truncated or has been replaced/);
  });

  /**
   * Absence is unknown, not failure. Every one of the 15 archives on the box on 2026-09-30
   * was written before checksums existed, and an archive copied off the box and back loses
   * its sidecar. Refusing those would make the guard break the thing it was added to
   * protect — this codebase's other documented defect shape.
   */
  it("reports an unrecorded checksum rather than refusing", async () => {
    for (const recorded of [null, {}, { archiveBytes: 30 }]) {
      const r = await verifyArchive(dir, GOOD, recorded);
      expect(r.state).toBe("unrecorded");
    }
  });

  it("does not check a size it was not given", async () => {
    const r = await verifyArchive(dir, GOOD, { sha256: goodHash });
    expect(r.state).toBe("verified");
  });
});

describe("integrityFact", () => {
  /**
   * Pinned because it is load-bearing in a way the value alone does not show: `summarize()`
   * turns any `warn` fact into an "Also, …" clause on the restore sentence AND makes the
   * whole operation conclude `partial`. An unrecorded checksum is the normal case for every
   * archive currently on the box, so a `warn` here would turn every one of their restores
   * amber and say something untrue about the restore itself.
   */
  it("never carries a verdict", () => {
    expect(integrityFact({ state: "verified", sha256: "a".repeat(64) })).not.toHaveProperty(
      "verdict"
    );
    expect(integrityFact({ state: "unrecorded", why: "x" })).not.toHaveProperty("verdict");
  });

  it("says it could not check, rather than implying it passed", () => {
    const f = integrityFact({ state: "unrecorded", why: "x" });
    expect(f.value).toContain("could not be checked");
  });
});
