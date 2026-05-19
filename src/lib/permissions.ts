type Role = "ADMIN" | "MOD" | "MEMBER";

const PERMISSIONS = {
  "server.start": ["ADMIN"],
  "server.stop": ["ADMIN"],
  "server.restart": ["ADMIN"],
  "server.version": ["ADMIN"],
  "server.loader": ["ADMIN"],
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
