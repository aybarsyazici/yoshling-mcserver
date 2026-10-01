import { describe, it, expect } from "vitest";
import {
  applyVerdict,
  checkIntegrity,
  digestsOf,
  needsProjectFallback,
  serverModTotal,
  serverSideVerdict,
  skippedSentence,
  type ObservedArtefact,
} from "../mod-admission";

/**
 * The live Modrinth API, measured 2026-10-01 over `/v2/project/<id>/version` for the 40
 * most-downloaded mods — 160 versions. These are the real pairings of a version's
 * `environment` against its project's `server_side`, with the counts, and they are the
 * reason `mod-admission.ts` is shaped the way it is rather than a one-line
 * `environment === "client_only"` test:
 *
 * | `environment`                   | `server_side` |  n |
 * |---------------------------------|---------------|----|
 * | `client_only`                   | unsupported   | 66 |
 * | `client_or_server_prefers_both` | optional      | 36 |
 * | `client_or_server`              | optional      | 24 |
 * | `client_only_server_optional`   | optional      | 16 |
 * | `client_and_server`             | optional      |  8 |
 * | `client_and_server`             | required      |  4 |
 * | `unknown`                       | required      |  4 |
 * | `client_and_server`             | unsupported   |  2 |
 *
 * Named mods confirmed individually: Sodium, Iris and Sodium Extra are `client_only` /
 * `server_side: unsupported`; Lithium and Fabric API are `client_or_server_prefers_both` /
 * `optional`; FerriteCore is `client_or_server` / `optional`; LuckPerms is `server_only`
 * with some versions `unknown`, project `server_side: required`.
 */
const MEASURED = [
  { environment: "client_only", serverSide: "unsupported", n: 66, install: false },
  { environment: "client_or_server_prefers_both", serverSide: "optional", n: 36, install: true },
  { environment: "client_or_server", serverSide: "optional", n: 24, install: true },
  { environment: "client_only_server_optional", serverSide: "optional", n: 16, install: true },
  { environment: "client_and_server", serverSide: "optional", n: 8, install: true },
  { environment: "client_and_server", serverSide: "required", n: 4, install: true },
  { environment: "unknown", serverSide: "required", n: 4, install: true },
  { environment: "client_and_server", serverSide: "unsupported", n: 2, install: true },
] as const;

describe("which mods belong on a dedicated server", () => {
  /**
   * The whole table at once. Every combination that exists in the wild gets the answer
   * the sampling says it should, so a change to the enum map that happens to keep one
   * hand-picked case working still turns this red.
   */
  it("decides every combination measured on the live API", () => {
    for (const row of MEASURED) {
      const v = serverSideVerdict({ environment: row.environment, serverSide: row.serverSide });
      expect(v.install, `${row.environment} / ${row.serverSide}`).toBe(row.install);
    }
  });

  /**
   * The property the filter exists for, stated on the mod that motivates it. Sodium is
   * 66-of-160's worth of this shape and it is in every optimisation pack anyone imports.
   */
  it("skips a client-only mod and says why", () => {
    const v = serverSideVerdict({ environment: "client_only" });
    expect(v.install).toBe(false);
    expect(v.basis).toBe("version-environment");
    expect(v.declared).toBe("unsupported");
    // The reason has to be a sentence a user can disagree with, not the word "skipped".
    expect(v.reason).toMatch(/client-only/);
    expect(v.reason).toMatch(/no server support/);
  });

  /**
   * `client_only_server_optional` is the trap: it reads like a skip and is not one.
   * Modrinth's own project field for all 16 of those versions says `server_side:
   * optional`, i.e. the server is a supported target — so dropping it would be us
   * overriding the registry to remove a mod a pack author chose.
   */
  it("installs client_only_server_optional, which reads like a skip", () => {
    expect(serverSideVerdict({ environment: "client_only_server_optional" }).install).toBe(true);
  });

  /**
   * The disagreement that fixes the signal ORDER, and the only one in the sample: 2
   * versions declare `client_and_server` while their project declares `server_side:
   * unsupported`. Per-project-first would drop a mod whose own build says it needs a
   * server. Per-version-first installs it.
   */
  it("prefers the version's own declaration over stale project metadata", () => {
    const v = serverSideVerdict({ environment: "client_and_server", serverSide: "unsupported" });
    expect(v.install).toBe(true);
    expect(v.basis).toBe("version-environment");
  });

  /**
   * The complement, and the reason filtering is safe at all: the two signals NEVER
   * disagreed on a skip across 160 versions — `client_only` paired with `unsupported`
   * 66 times out of 66. So the destructive decision is never made on contested data.
   */
  it("agrees with the project field on every skip", () => {
    for (const row of MEASURED.filter((r) => !r.install)) {
      expect(serverSideVerdict({ serverSide: row.serverSide }).install).toBe(false);
      expect(serverSideVerdict({ environment: row.environment }).install).toBe(false);
    }
  });

  /**
   * `unknown` is a value the API returns (4 of 160), not a missing field, and it has to
   * fall THROUGH to the project rather than being decided. Both directions matter: it
   * must not drop a mod whose project says `required`, and it must not install one whose
   * project says `unsupported`.
   */
  it("falls through an unknown environment to the project's server_side", () => {
    expect(serverSideVerdict({ environment: "unknown", serverSide: "required" }).install).toBe(true);
    const dropped = serverSideVerdict({ environment: "unknown", serverSide: "unsupported" });
    expect(dropped.install).toBe(false);
    expect(dropped.basis).toBe("project-server-side");
    // And the reason names the project, because a skip decided on project metadata is
    // the one a user is most likely to want to argue with.
    expect(dropped.reason).toMatch(/project/);
  });

  /**
   * An enum Modrinth has already extended once. A value we do not recognise must fall
   * through, never be guessed at from the string: a substring test for "client" would
   * read a future `client_or_server_prefers_server` as client-only and delete it from
   * every pack it appears in.
   */
  it("falls through a value it does not recognise rather than guessing", () => {
    const future = serverSideVerdict({
      environment: "client_or_server_prefers_server",
      serverSide: "required",
    });
    expect(future.install).toBe(true);
    expect(future.basis).toBe("project-server-side");
    // With nothing else to go on it installs — fail-open, because a wrong skip removes a
    // mod the pack needs and nothing on screen would say which.
    expect(serverSideVerdict({ environment: "something_new_entirely" }).install).toBe(true);
  });

  /** Nothing declared at all (a Technic/Solder direct download) installs and says so. */
  it("installs when nothing is declared, and records that nothing was", () => {
    const v = serverSideVerdict({});
    expect(v.install).toBe(true);
    expect(v.basis).toBe("nothing-declared");
    expect(v.declared).toBe("unknown");
    expect(serverSideVerdict({ environment: null, serverSide: null }).basis).toBe("nothing-declared");
    expect(serverSideVerdict({ environment: "  ", serverSide: "unknown" }).basis).toBe(
      "nothing-declared"
    );
  });

  /**
   * The `.mrpack` index shape. Documented in Modrinth's modpack format as an object with
   * a `client` and a `server` value — it is NOT on the API's version object (measured:
   * 160 of 160 version objects carry `environment` and none carry `env`), so nothing in
   * this repo produces it yet. It ranks first because it is the pack author's statement
   * about one exact file, which is more specific than either registry-wide field.
   */
  it("reads the mrpack env object, and ranks it above the version", () => {
    const v = serverSideVerdict({
      env: { client: "required", server: "unsupported" },
      // Deliberately contradicted by both weaker signals, so the ordering is what passes
      // this and not the answer happening to agree.
      environment: "client_and_server",
      serverSide: "required",
    });
    expect(v.install).toBe(false);
    expect(v.basis).toBe("file-env");
    expect(serverSideVerdict({ env: { server: "required" }, environment: "client_only" }).install).toBe(
      true
    );
    // A pack entry that omits `env` (the field is optional in the format) must not be
    // read as a declaration.
    expect(serverSideVerdict({ env: {}, environment: "client_only" }).basis).toBe(
      "version-environment"
    );
  });

  /**
   * `needsProjectFallback` is a cost decision: it is what stops the modpack installer
   * making 166 extra HTTP round trips to change about four answers.
   */
  it("asks for the project only when the version decided nothing", () => {
    expect(needsProjectFallback({ environment: "unknown" })).toBe(true);
    expect(needsProjectFallback({})).toBe(true);
    expect(needsProjectFallback({ environment: "client_only" })).toBe(false);
    expect(needsProjectFallback({ environment: "client_or_server" })).toBe(false);
  });
});

/**
 * A real Modrinth file, copied from the live API on 2026-10-01: Sodium's build for
 * Minecraft 1.21.1 (`/v2/project/sodium/version?game_versions=["1.21.1"]`, files[0]).
 * Both hashes are present, which is what the modpack format requires ("MUST contain the
 * SHA1 hash and the SHA512 hash") and what was observed on every file looked at.
 */
const LIVE_FILE = {
  hashes: {
    sha1: "1757289be21ed18db5b0d90703fa3db1b2de5693",
    sha512:
      "4f537696af95411e9daf15795fb5fcbc49913d488a96fa912fa8f1d7db408710995e8a1461190f3cd0f8217bf9e35e9539176592428ed587ca2d7aa84450a390",
  },
  size: 1_000_000,
};

/** The digests of some actual bytes, so the comparison is exercised against something
 * `digestsOf` really produced rather than against a literal typed next to it. */
const JAR = Buffer.from("PK\u0003\u0004 pretend this is a mod jar");
const REAL: ObservedArtefact = digestsOf(JAR);

describe("hash verification", () => {
  /**
   * The baseline: `digestsOf` has to agree with the thing that produced the published
   * digest. Pinned against an independent vector (`sha1`/`sha512` of the empty string are
   * published constants) so a transposed algorithm name — `sha1` computed into the
   * `sha512` field — cannot pass by being self-consistent.
   */
  it("computes the digests the registry would have computed", () => {
    const empty = digestsOf(Buffer.alloc(0));
    expect(empty.sha1).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(empty.sha512).toBe(
      "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
    );
    expect(empty.size).toBe(0);
    expect(REAL.sha512).toHaveLength(128);
    expect(REAL.sha1).toHaveLength(40);
    expect(REAL.size).toBe(JAR.byteLength);
  });

  it("passes a file that matches the published sha512", () => {
    const check = checkIntegrity({ hashes: { sha1: REAL.sha1, sha512: REAL.sha512 } }, REAL);
    expect(check.ok).toBe(true);
    expect(check.checked).toBe("sha512");
    expect(check.reason).toBe("");
  });

  /**
   * The defect this exists for. A truncated download is the common corruption, and
   * before this the route wrote it and answered `{success:true}`.
   */
  it("fails a truncated download, and names what it compared", () => {
    const truncated = digestsOf(JAR.subarray(0, JAR.byteLength - 1));
    const check = checkIntegrity({ hashes: { sha1: REAL.sha1, sha512: REAL.sha512 } }, truncated);
    expect(check.ok).toBe(false);
    expect(check.checked).toBe("sha512");
    // Both digests, truncated to something readable, plus the byte count — enough to tell
    // two failed downloads apart in a 166-row report.
    expect(check.reason).toContain(REAL.sha512.slice(0, 12));
    expect(check.reason).toContain(truncated.sha512.slice(0, 12));
    expect(check.reason).toContain(String(truncated.size));
    // And it has to say the file did not land, or the user has no idea what state the
    // mods directory is in.
    expect(check.reason).toMatch(/discarded, not installed/);
  });

  /**
   * sha512 must WIN when both are published, and the test has to be able to tell. A
   * correct sha1 beside a wrong sha512 is exactly the file a sha1-first implementation
   * would wave through — and sha1 is the weaker digest, which is the whole reason the
   * order is specified.
   */
  it("prefers sha512 even when a correct sha1 sits beside a wrong one", () => {
    const check = checkIntegrity(
      { hashes: { sha1: REAL.sha1, sha512: digestsOf(Buffer.from("other")).sha512 } },
      REAL
    );
    expect(check.ok).toBe(false);
    expect(check.checked).toBe("sha512");
  });

  /** Falls back to sha1 only when sha512 is genuinely absent, not when it is blank. */
  it("falls back to sha1 when that is all that was published", () => {
    const ok = checkIntegrity({ hashes: { sha1: REAL.sha1 } }, REAL);
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBe("sha1");

    const bad = checkIntegrity({ hashes: { sha1: digestsOf(Buffer.from("other")).sha1 } }, REAL);
    expect(bad.ok).toBe(false);
    expect(bad.checked).toBe("sha1");

    // An empty or whitespace sha512 is not a declaration — a `!= null` test would try to
    // compare against "" and fail every single mod.
    expect(checkIntegrity({ hashes: { sha1: REAL.sha1, sha512: "" } }, REAL).checked).toBe("sha1");
    expect(checkIntegrity({ hashes: { sha1: REAL.sha1, sha512: "   " } }, REAL).checked).toBe("sha1");
  });

  /**
   * Hex case varies by registry. A `===` on the raw strings would reject every file from
   * one that upper-cases its digests — a total failure that looks exactly like universal
   * corruption.
   */
  it("compares hex case-insensitively and ignores surrounding whitespace", () => {
    expect(checkIntegrity({ hashes: { sha512: REAL.sha512.toUpperCase() } }, REAL).ok).toBe(true);
    expect(checkIntegrity({ hashes: { sha512: ` ${REAL.sha512}\n` } }, REAL).ok).toBe(true);
    expect(checkIntegrity({ hashes: { sha1: REAL.sha1.toUpperCase() } }, REAL).ok).toBe(true);
  });

  /** With no hash at all, size catches the truncation and claims nothing more. */
  it("uses size when no checksum was published, and does not call that verification", () => {
    const ok = checkIntegrity({ size: REAL.size }, REAL);
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBe("size");
    // It passed, and it still says what was and was not checked — the result carries a
    // reason on a PASS, which no other passing branch does.
    expect(ok.reason).toMatch(/only the file size/);

    const short = checkIntegrity({ size: REAL.size + 10 }, REAL);
    expect(short.ok).toBe(false);
    expect(short.checked).toBe("size");
    expect(short.reason).toMatch(/truncated/);
  });

  /**
   * `size: 0` is the API's "no value", and a real jar is never zero bytes. Treating it as
   * a declaration would compare 0 against the real length and fail every mod from a
   * source that does not publish sizes.
   */
  it("does not treat a zero size as a declaration", () => {
    const check = checkIntegrity({ size: 0 }, REAL);
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(null);
  });

  /**
   * Nothing published: the file is admitted, and `checked: null` is how the caller knows
   * to say "installed, not verified" rather than implying it checked. The registry has an
   * `unverified` outcome for precisely this distinction.
   */
  it("admits a file with nothing to check against, flagged as unchecked", () => {
    const check = checkIntegrity({}, REAL);
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(null);
    expect(check.reason).toMatch(/could not be verified/);
    expect(checkIntegrity({ hashes: null, size: null }, REAL).checked).toBe(null);
  });

  /** The live file from the API, against bytes that are not it. The published digest is
   * real; what we "downloaded" is not — which is the whole failure mode in one line. */
  it("rejects real published hashes against the wrong bytes", () => {
    const check = checkIntegrity(LIVE_FILE, REAL);
    expect(check.ok).toBe(false);
    expect(check.checked).toBe("sha512");
    expect(check.reason).toContain(LIVE_FILE.hashes.sha512.slice(0, 12));
  });
});

describe("what 'installed n of m' counts", () => {
  /**
   * **The property this whole group exists for.** An apply that installs every
   * server-side mod and leaves the client-only ones out is COMPLETE — green, outcome
   * `ok`. Counting the skips in the denominator would make it `installed < total`, which
   * `install-modpack` settles as a `noop` step and `concludeOperation` turns into
   * `partial`: every correct apply of every real pack would render amber and summarise as
   * something having gone wrong.
   *
   * That is not hypothetical here. It is the regression this repo's test suite was
   * created over — a `noop` step made every clean Minecraft and 7DTD backup conclude
   * "but part of it is missing. This is not a restore point." — reappearing in a new
   * place. A large pack is 30-50% client mods, so it would have fired on every use.
   */
  it("calls an apply complete when only client-only mods were left out", () => {
    const v = applyVerdict({ packSize: 166, skipped: 40, installed: 126 });
    expect(v.total).toBe(126);
    expect(v.complete).toBe(true);
    expect(v.failed).toBe(0);
  });

  /**
   * The other direction, which is the one a naive "use plan.length" fix would break: a
   * mod that was attempted and did not land keeps its place in the denominator, so the
   * count cannot read complete while errors are listed beside it.
   */
  it("keeps a failed mod in the denominator", () => {
    const v = applyVerdict({ packSize: 166, skipped: 40, installed: 125 });
    expect(v.total).toBe(126);
    expect(v.complete).toBe(false);
    expect(v.failed).toBe(1);
  });

  it("is unchanged from the old behaviour when nothing is skipped", () => {
    // The pre-filtering semantics have to survive, or this change silently redefines
    // every historical count. A pack with no client mods reports exactly what it used to.
    expect(applyVerdict({ packSize: 166, skipped: 0, installed: 166 })).toEqual({
      total: 166,
      failed: 0,
      complete: true,
    });
    expect(applyVerdict({ packSize: 166, skipped: 0, installed: 0 })).toEqual({
      total: 166,
      failed: 166,
      complete: false,
    });
  });

  /**
   * An all-client pack. `total: 0` is what makes the route refuse before it tars the
   * world and deletes every jar — and `complete` must NOT be true for it, or installing
   * nothing would report success. The route takes the refusal branch on `plan.length ===
   * 0` before this is read, and this pins that the arithmetic agrees with that decision
   * rather than quietly contradicting it.
   */
  it("gives an all-client-only pack a total of zero", () => {
    const v = applyVerdict({ packSize: 45, skipped: 45, installed: 0 });
    expect(v.total).toBe(0);
    expect(v.failed).toBe(0);
    // 0 === 0, so `complete` is vacuously true. That is exactly why the route refuses on
    // the empty plan FIRST and never reaches this — asserted here so that the day someone
    // deletes that guard, this comment is sitting next to the reason.
    expect(v.complete).toBe(true);
  });

  it("never reports a negative total or a negative failure count", () => {
    // Impossible by construction (the skipped set is a filter of the pack), so this
    // guards a future caller counting something else rather than a case seen today —
    // "Installed 0 of -3 mods" in the report dialog is worse than being wrong quietly.
    expect(serverModTotal(10, 12)).toBe(0);
    expect(applyVerdict({ packSize: 10, skipped: 12, installed: 0 }).failed).toBe(0);
    expect(applyVerdict({ packSize: 10, skipped: 0, installed: 12 }).failed).toBe(0);
  });

  /**
   * `complete` is EQUALITY, not `installed >= total` — and this is the assertion that
   * tells the two apart, which nothing else in the file does.
   *
   * Installing more mods than belong on the server cannot happen while the loop walks a
   * plan it built itself, so `>=` is behaviourally identical today and a mutation to it
   * survived the rest of this suite. It is still the wrong operator: an overshoot means
   * something double-counted, and `>=` would answer 200 `{success:true}` for it while
   * equality makes the route say "Only 12 of 10 mods were installed" — nonsense, but
   * nonsense somebody reads. In a codebase whose documented recurring defect is "reports
   * success after doing nothing or the wrong thing", a miscount has to surface rather
   * than round itself off into a green toast.
   */
  it("does not call an overshoot complete", () => {
    expect(applyVerdict({ packSize: 10, skipped: 0, installed: 12 }).complete).toBe(false);
  });

  it("subtracts the skips from the pack size, not from the plan", () => {
    expect(serverModTotal(166, 40)).toBe(126);
    expect(serverModTotal(3, 0)).toBe(3);
    expect(serverModTotal(0, 0)).toBe(0);
  });
});

describe("the sentence the report leads with", () => {
  it("names the skipped mods instead of only counting them", () => {
    const s = skippedSentence([
      { name: "Sodium", reason: "client-only — this build declares no server support" },
      { name: "Iris Shaders", reason: "client-only — this build declares no server support" },
    ]);
    expect(s).toContain("2 mods");
    expect(s).toContain("Sodium");
    expect(s).toContain("Iris Shaders");
    // Says what "skipped" means, because "skipped" alone reads like a failure.
    expect(s).toMatch(/do not run on a server/);
  });

  it("truncates a long list and says how many are left", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Mod ${i}`, reason: "r" }));
    const s = skippedSentence(many, 8);
    expect(s).toContain("40 mods");
    expect(s).toContain("Mod 7");
    expect(s).not.toContain("Mod 8");
    expect(s).toContain("+32 more");
  });

  it("is singular for one mod", () => {
    expect(skippedSentence([{ name: "Sodium", reason: "r" }])).toContain("1 mod skipped");
  });

  /** Empty string for an empty list, so a caller can `if (sentence)` — a report that
   * reads "0 mods skipped" on the normal path is noise, and noise gets ignored. */
  it("says nothing when nothing was skipped", () => {
    expect(skippedSentence([])).toBe("");
  });
});
