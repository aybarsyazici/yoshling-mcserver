import { pluralise } from "./format";
import type { AppliedPack } from "./modpack-applied";
import type { ModInventory } from "./mod-inventory";

/**
 * **Where each jar on the server came from — counted, not assumed.**
 *
 * "Which of these did the pack put there, and which did we add ourselves" was not
 * answerable by anything in this app until `InstalledMod.source` existed: after an apply
 * the only record of the difference was in whoever had been watching. The column is the
 * measurement; this module is the arithmetic over it, kept out of the component so the
 * numbers are pinned by unit tests rather than by reading a sentence off a rendered page.
 *
 * Two rules the sentences obey, both of which this repo has paid for:
 *
 * - **Only jars that are actually in the folder are counted as jars.** A `missing` row is
 *   a record whose file is gone, so folding it into "N jars from a pack" would report a
 *   mod the server will not load as installed. It is reported on its own.
 * - **A record of an apply is not a measurement of the result.** `AppliedPack` says a pack
 *   was applied, when and by whom; the counts say what is on disk now. They are stated as
 *   two facts, never joined into "78 jars from Big Pack" — `source` carries no pack id, so
 *   that sentence is not one the data supports.
 */

export interface ProvenanceCounts {
  /** Jars in the mods folder: the matched rows plus the untracked files. */
  jars: number;
  /** A matched row written by a modpack apply. */
  fromPack: number;
  /** A matched row written by a single-mod install. */
  ownInstall: number;
  /** A matched row whose `source` is null — written before the column existed, or
   *  restored from an archive whose manifest never carried provenance. */
  unrecorded: number;
  /** A jar with no row at all: this dashboard did not put it there. */
  untracked: number;
  /** A row whose jar is not in the folder. Not a jar, and counted separately. */
  missing: number;
}

/**
 * Count the reading.
 *
 * Derived from the single `mods` list, the way `reconcileMods` derives its three groups
 * from it, so a reader of these counts and a reader of the rows cannot disagree.
 * `jars === fromPack + ownInstall + unrecorded + untracked` holds by construction and is
 * pinned by a test — the one arithmetic mistake that would make the header quietly wrong.
 */
export function provenanceCounts(inv: Pick<ModInventory, "mods">): ProvenanceCounts {
  const counts: ProvenanceCounts = {
    jars: 0,
    fromPack: 0,
    ownInstall: 0,
    unrecorded: 0,
    untracked: 0,
    missing: 0,
  };
  for (const mod of inv.mods) {
    if (mod.state === "missing") {
      counts.missing += 1;
      continue;
    }
    counts.jars += 1;
    if (mod.state === "untracked") counts.untracked += 1;
    else if (mod.source === "pack") counts.fromPack += 1;
    else if (mod.source === "manual") counts.ownInstall += 1;
    else counts.unrecorded += 1;
  }
  return counts;
}

/**
 * The measured split, as one sentence.
 *
 * Built from clauses rather than from a branch per combination: there are five
 * independent quantities and a sentence per shape would be 2^4 templates, which is how a
 * reachable combination ends up with no wording at all. Every non-zero part is named and
 * zero parts say nothing — a server with no untracked jars should not be told it has none.
 */
export function provenanceSentence(counts: ProvenanceCounts): string {
  if (counts.jars === 0) return "There are no jars in the mods folder.";

  const parts: string[] = [];
  if (counts.fromPack > 0) parts.push(`${counts.fromPack} from a pack`);
  if (counts.ownInstall > 0) parts.push(`${counts.ownInstall} added one at a time`);
  if (counts.unrecorded > 0) parts.push(`${counts.unrecorded} with no record of how`);
  // Worded as a statement about this app rather than about the file: the server loads an
  // untracked jar perfectly well, and calling it "unknown" invites deleting something that
  // works. The drift band says what to do about it.
  if (counts.untracked > 0) parts.push(`${counts.untracked} this dashboard did not install`);

  return `${pluralise(counts.jars, "jar")} in the mods folder — ${parts.join(", ")}.`;
}

export interface PackHeadline {
  /** The pack's name, or the reason there is no name to give. */
  title: string;
  /** One line under it. Always says something; never empty. */
  detail: string;
  /**
   * Whether `title` names an actual pack.
   *
   * The surface styles the two differently and a boolean is cheaper than matching on the
   * sentence — and safer, because a copy edit must not change which branch renders.
   */
  named: boolean;
}

/**
 * What the pack strip says at the top of the page.
 *
 * Three states, and the third is the one worth keeping: a server whose jars were put
 * there by a pack apply that predates this record. Reporting that as "no pack" would be
 * false and reporting it as a pack name would be invented, so it says exactly what is
 * known — some jars came from an apply, and nothing here knows which pack.
 */
export function packHeadline(
  pack: AppliedPack | null,
  counts: ProvenanceCounts
): PackHeadline {
  if (pack) {
    const bits: string[] = [`Applied ${shortDate(pack.appliedAt)}`];
    if (pack.appliedByName) bits.push(`by ${pack.appliedByName}`);
    // Counts from the apply itself, which is a different claim from the counts on disk —
    // and the only place a shortfall is still visible once the ledger record has aged out.
    if (pack.installed != null && pack.total != null) {
      bits.push(`${pack.installed} of ${pluralise(pack.total, "mod")} installed`);
    }
    return { title: pack.name, detail: bits.join(" · "), named: true };
  }

  if (counts.fromPack > 0) {
    return {
      title: "A pack was applied, but not from here",
      detail:
        `${pluralise(counts.fromPack, "jar")} on this server was installed by a modpack ` +
        `apply, and there is no record of which pack or when. Applies made from this ` +
        `dashboard are recorded.`,
      named: false,
    };
  }

  return {
    title: "No pack applied",
    detail:
      counts.jars === 0
        ? "Nothing is installed. Add a mod, or apply a pack to install a whole set."
        : `Every jar on this server was added on its own, not by a pack.`,
    named: false,
  };
}

/**
 * The pack was built for a Minecraft version this server no longer runs.
 *
 * Real drift, and previously invisible: the version dropdown can be changed after a pack
 * is applied, and the jars do not move with it. `null` when there is nothing to compare or
 * nothing to report — an absent reading must never render as a disagreement, which is the
 * rule every settings surface in this app follows.
 */
export function packVersionNote(
  pack: AppliedPack | null,
  server: { mcVersion: string; loader: string } | null
): string | null {
  if (!pack || !server || !pack.mcVersion) return null;
  if (pack.mcVersion === server.mcVersion) return null;
  return (
    `This pack was applied for Minecraft ${pack.mcVersion}; the server is set to ` +
    `${server.mcVersion}. Its jars were built for the older version.`
  );
}

/** `2026-10-02T…` → `2 Oct 2026`. The runner's locale decides the order. */
function shortDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "an unknown date";
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
