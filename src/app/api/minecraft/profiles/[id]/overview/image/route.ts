import { NextResponse } from "next/server";
import { getMinecraftProfile, MinecraftProfileError } from "@/lib/minecraft-profile-store";
import { minecraftProfileGate, minecraftProfileResponse, profileIdentifier } from "@/lib/minecraft-profile-http";
import { readMinecraftProfileOverviewImage } from "@/lib/minecraft-profile-overview-queue";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const gate = await minecraftProfileGate(); if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id), profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    const revision = new URL(request.url).searchParams.get("revision") ?? "";
    return new NextResponse(new Uint8Array(await readMinecraftProfileOverviewImage(profile, revision)), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  });
}
