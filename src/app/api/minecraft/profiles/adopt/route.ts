import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { adoptLegacyMinecraftProfile } from "@/lib/minecraft-profile-adoption";
import { MinecraftProfileActionError } from "@/lib/minecraft-profile-activation";
import { MINECRAFT_JAVA_VARIANTS, type MinecraftJavaVariant } from "@/lib/minecraft-profile-types";

export const maxDuration = 900;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "settings.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!hasPermission(session.user.role, "server.stop")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid adoption request" }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name) ||
      (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000)) ||
      (input.confirmStopCurrent !== undefined && typeof input.confirmStopCurrent !== "boolean") ||
      (input.loaderVersion !== undefined && (typeof input.loaderVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/.test(input.loaderVersion))) ||
      (input.javaVariant !== undefined && !(MINECRAFT_JAVA_VARIANTS as readonly unknown[]).includes(input.javaVariant))) {
    return NextResponse.json({ error: "A valid name, description and explicit shutdown choice are required" }, { status: 400 });
  }
  try {
    const result = await adoptLegacyMinecraftProfile({ name: input.name.trim(), description: input.description as string | undefined,
      confirmStopCurrent: input.confirmStopCurrent as boolean | undefined, loaderVersion: input.loaderVersion as string | undefined,
      javaVariant: input.javaVariant as MinecraftJavaVariant | undefined }, { userId: session.user.id, name: session.user.name });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isConflict(error)) return conflictResponse(error);
    if (error instanceof MinecraftProfileActionError) return NextResponse.json({ error: error.message, operationId: error.operationId }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Minecraft adoption failed" }, { status: 502 });
  }
}
