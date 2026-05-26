import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installMod, removeMod } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile } from "fs/promises";

const execAsync = promisify(exec);
const MC_CONTAINER = "yoshling-mc";
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

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { modpackId, mcVersion, modLoader } = await request.json();

  if (!modpackId) {
    return NextResponse.json({ error: "modpackId required" }, { status: 400 });
  }

  const modpack = await db.modpack.findUnique({
    where: { id: modpackId },
    include: { mods: true },
  });

  if (!modpack) {
    return NextResponse.json({ error: "Modpack not found" }, { status: 404 });
  }

  let serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  if (!serverConfig) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Use modpack's target version/loader, or explicit overrides, or current config
  const finalMcVersion = mcVersion || (modpack as any).targetMcVersion || serverConfig.mcVersion;
  const finalLoader = modLoader || (modpack as any).targetLoader || serverConfig.modLoader;

  if (finalMcVersion !== serverConfig.mcVersion || finalLoader !== serverConfig.modLoader) {
    await db.serverConfig.update({
      where: { id: "main" },
      data: { mcVersion: finalMcVersion, modLoader: finalLoader },
    });

    // Update compose file and recreate MC container
    try {
      const memory = serverConfig.maxMemory || "4G";
      const composeContent = generateCompose(finalMcVersion, finalLoader, memory);
      await writeFile(COMPOSE_FILE, composeContent, "utf-8");
      await execAsync(`cd /opt/yoshling && docker compose up -d --force-recreate minecraft`);
    } catch {}

    serverConfig = { ...serverConfig, mcVersion: finalMcVersion, modLoader: finalLoader };
  }

  // Remove all currently installed mods
  const installedMods = await db.installedMod.findMany();
  for (const mod of installedMods) {
    try {
      await removeMod(mod.id, session.user.id);
    } catch {}
  }

  // Install modpack mods
  let installed = 0;
  const errors: string[] = [];

  for (const mod of modpack.mods) {
    try {
      if ((mod as any).downloadUrl) {
        // Direct download (e.g. Technic/Solder)
        const { writeFile } = await import("fs/promises");
        const path = await import("path");
        const { getModsDir } = await import("@/lib/server-manager");

        const response = await fetch((mod as any).downloadUrl);
        if (!response.ok) {
          errors.push(`${mod.name}: download failed`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const fileName = `${mod.slug}.jar`;
        await writeFile(path.join(getModsDir(), fileName), buffer);

        await db.installedMod.create({
          data: {
            modrinthId: mod.modrinthId || mod.slug,
            slug: mod.slug,
            name: mod.name,
            version: "technic",
            fileName,
            mcVersion: serverConfig.mcVersion,
            loader: serverConfig.modLoader,
            installedBy: session.user.id,
          },
        });
        installed++;
      } else if (mod.modrinthId) {
        // Modrinth-based mod
        const versions = await getProjectVersions(mod.modrinthId, {
          loaders: [serverConfig.modLoader],
          game_versions: [serverConfig.mcVersion],
        });

        const version = mod.versionId
          ? versions.find((v: any) => v.id === mod.versionId)
          : versions[0];

        if (!version) {
          errors.push(`${mod.name}: no compatible version`);
          continue;
        }

        await installMod({
          modrinthId: mod.modrinthId,
          slug: mod.slug,
          name: mod.name,
          version,
          userId: session.user.id,
        });
        installed++;
      } else {
        errors.push(`${mod.name}: no download source`);
      }
    } catch (e: any) {
      errors.push(`${mod.name}: ${e.message || "failed"}`);
    }
  }

  return NextResponse.json({
    success: true,
    installed,
    total: modpack.mods.length,
    errors,
  });
}
