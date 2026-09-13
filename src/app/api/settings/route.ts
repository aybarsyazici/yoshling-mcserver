import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";

const execAsync = promisify(exec);
const COMPOSE_FILE = "/opt/yoshling/docker-compose.yml";

/**
 * Rewrite `KEY: value` lines inside ONE compose service block, leaving the rest
 * of the file byte-for-byte alone.
 *
 * This used to regenerate the whole file from a template, which silently dropped
 * every service the template didn't know about — the 7 Days to Die and Project
 * Zomboid containers, and the volume declarations the web container mounts. It
 * also has to be scoped to the service: `VERSION` means the Minecraft version
 * here and the Steam branch two services down.
 */
function patchServiceEnv(
  compose: string,
  service: string,
  updates: Record<string, string>
): { text: string; applied: string[] } {
  const lines = compose.split("\n");
  const applied: string[] = [];

  const startRe = new RegExp(`^(\\s*)${service}:\\s*$`);
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (m) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start < 0) return { text: compose, applied };

  // The block ends at the next non-blank line indented no deeper than the key.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if ((lines[i].match(/^\s*/)?.[0].length ?? 0) <= indent.length) {
      end = i;
      break;
    }
  }

  for (let i = start + 1; i < end; i++) {
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^(\\s*${key}:\\s*)(.*)$`);
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `$1"${value}"`);
      applied.push(key);
    }
  }

  return { text: lines.join("\n"), applied };
}

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

      // Patch only the minecraft service's env in docker-compose.yml
      const current = await readFile(COMPOSE_FILE, "utf-8");
      const { text, applied } = patchServiceEnv(current, "minecraft", {
        TYPE: finalLoader.toUpperCase(),
        VERSION: finalVersion,
        MEMORY: finalMemory,
      });
      if (applied.length === 0) {
        return NextResponse.json({
          success: true,
          warning: "Settings saved, but the minecraft service wasn't found in docker-compose.yml.",
        });
      }
      await writeFile(COMPOSE_FILE, text, "utf-8");

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
