import { NextResponse } from "next/server";
import { minecraftProfileGate, profileIdentifier } from "@/lib/minecraft-profile-http";
import { captureResponse, captureStatus, cancelCapture } from "@/lib/minecraft-profile-capture";
import { withGameFileWrite } from "@/lib/operation-response";
type Context = { params: Promise<{ id: string; sessionId: string }> };
export async function GET(_request: Request, context: Context) {
  const gate = await minecraftProfileGate(true); if (!gate.ok) return gate.response;
  return captureResponse(async () => { const params = await context.params; return NextResponse.json(await captureStatus(profileIdentifier(params.id), profileIdentifier(params.sessionId), gate.session.user.id), { headers: { "Cache-Control": "private, no-store" } }); });
}
export async function DELETE(_request: Request, context: Context) {
  const gate = await minecraftProfileGate(true); if (!gate.ok) return gate.response;
  return withGameFileWrite("minecraft", () => captureResponse(async () => { const params = await context.params; return NextResponse.json(await cancelCapture(profileIdentifier(params.id), profileIdentifier(params.sessionId), gate.session.user.id), { headers: { "Cache-Control": "private, no-store" } }); }));
}
