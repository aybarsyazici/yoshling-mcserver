import { describe, it, expect } from "vitest";
import {
  applyReport,
  applyVerdict,
  checkIntegrity,
  declaredFromHeaders,
  digestsOf,
  needsProjectFallback,
  serverModTotal,
  serverSideVerdict,
  skippedSentence,
  unrecognisedEnvironmentSentence,
  type ObservedArtefact,
} from "../mod-admission";

/**
 * The live Modrinth API, measured 2026-10-01 over `/v2/project/<id>/version` across **527
 * projects / 2,751 versions** — the top 200 mods by downloads, the top 100 each of
 * `server_side:required`, `server_side:unsupported` and `client_side:unsupported`, the top
 * 60 plugins, the 100 newest mods, and the top 40 each of modpacks and datapacks. These
 * are the real pairings of a version's `environment` against its project's `server_side`,
 * with the counts, and they are the reason `mod-admission.ts` is shaped the way it is
 * rather than a one-line `environment === "client_only"` test.
 *
 * **This table replaces a 160-version one drawn from the 40 most-downloaded mods, and the
 * narrow sample was actively misleading.** It contained no `server_only` row at all — even
 * though the source comment claimed the value had been "observed directly on LuckPerms" —
 * so flipping `server_only` from `required` to `unsupported` in the enum map was
 * catastrophic and undetected: every server-only mod in every pack, silently dropped. It
 * also missed `server_only_client_optional`, `dedicated_server_only` and
 * `singleplayer_only` entirely. Nine rows below exist only because the sample was widened.
 *
 * Every row is a (environment, server_side) pair that occurs in the wild; `n` is how often.
 * Rows are ordered by `environment` frequency, and the whole table is driven through
 * `serverSideVerdict` in the first test, so a mapping change that happens to keep one
 * hand-picked case working still turns it red.
 */
const MEASURED = [
  { environment: "client_and_server", serverSide: "required", n: 683, install: true },
  { environment: "client_and_server", serverSide: "optional", n: 24, install: true },
  { environment: "client_and_server", serverSide: "unsupported", n: 15, install: true },
  { environment: "client_only", serverSide: "unsupported", n: 681, install: false },
  { environment: "client_only", serverSide: "optional", n: 2, install: false },
  { environment: "client_only", serverSide: "required", n: 1, install: false },
  { environment: "server_only", serverSide: "required", n: 495, install: true },
  { environment: "server_only", serverSide: "optional", n: 2, install: true },
  { environment: "unknown", serverSide: "required", n: 315, install: true },
  { environment: "unknown", serverSide: "optional", n: 16, install: true },
  { environment: "unknown", serverSide: "unsupported", n: 4, install: false },
  { environment: "client_or_server_prefers_both", serverSide: "optional", n: 185, install: true },
  { environment: "client_or_server_prefers_both", serverSide: "unsupported", n: 6, install: true },
  { environment: "client_only_server_optional", serverSide: "optional", n: 107, install: true },
  { environment: "client_only_server_optional", serverSide: "unsupported", n: 15, install: true },
  { environment: "client_or_server", serverSide: "optional", n: 82, install: true },
  { environment: "client_or_server", serverSide: "required", n: 3, install: true },
  { environment: "server_only_client_optional", serverSide: "required", n: 55, install: true },
  { environment: "dedicated_server_only", serverSide: "required", n: 15, install: true },
  { environment: "dedicated_server_only", serverSide: "unsupported", n: 1, install: true },
  { environment: "singleplayer_only", serverSide: "required", n: 14, install: false },
] as const;

/**
 * The three values the narrow sample missed, with the projects they were measured on and
 * what each one says about a dedicated server.
 *
 * Separate from `MEASURED` because these are the rows a regression is most likely to
 * remove — they are the ones somebody tidying the enum map would not recognise — and
 * because the direction of each one needs stating on its own, with the mod that proves it.
 */
const WIDENED_SAMPLE_ADDITIONS = [
  {
    environment: "singleplayer_only",
    install: false,
    projects: ["e4mc", "buildpaste", "runlab"],
    why: "opens a SINGLEPLAYER world; the opposite of a dedicated server",
  },
  {
    environment: "server_only_client_optional",
    install: true,
    projects: ["c2me-fabric", "vmp-fabric", "tectonic", "open-parties-and-claims"],
    why: "server performance and worldgen mods",
  },
  {
    environment: "dedicated_server_only",
    install: true,
    projects: ["bluemap", "dynmap", "dcintegration", "tab-was-taken"],
    why: "web maps and chat bridges that only exist on a server",
  },
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
    // Every value in the enum is exercised, so a row cannot be quietly dropped from the
    // table above and take its coverage with it. 10 distinct values were measured.
    expect(new Set(MEASURED.map((r) => r.environment)).size).toBe(10);
  });

  /**
   * **Each value decided on its own, with no project field to lean on.**
   *
   * `MEASURED` always supplies a `serverSide`, and for every row except the skips that
   * field agrees with the answer — so flipping a single mapping in `ENVIRONMENT_TO_SERVER`
   * can leave the table green by falling through to a project that happens to say the same
   * thing. `server_only` → `"unsupported"` is exactly that mutation: catastrophic (every
   * server-only mod in every pack dropped) and invisible, because `server_only` had no row
   * in the old table at all.
   *
   * Here the version is the only signal, so the mapping itself is what passes or fails.
   */
  it("decides each environment value with no project field to fall back on", () => {
    const expected: Record<string, { install: boolean; declared: string }> = {
      client_only: { install: false, declared: "unsupported" },
      singleplayer_only: { install: false, declared: "unsupported" },
      server_only: { install: true, declared: "required" },
      server_only_client_optional: { install: true, declared: "required" },
      dedicated_server_only: { install: true, declared: "required" },
      client_and_server: { install: true, declared: "required" },
      client_or_server: { install: true, declared: "optional" },
      client_or_server_prefers_both: { install: true, declared: "optional" },
      client_only_server_optional: { install: true, declared: "optional" },
    };
    for (const [environment, want] of Object.entries(expected)) {
      const v = serverSideVerdict({ environment });
      expect(v.install, environment).toBe(want.install);
      expect(v.declared, environment).toBe(want.declared);
      expect(v.basis, environment).toBe("version-environment");
      // A mapped value is never reported as drift, however surprising it looks.
      expect(v.unrecognisedEnvironment, environment).toBeUndefined();
    }
    // `unknown` is the tenth value and the only one that decides nothing.
    expect(serverSideVerdict({ environment: "unknown" }).basis).toBe("nothing-declared");
    expect(serverSideVerdict({ environment: "unknown" }).unrecognisedEnvironment).toBeUndefined();
    // The table above has to stay exhaustive, or a future value can be added to the map
    // with no row here and no test.
    expect(Object.keys(expected)).toHaveLength(9);
  });

  /**
   * The three values the 160-version sample missed, each asserted on its own with the
   * projects it was measured on. `singleplayer_only` is the one that changes an answer, and
   * it is the whole justification for widening the sample.
   */
  it.each(WIDENED_SAMPLE_ADDITIONS)(
    "maps $environment ($why)",
    ({ environment, install, projects }) => {
      expect(projects.length).toBeGreaterThan(0);
      expect(serverSideVerdict({ environment }).install).toBe(install);
    }
  );

  /**
   * `server_only` on its own, named, because it is the mutation that survived review and
   * the one with the largest blast radius: 503 of 2,751 sampled versions are `server_only`,
   * and mapping it to `unsupported` would make the installer drop every one of them —
   * LuckPerms, dynmap, every permissions and admin mod — while reporting a clean apply,
   * since a skip is not a failure.
   */
  it("installs a server_only mod, which is the mutation with the widest blast radius", () => {
    const v = serverSideVerdict({ environment: "server_only" });
    expect(v.install).toBe(true);
    expect(v.declared).toBe("required");
    expect(v.reason).toBe("");
    // Even with no project field, and even when the project disagrees (measured: 2 of 503
    // `server_only` versions sit on a project saying `optional`, 6 on one saying `unknown`).
    expect(serverSideVerdict({ environment: "server_only", serverSide: "unknown" }).install).toBe(
      true
    );
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
   * Modrinth's project field says `server_side: optional` for 107 of those 122 versions,
   * i.e. the server is a supported target — so dropping it would be us overriding the
   * registry to remove a mod a pack author chose.
   */
  it("installs client_only_server_optional, which reads like a skip", () => {
    expect(serverSideVerdict({ environment: "client_only_server_optional" }).install).toBe(true);
  });

  /**
   * The disagreement that fixes the signal ORDER. 15 versions declare `client_and_server`
   * while their project declares `server_side: unsupported`. Per-project-first would drop a
   * mod whose own build says it needs a server. Per-version-first installs it.
   */
  it("prefers the version's own declaration over stale project metadata", () => {
    const v = serverSideVerdict({ environment: "client_and_server", serverSide: "unsupported" });
    expect(v.install).toBe(true);
    expect(v.basis).toBe("version-environment");
  });

  /**
   * **A test whose predecessor encoded a false claim.** It read "the two signals NEVER
   * disagreed on a skip across 160 versions" and asserted, for every skipping row, that the
   * project field alone would also have skipped. That held only because the 160-version
   * sample was the top 40 mods. The 2,751-version sample has **17 counter-examples**: all
   * 14 `singleplayer_only` versions sit on a project declaring `server_side: required`, and
   * 3 `client_only` versions on one declaring `required`/`optional`.
   *
   * So the honest property is not "the signals agree before we skip" — they sometimes do
   * not. It is **"a skip needs a positive `unsupported` from the most specific signal
   * available, and that signal is the version"**, which gets all 17 right where a
   * project-first ordering would get all 17 wrong by installing a singleplayer mod on a
   * dedicated server.
   */
  it("skips on the version's declaration even when the project contradicts it", () => {
    // The real counter-examples, by project, from the measurement.
    const contested = [
      { mod: "e4mc", environment: "singleplayer_only", serverSide: "required" },
      { mod: "buildpaste", environment: "singleplayer_only", serverSide: "required" },
      { mod: "runlab", environment: "singleplayer_only", serverSide: "required" },
      { mod: "simple-homing-xp-no-particles", environment: "client_only", serverSide: "required" },
      { mod: "pick-up-notifier", environment: "client_only", serverSide: "optional" },
    ];
    for (const row of contested) {
      const v = serverSideVerdict({ environment: row.environment, serverSide: row.serverSide });
      expect(v.install, row.mod).toBe(false);
      expect(v.basis, row.mod).toBe("version-environment");
    }
    // And the project field alone still skips the uncontested majority (681 of 686
    // `client_only` versions pair with `unsupported`), so the fallback is not useless — it
    // is just not the signal that decides when both are present.
    expect(serverSideVerdict({ serverSide: "unsupported" }).install).toBe(false);
  });

  /**
   * `unknown` is a value the API returns (355 of 2,751), not a missing field, and it has to
   * fall THROUGH to the project rather than being decided. Both directions matter: it
   * must not drop the 331 mods whose project says `required`/`optional`, and it must not
   * install the 4 whose project says `unsupported`.
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
   * every pack it appears in — and would have read `singleplayer_only` as server-side.
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

  /**
   * **Safe AND loud.** Falling through silently is how `singleplayer_only` was installed on
   * dedicated servers by the feature written to keep it off them: it was in the live API the
   * whole time, it was not in the table, and nothing anywhere said so. The fall-through is
   * the safe half and stays; `unrecognisedEnvironment` is the half that was missing.
   */
  it("reports an environment value it cannot read, while still installing the mod", () => {
    const v = serverSideVerdict({ environment: "client_or_server_prefers_server" });
    expect(v.install).toBe(true);
    expect(v.unrecognisedEnvironment).toBe("client_or_server_prefers_server");

    // Reported whatever the eventual verdict is, including when a project field decides it
    // — the point is that our table is stale, not that the answer was wrong.
    expect(
      serverSideVerdict({ environment: "brand_new", serverSide: "unsupported" })
        .unrecognisedEnvironment
    ).toBe("brand_new");
    expect(
      serverSideVerdict({ environment: "BRAND_NEW", serverSide: "required" }).unrecognisedEnvironment
    ).toBe("brand_new");

    // And NOT reported for anything that is not drift: a mapped value (however odd it
    // looks), a declared `unknown`, an absent field, or whitespace.
    for (const environment of ["singleplayer_only", "dedicated_server_only", "unknown", "", "  "]) {
      expect(
        serverSideVerdict({ environment, serverSide: "required" }).unrecognisedEnvironment,
        environment || "(blank)"
      ).toBeUndefined();
    }
    expect(serverSideVerdict({}).unrecognisedEnvironment).toBeUndefined();
    expect(serverSideVerdict({ environment: null }).unrecognisedEnvironment).toBeUndefined();
  });

  /** The skip reason quotes the raw enum value, because `client_only` and
   * `singleplayer_only` are both skips and are not the same statement. */
  it("names the declaration that decided a skip, not just the word client-only", () => {
    expect(serverSideVerdict({ environment: "singleplayer_only" }).reason).toMatch(
      /`singleplayer_only`/
    );
    expect(serverSideVerdict({ environment: "client_only" }).reason).toMatch(/`client_only`/);
    // The project-decided skip keeps naming the project instead, since there is no version
    // declaration to quote.
    expect(serverSideVerdict({ serverSide: "unsupported" }).reason).toMatch(/project/);
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
    // The three added values decide locally, which is the 71 fetches of the sample that
    // mapping them removed outright.
    expect(needsProjectFallback({ environment: "singleplayer_only" })).toBe(false);
    expect(needsProjectFallback({ environment: "server_only_client_optional" })).toBe(false);
    expect(needsProjectFallback({ environment: "dedicated_server_only" })).toBe(false);
    // An unreadable value still needs the fallback — that is what makes it safe.
    expect(needsProjectFallback({ environment: "brand_new" })).toBe(true);
  });
});

/**
 * The declaration a plain HTTP download comes with, now that the direct-download branch no
 * longer passes a literal `{}` to `checkIntegrity` (which could only ever answer `ok: true`,
 * making the guard below it unreachable code on the one path with no registry hashes).
 */
describe("Content-Length as the direct download's declaration", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("reads a plain Content-Length as a size declaration", () => {
    expect(declaredFromHeaders(headers({ "content-length": "4096" }))).toEqual({ size: 4096 });
    expect(declaredFromHeaders(headers({ "Content-Length": " 4096 " }))).toEqual({ size: 4096 });
  });

  /**
   * **The guard that stops this breaking every direct download.** `fetch` decodes the body
   * transparently, so on a gzip response `Content-Length` is the *compressed* length and
   * comparing it to the decoded byte count fails every single file — universal corruption
   * that is really a universal false positive, the same shape as a case-sensitive hex
   * compare against a registry that upper-cases its digests.
   */
  it("declares nothing when the transfer was encoded", () => {
    expect(declaredFromHeaders(headers({ "content-length": "900", "content-encoding": "gzip" }))).toEqual(
      {}
    );
    expect(declaredFromHeaders(headers({ "content-length": "900", "content-encoding": "br" }))).toEqual(
      {}
    );
    // `identity` is "not encoded", so it is still comparable.
    expect(
      declaredFromHeaders(headers({ "content-length": "900", "content-encoding": "identity" }))
    ).toEqual({ size: 900 });
  });

  it("declares nothing for a missing, empty or non-numeric header", () => {
    expect(declaredFromHeaders(headers({}))).toEqual({});
    expect(declaredFromHeaders(headers({ "content-length": "" }))).toEqual({});
    expect(declaredFromHeaders(headers({ "content-length": "   " }))).toEqual({});
    // A comma-joined duplicate header. `Number("42, 42")` is NaN and `Number("")` is 0;
    // either one reaching the comparison is a false verdict on a good file.
    expect(declaredFromHeaders(headers({ "content-length": "42, 42" }))).toEqual({});
    expect(declaredFromHeaders(headers({ "content-length": "abc" }))).toEqual({});
    expect(declaredFromHeaders(headers({ "content-length": "-1" }))).toEqual({});
    // Zero is the "no value" case, same as on a registry file: a real jar is never empty.
    expect(declaredFromHeaders(headers({ "content-length": "0" }))).toEqual({});
  });

  /** End to end: the header plus the bytes, through the real comparison. A truncated
   * transfer is refused; a complete one passes as a size check, never as "verified". */
  it("catches a truncated transfer and refuses to call a size check verification", () => {
    const full = digestsOf(JAR);
    const short = digestsOf(JAR.subarray(0, 4));

    const bad = checkIntegrity(
      declaredFromHeaders(headers({ "content-length": String(JAR.byteLength) })),
      short
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/truncated/);

    const good = checkIntegrity(
      declaredFromHeaders(headers({ "content-length": String(JAR.byteLength) })),
      full
    );
    expect(good.ok).toBe(true);
    expect(good.checked).toBe("size");

    // No header at all: admitted, and flagged as unchecked so the report says so.
    expect(checkIntegrity(declaredFromHeaders(headers({})), full).checked).toBe(null);
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

describe("the warning raised by an environment value we cannot read", () => {
  it("names the value and a mod carrying it", () => {
    const s = unrecognisedEnvironmentSentence([
      { name: "FromTheFuture", environment: "client_or_server_prefers_server" },
    ]);
    // The raw string, because the only useful action is to look it up and add a row.
    expect(s).toContain("client_or_server_prefers_server");
    expect(s).toContain("FromTheFuture");
    // And it says what was done about it, so a reader does not assume mods were dropped.
    expect(s).toMatch(/nothing was skipped/);
    expect(s).toContain("src/lib/mod-admission.ts");
  });

  it("counts distinct values, not mods", () => {
    const s = unrecognisedEnvironmentSentence([
      { name: "A", environment: "brand_new" },
      { name: "B", environment: "brand_new" },
      { name: "C", environment: "also_new" },
    ]);
    expect(s).toMatch(/^Modrinth reported 2 `environment` values/);
  });

  it("truncates a long list and says how many are left", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `Mod ${i}`, environment: "x" }));
    const s = unrecognisedEnvironmentSentence(many, 3);
    expect(s).toContain("Mod 2");
    expect(s).not.toContain("Mod 3");
    expect(s).toContain("+6 more");
  });

  it("says nothing when the table is up to date", () => {
    expect(unrecognisedEnvironmentSentence([])).toBe("");
  });
});

describe("what the apply reports about itself", () => {
  const sodium = { name: "Sodium", reason: "client-only — this build declares `client_only`" };
  const iris = { name: "Iris", reason: "client-only — this build declares `client_only`" };

  function report(over: Partial<Parameters<typeof applyReport>[0]> = {}) {
    return applyReport({
      packSize: 10,
      installed: 8,
      skipped: [sodium, iris],
      errors: [],
      warnings: [],
      unverified: [],
      ...over,
    });
  }

  /**
   * **The defect this function was extracted to fix.** The client-only skips were pushed
   * into `warnings` *and* returned in `skipped`, so `modpacks.tsx` rendered the same
   * decision twice — once in `chart-5`, the amber warning colour, and once in the world's
   * accent under a heading whose own comment said "nothing went wrong here". A large pack
   * is 30–50% client mods, so the amber block fired on every correct apply, which is how a
   * report teaches people to ignore it.
   *
   * The colour is a claim. Skips travel in `skipped`; `warnings` stays empty unless
   * something actually wants looking at.
   */
  it("keeps client-only skips out of the amber warning channel", () => {
    const r = report();
    expect(r.warnings).toEqual([]);
    expect(r.skipped).toEqual([sodium, iris]);
    // Stated the other way round too, so a mutant that puts the sentence back in under any
    // wording is caught rather than only the exact `skippedSentence` call.
    expect(r.warnings.join(" ")).not.toMatch(/skipped|client-only|Sodium|Iris/);
  });

  /** Warnings raised before the loop are passed through — the channel is not disabled, it
   * is reserved for things that are actually warnings. */
  it("passes through the warnings that are real warnings", () => {
    const r = report({ warnings: ["3 of 10 mods in this pack have no download source"] });
    expect(r.warnings).toEqual(["3 of 10 mods in this pack have no download source"]);
  });

  it("warns about mods installed with nothing to verify them against", () => {
    const r = report({ unverified: ["Technic Thing"] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("Technic Thing");
    expect(r.warnings[0]).toMatch(/was installed without a checksum/);
    // Plural agreement, because this sentence is read far more often than it is written.
    expect(report({ unverified: ["A", "B"] }).warnings[0]).toMatch(/were installed/);
    // Long lists are cut, with the remainder counted.
    const many = report({ unverified: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(many.warnings[0]).toContain("+2 more");
  });

  /**
   * **The step label the reviewer found unreachable.** It read
   * `Installed 0 of N mods — no download source recorded`, which stopped being possible the
   * moment the plan pass landed: a row with no source is counted out *before* the download
   * loop, so reaching the loop means the plan was non-empty and `installed === 0` means
   * every planned download failed. Naming the one cause that can no longer produce it is
   * worse than naming none — somebody reading it after a Modrinth outage re-imports a pack
   * that was fine.
   */
  it("says what actually happened when nothing installed", () => {
    const r = report({ installed: 0, errors: ["A: 502", "B: 502", "C: 502"] });
    expect(r.stepLabel).toBe("Installed 0 of 8 mods — 8 failed");
    expect(r.stepLabel).not.toMatch(/no download source/);
    expect(r.error).toMatch(/No mods were installed \(0 of 8\)/);
    expect(r.complete).toBe(false);
  });

  it("states the shortfall when some installed and some did not", () => {
    const r = report({ installed: 6 });
    expect(r.stepLabel).toBe("Installed 6 of 8 mods — 2 failed");
    expect(r.failed).toBe(2);
    expect(r.error).toBe("Only 6 of 8 mods were installed.");
  });

  /**
   * The green case, and the denominator decision in one assertion: 10 rows, 2 client-only,
   * 8 installed is **complete**. Counting the skips would make it 8 of 10 — a `noop` step,
   * outcome `partial`, amber on every correct apply of every real pack. That is the
   * backup-`noop` regression this suite was created over.
   */
  it("calls an apply with only client-only shortfall complete, and adds no error", () => {
    const r = report();
    expect(r.total).toBe(8);
    expect(r.complete).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.stepLabel).toBe("Installed 8 of 8 mods");
    expect(r.error).toBeUndefined();
    expect(r.stepLabel).not.toMatch(/failed/);
  });

  /** The errors list is passed through untouched — the route's per-mod reasons are what the
   * dialog lists, and a report that summarised them would lose the only actionable detail. */
  it("passes the per-mod failures through verbatim", () => {
    const errors = ["Gone: no compatible version", "Bad: sha512 mismatch"];
    expect(report({ installed: 6, errors }).errors).toEqual(errors);
  });
});
