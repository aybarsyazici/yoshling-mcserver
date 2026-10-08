import { NextResponse } from "next/server";
import { bearerCapture } from "@/lib/minecraft-profile-capture-store";
import { captureManager, captureResponse, pairCapture, validateCaptureClient } from "@/lib/minecraft-profile-capture";
import { profileJSON } from "@/lib/minecraft-profile-http";
import { withGameFileWrite } from "@/lib/operation-response";
export async function POST(request: Request) {
  return captureResponse(async () => {
    const grant = await bearerCapture(request); await captureManager(grant.userId, grant.discordId);
    validateCaptureClient(await profileJSON(request));
    return withGameFileWrite("minecraft", () => captureResponse(async () => NextResponse.json(await pairCapture(await bearerCapture(request)), { headers: { "Cache-Control": "private, no-store" } })));
  });
}
