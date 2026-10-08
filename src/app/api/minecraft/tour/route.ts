import { NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { readMinecraftTourState, completeMinecraftTour, validateMinecraftTourCompletion, MinecraftTourError, type MinecraftTourActor } from "@/lib/minecraft-tour-state";

const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof MinecraftTourError ? error.message : "Minecraft tour preference could not be verified" }, { status: error instanceof MinecraftTourError ? error.status : 503, headers });
}
async function actor(request: Request): Promise<MinecraftTourActor | NextResponse> {
  const gate = await gameGate("minecraft");
  if (!gate.ok) { gate.response.headers.set("Cache-Control", headers["Cache-Control"]); return gate.response; }
  const expected = request.headers.get("X-Minecraft-Tour-User");
  if (!expected || !/^[A-Za-z0-9_-]{1,256}$/.test(expected)) throw new MinecraftTourError("The expected tour account is required", 400);
  // This precondition rejects stale tabs; it never chooses a database target.
  if (expected !== gate.session.user.id) throw new MinecraftTourError("The signed-in account changed; reload before using the tour", 409);
  return { userId: gate.session.user.id, discordId: gate.session.user.discordId };
}
async function completionBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024)) throw new MinecraftTourError("Tour completion request is too large", 413);
  const reader = request.body?.getReader(); if (!reader) throw new MinecraftTourError("Expected Minecraft tour completion", 400);
  let expired = false, total = 0; const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) { const result = await reader.read(); if (expired) throw new MinecraftTourError("Tour completion request timed out", 408); if (result.done) break; total += result.value.byteLength; if (total > 1024) throw new MinecraftTourError("Tour completion request is too large", 413); chunks.push(result.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new MinecraftTourError("Expected Minecraft tour completion JSON", 400); }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
export async function GET(request: Request) {
  try { const current = await actor(request); if (current instanceof NextResponse) return current; return NextResponse.json(await readMinecraftTourState(current), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const current = await actor(request); if (current instanceof NextResponse) return current;
    await readMinecraftTourState(current);
    validateMinecraftTourCompletion(await completionBody(request));
    return NextResponse.json(await completeMinecraftTour(current), { headers });
  } catch (error) { return failure(error); }
}
