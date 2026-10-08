import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { withMinecraftProfileRead } from "@/lib/minecraft-active-profile";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  return withMinecraftProfileRead(async context => NextResponse.json({ profileId: context.profileId, revision: context.revision }));
}
