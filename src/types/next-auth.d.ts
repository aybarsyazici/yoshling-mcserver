import "next-auth";
import type { GameId } from "@/lib/games";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      image?: string;
      role: "ADMIN" | "MOD" | "MEMBER";
      discordId: string;
      /** Worlds this user may see, already resolved (ADMIN = all of them). */
      games: GameId[];
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "ADMIN" | "MOD" | "MEMBER";
    discordId: string;
    /** Raw CSV from the user row; resolved into `session.user.games`. */
    games: string;
  }
}
