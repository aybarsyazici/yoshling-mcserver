import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { operationsPayload } from "@/lib/operations";

/**
 * Everything running on this box, and what just finished.
 *
 * Separate from `/api/games/status` on purpose. That endpoint is expensive — per
 * game a `docker inspect` for state, another for `StartedAt`, and while booting a
 * `docker logs | awk` pass plus a `lastLogLine` — so it stays on a 4s poll. This
 * one is an in-memory read plus the boot projection (itself coalesced behind
 * `cachedAllStatus`), which is what makes a 1.5s poll affordable: the cheap thing
 * gets polled fast and the expensive thing stays slow.
 *
 * Read-only, deliberately. There is no `DELETE /api/operations/:id`, because a
 * clear button that removed a *live* record would let a second operation start on
 * top of a running one — the cure would be worse than the stuck banner it fixed.
 * Expiry is automatic (90s without a heartbeat) and dismissal is per-viewer in
 * `sessionStorage`, where it cannot affect anyone else or the server.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Redaction happens here, not in the hook: a live step reads "Downloading
  // Secretz42" and the facts name mods, so filtering client-side would ship them to
  // the browser anyway. Same reasoning as stripping player names in /api/games/status.
  return NextResponse.json(await operationsPayload(session.user.games));
}
