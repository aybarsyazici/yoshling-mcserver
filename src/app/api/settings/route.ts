import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const MC_CONTAINER = "yoshling-mc";

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

  const oldConfig = await db.serverConfig.findUnique({ where: { id: "main" } });

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

  // If version, loader, or memory changed, recreate the MC container
  const versionChanged = mcVersion && mcVersion !== oldConfig?.mcVersion;
  const loaderChanged = modLoader && modLoader !== oldConfig?.modLoader;
  const memoryChanged = maxMemory && maxMemory !== oldConfig?.maxMemory;

  if (versionChanged || loaderChanged || memoryChanged) {
    try {
      const type = (modLoader || oldConfig?.modLoader || "fabric").toUpperCase();
      const version = mcVersion || oldConfig?.mcVersion || "1.21.4";
      const memory = maxMemory || oldConfig?.maxMemory || "4G";

      // Stop and remove old container, start new one with updated env
      await execAsync(`docker stop ${MC_CONTAINER} 2>/dev/null || true`);
      await execAsync(`docker rm ${MC_CONTAINER} 2>/dev/null || true`);
      await execAsync(
        `docker run -d --name ${MC_CONTAINER} ` +
        `--network yoshling_default ` +
        `-p 25565:25565 ` +
        `-e EULA=TRUE ` +
        `-e "TYPE=${type}" ` +
        `-e "VERSION=${version}" ` +
        `-e "MEMORY=${memory}" ` +
        `-e "ENABLE_RCON=true" ` +
        `-e "RCON_PORT=25575" ` +
        `-e "RCON_PASSWORD=${process.env.RCON_PASSWORD || "changeme"}" ` +
        `-v yoshling_mc-data:/data ` +
        `--restart unless-stopped ` +
        `itzg/minecraft-server`
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
