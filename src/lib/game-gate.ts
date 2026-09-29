import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { canAccessGame } from "@/lib/permissions";
import type { GameId } from "@/lib/games";

/**
 * Session + per-world gate for API routes. Every route that touches one game's
 * containers, files or config starts with this, so world access is enforced on
 * the server and not just hidden in the UI.
 *
 *   const gate = await gameGate("zomboid");
 *   if (!gate.ok) return gate.response;
 *   // gate.session is authenticated and allowed to see this world
 */
export type GameGate =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export async function gameGate(game: GameId): Promise<GameGate> {
  const session = await auth();
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!canAccessGame(session.user.role, session.user.games, game)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No access to this server" }, { status: 403 }),
    };
  }
  return { ok: true, session };
}

/**
 * Drop-in for routes that already resolved a session: returns the 403 to send
 * back, or null when the user may see this world.
 *
 *   const denied = denyGame(session, "minecraft");
 *   if (denied) return denied;
 */
export function denyGame(session: Session | null, game: GameId): NextResponse | null {
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canAccessGame(session.user.role, session.user.games, game)) {
    return NextResponse.json({ error: "No access to this server" }, { status: 403 });
  }
  return null;
}

// `gameGateFor(game: unknown)` used to live here — gameGate plus an `isGameId`
// check, for routes that take the world as a request parameter. It never had a
// caller: `/api/games/{control,stats,memory}` each call `isGameId` themselves and
// then pass the narrowed `GameId` to `denyGame`, which is what lets the compiler
// check the rest of the handler. An untaken shortcut that launders `unknown` into a
// `GameId` is worth more gone than kept.
