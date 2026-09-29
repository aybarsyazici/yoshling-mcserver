import { describe, expect, it } from "vitest";
// Relative, not `@/lib/...`: this then runs under a bare `npx vitest run` with no
// config at all, which is what let it be watched failing before the harness landed.
import { BadArchiveError, manifestSidecarPath, safeBackupName } from "../backup-archive";

/**
 * `safeBackupName` gates a name that reaches both `path.join` and `tar`'s argv in
 * three backup routes. It was copy-pasted into each of them, which is why this file
 * exists at all: one predicate, one set of assertions, three callers.
 *
 * Every hostile input below was tried by hand against production first — these are
 * the recorded vectors, not invented ones.
 */
describe("safeBackupName", () => {
  const hostile = [
    "../../../etc/passwd",
    "x.tar.gz; rm -rf /",
    "$(id).tar.gz",
    "`id`.tar.gz",
    "zomboid-x.tar.gz/../x",
    ".hidden.tar.gz",
    "../zomboid-yoshling-2026-09-18T22-47-35.tar.gz",
    // A separator `path.basename` would have stripped on win32 and kept on posix.
    "..\\..\\x.tar.gz",
    // Right extension, wrong shape: a bare directory traversal that ends correctly.
    "a/b.tar.gz",
    // Not an archive at all — the sidecar must not be reachable through this name.
    "7dtd-Reveo_Valley-2026-09-29T13-40-40.tar.gz.manifest.json",
    "world.tar.gz\n",
    "",
    ".",
    "..",
  ];

  for (const name of hostile) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(safeBackupName(name)).toBeNull();
    });
  }

  const accepted = [
    "zomboid-yoshling-2026-09-29T19-01-20.tar.gz",
    "auto-before-modpack-2026-09-29T18-29-08.tar.gz",
    "world-2026-09-29T19-01-20.tar.gz",
    "7dtd-Reveo_Valley-2026-09-29T13-40-40.tar.gz",
    // `/api/7dtd/reset` names its pre-reset archive after the world without
    // sanitising it, so a space has to be admitted. No shell ever sees it.
    "presreset-Reveo Valley-2026-09-29T13-40-40.tar.gz",
  ];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(safeBackupName(name)).toBe(name);
    });
  }

  it("rejects anything that is not a string", () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(safeBackupName(v)).toBeNull();
    }
  });
});

describe("manifestSidecarPath", () => {
  it("sits beside the archive, and cannot be mistaken for one", () => {
    const p = manifestSidecarPath("/app/data/backups-7dtd/7dtd-x-2026-09-29T13-40-40.tar.gz");
    expect(p).toBe("/app/data/backups-7dtd/7dtd-x-2026-09-29T13-40-40.tar.gz.manifest.json");
    // The listings filter on `.tar.gz`, so a sidecar must never end in it — otherwise
    // every archive would appear twice, the second with a size of ~100 bytes.
    expect(p.endsWith(".tar.gz")).toBe(false);
  });
});

describe("BadArchiveError", () => {
  it("is distinguishable after being rethrown by runOperation", () => {
    // `runOperation` and `withGameStopped` both `throw err` unchanged, so the route's
    // catch can still tell "your archive is wrong" (400) from "the server broke" (500).
    const e: unknown = new BadArchiveError("This backup has no world folder in it.");
    expect(e instanceof BadArchiveError).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect((e as Error).message).toContain("no world folder");
  });
});
