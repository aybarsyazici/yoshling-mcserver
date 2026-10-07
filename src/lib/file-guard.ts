import { lstat, realpath } from "fs/promises";
import path from "path";
import { readFileSnapshot } from "@/lib/file-revision";

/**
 * Shared guards for the three file-browser routes (`/api/server/files`,
 * `/api/7dtd/files`, `/api/zomboid/files`).
 *
 * They were three byte-identical copies of the same two predicates, and both
 * copies were wrong in the same way. This file exists so the next fix lands once
 * instead of two-thirds of the time -- the prefix-boundary bug below has already
 * been fixed twice elsewhere in this codebase under different names.
 *
 * The documented defect class here is "reports success after doing nothing". These
 * two are its twin: **reports success after doing something destructive.**
 */

/**
 * True when the buffer is not editable text.
 *
 * Measured 2026-09-29 on the box: `GET /api/server/files?path=world/level.dat&action=read`
 * returned 200 with mojibake, because the route read it with `"utf-8"` and every byte
 * that is not valid UTF-8 became U+FFFD. `PUT`ting that string straight back -- exactly
 * what the editor submits when you open a file and press Save -- turned a **411-byte
 * valid gzip NBT file into 752 bytes** (md5 `029200a0…` → `0c34de2d…`, `gzip -t`: "invalid
 * magic"), and answered `{"success":true}`. The write was never the problem; reading
 * lossily was, and nothing downstream could tell.
 *
 * Two signals, both cheap: a NUL byte (no text file we serve has one), and any byte
 * sequence a strict UTF-8 decoder rejects. `.dat`, `.ttw`, `.jar`, `.png` and `.db`
 * all trip one or the other.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  try {
    // `fatal: true` is the whole point -- the non-fatal decoder is what silently
    // substituted U+FFFD and made the corruption look like a successful read.
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

/**
 * Read a file as text, or tell the caller it is not text. Never lossy: the buffer is
 * checked before it is decoded, so a binary file can't come back as mojibake the
 * caller will later write over the original.
 */
export async function readTextFile(
  fullPath: string
): Promise<{ ok: true; content: string } | { ok: false }> {
  const buf = await readFileSnapshot(fullPath);
  if (looksBinary(buf)) return { ok: false };
  return { ok: true, content: buf.toString("utf-8") };
}

/**
 * True when `resolved` is `baseDir` itself or a path beneath it.
 *
 * `resolved.startsWith(baseDir)` -- what all three routes used -- matches a **sibling
 * that merely shares the prefix**. Measured live on 7DTD: `?root=saves&path=/sevendtd-config`
 * returned a 200 listing of the whole config tree, because `path.resolve("/sevendtd",
 * "/sevendtd-config")` is `/sevendtd-config`, which starts with `/sevendtd` and contains
 * no `..` for the blocked-pattern check to catch. The same predicate gates PUT and
 * DELETE, so a write could have landed on `sdtdserver.xml` "through" the saves root.
 * Minecraft and PZ had the identical predicate and were unreachable only by luck --
 * their roots nest inside one another.
 *
 * Comparing with a trailing separator is the fix: `/sevendtd-config` does not start
 * with `/sevendtd/`.
 */
export function isPathInside(baseDir: string, resolved: string): boolean {
  const base = path.resolve(baseDir);
  const target = path.resolve(resolved);
  if (target === base) return true;
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

interface SafeFilePathOptions {
  /** Shortcut roots must remain within their trusted game-data root. */
  boundaryRoot?: string;
  /** Permit a new file/directory suffix after checking its existing parent tree. */
  allowMissing?: boolean;
  /** Reads may list the root; mutations must not replace or remove it. */
  allowRoot?: boolean;
  /** DELETE removes a contained final link itself, rather than its destination. */
  followFinalSymlink?: boolean;
}

/**
 * Resolve a browser path inside its configured root, including filesystem links.
 *
 * The root is trusted configuration and may itself be a mount or symlink. Every
 * existing component below it is checked with lstat before resolving links, so a
 * dangling link cannot masquerade as a legitimate new file. A missing suffix is
 * admitted only after its existing ancestors passed the physical boundary check.
 * Operations use the canonical parent tree to avoid following a checked parent
 * alias again. This is path admission, not a lock against external filesystem moves.
 */
export async function resolveSafeFilePath(
  baseDir: string,
  requestedPath: unknown,
  options: SafeFilePathOptions = {}
): Promise<string | null> {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) return null;
  if (["..", "~", "node_modules"].some((blocked) => requestedPath.includes(blocked))) {
    return null;
  }

  const base = path.resolve(baseDir);
  const target = path.resolve(base, requestedPath);
  if (!isPathInside(base, target)) return null;
  if (options.allowRoot === false && target === base) return null;

  const physicalRoot = await realpath(base);
  if (options.boundaryRoot) {
    const boundary = await realpath(options.boundaryRoot);
    if (!isPathInside(boundary, physicalRoot)) return null;
  }
  const relative = path.relative(base, target);
  if (!relative) return physicalRoot;

  const parts = relative.split(path.sep);
  let current = physicalRoot;
  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(current, parts[i]);
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (e) {
      if (options.allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return path.join(current, ...parts.slice(i));
      }
      throw e;
    }

    if (entry.isSymbolicLink()) {
      let destination;
      try {
        destination = await realpath(candidate);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ELOOP") return null;
        throw e;
      }
      if (!isPathInside(physicalRoot, destination)) return null;
      if (i === parts.length - 1) {
        if (options.allowRoot === false && destination === physicalRoot) return null;
        if (options.followFinalSymlink === false) return candidate;
      }
      current = destination;
    } else {
      current = candidate;
    }
  }
  return current;
}

/**
 * The member names in `unzip -l` output.
 *
 * Measured against the `unzip` the web container actually has, which is **BusyBox
 * v1.37.0, not Info-ZIP** (`docker exec yoshling-web-1 unzip -v`, 2026-09-29). Its rows
 * look like:
 *
 *     Archive:  evil.zip
 *       Length      Date    Time    Name
 *     ---------  ---------- -----   ----
 *             1  00-00-1980 00:00   etc/agent7dtd-pwned
 *      --------                     -------
 *             6                     3 files
 *
 * Three fields then the name, so the header, the rules and the trailing total are all
 * excluded — the total is the one that matters, because `/^\s*\d+\s/` (what the upload
 * route counted entries with) matches it and reported a 3-file zip as 4 files.
 */
export function zipMemberNames(listing: string): string[] {
  const out: string[] = [];
  for (const line of listing.split("\n")) {
    const name = line.match(/^\s*\d+\s+\S+\s+\S+\s+(\S.*)$/)?.[1];
    if (name) out.push(name.trimEnd());
  }
  return out;
}

/**
 * Does this archive contain a path we refuse to extract?
 *
 * **The unzip binary's own sanitisation is the primary defence; this is the honest
 * secondary.** The check this replaces pretended the opposite and was dead code.
 *
 * It tested `unzip -l`'s **stdout** for `../`, which can never contain it. Measured
 * 2026-09-29 in the web container, with a zip whose first member was literally
 * `../../../../etc/agent7dtd-pwned`:
 *
 *   - stdout listed it as `etc/agent7dtd-pwned` — already stripped, so the guard saw
 *     nothing and the upload was **accepted**;
 *   - `unzip: removing leading '../../../../' from member names` went to **stderr**, from
 *     *both* the `-l` and the `-o` invocation, and the route read neither;
 *   - nothing reached `/etc` (BusyBox had contained it), but the stray path was extracted
 *     to `out/etc/agent7dtd-pwned` and the old save branch would have moved it into the
 *     saves tree.
 *
 * So the signal that works is stderr, and it is available on the *listing* pass, before
 * anything is extracted. The stdout patterns stay as defence in depth for a `..` segment
 * that is not leading, an absolute or drive-letter member, and backslash separators
 * (BusyBox keeps those verbatim on Linux, where `..\..\etc\x` is one long filename — not a
 * traversal, but not something to move into a game directory either).
 */
export function unsafeZipPaths(listing: string, stderr: string): boolean {
  if (/removing leading|skipped .*path component|skipping: .*unsafe|name with|mapname:/i.test(stderr)) {
    return true;
  }
  for (const name of zipMemberNames(listing)) {
    if (/(^|[/\\])\.\.([/\\]|$)/.test(name)) return true;
    if (name.startsWith("/") || /^[A-Za-z]:[/\\]/.test(name)) return true;
    if (name.includes("\\")) return true;
  }
  return false;
}
