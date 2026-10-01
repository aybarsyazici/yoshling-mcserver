import { createHash } from "node:crypto";

/**
 * The two checks a jar has to pass before it is allowed into the Minecraft mods
 * directory: **does it run on a dedicated server at all**, and **is it the file
 * Modrinth said it would be**.
 *
 * Neither existed. `/api/mods/install-modpack` downloaded every row of a pack into the
 * server's mods dir and `installMod` wrote whatever bytes came back off the wire, so:
 *
 * - A client-only mod (Sodium, Iris, a resource-pack shim) landed on the server, where
 *   at best it does nothing and at worst Fabric Loader aborts on it and the container
 *   never finishes booting — which on this box renders as a permanent "Starting…" with
 *   no explanation, the single most expensive failure shape in this repo's history.
 * - A truncated or corrupted download wrote a bad jar and the route answered
 *   `{success:true}`. That is this codebase's documented recurring defect ("reports
 *   success after doing nothing or the wrong thing") in the one place where the
 *   evidence to prevent it was already in the payload: `ModrinthFile.hashes` has been
 *   typed in `modrinth.ts` since the file was written and nothing ever read it.
 *
 * Pure on purpose. The routes do the fetching; every branch below is decided from data
 * and is unit-testable with no network, no database and no mods directory.
 */

// ---------------------------------------------------------------------------
// Which side of the game a mod belongs on
// ---------------------------------------------------------------------------

/**
 * Modrinth's client/server type specification, used verbatim by the project fields
 * (`client_side` / `server_side`) and by the `env` object in a `.mrpack`'s
 * `modrinth.index.json`.
 *
 * `unknown` is a real value the API returns, not a stand-in for "field missing" — and
 * the distinction matters, because it is the case that has to fall through to a less
 * specific signal rather than being decided.
 */
export type SideDeclaration = "required" | "optional" | "unsupported" | "unknown";

/**
 * Everything that can tell us whether a mod runs server-side, in the shapes Modrinth
 * actually publishes them in. All optional: a caller passes whatever it has.
 *
 * **The task that produced this file asked for `env.server`, and that field is real but
 * it is not on the API's version object.** Measured against the live API on 2026-10-01
 * (`/v2/project/<id>/version` over 527 projects, 2,751 versions — see the table on
 * `ENVIRONMENT_TO_SERVER` for how that sample was drawn): a version object's keys are
 * `author_id changelog changelog_url date_published dependencies downloads environment
 * featured files game_versions id loaders name project_id requested_status status
 * version_number version_type` — there is no `env`, and `environment` is a single
 * string, present on 2,751 of 2,751. `env: {client, server}` is the **modpack-index** shape
 * (documented in Modrinth's `.mrpack` format: "an object which contains a client and a
 * server value", each `required | optional | unsupported`, and the whole field
 * optional). So both are accepted here and `env` is ranked first as the most specific —
 * it is a per-file statement by the pack author rather than a per-project one — but
 * nothing in this repo produces it yet: `ModpackMod` stores
 * `modrinthId slug name versionId downloadUrl` and the importer reads the API, not a
 * `.mrpack`. It is four lines and a test, and it means an importer that does read a
 * `.mrpack` needs no change here.
 */
export interface ModSideSignals {
  /**
   * `files[].env` from a `.mrpack` index. Most specific: the pack author's statement
   * about this exact file.
   */
  env?: { client?: string | null; server?: string | null } | null;
  /** `environment` off an API version object, e.g. `"client_only"`. */
  environment?: string | null;
  /** `server_side` off an API *project* object, e.g. `"unsupported"`. */
  serverSide?: string | null;
}

export interface ServerSideVerdict {
  /** True = put it in the mods directory. */
  install: boolean;
  /** Which signal decided, so a report can say where the answer came from. */
  basis: "file-env" | "version-environment" | "project-server-side" | "nothing-declared";
  /** The declaration that decided it, normalised. */
  declared: SideDeclaration;
  /**
   * One clause for the user, written here next to the facts so a route cannot
   * paraphrase it into "skipped". Empty string when there is nothing to say.
   */
  reason: string;
  /**
   * The raw `environment` string, set **only** when it is a value this app has no
   * mapping for — i.e. Modrinth has extended the enum since the table below was
   * measured.
   *
   * This is the "loud" half of failing safe. The fall-through is the safe half and it
   * stays: an unmapped value is treated as undeclared, so the next signal decides and
   * nothing is dropped on a string we cannot read. But silence was the wrong second
   * half. `singleplayer_only` existed in the live API the whole time this file's first
   * draft was being written and was not in its table, so every `singleplayer_only` mod
   * fell through to a project field that for all three of them says the server is
   * *required* — and was installed, silently, by the feature whose entire job is to keep
   * exactly that jar off the server. A value we cannot read has to reach the report, or
   * the enum is never updated because nobody learns it drifted.
   */
  unrecognisedEnvironment?: string;
}

/**
 * The `environment` enum, mapped to what it says about the *server*.
 *
 * Measured, not inferred. 2026-10-01, `/v2/project/<id>/version` over **527 projects /
 * 2,751 versions** (up to 6 versions each). The sample is deliberately not just the
 * most-downloaded mods — that first sample was 160 versions of the top 40 mods and it
 * *missed three of the ten values*, including the one that matters most. It is the top
 * 200 mods by downloads, the top 100 each of `server_side:required`,
 * `server_side:unsupported` and `client_side:unsupported`, the top 60 plugins, the 100
 * newest mods, and the top 40 each of modpacks and datapacks.
 *
 * | `environment`                   |   n | server is |
 * |---------------------------------|-----|-----------|
 * | `client_and_server`             | 724 | required |
 * | `client_only`                   | 686 | unsupported |
 * | `server_only`                   | 503 | required |
 * | `unknown`                       | 355 | unknown |
 * | `client_or_server_prefers_both` | 191 | optional |
 * | `client_only_server_optional`   | 122 | optional |
 * | `client_or_server`              |  85 | optional |
 * | `server_only_client_optional`   |  55 | required |
 * | `dedicated_server_only`         |  16 | required |
 * | `singleplayer_only`             |  14 | unsupported |
 *
 * The three at the bottom are the ones the narrow sample missed, and they are the reason
 * a wider one was worth drawing:
 *
 * - **`singleplayer_only` is the shape this whole feature exists to exclude** and is the
 *   only addition that changes an answer from install to skip (e4mc, buildpaste, runlab —
 *   mods that open a *singleplayer* world, which is the opposite of a dedicated server).
 *   All 14 of those versions sit on a project whose `server_side` says **required**, so
 *   without a mapping here every one of them is installed on the server. That is the
 *   strongest argument in this file for ranking the version above the project.
 * - `server_only_client_optional` (c2me, vmp, tectonic, open-parties-and-claims) and
 *   `dedicated_server_only` (bluemap, dynmap, dcintegration) are server mods. They were
 *   already being installed by the fall-through, so mapping them changes no outcome in
 *   the sample — it changes the *basis*, from "nothing declared, so install" to "declared
 *   required", and it removes the per-project HTTP fetch those 71 versions were each
 *   costing.
 *
 * **`client_only_server_optional` installs.** It reads like a skip and is not one:
 * Modrinth's project field says `server_side: optional` for 107 of those 122 versions,
 * i.e. the server is a supported target. Overriding a pack author to remove a mod the
 * registry says the server tolerates is the wrong direction of error — see the note on
 * `serverSideVerdict`.
 *
 * A value **not** in this table maps to `unknown`, falls through to the next signal, and
 * is reported through `unrecognisedEnvironment`. Falling through is the only safe thing
 * to do with an enum Modrinth can extend — guessing from the string ("does it contain
 * 'client'?") would read a future `client_or_server_prefers_server` as client-only and
 * delete it from every pack, and would have read `singleplayer_only` as server-side.
 * Reporting it is what stops the table going stale again. Note that the literal string
 * `"unknown"` is a *mapped* value, not an unrecognised one: Modrinth returns it for 355
 * of 2,751 versions and it means "this build says nothing", which is a different fact
 * from "we cannot read what this build said".
 */
const ENVIRONMENT_TO_SERVER: Record<string, SideDeclaration> = {
  client_only: "unsupported",
  singleplayer_only: "unsupported",
  server_only: "required",
  server_only_client_optional: "required",
  dedicated_server_only: "required",
  client_and_server: "required",
  client_or_server: "optional",
  client_or_server_prefers_both: "optional",
  client_only_server_optional: "optional",
  unknown: "unknown",
};

function normaliseSide(raw: string | null | undefined): SideDeclaration {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "required" || v === "optional" || v === "unsupported") return v;
  return "unknown";
}

/**
 * Does this mod belong on a dedicated server?
 *
 * **Skip only what is positively declared `unsupported`.** Everything else —
 * `required`, `optional`, and anything undeclared — installs. The asymmetry is
 * deliberate and it is the whole safety argument for being allowed to filter at all:
 *
 * - A wrong *skip* removes a mod the pack needs. The server then either boots missing
 *   content or, if another mod depends on it, does not boot at all — and the user has
 *   no way to tell, because the mod was never in the list to begin with.
 * - A wrong *install* puts a client mod on the server, which is the status quo this
 *   file is fixing, and it is reported rather than hidden.
 *
 * The signal ordering (file `env` → version `environment` → project `server_side`) is
 * most-specific-first, and the measurement over 2,751 versions says the version is the
 * one to trust when they differ:
 *
 * - **A skip the project contradicts: 17 of 2,751 (0.6%).** All 14 `singleplayer_only`
 *   versions sit on a project declaring `server_side: required` (e4mc, buildpaste,
 *   runlab), plus 3 `client_only` versions on a project declaring `required`/`optional`
 *   (pick-up-notifier, simple-homing-xp-no-particles). Every one of those is a client
 *   mod with stale project metadata, so the version-first ordering gets all 17 right and
 *   a project-first ordering would get all 17 wrong — by *installing* them.
 * - An install the project contradicts: 37 of 2,751, led by 15 `client_and_server`
 *   versions whose project says `unsupported`. Same conclusion, other direction: the
 *   build knows, the project field has rotted.
 *
 * **The earlier draft of this comment said "the signals never conflict on a skip" and
 * that is false** — it was measured over 160 versions of the top 40 mods, where
 * `client_only` paired with `server_side: unsupported` 66 times out of 66. The wider
 * sample has 17 counter-examples. The ordering survives the correction (it is right in
 * all 17); the claim that nothing contested is ever skipped does not, so do not lean on
 * it. What makes filtering safe is that a skip needs a **positive `unsupported`** from
 * the most specific signal available, not that the signals agree.
 *
 * The fall-through on `unknown` is why this cannot be a one-liner: `unknown` is a value
 * the API returns (355 of 2,751), and 335 of those are paired with a project
 * `server_side` that *was* decided. Treating it as "not server-supported" would drop 331
 * mods the registry says the server supports; treating it as decided-install would
 * ignore the 4 whose project says `unsupported`.
 */
export function serverSideVerdict(signals: ModSideSignals): ServerSideVerdict {
  const rawEnvironment = (signals.environment ?? "").trim().toLowerCase();
  const mappedEnvironment = rawEnvironment ? ENVIRONMENT_TO_SERVER[rawEnvironment] : undefined;
  // Loud, not silent — see `unrecognisedEnvironment`. An absent/blank `environment` is
  // not unrecognised, it is simply not there; only a value Modrinth published that this
  // table has no row for counts.
  const loud: Pick<ServerSideVerdict, "unrecognisedEnvironment"> =
    rawEnvironment && mappedEnvironment === undefined
      ? { unrecognisedEnvironment: rawEnvironment }
      : {};

  const candidates: Array<{ basis: ServerSideVerdict["basis"]; declared: SideDeclaration }> = [
    { basis: "file-env", declared: normaliseSide(signals.env?.server) },
    { basis: "version-environment", declared: mappedEnvironment ?? "unknown" },
    { basis: "project-server-side", declared: normaliseSide(signals.serverSide) },
  ];

  const decided = candidates.find((c) => c.declared !== "unknown");
  if (!decided) {
    return {
      install: true,
      basis: "nothing-declared",
      declared: "unknown",
      reason: "",
      ...loud,
    };
  }

  if (decided.declared === "unsupported") {
    return {
      install: false,
      basis: decided.basis,
      declared: "unsupported",
      // Names the publisher of the claim, because "skipped as client-only" with no
      // source is unarguable-with, and a wrong skip is the expensive direction. The
      // version branch quotes the raw enum value: `singleplayer_only` and `client_only`
      // are both skips and they are not the same statement, and a user looking at a
      // mod they expected on the server needs the word Modrinth actually published.
      reason:
        decided.basis === "project-server-side"
          ? "client-only — Modrinth lists this project as server-side unsupported"
          : decided.basis === "version-environment"
          ? `client-only — this build declares \`${rawEnvironment}\`, which has no server support`
          : "client-only — this build declares no server support",
      ...loud,
    };
  }

  return { install: true, basis: decided.basis, declared: decided.declared, reason: "", ...loud };
}

/**
 * The warning raised when Modrinth published an `environment` value this app cannot read.
 *
 * Its own sentence, next to the table it is about, so the route cannot water it down into
 * "some mods could not be checked". It names the value *and* a mod carrying it, because
 * the only useful action is to look that value up and add a row to
 * `ENVIRONMENT_TO_SERVER` — and a warning that does not say which string to look up gets
 * read once and never acted on.
 *
 * Returns `""` for an empty list so a caller can `if (sentence)` without a length check.
 */
export function unrecognisedEnvironmentSentence(
  seen: Array<{ name: string; environment: string }>,
  limit = 5
): string {
  if (seen.length === 0) return "";
  const values = [...new Set(seen.map((s) => s.environment))];
  const examples = seen.slice(0, limit).map((s) => `\`${s.environment}\` on ${s.name}`);
  const rest = seen.length - examples.length;
  return (
    `Modrinth reported ${values.length} \`environment\` value${values.length === 1 ? "" : "s"} ` +
    `this app does not recognise (${examples.join(", ")}${rest > 0 ? `, +${rest} more` : ""}). ` +
    `They were treated as undeclared, so nothing was skipped because of them — but the ` +
    `mapping in src/lib/mod-admission.ts is out of date and should be updated.`
  );
}

/**
 * Is this version's server support merely undeclared?
 *
 * The routes use it to decide whether the extra per-project fetch is worth making.
 * Measured over 2,751 versions: the version's own `environment` decides **2,396 of them
 * (87%)**, so fetching the project for every mod would add one HTTP round trip per mod to
 * change at most 13% of the answers. (The first draft of this comment said 4 of 160 —
 * 2.5% — because it was measured on the top 40 mods only. 13% is a smaller saving than
 * that implied but still the overwhelming majority of a 166-mod apply's fetches, and
 * mapping `server_only_client_optional` and `dedicated_server_only` above removed 71 of
 * the sample's fallbacks outright.)
 */
export function needsProjectFallback(signals: Omit<ModSideSignals, "serverSide">): boolean {
  return serverSideVerdict(signals).basis === "nothing-declared";
}

// ---------------------------------------------------------------------------
// Is it the file Modrinth said it would be
// ---------------------------------------------------------------------------

/** What the registry told us to expect. Every field optional: a Technic/Solder direct
 * download publishes none of them. */
export interface DeclaredArtefact {
  hashes?: { sha1?: string | null; sha512?: string | null } | null;
  /** Bytes, as the API reported them. */
  size?: number | null;
}

/** What we actually got. `digestsOf` produces this from the downloaded buffer. */
export interface ObservedArtefact {
  sha1: string;
  sha512: string;
  size: number;
}

export interface IntegrityCheck {
  /** False = do not write this file anywhere. */
  ok: boolean;
  /**
   * What the verdict rests on. `null` means **nothing was published to check against**,
   * which is reported as unverified rather than passed off as verified — the registry
   * already has an `unverified` outcome precisely because "it finished and I could not
   * read the evidence back" needed to be sayable in this codebase.
   */
  checked: "sha512" | "sha1" | "size" | null;
  /** One sentence, specific enough to act on. Empty when `checked` is a hash and it matched. */
  reason: string;
}

/**
 * sha1 and sha512 of a buffer, plus its length.
 *
 * Both, always, because which one gets compared depends on what the registry published
 * and hashing is cheap next to the download it follows. Measured on this machine over a
 * 16 MiB buffer — larger than any single mod jar in the 166-mod pack this route exists
 * for — sha1 is 5.1 ms, sha512 is 8.6 ms and computing both costs 13.5 ms, against
 * whole seconds for the fetch. So there is nothing to save by choosing one up front, and
 * computing both keeps the comparison decided by what the registry published rather than
 * by what we guessed it would publish.
 */
export function digestsOf(buffer: Buffer | Uint8Array): ObservedArtefact {
  return {
    sha1: createHash("sha1").update(buffer).digest("hex"),
    sha512: createHash("sha512").update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
}

function sameHex(a: string, b: string): boolean {
  // Case-insensitive and trimmed: hex digests are published in both cases by different
  // registries and a `===` on the raw strings would fail every mod against a registry
  // that happens to upper-case them. NOT a timing-safe compare, deliberately — this
  // compares a public checksum against a file we just downloaded, there is no secret on
  // either side, and `timingSafeEqual` would only add a length-mismatch throw to guard.
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Compare what arrived against what was declared, **before** anything is written.
 *
 * sha512 first, sha1 only if that is all there is, size only if there is no hash at
 * all. Modrinth's modpack format says a file entry "MUST contain the SHA1 hash and the
 * SHA512 hash", and measured on the live API both are present on every version file
 * looked at — so the sha1 and size branches are for the direct-download (Technic/Solder)
 * path and for a registry that regresses, not for Modrinth's normal output.
 *
 * A size-only check is explicitly *not* called verification in the result: it catches
 * the truncated download, which is the common corruption, and catches nothing else.
 */
export function checkIntegrity(
  declared: DeclaredArtefact,
  observed: ObservedArtefact
): IntegrityCheck {
  const sha512 = (declared.hashes?.sha512 ?? "").trim();
  const sha1 = (declared.hashes?.sha1 ?? "").trim();

  if (sha512) {
    return sameHex(sha512, observed.sha512)
      ? { ok: true, checked: "sha512", reason: "" }
      : {
          ok: false,
          checked: "sha512",
          reason:
            `the downloaded file does not match the sha512 Modrinth published ` +
            `(expected ${short(sha512)}, got ${short(observed.sha512)}, ` +
            `${observed.size} bytes) — the file was discarded, not installed`,
        };
  }

  if (sha1) {
    return sameHex(sha1, observed.sha1)
      ? { ok: true, checked: "sha1", reason: "" }
      : {
          ok: false,
          checked: "sha1",
          reason:
            `the downloaded file does not match the sha1 Modrinth published ` +
            `(expected ${short(sha1)}, got ${short(observed.sha1)}, ` +
            `${observed.size} bytes) — the file was discarded, not installed`,
        };
  }

  // `size: 0` is not a declaration — the API uses it for "no value", and a real jar is
  // never zero bytes — so `> 0` rather than `!= null`.
  if ((declared.size ?? 0) > 0) {
    return declared.size === observed.size
      ? {
          ok: true,
          checked: "size",
          reason: `no checksum was published, so only the file size was checked (${observed.size} bytes)`,
        }
      : {
          ok: false,
          checked: "size",
          reason:
            `the download is ${observed.size} bytes but ${declared.size} were expected — ` +
            `it was truncated, and was discarded rather than installed`,
        };
  }

  return {
    ok: true,
    checked: null,
    reason: `no checksum or size was published for this file, so the download could not be verified`,
  };
}

/** First 12 hex characters. A full sha512 is 128 characters and makes the sentence
 * unreadable in a toast or a one-line report row; 12 is plenty to tell two apart. */
function short(hex: string): string {
  return hex.trim().toLowerCase().slice(0, 12);
}

/**
 * The declaration a plain HTTP download *does* come with: `Content-Length`.
 *
 * This exists because the modpack installer's direct-download (Technic/Solder) branch used
 * to call `checkIntegrity({}, …)` — a literal empty declaration — which can only ever
 * answer `{ok: true}`, so the `if (!check.ok)` guard below it was unreachable code with a
 * comment claiming it was "unreachable today, live tomorrow". It was unreachable
 * permanently, and this is the path with *no* registry hashes, i.e. the only one where a
 * truncated download had nothing at all standing in its way. `ModpackMod` stores
 * `modrinthId slug name versionId downloadUrl` and no hash or size column, so the
 * declaration cannot come from our database; it has to come off the wire.
 *
 * `Content-Length` catches exactly the truncation that a dropped connection produces,
 * which is the corruption `checkIntegrity`'s size branch was written for. It is a weaker
 * guarantee than a hash and the result says so (`checked: "size"`, never "verified").
 *
 * **The `Content-Encoding` guard is load-bearing.** `fetch` decodes the body
 * transparently, so for a gzip/br response `Content-Length` is the *compressed* length and
 * comparing it against the decoded byte count fails every single file — a total failure
 * that looks exactly like universal corruption, which is the same trap the case-sensitive
 * hex compare had. Jars are already-compressed zips and are normally served `identity`,
 * but a CDN that gzips regardless must not take every direct download down with it.
 */
export function declaredFromHeaders(headers: {
  get(name: string): string | null;
}): DeclaredArtefact {
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding && encoding !== "identity") return {};

  const raw = (headers.get("content-length") ?? "").trim();
  // Digits only: a missing header, `""`, a comma-joined duplicate (`"42, 42"`) or any
  // other junk is "no declaration", not a number to compare against. `Number("")` is 0
  // and `Number("42, 42")` is NaN, and either reaching the comparison is a false verdict.
  if (!/^\d+$/.test(raw)) return {};
  const size = Number(raw);
  return Number.isSafeInteger(size) && size > 0 ? { size } : {};
}

// ---------------------------------------------------------------------------
// Saying what was skipped
// ---------------------------------------------------------------------------

export interface SkippedMod {
  name: string;
  reason: string;
}

/**
 * **The denominator**, and the one judgement call in the filtering change.
 *
 * Once an installer is allowed to leave mods out, "installed 126 of 166" stops meaning
 * anything until someone decides what the 166 is. The answer here: **the number of mods
 * that belong on this server** — every row in the pack minus the ones positively declared
 * client-only.
 *
 * Both alternatives are actively wrong, and in opposite directions:
 *
 * - **The pack's row count** makes every honest apply amber. `install-modpack` settles its
 *   download step `noop` when `installed < total`, and `concludeOperation` turns any
 *   `noop` step into outcome `partial` — so a 166-mod pack with 40 client mods could never
 *   reach its total and every correct apply would conclude "partial" and render amber.
 *   That is the backup-`noop` regression this project's test suite was created over
 *   ("part of it is missing. This is not a restore point." on a flawless archive), in a
 *   new costume.
 * - **The plan's length** hides failures. A mod whose version cannot be resolved drops
 *   out of the plan, so the count would read "163 of 163 — complete" with three errors
 *   listed beside it.
 *
 * So a skip leaves the denominator (it is not something that failed to happen) and every
 * other outcome stays in it (they are). `installed === total` then means exactly "every
 * mod that should be on this server is on it", which is the only claim worth rendering
 * green.
 */
export function serverModTotal(packSize: number, skippedCount: number): number {
  // Clamped because this number is a denominator that reaches the UI, and "Installed 0 of
  // -3 mods" is worse than being wrong quietly. It cannot go negative by construction —
  // the skipped set is built by filtering the pack — so the clamp is a guard against a
  // future caller counting something else, not a case that happens today.
  return Math.max(0, packSize - skippedCount);
}

export interface ApplyVerdict {
  /** Mods that belong on this server: the denominator every count is reported against. */
  total: number;
  /** Attempted and did not land — a download failure, a hash mismatch, an unresolved version. */
  failed: number;
  /** Every mod that belongs on this server is on it. The only state worth calling success. */
  complete: boolean;
}

/**
 * The verdict the response and the operation's final step both read, so they cannot
 * disagree about the same apply. Delegates to `serverModTotal`, so there is one
 * definition of the denominator rather than one per reader.
 */
export function applyVerdict(tally: {
  /** Rows in the modpack. */
  packSize: number;
  /** Positively declared client-only, so never attempted. */
  skipped: number;
  /** Jars written and recorded. */
  installed: number;
}): ApplyVerdict {
  const total = serverModTotal(tally.packSize, tally.skipped);
  return {
    total,
    failed: Math.max(0, total - tally.installed),
    complete: tally.installed === total,
  };
}

/**
 * The sentence the modpack report leads with.
 *
 * Names them, up to a limit, rather than only counting: "7 mods skipped" sends the
 * reader to Modrinth to work out which, and the whole point of filtering is that the
 * user can see the decision was right. The same argument is already written down for
 * the `Failed` fact in `install-modpack/route.ts`, which was changed from a count to
 * names for exactly this reason.
 *
 * Returns `""` for an empty list so a caller can `if (sentence)` without a second
 * length check — a skip report that reads "0 mods skipped" is noise on the normal path.
 */
export function skippedSentence(skipped: SkippedMod[], limit = 8): string {
  if (skipped.length === 0) return "";
  const names = skipped.slice(0, limit).map((s) => s.name);
  const rest = skipped.length - names.length;
  return (
    `${skipped.length} mod${skipped.length === 1 ? "" : "s"} ` +
    `skipped as client-only (they do not run on a server): ` +
    names.join(", ") +
    (rest > 0 ? `, +${rest} more` : "") +
    `.`
  );
}

// ---------------------------------------------------------------------------
// What the apply reports, in one place
// ---------------------------------------------------------------------------

export interface ApplyReport extends ApplyVerdict {
  installed: number;
  /**
   * The sentence the operation's final step records. `concludeOperation` reads the step's
   * count rather than its words, but these words are what a human reads in the ledger
   * months later, so they have to be true on every path that can reach them.
   */
  stepLabel: string;
  /**
   * The **amber** channel. `modpacks.tsx` renders every entry in `chart-5` — the warning
   * colour — so a string belongs here only if something actually wants looking at.
   *
   * **Client-only skips are deliberately NOT in here**, and this is the one property of
   * this function worth protecting. They were: the route pushed `skippedSentence(skipped)`
   * into `warnings` *and* returned the named list in `skipped`, so a correct apply of a
   * real pack rendered the same decision twice — once amber as a warning, once in the
   * world accent under a heading whose own comment said "nothing went wrong here". A large
   * pack is 30–50% client mods, so that amber block fired on every correct install, which
   * is how a report teaches people to ignore it. The colour is a claim; the two have to
   * agree. Skips travel in `skipped`, which the dialog renders in the world's accent.
   */
  warnings: string[];
  skipped: SkippedMod[];
  errors: string[];
  /** The headline sentence, present only when the apply did not finish. */
  error?: string;
}

/**
 * Everything the modpack apply says about itself, derived once from the tally.
 *
 * It lives here rather than in the route because the route had four readers of the same
 * arithmetic — the HTTP status, the response `error`, the operation's final step and the
 * per-mod progress bar — and nothing stopping them disagreeing. `applyVerdict` already
 * owned the counts; this owns the sentences built from them.
 */
export function applyReport(input: {
  /** Rows in the modpack. */
  packSize: number;
  installed: number;
  skipped: SkippedMod[];
  errors: string[];
  /**
   * Warnings raised before the download loop — rows with no download source, `environment`
   * values this app cannot read. Genuine warnings, passed through.
   */
  warnings: string[];
  /** Mods now on disk with nothing published to compare them against. */
  unverified: string[];
}): ApplyReport {
  const verdict = applyVerdict({
    packSize: input.packSize,
    skipped: input.skipped.length,
    installed: input.installed,
  });
  const { total, failed, complete } = verdict;
  const warnings = [...input.warnings];

  if (input.unverified.length > 0) {
    warnings.push(
      `${input.unverified.length} mod${input.unverified.length === 1 ? " was" : "s were"} ` +
        `installed without a checksum to verify against ` +
        `(${input.unverified.slice(0, 5).join(", ")}` +
        `${input.unverified.length > 5 ? `, +${input.unverified.length - 5} more` : ""}). ` +
        `Modrinth publishes one for every file, so this means the mod came from a direct ` +
        `download source.`
    );
  }

  return {
    ...verdict,
    installed: input.installed,
    // ONE shortfall sentence, because there is only one kind of shortfall left to report.
    //
    // This used to special-case `installed === 0` as "no download source recorded", which
    // became unreachable the moment the plan pass landed: a row with no source is counted
    // out *before* the download loop (it is pushed to `errors` and the pack is refused
    // outright when none has a source), so reaching the loop at all means the plan was
    // non-empty and `installed === 0` means every planned download failed. The old label
    // named the one cause that could no longer produce it, which is worse than no label —
    // somebody reading "no download source recorded" after a Modrinth outage goes and
    // re-imports a pack that was fine.
    stepLabel: complete
      ? `Installed ${input.installed} of ${total} mods`
      : `Installed ${input.installed} of ${total} mods — ${failed} failed`,
    warnings,
    skipped: input.skipped,
    errors: input.errors,
    ...(complete
      ? {}
      : {
          error:
            input.installed === 0
              ? `No mods were installed (0 of ${total}). The server's mods are now empty.`
              : `Only ${input.installed} of ${total} mods were installed.`,
        }),
  };
}
