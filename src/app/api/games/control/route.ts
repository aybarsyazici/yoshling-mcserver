import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { powerOn, powerOff, restartGame, ControlBusyError } from "@/lib/game-manager";
import { isGameId, GAMES } from "@/lib/games";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { game, action } = await request.json();

  if (!isGameId(game)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  }
  // Powering a world on stops the others, so this is gated on the world being
  // started — not on the ones being stopped.
  const denied = denyGame(session, game);
  if (denied) return denied;

  if (!["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const permission = action === "restart" ? "server.restart" : `server.${action}`;
  if (!hasPermission(session.user.role, permission as "server.start")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let steps: { step: string; game?: string }[] = [];
  try {
    switch (action) {
      case "start":
        steps = await powerOn(game);
        await db.gameState.upsert({
          where: { id: "main" },
          update: { activeGame: game },
          create: { id: "main", activeGame: game },
        });
        break;
      case "stop":
        await powerOff(game);
        await db.gameState.upsert({
          where: { id: "main" },
          update: { activeGame: null },
          create: { id: "main", activeGame: null },
        });
        break;
      case "restart":
        await restartGame(game);
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

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: `server_${action}`,
        details: JSON.stringify({ game, action, gameName: GAMES[game].name }),
      },
    });
  } catch {}

  return NextResponse.json({ success: true, steps });
}
