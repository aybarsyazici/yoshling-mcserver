interface GameVersionTag { version: string; version_type: string }
interface CategoryTag { project_type: string; name: string; icon?: string | null }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function gameVersionTags(value: unknown): GameVersionTag[] | null {
  if (!Array.isArray(value) || !value.every((tag: unknown) => record(tag) &&
      typeof tag.version === "string" && typeof tag.version_type === "string")) return null;
  return value as GameVersionTag[];
}

export function categoryTags(value: unknown): CategoryTag[] | null {
  if (!Array.isArray(value) || !value.every((tag: unknown) => record(tag) &&
      typeof tag.project_type === "string" && typeof tag.name === "string" &&
      (tag.icon === undefined || tag.icon === null || typeof tag.icon === "string"))) return null;
  return value as CategoryTag[];
}
