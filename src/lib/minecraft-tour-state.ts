import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { discordUserId } from "./discord-identity";
import { canAccessGame, isRole } from "./permissions";
import { isWhitelisted } from "./whitelist";

/** Import this type only from client components; preference reads remain server-owned. */
export interface MinecraftTourState { userId: string; version: 1; done: boolean }
export interface MinecraftTourActor { userId: string; discordId: string }
export class MinecraftTourError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function authorizedUser(actor: MinecraftTourActor, client: Pick<Prisma.TransactionClient, "user"> = db) {
  if (!actor || typeof actor.userId !== "string" || !actor.userId || !discordUserId(actor.discordId)) throw new MinecraftTourError("Unauthorized", 401);
  const user = await client.user.findUnique({ where: { id: actor.userId }, select: { id: true, discordId: true, role: true, games: true, minecraftTourDone: true } });
  if (!user || user.id !== actor.userId || user.discordId !== actor.discordId || !discordUserId(user.discordId)) throw new MinecraftTourError("The signed-in identity could not be confirmed", 401);
  if (!isRole(user.role) || !canAccessGame(user.role, user.games, "minecraft") || !await isWhitelisted(user.discordId)) throw new MinecraftTourError("No access to Minecraft", 403);
  if (typeof user.minecraftTourDone !== "boolean") throw new Error("Minecraft tour state could not be verified");
  return user;
}
export async function readMinecraftTourState(actor: MinecraftTourActor): Promise<MinecraftTourState> {
  const user = await authorizedUser(actor);
  return { userId: user.id, version: 1, done: user.minecraftTourDone };
}
/** A one-way own-user preference. Replaying a completed tour never rewrites the row. */
export async function completeMinecraftTour(actor: MinecraftTourActor): Promise<MinecraftTourState> {
  return db.$transaction(async tx => {
    const before = await authorizedUser(actor, tx);
    if (before.minecraftTourDone) return { userId: before.id, version: 1, done: true };
    const changed = await tx.user.updateMany({ where: { id: before.id, discordId: before.discordId, role: before.role, games: before.games, minecraftTourDone: false }, data: { minecraftTourDone: true } });
    if (changed.count !== 1) throw new Error("Minecraft tour completion could not be confirmed");
    const saved = await authorizedUser(actor, tx);
    if (!saved.minecraftTourDone) throw new Error("Minecraft tour completion failed readback");
    return { userId: saved.id, version: 1, done: true };
  });
}
export function validateMinecraftTourCompletion(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MinecraftTourError("Expected Minecraft tour completion", 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || input.version !== 1 || input.done !== true || Object.keys(input).some(key => key !== "version" && key !== "done")) throw new MinecraftTourError("Only version 1 completion is supported", 400);
}
