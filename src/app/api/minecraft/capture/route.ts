import { NextResponse } from "next/server";
import { CaptureError, bearerCapture } from "@/lib/minecraft-profile-capture-store";
import { captureManager, captureResponse, normalizeCapture, preflightCaptureUpload, publishCapture } from "@/lib/minecraft-profile-capture";
import { boundedCaptureBody, withCaptureIngress } from "@/lib/minecraft-profile-capture-ingress";
import { PROFILE_COVER_MAX_BYTES } from "@/lib/minecraft-profile-cover";
import { withGameFileWrite } from "@/lib/operation-response";
export async function POST(request: Request) {
  return captureResponse(async () => {
    const grant = await bearerCapture(request); await captureManager(grant.userId, grant.discordId);
    return withCaptureIngress(grant.id, async signal => {
      await preflightCaptureUpload(request, grant);
      const input = await boundedCaptureBody(request, signal, PROFILE_COVER_MAX_BYTES);
      const output = await normalizeCapture(input);
      if (signal.aborted) throw new CaptureError("Capture normalization timed out", 408, "capture_timeout");
      return withGameFileWrite("minecraft", () => captureResponse(async () => {
        const current = await bearerCapture(request); await preflightCaptureUpload(request, current);
        if (signal.aborted) throw new CaptureError("Capture upload timed out before publication", 408, "capture_timeout");
        return NextResponse.json(await publishCapture(current, input, output), { headers: { "Cache-Control": "private, no-store" } });
      }));
    });
  });
}
