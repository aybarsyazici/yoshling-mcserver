import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { getMemoryState, isMemoryRangeError, setMemory } from "@/lib/game-manager";
import { hasPermission } from "@/lib/permissions";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { isGameId, GAMES } from "@/lib/games";
import { db } from "@/lib/db";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const game = new URL(request.url).searchParams.get("game");
  if (!isGameId(game)) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  const denied = denyGame(session, game);
  if (denied) return denied;

  return NextResponse.json(await getMemoryState(game));
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { game, gb } = await request.json();
  if (!isGameId(game)) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  const denied = denyGame(session, game);
  if (denied) return denied;
  // The memory card lives on each game's Settings page and this is what its Apply
  // button calls, so `settings.edit` is the capability that matches. It used to
  // compare `role !== "ADMIN"` by hand, which withheld it from a MOD who could
  // already edit every other setting on the same page — drift from the documented
  // model (MOD equals ADMIN, scoped to its worlds), not a policy.
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const state = await setMemory(game, Number(gb), session.user.name);
    await db.activity
      .create({
        data: {
          userId: session.user.id,
          action: "set_memory",
          details: JSON.stringify({ game, gb: Number(gb), gameName: GAMES[game].name }),
        },
      })
      .catch(() => {});
    return NextResponse.json(state);
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    // 400, not 500: an out-of-range heap or one under the service's `-Xms` is the server
    // working correctly and declining, and nothing was changed. The message reached the
    // user either way — the card toasts `data.error` — but a 500 tells every log and
    // monitor that the dashboard broke.
    if (isMemoryRangeError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't change the memory setting" },
      { status: 500 }
    );
  }
}
