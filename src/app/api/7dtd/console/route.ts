import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";
import { RUNTIME } from "@/lib/game-manager";

const execAsync = promisify(exec);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lines = parseInt(new URL(request.url).searchParams.get("lines") || "200");

  try {
    const { stdout } = await execAsync(
      `docker logs --tail ${lines} ${RUNTIME["7dtd"].container} 2>&1`
    );
    return NextResponse.json({ logs: stdout });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to get logs";
    return NextResponse.json({ logs: msg });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
