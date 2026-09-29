import path from "path";

/**
 * The one definition of "this request stays inside the root it named".
 *
 * It used to be three copies — `api/server/files`, `api/7dtd/files` and
 * `api/zomboid/files` each carried a private `isPathSafe` and a private
 * `BLOCKED_PATTERNS`, and the MC one took a different argument list. That is the same
 * drift that let the power control end up in three versions where two were missing a
 * fix, so this is deliberately not duplicated for symmetry with anything.
 *
 * All three copies compared with a bare `resolved.startsWith(baseDir)`, which is a
 * **prefix test on a string, not a containment test on a path**: it has no separator,
 * so a sibling directory whose name merely begins with the root's name passes it.
 * 7 Days to Die has exactly that pair of roots — `/sevendtd` (saves) and
 * `/sevendtd-config` (config) — so `?root=saves&path=/sevendtd-config/sdtdserver.xml`
 * resolved to `/sevendtd-config/sdtdserver.xml`, satisfied `startsWith("/sevendtd")`,
 * and read a file outside the root the request asked for. `..` was separately blocked
 * as a substring, which is why an *absolute* sibling path was the way through.
 */
const BLOCKED_PATTERNS = ["..", "~", "node_modules"];

/**
 * True when `requestedPath` resolves to `baseDir` itself or to something genuinely
 * beneath it.
 *
 * The separator is the whole point: `"/sevendtd-config".startsWith("/sevendtd")` is
 * true and `"/sevendtd-config".startsWith("/sevendtd" + path.sep)` is false. `baseDir`
 * is normalised first and its trailing separator stripped, so a root written as
 * `/zomboid/` cannot make every check pass by accident.
 */
export function isPathSafe(baseDir: string, requestedPath: string): boolean {
  if (BLOCKED_PATTERNS.some((p) => requestedPath.includes(p))) return false;
  const root = stripTrailingSep(path.resolve(baseDir));
  const resolved = path.resolve(root, requestedPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * The contained absolute path, or `null` if the request escapes.
 *
 * Exists so a caller cannot check one path and then open another: every route used to
 * call `isPathSafe(base, rel)` and then re-derive `path.resolve(base, rel)` a few lines
 * later, which is two chances to disagree for no benefit.
 */
export function resolveWithin(baseDir: string, requestedPath: string): string | null {
  if (!isPathSafe(baseDir, requestedPath)) return null;
  return path.resolve(stripTrailingSep(path.resolve(baseDir)), requestedPath);
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
}
