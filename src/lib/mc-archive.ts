// What a Minecraft archive holds, and how to put it back.
//
// ## Why the two halves live in one file
//
// Until 2026-10-02 `/api/mods/install-modpack` tarred `-C MC_DIR world` and then
// `removeMod`-ed **every** installed jar, and the ledger called that archive a "Rollback
// point". So the one directory it preserved was the one the apply does not touch, and
// nothing of what it destroys: the mods directory was archived nowhere in this app, and
// `removeMod` deletes the `InstalledMod` row along with the jar, so after an apply there
// was no record left of what had been installed either.
//
// Adding `mods` to the tar is half a fix, and the dangerous half on its own. The restore in
// `/api/server/backups` extracts **every** member into a staging dir, renames only `world`
// into place, and `rm -rf`s the staging dir in its `finally` — so a two-member archive
// would have restored, answered `{success: true}`, and discarded the mods. That is this
// repo's named defect class ("reports success after doing nothing or the wrong thing"), so
// the member list, the swap and the manifest predicate are one module where they cannot
// drift apart. The power control already drifted into three copies here and two of them
// missed a fix.

import { execFile } from "child_process";
import { mkdir, rename, rm, stat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { BadArchiveError } from "@/lib/backup-archive";

const execFileAsync = promisify(execFile);

/**
 * The top-level directories of `MC_DIR` an archive can carry, in the order a restore
 * swaps them in.
 *
 * `world` first, because it is the irreplaceable half: a mod set can be fetched from
 * Modrinth again, a world cannot be re-generated. If a restore dies between the two swaps,
 * that is the half that landed.
 *
 * These are relative names passed to `tar -C MC_DIR`, and they are also the names the
 * extracted members have under the staging dir, which is what lets one list drive the
 * create side and the restore side.
 */
export const MC_ARCHIVE_MEMBERS = ["world", "mods"] as const;
export type McArchiveMember = (typeof MC_ARCHIVE_MEMBERS)[number];

/**
 * Which of the known members are present as directories under `root`.
 *
 * Called on `MC_DIR` to decide what to archive and on the staging dir to decide what to
 * swap back, so "what the archive holds" is computed by the same expression on both
 * sides. A fresh install has neither; a server that has booted once has both.
 */
export async function archiveMembersPresent(root: string): Promise<McArchiveMember[]> {
  const out: McArchiveMember[] = [];
  for (const member of MC_ARCHIVE_MEMBERS) {
    const present = await stat(path.join(root, member))
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (present) out.push(member);
  }
  return out;
}

/**
 * Does restoring this archive bring the mods back?
 *
 * Reads the manifest's recorded `members`, so an archive written before that field
 * existed answers **false** — which is not a guess: every Minecraft archive written
 * before 2026-10-02 was `tar -czf … -C MC_DIR world`, one member, and routine backups
 * still are. Deliberately does not open the tar: the sidecar exists because reading an
 * in-tar member costs a full gzip decompression per archive, measured at 7.9 s for one
 * listing (see `backup-archive.ts`).
 */
export function manifestIncludesMods(manifest: { members?: string[] } | null | undefined): boolean {
  return Array.isArray(manifest?.members) && manifest.members.includes("mods");
}

/**
 * The members, as a clause for a step label, a fact or a journal line.
 *
 * One sentence-builder rather than a conditional at each call site: the apply's "Rollback
 * point" fact and the restore's "Replaced" step are the two ends of the same promise, and
 * they are supposed to use the same words.
 */
export function describeMembers(members: readonly McArchiveMember[]): string {
  const names: Record<McArchiveMember, string> = {
    world: "the world folder",
    mods: "the mods directory",
  };
  const parts = members.map((m) => names[m]);
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Extract into a staging dir and only then swap the members in.
 *
 * This used to `rm -rf world` *first* and extract second, so a truncated or wrong-shaped
 * archive — or a full disk — left no world at all. 7DTD and PZ already extract before they
 * replace. The staging dir lives inside `mcDir` so each final step is a same-device
 * rename: a live directory only disappears once its replacement is complete on disk.
 *
 * **Every member is decided before the first `rm`.** An archive this cannot use therefore
 * costs no downtime and leaves nothing half-replaced, which is the same ordering argument
 * the checksum check one layer up is built on.
 *
 * Returns what it actually replaced, because the caller may not state an outcome it did
 * not read back: a legacy one-member archive replaces the world and leaves the live mods
 * directory **untouched**, and saying "world and mods" there would be a lie about a
 * directory full of jars.
 */
export async function restoreMinecraftArchive(opts: {
  archivePath: string;
  mcDir: string;
  /** `undefined` means no wall-clock cap, matching `execFile`'s own default. */
  timeoutMs?: number;
}): Promise<{ replaced: McArchiveMember[] }> {
  const { archivePath, mcDir, timeoutMs } = opts;
  const work = path.join(mcDir, `.restore-${Date.now()}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", work], { timeout: timeoutMs });

    const present = await archiveMembersPresent(work);
    if (present.length === 0) {
      // `BadArchiveError`, so the route answers 400 rather than 500: a valid gzip file
      // that happens to hold neither of these is the user's archive being wrong, not the
      // server breaking. Reached by pointing a Minecraft restore at a 7DTD bundle
      // (`Saves/`, `GeneratedWorlds/`, `sdtdserver.xml`, `manifest.json`) or a Project
      // Zomboid one (`Saves/`, `db/`, `Server/`, `manifest.json`) — neither writes a
      // `world` or a `mods` member.
      throw new BadArchiveError(
        "This backup has no world folder and no mods folder in it — nothing was changed."
      );
    }

    for (const member of present) {
      const live = path.join(mcDir, member);
      await rm(live, { recursive: true, force: true });
      await rename(path.join(work, member), live);
    }
    return { replaced: present };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
