import { serverModTotal, type ServerSideVerdict, type SkippedMod } from "./mod-admission";
import type { ModrinthVersion } from "./modrinth";

/**
 * **What a modpack apply is going to do, worked out before anything is destroyed.**
 *
 * This was 45 lines inside `applyModpack` in `/api/mods/install-modpack`, and it is the
 * part of that route carrying the guarantees the filtering change exists for: a client-only
 * mod is left out, a mod that cannot be resolved is a *failure* rather than a skip, and the
 * denominator is the pack minus the skips. None of it was reachable from a test — the route
 * needs `auth()`, Prisma, a mods directory, `tar` and Modrinth — and the reviewer that
 * mutated it proved the point: `if (false && !side.install)` deletes the entire client-only
 * filter, restoring the exact behaviour the change was written to fix, and the whole suite
 * stayed green.
 *
 * So the decisions moved here and the I/O stayed there. The two Modrinth calls are
 * parameters rather than imports, which is the same seam `src/lib/docker-cli.ts` puts in
 * front of every `docker` fork and for the same reason: a decision you cannot drive from a
 * test is a decision nobody is defending.
 */

/**
 * The fields of a `ModpackMod` row the installer reads.
 *
 * Structural, not the Prisma type, so the shape this code depends on is stated in one
 * place — and `any[]` is what let `(mod as any).downloadUrl` spread through the old
 * download loop, which is how a row with no download source reached the download step at
 * all instead of being counted out at the top.
 */
export interface PackMod {
  name: string;
  slug: string;
  modrinthId: string | null;
  versionId: string | null;
  downloadUrl: string | null;
}

/**
 * `url` and `modrinthId` are carried on the item rather than re-read off `mod` in the
 * download loop. Both are nullable on the row and the narrowing that proved them non-null
 * happened here; re-deriving them later would need a second null check or a `!`, and a `!`
 * on the wrong branch is how a `null` modrinthId reaches Modrinth as the string "null".
 */
export type PlanItem =
  | { kind: "direct"; mod: PackMod; url: string }
  | { kind: "modrinth"; mod: PackMod; modrinthId: string; version: ModrinthVersion };

export interface ModPlan {
  /** What will be downloaded, in pack order. */
  items: PlanItem[];
  /** Positively declared client-only, so never attempted. Named, never silent. */
  skipped: SkippedMod[];
  /** Attempted and lost before the download: no compatible version, no source, a lookup that threw. */
  errors: string[];
  /** Mods whose `environment` this app has no mapping for — see `unrecognisedEnvironmentSentence`. */
  unrecognised: Array<{ name: string; environment: string }>;
  /**
   * **The denominator every count in the report is measured against**: the pack's rows
   * minus the mods that do not belong on a server.
   *
   * Computed here, from `serverModTotal`, so that there is one number and the route cannot
   * drift. The tempting alternative is `items.length`, and it is wrong in a way that hides
   * exactly what a report exists to show: a mod whose version will not resolve is not in
   * `items`, so `items.length` reads "163 of 163 — complete" with three failures listed
   * underneath. `serverModTotal` keeps those three in the denominator and leaves only the
   * skips out, so `installed === total` means "every mod that belongs on this server is on
   * it" and nothing else.
   */
  total: number;
}

export async function planModpackInstall(input: {
  mods: PackMod[];
  /** `getProjectVersions(id, {loaders, game_versions})` with the server's loader/version bound. */
  resolveVersions: (modrinthId: string) => Promise<ModrinthVersion[]>;
  /** `serverSideFor` — one shared decision with `/api/mods/install`, including its project fallback. */
  sideFor: (version: ModrinthVersion, modrinthId: string) => Promise<ServerSideVerdict>;
  /** Called once per mod before it is examined, for the operation's progress count. */
  onExamine?: (mod: PackMod, index: number) => void;
}): Promise<ModPlan> {
  const items: PlanItem[] = [];
  const skipped: SkippedMod[] = [];
  const errors: string[] = [];
  const unrecognised: Array<{ name: string; environment: string }> = [];

  for (const [index, mod] of input.mods.entries()) {
    input.onExamine?.(mod, index);
    try {
      if (mod.downloadUrl) {
        // A Technic/Solder direct download publishes no side declaration, so there is
        // nothing to filter on. Its integrity is checked against the response's
        // `Content-Length` at download time — see `declaredFromHeaders`.
        items.push({ kind: "direct", mod, url: mod.downloadUrl });
      } else if (mod.modrinthId) {
        const versions = await input.resolveVersions(mod.modrinthId);
        const version = mod.versionId
          ? versions.find((v) => v.id === mod.versionId)
          : versions[0];
        if (!version) {
          errors.push(`${mod.name}: no compatible version`);
          continue;
        }
        const side = await input.sideFor(version, mod.modrinthId);
        if (side.unrecognisedEnvironment) {
          unrecognised.push({ name: mod.name, environment: side.unrecognisedEnvironment });
        }
        if (!side.install) {
          // NOT an error and NOT silent. The 7DTD config route's documented defect was
          // dropping settings it could not write and reporting "Saved"; the fix there was
          // to name them. Same shape here: a skip is a decision the user gets to see and
          // disagree with.
          skipped.push({ name: mod.name, reason: side.reason });
          continue;
        }
        items.push({ kind: "modrinth", mod, modrinthId: mod.modrinthId, version });
      } else {
        // Modpacks imported before f2018a4 stored no modrinthId (the Modrinth project
        // endpoint returns `id`, not `project_id`), so whole packs are unusable until they
        // are imported again.
        errors.push(`${mod.name}: no download source recorded — re-import this modpack`);
      }
    } catch (e) {
      // A mod we could not even look up is a FAILURE, not a skip: it stays in the
      // denominator and gets named. Treating a Modrinth timeout as "client-only" would
      // quietly shrink the pack every time the API had a bad minute.
      errors.push(`${mod.name}: ${(e instanceof Error && e.message) || "could not be checked"}`);
    }
  }

  return {
    items,
    skipped,
    errors,
    unrecognised,
    total: serverModTotal(input.mods.length, skipped.length),
  };
}

/**
 * **May this plan touch the mods directory at all?**
 *
 * The one guard between an empty plan and destruction, and the reason it is a function
 * rather than an `if` in the route: an adversarial recheck replaced
 * `if (plan.items.length === 0)` in `/api/mods/install-modpack` with `if (false)` and all
 * 835 tests passed. With that branch gone the route goes on to tar the ~215 MB world,
 * delete **every installed jar** via `removeMod`, download nothing, and answer HTTP 200
 * `{success:true}`. The steps are ordered backup → remove → download, so an empty plan
 * reaching them is not a wasted apply, it is a wipe that reports success — the house
 * defect class with the worst available blast radius.
 *
 * `null` means proceed. A string is the refusal, and it has to distinguish the two ways a
 * plan empties out, because the operator's next move is different:
 *
 * - **every mod is client-only.** Nothing is wrong; this pack has nothing for a server.
 * - **every mod failed to resolve.** Something *is* wrong — a version mismatch, Modrinth
 *   unreachable — and the errors name it.
 *
 * Conflating them is how "no mod in this pack runs on a server" would get told to someone
 * whose network was down.
 */
export function modsDirRefusal(plan: ModPlan, packSize: number): string | null {
  if (plan.items.length > 0) return null;
  if (packSize === 0) return "This modpack has no mods recorded.";
  if (plan.skipped.length === packSize) {
    return "No mod in this pack runs on a server — every one of them is client-only.";
  }
  if (plan.skipped.length === 0) {
    return `None of the ${packSize} mods in this pack could be resolved, so nothing was changed.`;
  }
  return (
    `None of this pack's server mods could be resolved, so nothing was changed. ` +
    `(${plan.skipped.length} of ${packSize} are client-only and were never attempted.)`
  );
}
