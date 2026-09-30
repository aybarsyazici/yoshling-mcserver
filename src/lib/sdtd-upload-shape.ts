import path from "path";
import { isPathInside } from "@/lib/file-guard";

/**
 * Where an uploaded 7 Days to Die zip is allowed to land, and what it is allowed to be
 * called.
 *
 * Every refusal in here was added because its absence was **destructive while reporting
 * success** — the documented recurring defect of this codebase. They were inline in
 * `/api/7dtd/world`'s POST handler, which is 400 lines of `execFile`, `runOperation` and
 * `chown` and therefore cannot be exercised without Docker and a real `/sevendtd`. Pulled
 * out here they are pure functions over strings, which is the only form in which the
 * guards themselves can be tested.
 *
 * Nothing here touches the filesystem. `rootDir`/`workDir` are paths the caller already
 * resolved; these functions only reason about their *names*.
 */

/** World markers: a custom map. */
export const WORLD_MARKERS = ["dtm.raw", "biomes.png", "prefabs.xml", "splat3.png", "world.json"];
/** Save markers: somebody's progress. */
export const SAVE_MARKERS = ["main.ttw", "players.xml"];

/**
 * Strip a name down to what 7DTD and the filesystem both tolerate.
 *
 * **It can return `""` or `"."`, and that is the whole reason the callers below exist.**
 * `path.join(WORLDS_DIR, "")` is `WORLDS_DIR` itself and `path.join(WORLDS_DIR, ".")` is
 * too — and the upload path `rm -rf`s its destination before moving onto it. So a zip
 * called `..zip`, or one whose inner folder is `世界地図`, resolved to "delete every
 * custom map on the box, including the live one" and would have reported a placed world.
 */
export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, "").replace(/\.+/g, ".").trim().slice(0, 60);
}

/** A name that survived `safeName` with at least one ASCII alphanumeric left in it. */
function usable(name: string): boolean {
  return /[a-zA-Z0-9]/.test(name);
}

/**
 * World, save, or neither — from `unzip -l` output.
 *
 * A substring match over the whole listing on purpose: the markers may sit at any depth,
 * and `findContentRoot` is what locates them afterwards. World wins a tie, which is the
 * order the route has always used (a world export can contain a `players.xml`; a save
 * never contains `dtm.raw`).
 */
export function classifyZipListing(listing: string): "world" | "save" | null {
  const lower = listing.toLowerCase();
  if (WORLD_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return "world";
  if (SAVE_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return "save";
  return null;
}

export type WorldTarget =
  | { ok: true; name: string; dest: string }
  | { ok: false; reason: "bad-name" };

/**
 * Where a custom **map** goes: `GeneratedWorlds/<name>`.
 *
 * The name comes from the folder inside the zip that held the markers, or — when the
 * markers sat at the zip root, so there is no folder — from the zip's own filename.
 */
export function worldTargetForUpload(opts: {
  /** Directory holding the markers, as found by `findContentRoot`. */
  rootDir: string;
  /** The extraction root. `rootDir === workDir` means "no folder in the zip". */
  workDir: string;
  /** The uploaded file's name, used only in the no-folder case. */
  uploadFilename: string;
  worldsDir: string;
}): WorldTarget {
  const fromZipRoot = path.basename(opts.rootDir) === path.basename(opts.workDir);
  const name = safeName(
    fromZipRoot ? opts.uploadFilename.replace(/\.zip$/i, "") : path.basename(opts.rootDir)
  );
  const dest = path.join(opts.worldsDir, name);
  // Two locks on the same door, because what is behind it is unrecoverable: the name
  // must contain something, and the path we are about to `rm -rf` must be a *child* of
  // GeneratedWorlds rather than GeneratedWorlds itself.
  if (!usable(name) || path.dirname(dest) !== opts.worldsDir) return { ok: false, reason: "bad-name" };
  return { ok: true, name, dest };
}

export type SaveTarget =
  | { ok: true; world: string; game: string; dest: string }
  | { ok: false; reason: "no-world-folder" | "bad-name" | "unsafe-path" };

/**
 * Where a **save** goes: `Saves/<GameWorld>/<GameName>`.
 *
 * Both names have to come out of the zip, because both are needed for the server to find
 * the save at all. `findContentRoot` returns the directory holding `main.ttw`, which is
 * the `<GameName>` level; its parent is `<GameWorld>`.
 *
 * What this replaces was `cp -a <rootDir>/. Saves/`, which flattened `main.ttw` and
 * `players.xml` **directly into `/sevendtd/Saves/`** — no world/game folders at all, so
 * no `GameWorld`/`GameName` pair could ever point at them — and reported a green success.
 * So the refusals here matter more than the happy path: a *guessed* world name is a save
 * the server will never find, which is indistinguishable from the bug.
 */
export function saveTargetForUpload(opts: {
  rootDir: string;
  workDir: string;
  savesRoot: string;
}): SaveTarget {
  const game = safeName(path.basename(opts.rootDir));
  const parentDir = path.dirname(opts.rootDir);
  const world = safeName(path.basename(parentDir));

  // `rootDir === workDir`: the markers sat at the zip root, so there are no names at all.
  // `parentDir === workDir`: there was exactly one folder, so we have a game name and no
  // world. Either way `Saves/<world>/<game>` cannot be formed and must not be invented.
  if (opts.rootDir === opts.workDir || parentDir === opts.workDir) {
    return { ok: false, reason: "no-world-folder" };
  }
  if (!usable(game) || !usable(world)) return { ok: false, reason: "bad-name" };

  const dest = path.join(opts.savesRoot, world, game);
  // The same second lock as the world branch. `safeName` collapses ".." to "." and a
  // name with no ASCII alphanumerics to "", either of which would make `dest` `Saves/`
  // itself — i.e. every save on the box, including the one being played.
  if (!isPathInside(opts.savesRoot, dest) || path.dirname(dest) !== path.join(opts.savesRoot, world)) {
    return { ok: false, reason: "unsafe-path" };
  }
  return { ok: true, world, game, dest };
}
