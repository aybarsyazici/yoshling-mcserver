import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gameAccess, hasPermission, serializeGameAccess } from "@/lib/permissions";
import { isGameId } from "@/lib/games";
import { db } from "@/lib/db";

/**
 * Set which worlds a user may see. Admin-only, and it takes effect immediately:
 * the session's world list is re-read from this column on every request rather
 * than baked into the token at sign-in.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(session.user.role, "users.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();
  if (!Array.isArray(body?.games) || !body.games.every(isGameId)) return NextResponse.json({ error: "games must be a list of known worlds" }, { status: 400 });
  const games = serializeGameAccess(body.games);

  const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) return NextResponse.json({ error: "No such user" }, { status: 404 });

  await db.user.update({ where: { id }, data: { games } });

  await db.activity
    .create({
      data: {
        userId: session.user.id,
        action: "set_user_games",
        details: JSON.stringify({ targetUserId: id, games }),
      },
    })
    .catch(() => {});

  const saved = await db.user.findUnique({ where: { id }, select: { id: true, role: true, games: true } });
  if (!saved || saved.games !== games) return NextResponse.json({ error: "The saved world access could not be verified" }, { status: 500 });
  return NextResponse.json({ success: true, games: saved.games, user: { id: saved.id, role: saved.role, games: gameAccess("MEMBER", saved.games) } });
}
