import { readdir, readFile } from "fs/promises";
import path from "path";
import { PZ_APP_ID, PZ_WORKSHOP_DIR, readIniProperties, splitList, updateIni } from "@/lib/zomboid";

/**
 * Map conflict detection for Project Zomboid.
 *
 * The world is a grid of 256x256-tile cells (32 chunks of 8), and a map mod
 * "claims" the cells it ships. Two mods claiming the same cell conflict: only one can win, and which
 * one is decided by `Map=` in the server .ini — **the first entry wins**. Get it
 * wrong and you get missing buildings, holes, or a broken world.
 *
 * 256 is Build 42's `IsoCell.CELL_SIZE_IN_SQUARES`; Build 41 used 300, and that
 * stale number is how a set of teleport coordinates derived as `cell * 300 + 150`
 * came out pointing at the wrong place. Verified two ways: the save stores chunks
 * as `map/<x/8>/<y/8>.bin`, and square 23700,12060 resolves to the shipped cell
 * 92_47 (23700/256 = 92.6), which 300 would have made 79.
 *
 * Cell coordinates don't need a database: they're the filenames. A map mod on
 * disk looks like
 *   <workshopId>/mods/<modId>/{common,42,…}/media/maps/<MapName>/<x>_<y>.lotheader
 * so scanning the workshop mount gives ground truth for everything installed.
 *
 * Caveat: the base game's own maps (Muldraugh, Riverside, Louisville…) live in
 * the game install, which isn't mounted here, so overlaps with vanilla can't be
 * detected — only mod-vs-mod. Vanilla should be last in `Map=` regardless.
 *
 * ## Every installed map must be in `Map=`, add-ons included
 *
 * A `map.info` may declare `lots=<parent map>` — "my cells sit on top of that
 * map" — for a checkpoint or bunker dropped into Muldraugh. Those still need a
 * `Map=` entry; `lots=` only says what they build on.
 *
 * An earlier version of this comment claimed the opposite: that Build 42 loads
 * add-ons through their mod and deliberately strips them from `Map=`. That was
 * wrong. The list really was being rewritten to `AZSpawn;AZSpawn;Muldraugh, KY`
 * seconds into every boot, but by the **Docker image**, not the game — see the
 * `Map=` section of CLAUDE.md and `pz/search_folder.sh`. Believing the game did it
 * on purpose left 20 maps inert and this card calling that normal.
 */

/** Vanilla map names, so they're not reported as "missing from disk". */
export const STOCK_MAPS = [
  "Muldraugh, KY",
  "Riverside, KY",
  "Rosewood, KY",
  "West Point, KY",
  "March Ridge",
  "Louisville, KY",
  "Ekron, KY",
  "Irvington, KY",
  "Brandenburg, KY",
];

export interface PzMap {
  /** Workshop item that ships this map. */
  workshopId: string;
  /** The mods/<modId> folder it lives under. */
  modId: string;
  /** The maps/<name> folder — this is what goes in `Map=`. */
  name: string;
  /** Claimed cells as "x_y". */
  cells: string[];
  /**
   * `lots=` from map.info: the map this one is laid on top of. Set = an add-on
   * that loads with its mod and is deliberately absent from `Map=`.
   */
  parent?: string;
  /** `title=` from map.info, nicer than the folder name. */
  title?: string;
}

const CELL_RE = /^(\d+)_(\d+)\.lotheader$/;

/** `lots=` and `title=` out of a map's map.info. Missing file → no metadata. */
async function readMapInfo(dir: string): Promise<{ parent?: string; title?: string }> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, "map.info"), "utf8");
  } catch {
    return {};
  }
  const pick = (key: string) =>
    raw
      .split(/\r?\n/)
      .map((l) => new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "i").exec(l))
      .find((m): m is RegExpExecArray => m !== null && m[1] !== "")?.[1];
  return { parent: pick("lots"), title: pick("title") };
}

/** Every `media/maps` directory inside one workshop item. */
async function findMapDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    if (entry.name === "maps" && path.basename(root) === "media") {
      found.push(child);
      continue; // maps/<Name>/ below are map folders, not more media dirs
    }
    found.push(...(await findMapDirs(child, depth + 1)));
  }
  return found;
}

/** Which mods/<modId> folder a path sits under, for reporting. */
function modIdFromPath(p: string): string {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf("mods");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : "";
}

/**
 * Every map installed on disk. Build 42 ships the same map twice (under
 * `common/` and `42/`), so cells are merged per (workshop item, map name)
 * instead of counting the map twice.
 */
export async function scanMaps(): Promise<PzMap[]> {
  const contentRoot = path.join(PZ_WORKSHOP_DIR, "content", PZ_APP_ID);
  let items: string[];
  try {
    items = (await readdir(contentRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const merged = new Map<string, PzMap>();

  for (const workshopId of items) {
    for (const mapsDir of await findMapDirs(path.join(contentRoot, workshopId))) {
      let mapNames;
      try {
        mapNames = (await readdir(mapsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }

      for (const name of mapNames) {
        let files: string[];
        try {
          files = await readdir(path.join(mapsDir, name));
        } catch {
          continue;
        }
        const cells = files
          .map((f) => CELL_RE.exec(f))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => `${m[1]}_${m[2]}`);
        // Keep maps with no cells. A mod's spawn-point and basement definitions
        // (SZ_ExtraSpawnPoints, ArmyGroup_Spawn…) are map folders that claim no
        // ground, so they can never conflict — but they still have to be listed
        // in `Map=` or they do nothing, which is exactly the sort of silent
        // failure this card exists to surface.
        if (files.length === 0) continue;

        const info = await readMapInfo(path.join(mapsDir, name));
        const key = `${workshopId}::${name}`;
        const existing = merged.get(key);
        if (existing) {
          existing.cells = Array.from(new Set([...existing.cells, ...cells]));
          // Copies under common/ and 42.x/ can differ; keep whichever declares
          // the metadata rather than letting an empty copy blank it out.
          existing.parent ??= info.parent;
          existing.title ??= info.title;
        } else {
          merged.set(key, {
            workshopId,
            modId: modIdFromPath(mapsDir),
            name,
            cells: Array.from(new Set(cells)),
            parent: info.parent,
            title: info.title,
          });
        }
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface MapConflict {
  /** The two map names fighting over cells. */
  maps: [string, string];
  cells: string[];
}

/** Every pair of installed maps that claim any of the same cells. */
export function findConflicts(maps: PzMap[]): MapConflict[] {
  const byCell = new Map<string, string[]>();
  for (const m of maps) {
    for (const cell of m.cells) {
      const list = byCell.get(cell);
      if (list) list.push(m.name);
      else byCell.set(cell, [m.name]);
    }
  }

  // Collect per pair rather than per cell, so one overlapping region reads as a
  // single conflict instead of eighty.
  const pairs = new Map<string, MapConflict>();
  for (const [cell, names] of byCell) {
    const unique = Array.from(new Set(names));
    if (unique.length < 2) continue;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = [unique[i], unique[j]].sort().join("::");
        const entry = pairs.get(key);
        if (entry) entry.cells.push(cell);
        else pairs.set(key, { maps: [unique[i], unique[j]], cells: [cell] });
      }
    }
  }

  return Array.from(pairs.values())
    .map((c) => ({ ...c, cells: c.cells.sort() }))
    .sort((a, b) => b.cells.length - a.cells.length);
}

/** The `Map=` load order, first entry wins. */
export async function readMapOrder(): Promise<string[]> {
  const props = await readIniProperties();
  return splitList(props.find((p) => p.name === "Map")?.value ?? "");
}

export async function writeMapOrder(order: string[]): Promise<void> {
  await updateIni({ Map: order.join(";") });
}
