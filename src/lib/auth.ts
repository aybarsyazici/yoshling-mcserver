import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { db } from "./db";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      if (!profile?.id) return false;

      const username = ((profile as any).username || user.name || "").toLowerCase();
      const allowedUsers = (process.env.ALLOWED_DISCORD_USERS || "")
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);

      if (allowedUsers.length > 0 && !allowedUsers.includes(username)) {
        return false;
      }

      const existing = await db.user.findUnique({
        where: { discordId: profile.id },
      });

      if (!existing) {
        await db.user.create({
          data: {
            discordId: profile.id,
            username: profile.username || user.name || "Unknown",
            avatar: user.image,
            role: "ADMIN",
          },
        });
      } else {
        await db.user.update({
          where: { discordId: profile.id },
          data: {
            username: profile.username || user.name || existing.username,
            avatar: user.image || existing.avatar,
          },
        });
      }

      return true;
    },
    async jwt({ token, profile }) {
      if (profile?.id) {
        const dbUser = await db.user.findUnique({
          where: { discordId: profile.id },
        });
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.discordId = dbUser.discordId;
        }
      } else if (!token.id && token.name) {
        const dbUser = await db.user.findFirst({
          where: { username: token.name },
        });
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.discordId = dbUser.discordId;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as any;
        session.user.discordId = token.discordId as string;
      }
      return session;
    },
  },
  session: { strategy: "jwt" },
});
