import { randomUUID } from "node:crypto";
import { db } from "./db";
import { ALL_GAMES } from "./permissions";

/** One SQLite write chooses the bootstrap role; simultaneous logins cannot both be first. */
export async function registerDiscordUser(input: { discordId: string; username: string; avatar: string | null }): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "User" ("id", "discordId", "username", "avatar", "role", "games", "createdAt")
    SELECT ${randomUUID()}, ${input.discordId}, ${input.username}, ${input.avatar},
      CASE WHEN EXISTS (SELECT 1 FROM "User") THEN 'MEMBER' ELSE 'ADMIN' END,
      CASE WHEN EXISTS (SELECT 1 FROM "User") THEN '' ELSE ${ALL_GAMES.join(",")} END,
      ${Date.now()}
    WHERE 1
    ON CONFLICT ("discordId") DO UPDATE SET
      "username" = excluded."username",
      "avatar" = COALESCE(excluded."avatar", "User"."avatar")
  `;
  const saved = await db.user.findUnique({ where: { discordId: input.discordId } });
  if (!saved || saved.discordId !== input.discordId || saved.username !== input.username ||
      (input.avatar !== null && saved.avatar !== input.avatar)) {
    throw new Error("The Discord account update could not be verified");
  }
}
