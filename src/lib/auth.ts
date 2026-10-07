import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { db } from "./db";
import { gameAccess, isRole } from "./permissions";
import { isWhitelisted } from "./whitelist";
import { discordUserId } from "./discord-identity";
import { registerDiscordUser } from "./discord-user";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      const discordId = discordUserId(profile?.id);
      if (!discordId) return false;
      if (!(await isWhitelisted(discordId))) {
        console.warn("[auth] sign-in refused by the Discord ID policy");
        return false;
      }
      const username = typeof profile?.username === "string" && profile.username.trim()
        ? profile.username : user.name || "Unknown";
      await registerDiscordUser({ discordId, username, avatar: user.image || null });
      return true;
    },
    async jwt({ token, profile }) {
      let dbUser = null;
      if (profile !== undefined || token.discordId !== undefined) {
        const discordId = discordUserId(profile?.id ?? token.discordId);
        if (!discordId) return null;
        dbUser = await db.user.findUnique({ where: { discordId } });
      } else if (typeof token.id === "string" && token.id) {
        dbUser = await db.user.findUnique({ where: { id: token.id } });
      } else {
        const discordId = discordUserId(token.sub);
        if (!discordId) return null;
        dbUser = await db.user.findUnique({ where: { discordId } });
      }
      // Deleted accounts and revoked invitations cannot retain old ADMIN/world claims.
      if (!dbUser || !discordUserId(dbUser.discordId) ||
          !isRole(dbUser.role) ||
          !(await isWhitelisted(dbUser.discordId))) {
        return null;
      }
      token.id = dbUser.id;
      token.role = dbUser.role;
      token.discordId = dbUser.discordId;
      token.games = dbUser.games;
      token.name = dbUser.username;
      return token;
    },
    async session({ session, token }) {
      if (token && typeof token.id === "string" && discordUserId(token.discordId) && isRole(token.role)) {
        const role = token.role;
        session.user.id = token.id as string;
        session.user.role = role;
        session.user.discordId = token.discordId as string;
        session.user.games = gameAccess(role, token.games as string);
      } else {
        throw new Error("The session identity could not be verified");
      }
      return session;
    },
  },
  session: { strategy: "jwt" },
});
