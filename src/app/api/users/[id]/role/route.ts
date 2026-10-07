import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gameAccess, hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasPermission(session.user.role, "users.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const { role } = await request.json();

  if (!["ADMIN", "MOD", "MEMBER"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  await db.user.update({
    where: { id },
    data: { role },
  });

  const saved = await db.user.findUnique({ where: { id }, select: { id: true, role: true, games: true } });
  if (!saved || saved.role !== role) return NextResponse.json({ error: "The saved role could not be verified" }, { status: 500 });
  return NextResponse.json({ success: true, user: { id: saved.id, role: saved.role, games: gameAccess("MEMBER", saved.games) } });
}
