import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { tailContainerLog } from "@/lib/game-manager";

export async function GET(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  const lines = parseInt(new URL(request.url).searchParams.get("lines") || "200");

  try {
    return NextResponse.json({ logs: await tailContainerLog("zomboid", lines) });
  } catch (e) {
    // Not 200 with the message as `logs`: docker's own error text then rendered in
    // the console pane, in the game's accent colour, as if the server had said it.
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: `Failed to read the log: ${msg}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const { role } = gate.session.user;
  if (role !== "ADMIN" && role !== "MOD") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { command } = await request.json();
  if (!command || typeof command !== "string") {
    return NextResponse.json({ error: "Command required" }, { status: 400 });
  }

  try {
    const { pzConsole } = await import("@/lib/zomboid");
    const response = await pzConsole(command);
    return NextResponse.json({ response });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "connection failed";
    return NextResponse.json({ error: "RCON error: " + msg }, { status: 500 });
  }
}
