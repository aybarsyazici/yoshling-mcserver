import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **The two guarantees `mod-manager.ts` exists to make, driven through the real functions.**
 *
 * `src/lib/__tests__/mod-admission.test.ts` pins the pure comparison and
 * `mod-verify-before-write.test.ts` pins the ORDER of the statements. Neither executes
 * `downloadVerifiedJar` or `serverSideFor`, and an adversarial review proved that gap is
 * not theoretical — it produced two surviving mutants in minutes:
 *
 * 1. `if (!check.ok)` → `if (!check.ok && check.checked === "sha1")` in
 *    `downloadVerifiedJar`. A **sha512 mismatch then returns the corrupt buffer**, which is
 *    the primary guarantee of the whole change, and every test stayed green because the
 *    only thing asserting it was a comment.
 * 2. Replacing `serverSideFor`'s catch body turns its fail-OPEN into a fail-CLOSED skip,
 *    i.e. a brief Modrinth outage quietly deletes mods from a pack — "the wrong-skip
 *    failure this whole feature is ordered to avoid", in the words of the comment sitting
 *    on the line.
 *
 * The four modules `mod-manager` imports for I/O are mocked (`db`, `modrinth`,
 * `server-manager`, `fs/promises`) and `fetch` is stubbed, so this needs no network, no
 * Prisma and no mods directory — the line `vitest.config.mts` draws. `mod-admission` is
 * deliberately **not** mocked: the hash comparison under test is the real one.
 */

const writeFile = vi.fn(async () => {});
const unlink = vi.fn(async () => {});
vi.mock("fs/promises", () => ({ writeFile, unlink }));

const create = vi.fn(async () => ({}));
const activityCreate = vi.fn(async () => ({}));
vi.mock("../db", () => ({
  db: { installedMod: { create }, activity: { create: activityCreate } },
}));

const getProject = vi.fn();
const getProjectVersions = vi.fn();
vi.mock("../modrinth", () => ({ getProject, getProjectVersions }));

vi.mock("../server-manager", () => ({ getModsDir: () => "/mods" }));

const { ModIntegrityError, downloadVerifiedJar, installMod, serverSideFor } = await import(
  "../mod-manager"
);
const { digestsOf } = await import("../mod-admission");

/** Some bytes that stand in for a jar, and the digests a registry would have published. */
const JAR = Buffer.from("PK\u0003\u0004 pretend this is a mod jar");
const REAL = digestsOf(JAR);

/** The one wire-level stub: a 200 carrying `body`. */
function serving(body: Buffer): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }))
  );
}

function file(hashes: { sha1?: string; sha512?: string }, size?: number) {
  return {
    url: "https://cdn.modrinth.com/data/AAAA/versions/1/thing.jar",
    filename: "thing.jar",
    hashes,
    size: size ?? 0,
    primary: true,
  } as never;
}

beforeEach(() => {
  writeFile.mockClear();
  unlink.mockClear();
  create.mockClear();
  activityCreate.mockClear();
  getProject.mockReset();
  getProjectVersions.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadVerifiedJar refuses bytes that are not what was published", () => {
  /**
   * **The mutant.** The published sha512 does not match the bytes that arrived, so nothing
   * may come back out of this function.
   *
   * Asserted on the THROW and on the error's own `check.checked`, because the mutation that
   * survived was specifically `check.checked === "sha1"` — an assertion that only said
   * "rejects a bad file somehow" would be satisfied by a sha1-only test and leave the
   * sha512 path, the one Modrinth actually uses for every file, undefended.
   */
  it("throws on a sha512 mismatch instead of handing back the buffer", async () => {
    serving(Buffer.from("totally different bytes"));
    const err = await downloadVerifiedJar(file({ sha512: REAL.sha512 })).then(
      (v) => v as never,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ModIntegrityError);
    expect((err as InstanceType<typeof ModIntegrityError>).check.checked).toBe("sha512");
    expect((err as InstanceType<typeof ModIntegrityError>).fileName).toBe("thing.jar");
  });

  /** The sha1 fallback path, so neither hash branch is the only one covered. */
  it("throws on a sha1 mismatch when sha1 is all that was published", async () => {
    serving(Buffer.from("totally different bytes"));
    await expect(downloadVerifiedJar(file({ sha1: REAL.sha1 }))).rejects.toBeInstanceOf(
      ModIntegrityError
    );
  });

  /** And the size-only path, which is what a direct download gets. */
  it("throws on a truncated download when only a size was published", async () => {
    serving(JAR.subarray(0, 5));
    const err = await downloadVerifiedJar(file({}, JAR.byteLength)).then(
      (v) => v as never,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ModIntegrityError);
    expect((err as InstanceType<typeof ModIntegrityError>).check.checked).toBe("size");
  });

  it("returns the bytes, and which hash it compared, when they match", async () => {
    serving(JAR);
    const got = await downloadVerifiedJar(file({ sha1: REAL.sha1, sha512: REAL.sha512 }));
    expect(got.check.ok).toBe(true);
    expect(got.check.checked).toBe("sha512");
    expect(got.buffer.equals(JAR)).toBe(true);
  });

  it("says a file with nothing published was not verified, and still returns it", async () => {
    serving(JAR);
    const got = await downloadVerifiedJar(file({}));
    expect(got.check.checked).toBe(null);
    expect(got.buffer.equals(JAR)).toBe(true);
  });

  it("fails a non-200 before it hashes anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))
    );
    await expect(downloadVerifiedJar(file({ sha512: REAL.sha512 }))).rejects.toThrow(/404/);
  });
});

describe("installMod never leaves a corrupt jar behind", () => {
  /**
   * The guarantee stated at the level that matters: on a hash mismatch **nothing is
   * written and nothing is recorded**. `mod-verify-before-write.test.ts` proves the check
   * is textually above the write; this proves the write does not happen.
   */
  it("writes no file and records no row when the hash disagrees", async () => {
    serving(Buffer.from("corrupt"));
    await expect(
      installMod({
        modrinthId: "AAAA",
        slug: "thing",
        name: "Thing",
        version: {
          version_number: "1.0.0",
          game_versions: ["26.1.2"],
          loaders: ["fabric"],
          files: [file({ sha512: REAL.sha512 })],
        } as never,
        userId: "u1",
        source: "manual",
      })
    ).rejects.toBeInstanceOf(ModIntegrityError);

    expect(writeFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("writes the verified bytes and records the install when the hash agrees", async () => {
    serving(JAR);
    const check = await installMod({
      modrinthId: "AAAA",
      slug: "thing",
      name: "Thing",
      version: {
        version_number: "1.0.0",
        game_versions: ["26.1.2"],
        loaders: ["fabric"],
        files: [file({ sha512: REAL.sha512 })],
      } as never,
      userId: "u1",
      source: "manual",
    });
    expect(check.checked).toBe("sha512");
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [target, bytes] = writeFile.mock.calls[0] as unknown as [string, Buffer];
    expect(target).toBe("/mods/thing.jar");
    expect(bytes.equals(JAR)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  /**
   * **Provenance reaches the row, not just the signature.** `source` and `versionId` are
   * the two columns added on 2026-10-02 so the Installed page can answer "which of these
   * did the pack put there" and so increment 5 has a build id to pin against — and both
   * were already in hand at this call site and discarded. A writer that accepts `source`
   * and then does not persist it is the drop-it-on-the-floor shape `mod-install-routes`
   * found eleven of.
   */
  it("records where the row came from and which build is on disk", async () => {
    serving(JAR);
    await installMod({
      modrinthId: "AAAA",
      slug: "thing",
      name: "Thing",
      version: {
        id: "VeRsIoN1",
        version_number: "1.0.0",
        game_versions: ["26.1.2"],
        loaders: ["fabric"],
        files: [file({ sha512: REAL.sha512 })],
      } as never,
      userId: "u1",
      source: "pack",
    });
    // The fake takes no declared arguments, so its recorded calls type as `[]`.
    const [{ data }] = create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(data.source).toBe("pack");
    // The **id**, not `version_number`: a version number is a publisher's free text and
    // cannot be handed back to Modrinth to identify a build.
    expect(data.versionId).toBe("VeRsIoN1");
    expect(data.version).toBe("1.0.0");
  });
});

describe("serverSideFor fails OPEN when Modrinth cannot be reached", () => {
  /**
   * **The mutant.** The version says `unknown`, so the project is the only thing left to
   * ask — and asking fails. The honest answer is the undeclared one: install it, and record
   * that nothing was declared.
   *
   * A fail-closed catch (`return {install: false, …}`) is the shape that survived review,
   * and it is worse than it looks: a Modrinth blip during a 166-mod apply would silently
   * shrink the pack, and the mods it dropped would never appear in the report as failures
   * because a skip is not a failure. Both halves are asserted — `install` *and* `basis` —
   * so a mutant that returns `{install: true}` with a decided basis (claiming the project
   * answered when it did not) is caught too.
   */
  it("installs, and reports nothing-declared, when the project fetch throws", async () => {
    getProject.mockRejectedValue(new Error("fetch failed"));
    const v = await serverSideFor({ environment: "unknown" } as never, "AAAA");
    expect(getProject).toHaveBeenCalledWith("AAAA");
    expect(v.install).toBe(true);
    expect(v.basis).toBe("nothing-declared");
    expect(v.declared).toBe("unknown");
  });

  /** Same for a version with no `environment` at all (an older or cached response). */
  it("installs when there is no environment and the project fetch throws", async () => {
    getProject.mockRejectedValue(new Error("502"));
    expect((await serverSideFor({} as never, "AAAA")).install).toBe(true);
  });

  /** The fallback working, so the catch is not passing by never being the live path. */
  it("uses the project's server_side when the fetch succeeds", async () => {
    getProject.mockResolvedValue({ server_side: "unsupported" });
    const v = await serverSideFor({ environment: "unknown" } as never, "AAAA");
    expect(v.install).toBe(false);
    expect(v.basis).toBe("project-server-side");

    getProject.mockResolvedValue({ server_side: "required" });
    expect((await serverSideFor({ environment: "unknown" } as never, "BBBB")).install).toBe(true);
  });

  /**
   * And the fetch is CONDITIONAL. This is the cost decision that keeps a 166-mod apply from
   * making 166 extra round trips; if the fetch became unconditional nothing else here would
   * notice, because every answer would be the same.
   */
  it("does not fetch the project when the version already decided", async () => {
    getProject.mockRejectedValue(new Error("must not be called"));
    expect((await serverSideFor({ environment: "client_only" } as never, "AAAA")).install).toBe(
      false
    );
    expect((await serverSideFor({ environment: "server_only" } as never, "AAAA")).install).toBe(
      true
    );
    expect(getProject).not.toHaveBeenCalled();
  });
});
