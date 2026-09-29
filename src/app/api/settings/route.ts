import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { applyServiceEnv } from "@/lib/game-manager";
import { conflictResponse, isConflict } from "@/lib/operation-response";

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
  if (!config) return NextResponse.json(null);

  // An explicit projection, never the whole row.
  //
  // This used to be `NextResponse.json(config)`, and `ServerConfig` carries
  // `rconPassword`. Verified on the box: the value this returned was byte-identical
  // to `password=` in the Minecraft container's `/minecraft/.rcon-cli.env` — so the
  // live RCON password went, in cleartext, into the page of anyone with Minecraft
  // access. That is the exact secret `/api/server/properties` keeps a `LOCKED` set
  // to hide, handed out unredacted one route over.
  //
  // `rconPort` and `serverPort` are left out too. They are not secrets, but they are
  // deployment-owned (the compose port mapping fixes them) and the properties editor
  // already locks `rcon.port`/`server-port` for that reason; returning them here
  // would only invite a second editor for values that cannot be changed.
  //
  // Additive, not subtractive: a future column is absent from this response until
  // someone adds it, rather than exposed until someone notices.
  return NextResponse.json({
    id: config.id,
    mcVersion: config.mcVersion,
    modLoader: config.modLoader,
    maxMemory: config.maxMemory,
  });
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
    // Declared outside the try so the failure message can name them — the caller
    // needs to know *which* version the DB now claims but the container doesn't run.
    const finalVersion = mcVersion || oldConfig?.mcVersion || "1.21.4";
    const finalLoader = modLoader || oldConfig?.modLoader || "fabric";
    try {
      // `applyServiceEnv` owns the compose patch, the graceful stop, `create`
      // (never `up`, so a stopped world stays stopped) and the control lock. This
      // route used to open-code that and got every part of it wrong.
      await applyServiceEnv(
        "minecraft",
        { TYPE: finalLoader.toUpperCase(), VERSION: finalVersion },
        {
          stage: `Changing the Minecraft version`,
          setting: "The Minecraft version",
          startedBy: session.user.name,
        }
      );
    } catch (e) {
      if (isConflict(e)) return conflictResponse(e);
      // Not `{success: true, warning}` with HTTP 200: the settings page checks only
      // `res.ok` and never reads `warning`, so a failed apply rendered as "Saved."
      // The DB row has already been written, which is why the message has to say
      // that the two now disagree rather than just "failed".
      return NextResponse.json(
        {
          error:
            `Saved ${finalLoader} ${finalVersion} to settings, but applying it to the container failed: ` +
            `${(e as Error).message}. The configured and running versions now disagree — retry, or check the Minecraft container.`,
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ success: true });
}
