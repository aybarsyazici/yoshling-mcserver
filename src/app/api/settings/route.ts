import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = await db.serverConfig.findUnique({ where: { id: "main" } });
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { mcVersion, modLoader, maxMemory } = body;

  await db.serverConfig.upsert({
    where: { id: "main" },
    update: {
      ...(mcVersion && { mcVersion }),
      ...(modLoader && { modLoader }),
      ...(maxMemory && { maxMemory }),
    },
    create: {
      id: "main",
      mcVersion: mcVersion || "1.21.4",
      modLoader: modLoader || "fabric",
      maxMemory: maxMemory || "4G",
      rconPassword: process.env.RCON_PASSWORD || "changeme",
    },
  });

  return NextResponse.json({ success: true });
}
