import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getServerStatus } from "@/lib/server-manager";
import { getPlayerList } from "@/lib/rcon";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let status: { status: string; uptime?: string } = { status: "offline" };
  try {
    status = await getServerStatus();
  } catch {}

  let config = null;
  try {
    config = await db.serverConfig.findUnique({ where: { id: "main" } });
  } catch {}

  let players = { online: 0, max: 20, players: [] as string[] };
  if (status.status === "online") {
    try {
      players = await getPlayerList();
    } catch {}
  }

  return NextResponse.json({
    ...status,
    players,
    config: config
      ? {
          mcVersion: config.mcVersion,
          modLoader: config.modLoader,
          maxMemory: config.maxMemory,
        }
      : { mcVersion: "1.21.4", modLoader: "fabric", maxMemory: "4G" },
  });
}
