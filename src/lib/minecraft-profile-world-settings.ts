import { escapeMcValue, sanitizeMcValue, unescapeMcValue } from "./mc-properties";
import { MinecraftProfileError } from "./minecraft-profile-store";

export const MINECRAFT_PROFILE_WORLD_KEYS = [
  "difficulty", "gamemode", "hardcore", "level-seed", "level-type", "generator-settings",
  "generate-structures", "allow-flight", "max-players", "view-distance", "simulation-distance",
  "white-list", "motd", "spawn-protection",
] as const;
export const MINECRAFT_PROFILE_CREATION_KEYS = ["level-seed", "level-type", "generator-settings"] as const;
const allowed = new Set<string>(MINECRAFT_PROFILE_WORLD_KEYS);
const booleans = new Set(["hardcore", "generate-structures", "allow-flight", "white-list"]);
const ranges: Record<string, [number, number]> = { "max-players": [1, 1000], "view-distance": [2, 32], "simulation-distance": [2, 32], "spawn-protection": [0, 1000] };

/** Create/inactive editors offer gameplay keys; advanced identity policy stays on the active page. Ports and control channels are deployment-owned. */
export function validateMinecraftProfileWorldSettings(settings: unknown): Record<string, string> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new MinecraftProfileError("Expected a world-settings object", 400, "invalid_settings");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) throw new MinecraftProfileError(`${key} is not an editable profile world setting`, 400, "invalid_settings");
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) throw new MinecraftProfileError(`Invalid value for ${key}`, 400, "invalid_settings");
    const cleaned = sanitizeMcValue(value);
    if (booleans.has(key) && !["true", "false"].includes(cleaned)) throw new MinecraftProfileError(`${key} must be true or false`, 400, "invalid_settings");
    const range = ranges[key];
    if (range && (!/^\d+$/.test(cleaned) || Number(cleaned) < range[0] || Number(cleaned) > range[1])) throw new MinecraftProfileError(`${key} is outside its allowed range`, 400, "invalid_settings");
    if (key === "difficulty" && !["peaceful", "easy", "normal", "hard", "0", "1", "2", "3"].includes(cleaned)) throw new MinecraftProfileError("Invalid difficulty", 400, "invalid_settings");
    if (key === "gamemode" && !["survival", "creative", "adventure", "spectator", "0", "1", "2", "3"].includes(cleaned)) throw new MinecraftProfileError("Invalid game mode", 400, "invalid_settings");
    result[key] = cleaned;
  }
  return result;
}

export function readMinecraftProfileWorldSettings(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (/^\s*[#!]/.test(line) || !line.includes("=")) continue;
    const split = line.indexOf("=");
    const key = line.slice(0, split).trim();
    if (allowed.has(key)) result[key] = unescapeMcValue(line.slice(split + 1).trim());
  }
  return result;
}

export function setMinecraftProfileWorldSettings(content: string, updates: Record<string, string>): { text: string; applied: string[] } {
  const validated = validateMinecraftProfileWorldSettings(updates);
  const applied = new Set<string>();
  const lines = content.split("\n").map(line => {
    const split = line.indexOf("=");
    if (split < 0 || /^\s*[#!]/.test(line)) return line;
    const key = line.slice(0, split).trim();
    if (!Object.hasOwn(validated, key)) return line;
    applied.add(key);
    return `${key}=${escapeMcValue(validated[key])}`;
  });
  for (const [key, value] of Object.entries(validated)) if (!applied.has(key)) { lines.push(`${key}=${escapeMcValue(value)}`); applied.add(key); }
  return { text: lines.join("\n"), applied: [...applied] };
}
