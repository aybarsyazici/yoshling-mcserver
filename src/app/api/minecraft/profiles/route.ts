import { NextResponse } from "next/server";
import { createPreparedMinecraftProfile } from "@/lib/minecraft-profile-prepare";
import { getMinecraftProfileRuntimeStatus } from "@/lib/minecraft-profile-activation";
import { listMinecraftProfiles, requiresMinecraftAdoption } from "@/lib/minecraft-profile-store";
import { createMinecraftProfileInput, minecraftProfileCapabilities, minecraftProfileDTO, minecraftProfileGate, minecraftProfileResponse, profileJSON } from "@/lib/minecraft-profile-http";

export async function GET() {
  const gate = await minecraftProfileGate();
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const profiles = await listMinecraftProfiles();
    return NextResponse.json({ profiles: await Promise.all(profiles.map(minecraftProfileDTO)), runtime: await getMinecraftProfileRuntimeStatus(), requiresAdoption: await requiresMinecraftAdoption(), capabilities: minecraftProfileCapabilities(gate.session.user.role) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(request: Request) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const result = await createPreparedMinecraftProfile(createMinecraftProfileInput(await profileJSON(request)), { userId: gate.session.user.id, name: gate.session.user.name });
    return NextResponse.json(result);
  });
}
