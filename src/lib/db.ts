import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createDatabase(): PrismaClient {
  const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" });
  return new PrismaClient({ adapter });
}

// Next module graphs and development reloads share the same typed connection.
export const db = (globalForPrisma.prisma ??= createDatabase());
