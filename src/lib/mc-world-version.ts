import { readFile } from "fs/promises";
import { gunzipSync } from "zlib";
import { gameDataPath } from "./game-data-path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";

/**
 * Which Minecraft version last opened the world on disk.
 *
 * This exists so the version dropdown can be guarded by something the *world* says
 * rather than by what the dashboard believes. `ServerConfig.mcVersion` is the app's
 * record and has been wrong before — it said 26.1.2 while `docker-compose.yml` said
 * 1.21.4 for weeks — whereas `level.dat` is written by the game itself on every save.
 *
 * No new dependency: `level.dat` is a gzipped NBT compound and `zlib` is a Node builtin.
 * A full NBT parser would be ~150 lines for one string, so this walks to the `Version`
 * compound by its tag bytes instead, which is why the format assumptions are spelled out
 * in `parseLevelDatVersion`.
 */

/**
 * Pull `Data.Version.Name` out of an **uncompressed** level.dat payload.
 *
 * Verified against the real file: a copy of `/data/world/level.dat` from the box
 * (415 bytes gzipped, 541 inflated) contains
 * `0A 00 07 "Version"` → `01 00 08 "Snapshot" 00`, `08 00 06 "Series" 00 04 "main"`,
 * `03 00 02 "Id" 00 00 12 B6` (= 4790, the data version `rcon-cli version` reports),
 * `08 00 04 "Name" 00 06 "26.1.2"`.
 *
 * Anchored on the `Version` compound rather than on the first `Name` tag, because
 * `LevelName` is also a string in the same compound and a looser scan would be one
 * NBT reordering away from returning the level's name as its version — a wrong answer
 * that would then be used to *block* a version change, i.e. the failure would present as
 * "the dashboard refuses to let me change anything".
 *
 * Returns null rather than throwing on anything unexpected: not knowing the world's
 * version must degrade to "no opinion", never to a blocked settings page.
 */
export function parseLevelDatVersion(nbt: Buffer): string | null {
  // TAG_Compound (0x0A), name length 7, "Version".
  const anchor = Buffer.from([0x0a, 0x00, 0x07]);
  let at = -1;
  for (let i = 0; i + 10 <= nbt.length; i++) {
    if (nbt.compare(anchor, 0, 3, i, i + 3) === 0 && nbt.toString("latin1", i + 3, i + 10) === "Version") {
      at = i + 10;
      break;
    }
  }
  if (at < 0) return null;

  // TAG_String (0x08), name length 4, "Name", u16 payload length, payload. Bounded to
  // the compound's plausible size so a corrupt file cannot walk the whole buffer and
  // find a `Name` belonging to something else.
  const limit = Math.min(nbt.length - 9, at + 256);
  for (let i = at; i <= limit; i++) {
    if (nbt[i] !== 0x08) continue;
    if (nbt.readUInt16BE(i + 1) !== 4) continue;
    if (nbt.toString("latin1", i + 3, i + 7) !== "Name") continue;
    const len = nbt.readUInt16BE(i + 7);
    if (len === 0 || len > 64 || i + 9 + len > nbt.length) return null;
    const value = nbt.toString("utf8", i + 9, i + 9 + len);
    return /^[\w.\-+ ]+$/.test(value) ? value : null;
  }
  return null;
}

/**
 * Read it off disk, or null when there is no world yet / it cannot be understood.
 *
 * Tolerates an uncompressed level.dat as well: `gunzipSync` throws on a raw NBT file,
 * and a world that has never been gzipped is still a world worth having an opinion about.
 */
export async function readWorldVersion(): Promise<string | null> {
  let raw: Buffer;
  try {
    raw = await readFile(await gameDataPath(MC_DIR, "world/level.dat"));
  } catch {
    return null;
  }
  let nbt: Buffer;
  try {
    nbt = gunzipSync(raw);
  } catch {
    nbt = raw;
  }
  try {
    return parseLevelDatVersion(nbt);
  } catch {
    return null;
  }
}
