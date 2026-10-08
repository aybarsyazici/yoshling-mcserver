import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { activateMinecraftProfile, MinecraftProfileActionError } from "@/lib/minecraft-profile-activation";
import type { GameId } from "@/lib/games";

export const maxDuration = 900;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "server.start")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!hasPermission(session.user.role, "server.restart")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return NextResponse.json({ error: "Invalid Minecraft profile ID" }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid profile start request" }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (typeof input.confirmStopPeers !== "boolean" || typeof input.expectedRevision !== "string" || !input.expectedRevision || input.expectedRevision.length > 128 ||
      !Array.isArray(input.confirmedPeers) || input.confirmedPeers.length > 2 || new Set(input.confirmedPeers).size !== input.confirmedPeers.length ||
      input.confirmedPeers.some(game => game !== "7dtd" && game !== "zomboid")) {
    return NextResponse.json({ error: "The current runtime revision and exact reviewed hand-off worlds are required" }, { status: 400 });
  }
  try {
    const result = await activateMinecraftProfile(id, { confirmStopPeers: input.confirmStopPeers,
      confirmedPeers: input.confirmedPeers as GameId[],
      expectedRevision: input.expectedRevision, startedBy: session.user.name, userId: session.user.id });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isConflict(error)) return conflictResponse(error);
    if (error instanceof MinecraftProfileActionError) return NextResponse.json({ error: error.message,
      operationId: error.operationId, ...(error.running ? { conflict: "coresidency", running: error.running } : {}) }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Minecraft profile startup failed" }, { status: 502 });
  }
}
