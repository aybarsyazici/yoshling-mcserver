import { randomUUID } from "node:crypto";
import { chmod, chown, link, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { PZ_DIR, serverName } from "@/lib/zomboid";
import {
  parseSandboxLua,
  setSandboxValues,
  type SandboxOption,
  type SandboxRejection,
} from "@/lib/sandbox-lua";

/**
 * Reading and writing `Server/<name>_SandboxVars.lua` on disk.
 *
 * The parsing and the validation live in `sandbox-lua.ts`, which has no `fs` in it and
 * is tested against a real excerpt of the production file. This module is only the
 * part that cannot be tested without a filesystem: where the file is, how it is
 * replaced, and whether the replacement actually landed.
 */

export async function sandboxPath(): Promise<string> {
  return path.join(PZ_DIR, "Server", `${await serverName()}_SandboxVars.lua`);
}

export async function readSandboxOptions(): Promise<SandboxOption[]> {
  return parseSandboxLua(await readFile(await sandboxPath(), "utf-8"));
}

/**
 * Replace the file atomically, keeping one `.bak`, and leave it owned by the game.
 *
 * Four deliberate choices, each for a failure that has happened to a file this app
 * writes:
 *
 * - **temp-then-`rename`.** A plain `writeFile` truncates first, so the web container
 *   being OOM-killed (it has a `mem_limit`) or recreated by a deploy inside that window
 *   leaves a half-written Lua table — and a Lua table that does not parse does not cost
 *   you one setting, it costs you the world load. `rename` within one filesystem is
 *   atomic and the bind mount is one filesystem. Same shape as `writeEnvFile`, which
 *   exists because a bare `writeFile` there would have destroyed every production secret.
 * - **one `.bak`, written before the new file.** There is no other copy: the `.ini` has
 *   four `.bak-*` files on the box, this file has none, and the backups bundle it only
 *   as part of a whole-world archive.
 * - **owner and mode restored after the rename.** The game runs as uid 1000 (`su - steam`)
 *   and the web container is root; the file is `1000:1000 664`. The game truncates and
 *   rewrites it on every startup, so handing it back a root-owned 0644 file would leave
 *   the server unable to persist its own options — it logs `Unable to save options to
 *   filename` and carries on, which is exactly the kind of quiet degradation that gets
 *   noticed weeks later.
 * - **no deletion of the temp file on success.** `rename` consumes it.
 */
async function replaceFile(file: string, text: string): Promise<void> {
  // Unique per write, not a fixed `.tmp`. The settings page renders TWO sandbox panels
  // (world scope and mods scope) and both Save buttons PUT this same route, so a shared temp
  // path meant two concurrent writes could rename each other's half-written file over the
  // live one.
  const tmp = `${file}.${randomUUID()}.tmp`;
  let mode = 0o664;
  let uid: number | null = null;
  let gid: number | null = null;
  try {
    const st = await stat(file);
    mode = st.mode & 0o777;
    uid = st.uid;
    gid = st.gid;
    // **A hard link, not a copy.** `writeFile(bak, await readFile(file))` had three
    // faults at once: it read the whole file into the web container and wrote it back, so
    // a crash between the two left a truncated `.bak`; the new file landed root:root 0644
    // beside a 1000:1000 664 original, which is the ownership trap this same function
    // exists to avoid two lines down; and it was the *only* copy of a file with no other
    // backup. `link` publishes the existing inode under a second name, so the backup is
    // byte-identical and carries the original's owner and mode by construction — there is
    // no window in which it is partly written. Linked to a unique name then renamed,
    // because `link` fails EEXIST on the second save.
    //
    // Best-effort: a missing backup must not stop the write it protects. It is logged
    // rather than swallowed — the whole point of the `.bak` is to exist on the one day
    // somebody needs it, so silently not having one is worth a line in the console.
    const bakTmp = `${file}.bak.${randomUUID()}`;
    try {
      await link(file, bakTmp);
      await rename(bakTmp, `${file}.bak`);
    } catch (e) {
      await unlink(bakTmp).catch(() => {});
      console.warn(`[sandbox] could not keep a .bak of ${file}: ${(e as Error).message}`);
    }
  } catch {
    // No existing file: there is nothing to back up and nothing to match.
  }

  await writeFile(tmp, text, { encoding: "utf-8", mode });
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await chmod(file, mode).catch(() => {});
  if (uid !== null && gid !== null) await chown(file, uid, gid).catch(() => {});
}

export interface SandboxWriteOutcome {
  applied: string[];
  rejected: SandboxRejection[];
  /** Options that were written but did not read back as asked. Empty on success. */
  unlanded: { name: string; wanted: string; found: string }[];
}

/**
 * Apply updates to the file and then **go and look**.
 *
 * The read-back is not paranoia about this writer; it is the one thing that makes the
 * success message mean something. Every settings bug this project has shipped was a
 * route that reported success for a write that did not happen or landed somewhere else:
 * two 7DTD quick settings wrote XML properties that do not exist, the PZ map-order card
 * wrote the .ini and a restart reverted it, Minecraft's whitelist wrote an empty uuid.
 * A re-read after the rename is cheap (one 75 KB file) and turns "saved" from a claim
 * into an observation.
 *
 * Nothing is written at all if any value is refused — see `setSandboxValues`.
 */
export async function updateSandbox(
  updates: Record<string, string>,
  /**
   * Test seam only. `setSandboxValues` refuses to write a file holding fewer options than a
   * real one has, because that is the signature of a read landing inside the game's own
   * truncate-and-rewrite — the scenario that silently reset 720 of 742 options in testing.
   * The tests work against a verbatim 38-option excerpt rather than committing 1,803 lines,
   * so they lower it. **The route must never pass this.**
   */
  opts: { minOptions?: number } = {}
): Promise<SandboxWriteOutcome> {
  const file = await sandboxPath();
  const current = await readFile(file, "utf-8");
  const result = setSandboxValues(current, updates, opts);
  if (result.rejected.length > 0) {
    return { applied: [], rejected: result.rejected, unlanded: [] };
  }
  if (result.applied.length === 0) {
    return { applied: [], rejected: [], unlanded: [] };
  }

  await replaceFile(file, result.text);

  const after = new Map(
    parseSandboxLua(await readFile(file, "utf-8")).map((o) => [o.name, o.value])
  );
  const unlanded: SandboxWriteOutcome["unlanded"] = [];
  for (const name of result.applied) {
    const found = after.get(name);
    const wanted = result.written[name];
    if (found !== wanted) unlanded.push({ name, wanted, found: found ?? "(gone)" });
  }

  return { applied: result.applied.filter((n) => !unlanded.some((u) => u.name === n)), rejected: [], unlanded };
}
