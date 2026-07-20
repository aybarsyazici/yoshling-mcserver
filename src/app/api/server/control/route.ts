import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { powerOn, powerOff, restartGame, ControlBusyError } from "@/lib/game-manager";
import { db } from "@/lib/db";

// Legacy Minecraft-only control endpoint. Kept for backward compatibility;
// it now routes through the shared game-manager (with graceful hand-off) and
// keeps the active-game flag in sync so the landing page stays accurate.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await request.json();

  if (!["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const permission = action === "restart" ? "server.restart" : `server.${action}`;
  if (!hasPermission(session.user.role, permission as "server.start")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    switch (action) {
      case "start":
        await powerOn("minecraft");
        await db.gameState.upsert({
          where: { id: "main" },
          update: { activeGame: "minecraft" },
          create: { id: "main", activeGame: "minecraft" },
        });
        break;
      case "stop":
        await powerOff("minecraft");
        await db.gameState.upsert({
          where: { id: "main" },
          update: { activeGame: null },
          create: { id: "main", activeGame: null },
        });
        break;
      case "restart":
        await restartGame("minecraft");
        break;
    }
  } catch (e) {
    if (e instanceof ControlBusyError) {
      return NextResponse.json(
        { error: `Busy: ${e.lock.game} is ${e.lock.action}ing. Try again in a moment.`, busy: e.lock },
        { status: 409 }
      );
    }
    const msg = e instanceof Error ? e.message : "Server control failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await db.activity.create({
    data: {
      userId: session.user.id,
      action: `server_${action}`,
      details: JSON.stringify({ game: "minecraft", action }),
    },
  });

  return NextResponse.json({ success: true });
}
