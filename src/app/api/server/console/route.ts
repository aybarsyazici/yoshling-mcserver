import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { tailContainerLog } from "@/lib/game-manager";

/**
 * "The server isn't running" is the most ordinary reason a console command fails, and
 * it used to surface as `500 {"error":"RCON error: getaddrinfo ENOTFOUND minecraft"}` —
 * a raw DNS error for an expected state, with no hint that the fix is "press Power on".
 * The GET above already has a comment about not rendering docker's error text as if the
 * game had said it; the POST never got the same treatment.
 *
 * Matched on both `code` and the message, because `src/lib/rcon.ts` raises its own
 * `new Error("timeout")` with no code at all, while the socket errors carry one.
 */
function isUnreachable(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    (typeof code === "string" && ["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT"].includes(code)) ||
    /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(msg)
  );
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  // Left unvalidated on purpose: `tailContainerLog` clamps to 1..MAX_LOG_LINES (1000)
  // and substitutes DEFAULT_LOG_LINES for anything non-finite, and its comment says
  // that lives in one place "so the three console routes cannot drift apart again".
  // A route-level clamp was written here and removed after measuring: `?lines=` of
  // `abc`, `0`, `-5`, `99999`, `250` already reach docker as `--tail` 200, 1, 1, 1000,
  // 250 respectively, so a second limit would only let this file claim a maximum
  // (2000) that the real cap (1000) contradicts.
  const lines = parseInt(searchParams.get("lines") || "100");

  try {
    return NextResponse.json({ logs: await tailContainerLog("minecraft", lines) });
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
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

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
    // 503, not 500: nothing is broken, the server is simply not there to ask.
    if (isUnreachable(e)) {
      return NextResponse.json(
        {
          error:
            "The Minecraft server isn't reachable — it may be powered off. " +
            "Start it, then try again.",
        },
        { status: 503 }
      );
    }
    // Anything else keeps the raw message: an RCON error the game itself produced is
    // information, and hiding it behind a friendly sentence is how a real fault becomes
    // invisible.
    return NextResponse.json(
      { error: "RCON error: " + (e.message || "connection failed") },
      { status: 500 }
    );
  }
}
