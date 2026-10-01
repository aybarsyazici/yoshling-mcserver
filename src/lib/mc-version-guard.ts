/**
 * The guard on the Minecraft version / loader dropdowns.
 *
 * **Why this is the most destructive control on the settings page.** Picking a version
 * patches `MC_VERSION` into `.env` and recreates the container, which is exactly what it
 * should do — and then nothing checks that the chosen version can open what is already on
 * disk. Measured on production 2026-10-01: the dropdown offers 30 Modrinth release
 * versions down to `1.18.2`; `level.dat` records **26.1.2**; the world is 215.6 MiB; and
 * all three installed mods declare 26.1.x (`fabric-api` 0.149.1+26.1.2 → `~26.1-`,
 * Xaero's Minimap and World Map → `>=26.1.2 <26.2.0`). Choose 1.21.4 and the route
 * answers `{success:true}`, the container comes up, Fabric Loader aborts on the
 * 26.1-dependent jars before it ever opens the world, and the dashboard shows a permanent
 * "Starting…" with no explanation anywhere. That precise failure has already happened
 * here once — the compose/DB version mismatch — and it cost weeks because the symptom
 * looks nothing like its cause.
 *
 * So: refuse by default, and let the operator override with an explicit confirmation that
 * names the consequence. Not a silent warning toast — this is the one control on the page
 * whose damage is measured in hours of forensics.
 *
 * The alternative is to delegate: itzg's image can resolve the version from the mods
 * themselves via `VERSION_FROM_MODRINTH_PROJECTS`, which makes the dropdown redundant
 * rather than guarded. That is a bigger change than this workstream and it is recorded in
 * the handover notes rather than half-done here.
 *
 * Pure on purpose — the route supplies the world version and the installed-mod rows, so
 * every branch below is unit-testable without a database or a filesystem.
 */

export interface InstalledModFact {
  name: string;
  /** What the mod was installed *for*, as Modrinth reported it (e.g. "26.1", "26.1.2"). */
  mcVersion: string;
  /** "fabric" | "forge" | … as stored on the row. */
  loader: string;
}

export interface VersionChangeRequest {
  /** The version the user picked. */
  version: string;
  /** The loader the user picked, lowercase ("fabric"). */
  loader: string;
  /** From level.dat, or null when there is no world / it could not be read. */
  worldVersion: string | null;
  mods: InstalledModFact[];
}

export interface VersionMismatch {
  kind: "world" | "mod-version" | "mod-loader";
  /** One sentence, specific enough to act on, naming the thing that disagrees. */
  detail: string;
}

/**
 * Is a mod installed for `declared` usable on `target`?
 *
 * Prefix-wise, not equality, and that is not a nicety: `fabric-api` is stored as `26.1`
 * while the server runs `26.1.2`, so an equality check would flag the healthiest mod on
 * the box and the guard would block *every* save, including a save that changes nothing.
 * A guard that cries wolf on the current configuration is a guard that gets clicked
 * through, which is how the 7DTD "Settings saved." lie survived for months.
 *
 * `26.1` admits `26.1.2` (same minor line); `26.1.2` does not admit `26.1.3`, because a
 * mod built against a specific patch is the stricter statement and we are not in the
 * business of guessing Minecraft's compatibility promises. Over-reporting a patch
 * difference is cheap here — it costs one confirmation click — while under-reporting is
 * the failure this file exists to prevent.
 */
export function modVersionAdmits(declared: string, target: string): boolean {
  const d = declared.trim();
  const t = target.trim();
  if (!d || !t) return true; // nothing declared is nothing to contradict
  return t === d || t.startsWith(`${d}.`);
}

/**
 * Everything about the request that disagrees with what is on disk, in the order a human
 * would want to read it. Empty array = nothing to confirm.
 */
export function versionChangeMismatches(req: VersionChangeRequest): VersionMismatch[] {
  const out: VersionMismatch[] = [];
  const version = req.version.trim();
  const loader = req.loader.trim().toLowerCase();

  if (req.worldVersion && version && req.worldVersion !== version) {
    out.push({
      kind: "world",
      detail:
        `The world on disk was last opened by Minecraft ${req.worldVersion}. ` +
        `${version} is a different version` +
        (isDowngrade(version, req.worldVersion)
          ? ` — and an older one, which cannot open a newer world at all.`
          : `, so it will upgrade the save format; older versions can never open it again.`),
    });
  }

  const wrongVersion = req.mods.filter((m) => !modVersionAdmits(m.mcVersion, version));
  if (wrongVersion.length > 0) {
    out.push({
      kind: "mod-version",
      detail:
        `${describeMods(wrongVersion)} installed for ` +
        `${[...new Set(wrongVersion.map((m) => m.mcVersion))].join(", ")}, not ${version}. ` +
        `A mod loader refuses to start when a mod's dependency is unmet, so the server ` +
        `will not boot until the mods are updated too.`,
    });
  }

  const wrongLoader = req.mods.filter(
    (m) => m.loader.trim().toLowerCase() !== loader && m.loader.trim() !== ""
  );
  if (wrongLoader.length > 0) {
    out.push({
      kind: "mod-loader",
      detail:
        `${describeMods(wrongLoader)} built for ` +
        `${[...new Set(wrongLoader.map((m) => m.loader.toLowerCase()))].join(", ")}, not ${loader}. ` +
        `Loaders do not read each other's mods.`,
    });
  }

  return out;
}

/**
 * Minecraft's version numbers went from `1.x.y` to a `26.x.y` scheme, so a plain string
 * compare is wrong in both directions ("1.21.4" > "1.18.2" lexically but "26.1.2" <
 * "1.21.4"). Numeric, segment by segment, and a non-numeric segment makes the answer
 * `false` — "I can't tell" has to read as "no claim", because this only chooses between
 * two wordings of the same refusal.
 */
export function isDowngrade(target: string, current: string): boolean {
  const a = target.split(".").map((s) => Number(s));
  const b = current.split(".").map((s) => Number(s));
  if (a.some((n) => !Number.isFinite(n)) || b.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function describeMods(mods: InstalledModFact[]): string {
  const names = mods.map((m) => m.name);
  if (names.length === 1) return `${names[0]} is`;
  if (names.length <= 3) return `${names.join(", ")} are`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} other mods are`;
}

/**
 * The sentence the route refuses with. Written here, next to the facts, so the route
 * cannot paraphrase it into something vaguer — and it ends by naming the way through,
 * because a refusal with no exit is the other way to make a control useless.
 */
export function versionChangeRefusal(
  // Only the two fields it names, so the route can pass what the user chose without
  // having to carry the facts it was compared against.
  req: Pick<VersionChangeRequest, "version" | "loader">,
  mismatches: VersionMismatch[]
): string {
  return (
    `${req.loader} ${req.version} doesn't match what's on disk. ` +
    mismatches.map((m) => m.detail).join(" ") +
    ` Nothing was changed. Confirm to apply it anyway.`
  );
}
