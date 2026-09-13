import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { exec } from "child_process";
import { promisify } from "util";
import { RUNTIME } from "@/lib/game-manager";

const execAsync = promisify(exec);

export async function GET(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  const lines = parseInt(new URL(request.url).searchParams.get("lines") || "200");

  try {
    const { stdout } = await execAsync(
      `docker logs --tail ${lines} ${RUNTIME.zomboid.container} 2>&1`,
      { maxBuffer: 4 * 1024 * 1024 }
    );
    return NextResponse.json({ logs: stdout });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to get logs";
    return NextResponse.json({ logs: msg });
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
