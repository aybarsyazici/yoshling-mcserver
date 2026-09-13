import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { COMPOSE_FILE, patchServiceEnv, readCompose, writeCompose } from "@/lib/compose";
import { COMPOSE_PROJECT } from "@/lib/game-manager";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Memory is NOT set here — /api/games/memory owns it, because applying a heap
// change means recreating the container, not just rewriting this file.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const config = await db.serverConfig.findUnique({ where: { id: "main" } });
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { mcVersion, modLoader } = body;

  const oldConfig = await db.serverConfig.findUnique({ where: { id: "main" } });

  await db.serverConfig.upsert({
    where: { id: "main" },
    update: {
      ...(mcVersion && { mcVersion }),
      ...(modLoader && { modLoader }),
    },
    create: {
      id: "main",
      mcVersion: mcVersion || "1.21.4",
      modLoader: modLoader || "fabric",
      maxMemory: "4G",
      rconPassword: process.env.RCON_PASSWORD || "changeme",
    },
  });

  const versionChanged = mcVersion && mcVersion !== oldConfig?.mcVersion;
  const loaderChanged = modLoader && modLoader !== oldConfig?.modLoader;

  if (versionChanged || loaderChanged) {
    try {
      const finalVersion = mcVersion || oldConfig?.mcVersion || "1.21.4";
      const finalLoader = modLoader || oldConfig?.modLoader || "fabric";

      // Patch only the minecraft service's env in docker-compose.yml
      const { text, applied } = patchServiceEnv(await readCompose(), "minecraft", {
        TYPE: finalLoader.toUpperCase(),
        VERSION: finalVersion,
      });
      if (applied.length === 0) {
        return NextResponse.json({
          success: true,
          warning: "Settings saved, but the minecraft service wasn't found in docker-compose.yml.",
        });
      }
      await writeCompose(text);

      // Recreate only the minecraft container with new config
      await execAsync(
        `cd ${path.dirname(COMPOSE_FILE)} && docker compose -p ${COMPOSE_PROJECT} up -d --no-deps --force-recreate minecraft`
      );
    } catch (e: any) {
      return NextResponse.json({
        success: true,
        warning: `Settings saved but failed to restart server: ${e.message}`,
      });
    }
  }

  return NextResponse.json({ success: true });
}
