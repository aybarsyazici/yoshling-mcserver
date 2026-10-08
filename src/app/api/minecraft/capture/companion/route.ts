import { NextResponse } from "next/server";
import { minecraftProfileGate } from "@/lib/minecraft-profile-http";
import { captureCompanion } from "@/lib/minecraft-profile-capture-companion";
import { captureResponse } from "@/lib/minecraft-profile-capture";
export async function GET() {
  const gate = await minecraftProfileGate(); if (!gate.ok) return gate.response;
  return captureResponse(async () => NextResponse.json(await captureCompanion(), { headers: { "Cache-Control": "private, no-store" } }));
}
