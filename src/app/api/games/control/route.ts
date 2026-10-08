import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { powerOn, powerOff, restartGame } from "@/lib/game-manager";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { isGameId, GAMES } from "@/lib/games";
import { db } from "@/lib/db";
import { CoResidencyError } from "@/lib/coresidency";
import { requireMinecraftProfileContext, assertMinecraftProfileCurrent, MinecraftActiveProfileError } from "@/lib/minecraft-active-profile";

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

  // Three literal gates rather than one computed key.
  //
  // This was `hasPermission(role, (action === "restart" ? "server.restart" :
  // `server.${action}`) as "server.start")` — which works, but hides the key from any
  // static reader: the only literal in it was `"server.start"`, in a cast that also
  // claimed the wrong type for the other two actions. The permissions suite has a guard
  // requiring every capability to appear as a negated `hasPermission(…, "key")` with a 403,
  // added because keeping the call and deleting the `if` left a secret leak looking
  // covered — and a computed key is invisible to it. Repetition is the cheaper half of
  // that trade.
  if (action === "start" && !hasPermission(session.user.role, "server.start")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (action === "stop" && !hasPermission(session.user.role, "server.stop")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (action === "restart" && !hasPermission(session.user.role, "server.restart")) {
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
    const context = game === "minecraft" && action !== "stop" ? await requireMinecraftProfileContext(request) : null;
    if (context?.profileId && action === "start") return NextResponse.json({ error: "Select a Minecraft profile in the start picker.", profileId: context.profileId }, { status: 409 });
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
        await restartGame(game, session.user.name, context ? () => assertMinecraftProfileCurrent(context) : undefined);
        break;
    }
  } catch (e) {
    // Widened from `ControlBusyError` to every conflict: a file-lane refusal (two
    // backups of the same world) is not a power-lock conflict and used to fall through
    // to a 500 with a message nobody could act on.
    if (isConflict(e)) return conflictResponse(e);
    if (e instanceof MinecraftActiveProfileError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof CoResidencyError) {
      return NextResponse.json({ error: e.message, conflict: "coresidency", running: e.running }, { status: 409 });
    }
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
      /**
       * A hand-off stops other worlds, and until now nothing durable said so.
       *
       * Measured on production 2026-09-29: six hand-offs stopped six worlds and the
       * Activity table contains **not one** `server_stop` row across that window, because
       * this route only ever wrote a row for the world that was *requested*. The ledger
       * forgets in minutes, so "when did 7 Days to Die go down, and who stopped it?" was
       * unanswerable shortly afterwards. `powerOn` already returns the evicted worlds as
       * `{step:"stop", game}`, so the data was sitting at the call site.
       *
       * Still gated on `changed`: a no-op start returns no steps, so this writes nothing.
       */
      if (action === "start") {
        for (const s of steps) {
          if (s.step !== "stop" || !s.game || s.game === game) continue;
          const stopped = s.game;
          await db.activity.create({
            data: {
              userId: session.user.id,
              action: "server_stop",
              details: JSON.stringify({
                game: stopped,
                action: "stop",
                gameName: isGameId(stopped) ? GAMES[stopped].name : stopped,
                handoffFor: game,
              }),
            },
          });
        }
      }
    } catch {}
  }

  return NextResponse.json({ success: true, changed, steps });
}
