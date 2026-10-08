/** Browser-only tutorial preferences. No game state or credentials belong in this record. */
export const MINECRAFT_GUIDE_CHAPTER_IDS = ["welcome", "profiles", "play", "mods", "backups", "settings", "covers", "server"] as const;
export type MinecraftGuideChapterId = typeof MINECRAFT_GUIDE_CHAPTER_IDS[number];
export interface MinecraftGuideProgress {
  version: 1;
  current: MinecraftGuideChapterId;
  completed: MinecraftGuideChapterId[];
}
const MAX_PROGRESS_LENGTH = 2048;
const chapter = (value: unknown): value is MinecraftGuideChapterId => typeof value === "string" && MINECRAFT_GUIDE_CHAPTER_IDS.some(id => id === value);

export function defaultMinecraftGuideProgress(): MinecraftGuideProgress {
  return { version: 1, current: "welcome", completed: [] };
}
function canonicalProgress(value: unknown): MinecraftGuideProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !chapter(row.current) || !Array.isArray(row.completed) || !row.completed.every(chapter)) return null;
  const completed = new Set(row.completed);
  return { version: 1, current: row.current, completed: MINECRAFT_GUIDE_CHAPTER_IDS.filter(id => completed.has(id)) };
}
export function parseMinecraftGuideProgress(raw: string | null): MinecraftGuideProgress {
  if (typeof raw !== "string" || raw.length > MAX_PROGRESS_LENGTH) return defaultMinecraftGuideProgress();
  try { return canonicalProgress(JSON.parse(raw)) ?? defaultMinecraftGuideProgress(); }
  catch { return defaultMinecraftGuideProgress(); }
}
export function minecraftGuideStorageKey(userId: string): string {
  if (typeof userId !== "string" || !userId.trim() || userId.length > 256 || /[\x00-\x1f\x7f]/.test(userId)) throw new Error("A valid user identity is required for tutorial progress.");
  return `yoshling:minecraft-guide:v1:user:${encodeURIComponent(userId)}`;
}
export function saveMinecraftGuideProgress(storage: Pick<Storage, "getItem" | "setItem">, userId: string, progress: MinecraftGuideProgress): boolean {
  try {
    const canonical = canonicalProgress(progress);
    if (!canonical) return false;
    const key = minecraftGuideStorageKey(userId), serialized = JSON.stringify(canonical);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch { return false; }
}
