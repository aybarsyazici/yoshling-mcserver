import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAllStatus, currentControlLock } from "@/lib/game-manager";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const games = await getAllStatus();

  let activeGame: string | null = null;
  try {
    const state = await db.gameState.findUnique({ where: { id: "main" } });
    activeGame = state?.activeGame ?? null;
  } catch {}

  // Reconcile intent with reality: whichever is actually online wins.
  const onlineGame =
    games.minecraft.status === "online" || games.minecraft.status === "starting"
      ? "minecraft"
      : games["7dtd"].status === "online" || games["7dtd"].status === "starting"
      ? "7dtd"
      : null;

  return NextResponse.json({
    games,
    activeGame: onlineGame ?? activeGame,
    busy: currentControlLock(),
  });
}
