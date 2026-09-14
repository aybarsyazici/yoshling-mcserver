import { GAME_LIST, isGameId, type GameId } from "@/lib/games";

type Role = "ADMIN" | "MOD" | "MEMBER";

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
 */
const PERMISSIONS = {
  "server.start": ["ADMIN", "MOD"],
  "server.stop": ["ADMIN", "MOD"],
  "server.restart": ["ADMIN", "MOD"],
  "server.version": ["ADMIN", "MOD"],
  "server.loader": ["ADMIN", "MOD"],
  "mods.install": ["ADMIN", "MOD"],
  "mods.remove": ["ADMIN", "MOD"],
  "mods.update": ["ADMIN", "MOD"],
  "mods.browse": ["ADMIN", "MOD", "MEMBER"],
  "mods.request": ["ADMIN", "MOD", "MEMBER"],
  "settings.edit": ["ADMIN", "MOD"],
  "users.manage": ["ADMIN"],
  "activity.view": ["ADMIN", "MOD", "MEMBER"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

export function requireRole(...roles: Role[]) {
  return (userRole: Role) => roles.includes(userRole);
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
