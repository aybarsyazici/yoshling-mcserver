// Valve KeyValues (`.acf`) parsing for `appworkshop_108600.acf`, the Steam Workshop
// manifest.
//
// Split out of `zomboid-updates.ts` so it can be tested against a real manifest: that
// module imports `game-manager`, which reaches Docker and Prisma, and this parsing is
// the part where getting it wrong is silent. `scripts/pz-stale-mods.py` reimplements
// the same rule in Python for use on the box; the two must agree.

/**
 * The body of a named Valve-KeyValues block, found by matching braces.
 *
 * Bounding the block is the entire point. `appworkshop_<appid>.acf` contains **two**
 * sections keyed by workshop id:
 *
 *   - `WorkshopItemsInstalled` — what is on disk, each item carrying `timeupdated`
 *   - `WorkshopItemDetails`    — what Steam knows, each item carrying BOTH
 *     `timeupdated` AND `latest_timeupdated`
 *
 * Because both sections use the same `"<id>" { … }` shape and both carry a
 * `timeupdated`, reading from the first section to end-of-file lets the second
 * section's value win for every id. That makes installed == published for every mod,
 * so the staleness check always answers "nothing to do" — silently, forever. That is
 * the bug this brace matching replaced, and it is the reason the answer has to be
 * bounded rather than found by a global regex.
 */
export function kvSection(text: string, name: string): string | null {
  const key = `"${name}"`;
  const at = text.indexOf(key);
  if (at < 0) return null;
  const open = text.indexOf("{", at + key.length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Per-item blocks hold only scalars, so there is no nesting to worry about here. */
const ITEM_RE = /"(\d{6,})"\s*\{([^}]*)\}/g;

function scalars(section: string, field: string): Map<string, number> {
  const out = new Map<string, number>();
  const fieldRe = new RegExp(`"${field}"\\s*"(\\d+)"`);
  // `ITEM_RE` is module-level and stateful (`/g` keeps `lastIndex`), so it is reset
  // before each scan rather than shared mid-iteration.
  ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(section)) !== null) {
    const hit = fieldRe.exec(m[2]);
    if (hit) out.set(m[1], Number(hit[1]));
  }
  return out;
}

/**
 * `timeupdated` per installed item — the version actually on disk.
 *
 * Read from `WorkshopItemsInstalled` only. `WorkshopItemDetails` also has a
 * `timeupdated` per id and it is NOT the installed one.
 */
export function parseInstalledVersions(text: string): Map<string, number> {
  const section = kvSection(text, "WorkshopItemsInstalled");
  return section ? scalars(section, "timeupdated") : new Map();
}

/**
 * `latest_timeupdated` per item from `WorkshopItemDetails` — Steam's own record of the
 * newest published version, maintained by the running server's Steam client.
 *
 * Used only to cross-check the Steam API answer, because it goes stale while the
 * server is stopped and nothing refreshes it.
 */
export function parseLatestKnownVersions(text: string): Map<string, number> {
  const section = kvSection(text, "WorkshopItemDetails");
  return section ? scalars(section, "latest_timeupdated") : new Map();
}
