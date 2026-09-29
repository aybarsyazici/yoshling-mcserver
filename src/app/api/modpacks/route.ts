import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";

/**
 * Every mutating modpack handler needs a capability, not just world access.
 *
 * Six of them — `POST /api/modpacks`, `PUT`+`DELETE /api/modpacks/[id]`,
 * `POST`+`DELETE /api/modpacks/[id]/mods` and `POST /api/modpacks/import` — called
 * `auth()` + `denyGame` and never read `session.user.role`, while every
 * `/api/mods/*` sibling checks `mods.install` / `mods.remove`. So a MEMBER, who is
 * meant to be read-only, could delete the three legacy packs that still need
 * re-importing. Nobody hit it only because all five production accounts are ADMIN.
 *
 * GETs stay open: browsing modpacks is gated by world access by design.
 *
 * (The check is repeated inline in each handler rather than factored out — a
 * route module may only export HTTP method handlers, so a shared helper would have
 * to live in another file, and these are one line each.)
 */

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const modpacks = await db.modpack.findMany({
    include: { mods: true },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(modpacks);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name, description, targetMcVersion, targetLoader } = await request.json();

  if (!name || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Default to current server config if not specified
  let mcVersion = targetMcVersion;
  let loader = targetLoader;

  if (!mcVersion || !loader) {
    const serverConfig = await db.serverConfig.findUnique({ where: { id: "main" } });
    if (!mcVersion) mcVersion = serverConfig?.mcVersion || "1.21.4";
    if (!loader) loader = serverConfig?.modLoader || "fabric";
  }

  const modpack = await db.modpack.create({
    data: {
      name: name.trim(),
      description: description?.trim() || "",
      createdBy: session.user.id,
      targetMcVersion: mcVersion,
      targetLoader: loader,
    },
    include: { mods: true },
  });

  return NextResponse.json(modpack);
}
