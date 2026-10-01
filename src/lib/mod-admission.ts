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
 * (`/v2/project/<id>/version`, 160 versions across the 40 most-downloaded mods): a
 * version object's keys are
 * `author_id changelog changelog_url date_published dependencies downloads environment
 * featured files game_versions id loaders name project_id requested_status status
 * version_number version_type` — there is no `env`, and `environment` is a single
 * string, present on 160 of 160. `env: {client, server}` is the **modpack-index** shape
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
}

/**
 * The `environment` enum, mapped to what it says about the *server*.
 *
 * Measured, not inferred — these are the only six values returned across the 160
 * versions sampled on 2026-10-01, with their counts:
 *
 * | `environment`                   |  n | server is |
 * |---------------------------------|----|-----------|
 * | `client_only`                   | 66 | unsupported |
 * | `client_or_server_prefers_both` | 36 | optional |
 * | `client_or_server`              | 24 | optional |
 * | `client_only_server_optional`   | 16 | optional |
 * | `client_and_server`             | 14 | required |
 * | `unknown`                       |  4 | unknown |
 *
 * `server_only` is absent from that sample because the sample was the most-downloaded
 * *mods*, which skew client-side; it is in the enum and was observed directly on
 * LuckPerms, so it is mapped rather than left to fall through.
 *
 * **`client_only_server_optional` installs.** It reads like a skip and is not one:
 * Modrinth's own project field for all 16 of those versions is `server_side: optional`,
 * i.e. the server is a supported target. Overriding a pack author to remove a mod the
 * registry says the server tolerates is the wrong direction of error — see the note on
 * `serverSideVerdict`.
 *
 * An unrecognised value maps to `unknown` and therefore falls through to the next
 * signal, which is the only safe thing to do with an enum Modrinth can extend: guessing
 * from the string ("does it contain 'client'?") would read a future
 * `client_or_server_prefers_server` as client-only and delete it from every pack.
 */
const ENVIRONMENT_TO_SERVER: Record<string, SideDeclaration> = {
  client_only: "unsupported",
  server_only: "required",
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
 * most-specific-first, and the measurement that justifies it is the one disagreement in
 * the sample: 2 versions declared `client_and_server` while their project declared
 * `server_side: unsupported` — stale project metadata that a per-project check would
 * have used to drop a mod its own build says needs a server. Worth stating the other
 * half too, because it is what makes filtering safe: across all 160 versions
 * `client_only` paired with `server_side: unsupported` 66 times out of 66 and never
 * disagreed. **The signals never conflict on a skip; they conflict only on an install,
 * and the ordering resolves those toward installing.**
 *
 * The fall-through on `unknown` is why this cannot be a one-liner: `unknown` is a value
 * the API returns (4 of 160), and in every case it was paired with a project
 * `server_side` that *was* decided. Treating it as "not server-supported" would drop
 * those; treating it as decided-install would ignore a project that says `unsupported`.
 */
export function serverSideVerdict(signals: ModSideSignals): ServerSideVerdict {
  const candidates: Array<{ basis: ServerSideVerdict["basis"]; declared: SideDeclaration }> = [
    { basis: "file-env", declared: normaliseSide(signals.env?.server) },
    {
      basis: "version-environment",
      declared:
        ENVIRONMENT_TO_SERVER[(signals.environment ?? "").trim().toLowerCase()] ?? "unknown",
    },
    { basis: "project-server-side", declared: normaliseSide(signals.serverSide) },
  ];

  const decided = candidates.find((c) => c.declared !== "unknown");
  if (!decided) {
    return {
      install: true,
      basis: "nothing-declared",
      declared: "unknown",
      reason: "",
    };
  }

  if (decided.declared === "unsupported") {
    return {
      install: false,
      basis: decided.basis,
      declared: "unsupported",
      // Names the publisher of the claim, because "skipped as client-only" with no
      // source is unarguable-with, and a wrong skip is the expensive direction.
      reason:
        decided.basis === "project-server-side"
          ? "client-only — Modrinth lists this project as server-side unsupported"
          : "client-only — this build declares no server support",
    };
  }

  return { install: true, basis: decided.basis, declared: decided.declared, reason: "" };
}

/**
 * Is this version's server support merely undeclared?
 *
 * The routes use it to decide whether the extra per-project fetch is worth making:
 * only 4 of 160 sampled versions are undecided, so resolving the fallback eagerly would
 * add ~160 HTTP round trips to a 166-mod apply to change ~4 answers.
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
