import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { startServer, stopServer, restartServer } from "@/lib/server-manager";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await request.json();

  if (!["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const permission = action === "restart" ? "server.restart" : `server.${action}`;
  if (!hasPermission(session.user.role, permission as any)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  switch (action) {
    case "start":
      await startServer();
      break;
    case "stop":
      await stopServer();
      break;
    case "restart":
      await restartServer();
      break;
  }

  await db.activity.create({
    data: {
      userId: session.user.id,
      action: `server_${action}`,
      details: JSON.stringify({ action }),
    },
  });

  return NextResponse.json({ success: true });
}
