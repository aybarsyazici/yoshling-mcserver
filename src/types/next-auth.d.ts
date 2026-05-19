import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      image?: string;
      role: "ADMIN" | "MOD" | "MEMBER";
      discordId: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "ADMIN" | "MOD" | "MEMBER";
    discordId: string;
  }
}
