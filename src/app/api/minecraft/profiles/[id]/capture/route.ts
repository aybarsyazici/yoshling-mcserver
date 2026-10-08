import { NextResponse } from "next/server";
import { minecraftProfileGate, profileIdentifier, profileJSON, profileRevision, rejectProfileKeys } from "@/lib/minecraft-profile-http";
import { captureResponse, mintCapture } from "@/lib/minecraft-profile-capture";
import { withGameFileWrite } from "@/lib/operation-response";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await minecraftProfileGate(true); if (!gate.ok) return gate.response;
  return captureResponse(async () => {
    const id = profileIdentifier((await context.params).id), body = await profileJSON(request);
    rejectProfileKeys(body, ["expectedRevision", "replaceExisting"]);
    if (typeof body.replaceExisting !== "boolean") return NextResponse.json({ error: "Explicit screenshot replacement consent is required" }, { status: 400 });
    const revision = profileRevision(body.expectedRevision);
    return withGameFileWrite("minecraft", () => captureResponse(async () => NextResponse.json(await mintCapture(id, gate.session.user.id, revision, body.replaceExisting as boolean), { headers: { "Cache-Control": "private, no-store" } })));
  });
}
