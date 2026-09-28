import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { tailContainerLog } from "@/lib/game-manager";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;

  const lines = parseInt(new URL(request.url).searchParams.get("lines") || "200");

  try {
    return NextResponse.json({ logs: await tailContainerLog("7dtd", lines) });
  } catch (e) {
    // Not 200 with the message as `logs`: docker's own error text then rendered in
    // the console pane, in the game's accent colour, as if the server had said it.
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: `Failed to read the log: ${msg}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (session.user.role !== "ADMIN" && session.user.role !== "MOD") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { command } = await request.json();
  if (!command || typeof command !== "string") {
    return NextResponse.json({ error: "Command required" }, { status: 400 });
  }

  try {
    const { sdtdConsole } = await import("@/lib/telnet");
    const response = await sdtdConsole(command);
    return NextResponse.json({ response });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "connection failed";
    return NextResponse.json({ error: "Telnet error: " + msg }, { status: 500 });
  }
}
