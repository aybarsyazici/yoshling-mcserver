/**
 * **Which pack was last applied to this server, read back out of the durable log.**
 *
 * Nothing recorded this. `/api/mods/install-modpack` is the most destructive endpoint in
 * the app — it tars the world and the mods folder, `removeMod`s **every** installed jar,
 * and downloads up to 166 replacements — and it wrote no `Activity` row of its own. Its
 * 166 `installMod` calls each wrote `install_mod`, so the log recorded the leaves and not
 * the act, and "which pack is on the server" was not answerable from anything durable: the
 * operation registry keeps non-`ok` records for six hours and loses everything on a web
 * container restart.
 *
 * So the apply writes one `apply_modpack` row and this reads it. No schema change: a
 * modpack apply is exactly the kind of event `Activity` exists for, it inherits the
 * `User` relation (so the actor's name resolves without a second lookup) and the
 * per-world `details.game` tag that `/api/activity` filters on, and it shows up on the
 * activity page beside the power and backup rows where somebody debugging a world that no
 * longer boots will look.
 *
 * **What this record does and does not prove.** It proves a pack was applied, when, by
 * whom, and with what counts. It does **not** prove the jars on disk are still that pack's
 * — a mod can be installed or removed afterwards. `InstalledMod.source` is the measurement
 * that answers *that*, and the surface states the two separately rather than joining them
 * into one claim. `source` is `"pack"` / `"manual"` with no pack id, so "78 of these came
 * from Big Pack" is not a sentence the data supports; "78 were installed by a pack apply"
 * is.
 */

/** The `Activity.action` a modpack apply writes. One definition; the route and the two
 *  renderers all read it from here. */
export const APPLY_MODPACK_ACTION = "apply_modpack";

export interface AppliedPack {
  /** The `Modpack` row's id at the time of the apply. It may since have been deleted. */
  packId: string | null;
  name: string;
  /** ISO 8601. */
  appliedAt: string;
  /** The actor's display name, or `null` when the row carried no user. */
  appliedByName: string | null;
  /** How many jars the apply actually wrote, where the row recorded it. */
  installed: number | null;
  /** The denominator the apply reported — the mods that belonged on a server. */
  total: number | null;
  mcVersion: string | null;
  loader: string | null;
}

/** The shape of an `Activity` row this reads. Accepts the Prisma row with its `user`. */
export interface ActivityRowish {
  action: string;
  details: string;
  createdAt: Date | string;
  user?: { username?: string | null } | null;
}

/**
 * Build the details blob. Used by the route; exported so the parser's tests drive the
 * real producer rather than a hand-written approximation of it — the two drifting apart
 * is the only way this record can go quietly wrong.
 */
export function appliedPackDetails(input: {
  game: string;
  packId: string;
  packName: string;
  installed: number;
  total: number;
  mcVersion: string;
  loader: string;
}): string {
  return JSON.stringify(input);
}

/**
 * Parse one row, or answer `null`.
 *
 * Defensive on every field, because `Activity.details` is free-text JSON written by
 * several routes over several months: a row whose blob will not parse, or that carries no
 * usable pack name, is not a record this surface can state anything from, and inventing
 * `"Unknown pack"` would put a pack on the header that nobody applied.
 */
export function parseAppliedPack(row: ActivityRowish | null | undefined): AppliedPack | null {
  if (!row || row.action !== APPLY_MODPACK_ACTION) return null;

  let blob: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.details);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    blob = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const name = typeof blob.packName === "string" ? blob.packName.trim() : "";
  if (!name) return null;

  const appliedAt = isoOf(row.createdAt);
  if (!appliedAt) return null;

  return {
    packId: typeof blob.packId === "string" && blob.packId ? blob.packId : null,
    name,
    appliedAt,
    // A blank username is `null`, not `""` — the surface renders "by <name>" only when
    // there is a name, the way `recordBackupEvent` collapses an empty actor rather than
    // journalling `actor: ""`.
    appliedByName: row.user?.username ? row.user.username : null,
    installed: finiteOrNull(blob.installed),
    total: finiteOrNull(blob.total),
    mcVersion: typeof blob.mcVersion === "string" && blob.mcVersion ? blob.mcVersion : null,
    loader: typeof blob.loader === "string" && blob.loader ? blob.loader : null,
  };
}

/** A number or nothing. `null` renders as "not recorded", never as `0 of 0`. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOf(value: Date | string): string | null {
  const when = value instanceof Date ? value : new Date(value);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}
