import { NextResponse } from "next/server";
import { isGameId } from "@/lib/games";
import { gameGate } from "@/lib/game-gate";
import { getMinecraftTarget } from "@/lib/game-manager";
import { minecraftJoinTarget, type MinecraftJoinTarget } from "@/lib/join-info";

/** Player-safe projection; no settings permission, secrets, DB mirror or lifecycle action. */
export async function GET(request: Request) {
  const game = new URL(request.url).searchParams.get("game");
  if (!isGameId(game)) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  const gate = await gameGate(game);
  if (!gate.ok) return gate.response;

  let target: MinecraftJoinTarget | null = null;
  if (game === "minecraft") {
    try {
      target = minecraftJoinTarget(await getMinecraftTarget());
    } catch {
      // Inspection errors may contain host details. Unknown is sufficient for players.
    }
  }
  return NextResponse.json({
    game,
    targetStatus: target ? "checked" : "unknown",
    target,
    checkedAt: Date.now(),
  }, { headers: { "Cache-Control": "no-store" } });
}
