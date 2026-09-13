import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAllStatus, currentControlLock } from "@/lib/game-manager";
import { GAME_LIST } from "@/lib/games";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const games = await getAllStatus();
  const access = session.user.games;

  // Every world's run state is reported, even ones this user can't open: only
  // one server fits on the box, so their Start button stops whatever is running
  // and the UI has to be able to say so. Who is *playing* it is none of their
  // business, so player names are dropped.
  for (const g of GAME_LIST) {
    if (access.includes(g.id)) continue;
    games[g.id] = { ...games[g.id], players: { online: 0, max: 0, players: [] }, detail: undefined };
  }

  let activeGame: string | null = null;
  try {
    const state = await db.gameState.findUnique({ where: { id: "main" } });
    activeGame = state?.activeGame ?? null;
  } catch {}

  // Reconcile intent with reality: whichever is actually online wins.
  const onlineGame =
    GAME_LIST.find((g) => games[g.id].status === "online" || games[g.id].status === "starting")?.id ??
    null;

  return NextResponse.json({
    games,
    activeGame: onlineGame ?? activeGame,
    busy: currentControlLock(),
    access,
  });
}
