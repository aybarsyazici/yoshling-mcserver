import { NextResponse } from "next/server";
import { getMinecraftProfile, MinecraftProfileError } from "@/lib/minecraft-profile-store";
import { minecraftProfileGate, minecraftProfileResponse, profileIdentifier, profileJSON, profileRevision, rejectProfileKeys } from "@/lib/minecraft-profile-http";
import { readMinecraftProfileOverview, requestMinecraftProfileOverview } from "@/lib/minecraft-profile-overview-queue";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const gate = await minecraftProfileGate(); if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id), profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    return NextResponse.json({ profileId: id, overview: await readMinecraftProfileOverview(profile) }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
export async function POST(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true); if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id), body = await profileJSON(request);
    rejectProfileKeys(body, ["expectedRevision", "expectedOverviewRevision"]);
    if (!(body.expectedOverviewRevision === null || typeof body.expectedOverviewRevision === "string" && /^[a-f0-9]{64}$/.test(body.expectedOverviewRevision))) throw new MinecraftProfileError("The reviewed generated overview revision is required", 400, "overview_revision_required");
    const result = await requestMinecraftProfileOverview(id, { expectedRevision: profileRevision(body.expectedRevision), expectedOverviewRevision: body.expectedOverviewRevision,
      actor: { userId: gate.session.user.id, name: gate.session.user.name ?? null } });
    return NextResponse.json(result, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  });
}
