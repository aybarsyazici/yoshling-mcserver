import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { db } from "./db";
import { ALL_GAMES, gameAccess } from "./permissions";
import { isWhitelisted } from "./whitelist";

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

      // Match on the @handle or the display name, whichever was whitelisted.
      // Reads the same store the Whitelist page writes — see lib/whitelist.ts.
      const handle = (profile as any).username as string | undefined;
      const displayName = ((profile as any).global_name as string | undefined) ?? user.name;

      if (!(await isWhitelisted([handle, displayName]))) {
        // Say who was turned away: a silent refusal is why a whitelist that
        // looked correct in the UI took so long to explain.
        console.warn(
          `[auth] sign-in refused: not on the whitelist (username=${handle ?? "?"}, display=${displayName ?? "?"})`
        );
        return false;
      }

      const existing = await db.user.findUnique({
        where: { discordId: profile.id },
      });

      if (!existing) {
        // The very first account to sign in owns the box: ADMIN, every world.
        // Everyone after that starts with no role privileges and no worlds —
        // an admin grants access on the Crew page.
        const first = (await db.user.count()) === 0;
        await db.user.create({
          data: {
            discordId: profile.id,
            username: profile.username || user.name || "Unknown",
            avatar: user.image,
            role: first ? "ADMIN" : "MEMBER",
            games: first ? ALL_GAMES.join(",") : "",
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
      // Role and world access are re-read from the DB on every call, not just at
      // sign-in: a JWT is otherwise frozen until the user signs out, so granting
      // or revoking access would not take effect until then.
      let dbUser = null;
      if (profile?.id) {
        dbUser = await db.user.findUnique({ where: { discordId: profile.id } });
      } else if (token.discordId) {
        dbUser = await db.user.findUnique({ where: { discordId: token.discordId as string } });
      } else if (token.id) {
        dbUser = await db.user.findUnique({ where: { id: token.id as string } });
      } else if (token.name) {
        dbUser = await db.user.findFirst({ where: { username: token.name } });
      }

      if (dbUser) {
        token.id = dbUser.id;
        token.role = dbUser.role;
        token.discordId = dbUser.discordId;
        token.games = dbUser.games;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        const role = token.role as "ADMIN" | "MOD" | "MEMBER";
        session.user.id = token.id as string;
        session.user.role = role;
        session.user.discordId = token.discordId as string;
        session.user.games = gameAccess(role, token.games as string);
      }
      return session;
    },
  },
  session: { strategy: "jwt" },
});
