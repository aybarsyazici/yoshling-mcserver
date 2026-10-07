import type { GameId } from "@/lib/games";

export interface MinecraftJoinTarget {
  mcVersion: string;
  loader: string;
}

export interface JoinInfo {
  game: GameId;
  targetStatus: "checked" | "unknown";
  target: MinecraftJoinTarget | null;
  checkedAt: number;
}

/** Exact version labels only: LATEST/SNAPSHOT aliases cannot identify a client build. */
export function minecraftJoinTarget(value: unknown): MinecraftJoinTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (typeof target.mcVersion !== "string" || !/^[0-9][A-Za-z0-9._-]{0,63}$/.test(target.mcVersion) ||
      typeof target.loader !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(target.loader)) return null;
  return { mcVersion: target.mcVersion, loader: target.loader };
}

/** A response for another world or a partial target is never evidence of compatibility. */
export function parseJoinInfo(value: unknown, game: GameId): JoinInfo | null {
  if (!value || typeof value !== "object") return null;
  const info = value as Record<string, unknown>;
  if (info.game !== game || typeof info.checkedAt !== "number" || !Number.isFinite(info.checkedAt) ||
      info.checkedAt <= 0) return null;
  if (info.targetStatus === "unknown" && info.target === null) {
    return { game, targetStatus: "unknown", target: null, checkedAt: info.checkedAt };
  }
  if (game !== "minecraft" || info.targetStatus !== "checked") return null;
  const target = minecraftJoinTarget(info.target);
  return target ? { game, targetStatus: "checked", target, checkedAt: info.checkedAt } : null;
}
