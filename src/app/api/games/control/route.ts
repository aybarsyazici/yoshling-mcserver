import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { powerOn, powerOff, restartGame } from "@/lib/game-manager";
import { conflictResponse, isConflict } from "@/lib/operation-response";
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
  /**
   * Whether anything on the box actually changed.
   *
   * A stop of a world that is already down changes nothing, and the Activity row is the
   * *durable* half of this feature — the registry forgets in 6 hours, `/activity` does
   * not. Measured on production 2026-09-29: two no-op stops wrote permanent `server_stop`
   * rows for two containers that had exited minutes and hours earlier, and `docker events`
   * over that window is empty. A log of things that did not happen is worse than no log.
   */
  let changed = true;
  try {
    switch (action) {
      case "start":
        steps = await powerOn(game, session.user.name);
        // No steps means the world was already running and answering — nothing happened,
        // so nothing goes in the durable log.
        changed = steps.length > 0;
        await db.gameState.upsert({
          where: { id: "main" },
          update: { activeGame: game },
          create: { id: "main", activeGame: game },
        });
        break;
      case "stop":
        changed = await powerOff(game, session.user.name);
        // Only clear the active-game flag if this stop is what emptied the box. Nulling
        // it for a world that was already down would wrongly claim the world that IS
        // running has gone away.
        if (changed) {
          await db.gameState.upsert({
            where: { id: "main" },
            update: { activeGame: null },
            create: { id: "main", activeGame: null },
          });
        }
        break;
      case "restart":
        await restartGame(game, session.user.name);
        break;
    }
  } catch (e) {
    // Widened from `ControlBusyError` to every conflict: a file-lane refusal (two
    // backups of the same world) is not a power-lock conflict and used to fall through
    // to a 500 with a message nobody could act on.
    if (isConflict(e)) return conflictResponse(e);
    const msg = e instanceof Error ? e.message : "Server control failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (changed) {
    try {
      await db.activity.create({
        data: {
          userId: session.user.id,
          action: `server_${action}`,
          details: JSON.stringify({ game, action, gameName: GAMES[game].name }),
        },
      });
    } catch {}
  }

  return NextResponse.json({ success: true, changed, steps });
}
