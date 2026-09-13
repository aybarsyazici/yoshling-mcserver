import { readdir } from "fs/promises";
import path from "path";
import { PZ_APP_ID, PZ_WORKSHOP_DIR, readIniProperties, splitList, updateIni } from "@/lib/zomboid";

/**
 * Map conflict detection for Project Zomboid.
 *
 * The world is a grid of 300x300-tile cells, and a map mod "claims" the cells it
 * ships. Two mods claiming the same cell conflict: only one can win, and which
 * one is decided by `Map=` in the server .ini — **the first entry wins**. Get it
 * wrong and you get missing buildings, holes, or a broken world.
 *
 * Cell coordinates don't need a database: they're the filenames. A map mod on
 * disk looks like
 *   <workshopId>/mods/<modId>/{common,42,…}/media/maps/<MapName>/<x>_<y>.lotheader
 * so scanning the workshop mount gives ground truth for everything installed.
 *
 * Caveat: the base game's own maps (Muldraugh, Riverside, Louisville…) live in
 * the game install, which isn't mounted here, so overlaps with vanilla can't be
 * detected — only mod-vs-mod. Vanilla should be last in `Map=` regardless.
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
}

const CELL_RE = /^(\d+)_(\d+)\.lotheader$/;

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

        const key = `${workshopId}::${name}`;
        const existing = merged.get(key);
        if (existing) {
          existing.cells = Array.from(new Set([...existing.cells, ...cells]));
        } else {
          merged.set(key, {
            workshopId,
            modId: modIdFromPath(mapsDir),
            name,
            cells: Array.from(new Set(cells)),
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
