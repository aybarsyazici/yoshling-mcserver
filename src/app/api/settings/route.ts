import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile } from "fs/promises";

const execAsync = promisify(exec);
const COMPOSE_FILE = "/opt/yoshling/docker-compose.yml";

function generateCompose(version: string, type: string, memory: string): string {
  return `services:
  minecraft:
    image: itzg/minecraft-server
    container_name: yoshling-mc
    ports:
      - "25565:25565"
    environment:
      EULA: "TRUE"
      TYPE: "${type.toUpperCase()}"
      VERSION: "${version}"
      MEMORY: "${memory}"
      RCON_PASSWORD: "\${RCON_PASSWORD}"
      ENABLE_RCON: "true"
      RCON_PORT: 25575
    volumes:
      - mc-data:/data
    restart: unless-stopped
    tty: true
    stdin_open: true

  web:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      NODE_ENV: production
      DOCKER_HOST: unix:///var/run/docker.sock
    volumes:
      - mc-data:/minecraft
      - web-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - minecraft
    restart: unless-stopped

volumes:
  mc-data:
  web-data:
`;
}

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

  const versionChanged = mcVersion && mcVersion !== oldConfig?.mcVersion;
  const loaderChanged = modLoader && modLoader !== oldConfig?.modLoader;
  const memoryChanged = maxMemory && maxMemory !== oldConfig?.maxMemory;

  if (versionChanged || loaderChanged || memoryChanged) {
    try {
      const finalVersion = mcVersion || oldConfig?.mcVersion || "1.21.4";
      const finalLoader = modLoader || oldConfig?.modLoader || "fabric";
      const finalMemory = maxMemory || oldConfig?.maxMemory || "4G";

      // Update docker-compose.yml with new values
      const composeContent = generateCompose(finalVersion, finalLoader, finalMemory);
      await writeFile(COMPOSE_FILE, composeContent, "utf-8");

      // Recreate only the minecraft container with new config
      await execAsync(
        `cd /opt/yoshling && docker compose up -d --force-recreate minecraft`
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
