import { GAME_LIST, isGameId, type GameId } from "@/lib/games";

/**
 * Exported so a route can name the type once instead of re-spelling the union.
 * `src/types/next-auth.d.ts` declares `session.user.role` as the same three
 * literals, so the two agree structurally and a route may pass one straight in.
 */
export type Role = "ADMIN" | "MOD" | "MEMBER";

export function isRole(value: unknown): value is Role {
  return value === "ADMIN" || value === "MOD" || value === "MEMBER";
}

/**
 * MOD can do everything ADMIN can — the difference is *scope*, not capability.
 * A MOD only ever acts on the worlds they've been granted (`User.games`), while
 * ADMIN implicitly holds every world. So a MOD who looks after Project Zomboid
 * can power it, restart it, edit its settings and manage its mods, and never
 * sees the Minecraft or 7 Days to Die pages at all.
 *
 * The single exception is `users.manage`. If a MOD could edit world access they
 * could grant themselves the worlds they were deliberately kept out of, which
 * would make the whole gate decorative — so handing out access stays ADMIN-only.
 *
 * **Every key here is checked by at least one caller, and it is meant to stay that
 * way.** Five keys used to sit in this table that nothing ever asked about —
 * `server.version`, `server.loader`, `mods.update`, `mods.browse`, `mods.request` —
 * so the table read like a policy while the code enforced something else. The
 * settings route — the one that actually changes the version and the loader — gates
 * on `settings.edit`, as does the Zomboid mod-update route; browsing mods is gated
 * by world access alone; and `mods.request` guarded a request feature that exists in
 * the Prisma schema and nowhere in the code. (`mods.update` is the easiest to
 * mis-grep: every remaining match in the tree is the *`OperationKind`* of the same
 * name, which is a different thing entirely.)
 * Removing them narrows `Permission`, so a future `hasPermission(role, "mods.update")`
 * fails to compile instead of silently returning a value nobody had reasoned about.
 * If you need a new capability, add the key *and* its check in the same change.
 *
 * `activity.view` was a sixth one, missed by that sweep: `/api/activity` gated on the
 * session alone, and because all three roles hold this key the table and the route
 * happened to agree — which is exactly why nobody noticed. It is checked now. The
 * guard against a seventh is a test, not this comment: `permissions.test.ts` greps
 * `src/` for a `hasPermission(…, "<key>")` call site per key and fails without one.
 *
 * ── The five keys added 2026-09-30, and why they are not ADMIN-only ─────────
 *
 * `server.update`, `world.reset`, `console.execute`, `files.delete` and
 * `settings.read` exist because `grep -rn 'role !== "ADMIN"' src/app/api/` found
 * **12 raw comparisons in 11 route files** — handlers deciding policy for themselves
 * instead of asking this table. Those comparisons **predate the 2026-09-14 decision
 * above** and quietly enforced a different policy than the one documented here: a MOD
 * trusted with a world could restart it but not reset it, could edit its config but
 * not delete a stray file, and could not update the game build at all.
 *
 * Nine of the twelve are routed through here now. The remaining three are the two
 * handlers in `/api/7dtd/world` plus `/api/7dtd/world/token`, left alone because
 * another change owns that file; they still compare by hand and want a capability of
 * their own (a world *upload*, which replaces a save wholesale).
 *
 * They are `["ADMIN", "MOD"]` because none of them lets a MOD widen their own
 * reach, which is the *only* reason `users.manage` is fenced off. World access
 * already scopes every one of them to the worlds in `User.games`. And the fence was
 * never coherent anyway: `console.execute` hands a MOD the game's own console — 7DTD
 * telnet, Minecraft and PZ RCON — which can already delete players and wipe regions,
 * so withholding "delete one file" from the same person protected nothing while
 * looking like it did.
 *
 * If a future owner wants any of them back to ADMIN-only, that is now **one line
 * here**, applied to every caller at once — which is the whole point of naming them.
 */
const PERMISSIONS = {
  "server.start": ["ADMIN", "MOD"],
  "server.stop": ["ADMIN", "MOD"],
  "server.restart": ["ADMIN", "MOD"],
  /** Re-download the game build (7DTD `START_MODE=3`). Recreates the container. */
  "server.update": ["ADMIN", "MOD"],
  /** Delete a world's save and start a fresh one. */
  "world.reset": ["ADMIN", "MOD"],
  /** Send an arbitrary command to the game (MC RCON, 7DTD telnet, PZ RCON). */
  "console.execute": ["ADMIN", "MOD"],
  "mods.install": ["ADMIN", "MOD"],
  "mods.remove": ["ADMIN", "MOD"],
  /**
   * Read raw server config and data files. Separate from `settings.edit` because
   * it gates **GETs**, and a permission named `…edit` on a read invites someone to
   * "fix" the mismatch by dropping the check. It is a privileged read, not a
   * browse: `sdtdserver.xml` carries `ServerPassword` (5 chars, non-empty on
   * production 2026-09-30) and PZ's `.ini` carries `Password` and `DiscordToken`,
   * so a read-only MEMBER who could load the "All settings" panel would read the
   * live server password out of it.
   */
  "settings.read": ["ADMIN", "MOD"],
  "settings.edit": ["ADMIN", "MOD"],
  /**
   * Irreversible removal of a file from a game's data tree. Split from
   * `settings.edit` (which covers the file browser's read and write) so the
   * unrecoverable half can be fenced off on its own if that is ever wanted.
   */
  "files.delete": ["ADMIN", "MOD"],
  /**
   * Upload a 7 Days to Die world or save, and delete an uploaded world.
   *
   * ADMIN **and MOD**, like every other key here except `users.manage`, and named rather
   * than left as the three hand-written `role !== "ADMIN"` comparisons it replaces
   * (`/api/7dtd/world` POST and DELETE, `/api/7dtd/world/token` GET) — the last three of
   * the twelve that sweep found. A MOD already holds `world.reset`, which deletes the
   * whole world outright, so withholding "replace the save with a different one" from the
   * same person protected nothing. The destination guards are what make this safe, not the
   * role: the target must survive `safeName` and must resolve to a direct child of the
   * worlds or saves root, and the active `GameWorld`/`GameName` pair is refused.
   */
  "world.upload": ["ADMIN", "MOD"],
  "users.manage": ["ADMIN"],
  "activity.view": ["ADMIN", "MOD", "MEMBER"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Every capability in the table, for callers that need to enumerate rather than
 * ask about one. The reachability test uses it to prove each key still has a
 * `hasPermission` call site somewhere in `src/` — the check that the five dead
 * keys removed earlier would have failed.
 */
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export function hasPermission(role: Role, permission: Permission): boolean {
  // `?? []` because both arguments arrive from outside the type system. `role` comes
  // out of a JWT claim (`token.role`), so a stale or hand-edited token can carry a
  // string this union does not contain, and `permission` survives a JS caller or a
  // half-finished rename. Without the fallback an unknown key indexed to `undefined`
  // and `.includes` threw — which a route turns into a 500, and a 500 on an auth check
  // is indistinguishable from the app being down. Denying is the only safe answer;
  // throwing is the only one that also hides why.
  const allowed = (PERMISSIONS as Record<string, readonly string[]>)[permission] ?? [];
  return allowed.includes(role);
}

// ── per-world access ────────────────────────────────────────────────────────
//
// Roles say what a user may *do*; game access says which worlds they may see
// at all. The two are orthogonal: a MOD with only Project Zomboid can install
// PZ mods but never learns the Minecraft pages exist. ADMIN always sees every
// world (and is the only role that can hand access out).

export const ALL_GAMES: GameId[] = GAME_LIST.map((g) => g.id);

/**
 * The worlds a user may see. Accepts the raw CSV column or an already-parsed
 * list, and always returns them in canonical GAME_LIST order.
 */
export function gameAccess(role: Role, games: string | string[] | null | undefined): GameId[] {
  if (role === "ADMIN") return ALL_GAMES;
  const raw = Array.isArray(games) ? games : String(games ?? "").split(",");
  const granted = new Set(raw.map((s) => s.trim()).filter(isGameId));
  return ALL_GAMES.filter((g) => granted.has(g));
}

export function canAccessGame(
  role: Role,
  games: string | string[] | null | undefined,
  game: GameId
): boolean {
  return gameAccess(role, games).includes(game);
}

/** Back to the CSV stored on the user row, deduped and in canonical order. */
export function serializeGameAccess(games: unknown): string {
  const list = Array.isArray(games) ? games : [];
  const granted = new Set(list.map((s) => String(s).trim()).filter(isGameId));
  return ALL_GAMES.filter((g) => granted.has(g)).join(",");
}
