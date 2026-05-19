import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const MC_CONTAINER = "yoshling-mc";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const lines = parseInt(searchParams.get("lines") || "100");

  try {
    const { stdout } = await execAsync(
      `docker logs --tail ${lines} ${MC_CONTAINER} 2>&1`
    );
    return NextResponse.json({ logs: stdout });
  } catch (e: any) {
    return NextResponse.json({ logs: e.message || "Failed to get logs" });
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
    const { sendCommand } = await import("@/lib/rcon");
    const response = await sendCommand(command);
    return NextResponse.json({ response });
  } catch (e: any) {
    return NextResponse.json(
      { error: "RCON error: " + (e.message || "connection failed") },
      { status: 500 }
    );
  }
}
