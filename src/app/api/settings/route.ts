import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { requireMinecraftProfileContext, assertMinecraftProfileCurrent, withMinecraftProfileRead } from "@/lib/minecraft-active-profile";
import { applyServiceEnv } from "@/lib/game-manager";
import { readCompose, readEnvMap, readServiceEnv } from "@/lib/compose";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { readWorldVersion } from "@/lib/mc-world-version";
import {
  versionChangeMismatches,
  versionChangeRefusal,
  type InstalledModFact,
} from "@/lib/mc-version-guard";

async function configuredMinecraft() {
  const compose = await readCompose();
  const env = await readEnvMap();
  const mcVersion = readServiceEnv(compose, "minecraft", "VERSION", env);
  const type = readServiceEnv(compose, "minecraft", "TYPE", env);
  const maxMemory = readServiceEnv(compose, "minecraft", "MEMORY", env);
  if (!mcVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mcVersion) ||
      !type || !/^[A-Za-z]+$/.test(type) || !maxMemory || !/^[1-9]\d*\s*[gGmM]$/.test(maxMemory) ||
      !Number.isFinite(Number.parseInt(maxMemory, 10))) {
    throw new Error("The configured Minecraft version, loader or memory could not be verified");
  }
  return { id: "main", mcVersion, modLoader: type.toLowerCase(), maxMemory };
}

// Memory is NOT set here — /api/games/memory owns it, because applying a heap
// change means recreating the container, not just rewriting this file.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  return withMinecraftProfileRead(async context => {
  const config = await db.serverConfig.findUnique({ where: { id: "main" } });
  if (!config) {
    try {
      const initial = await configuredMinecraft();
      return NextResponse.json({ ...initial, initialized: false, worldVersion: await readWorldVersion(context.root), profileId: context.profileId, targetEditable: !context.profileId });
    } catch (e) {
      return NextResponse.json({ error: `Couldn't read the initial Minecraft configuration: ${(e as Error).message}` }, { status: 503 });
    }
  }

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
  //
  // `worldVersion` is not a column — it is read out of `world/level.dat`, i.e. from what
  // the *game* last wrote, and it is here so the version dropdown can state the
  // consequence of a change **before** it is saved rather than only in the refusal. The
  // DB and the disk have disagreed before (`ServerConfig` said 26.1.2 while compose said
  // 1.21.4 for weeks), so showing the two side by side is the same
  // configured-vs-live comparison the memory card makes.
  return NextResponse.json({
    profileId: context.profileId,
    targetEditable: !context.profileId,
    id: config.id,
    mcVersion: config.mcVersion,
    modLoader: config.modLoader,
    maxMemory: config.maxMemory,
    initialized: true,
    worldVersion: await readWorldVersion(context.root),
  });
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
  let context;
  try {
    context = await requireMinecraftProfileContext(request);
    if (context.profileId) return NextResponse.json({ error: "This profile has an exact Minecraft and loader target. Create another profile to play a different version or pack.", profileId: context.profileId }, { status: 409 });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 409 }); }

  const body = await request.json();
  const { mcVersion, modLoader, confirm } = body;
  if ((mcVersion !== undefined && (typeof mcVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mcVersion))) ||
      (modLoader !== undefined && (typeof modLoader !== "string" || !/^[A-Za-z]+$/.test(modLoader))) ||
      (mcVersion === undefined && modLoader === undefined)) {
    return NextResponse.json({ error: "A valid Minecraft version or loader is required" }, { status: 400 });
  }

  const oldConfig = await db.serverConfig.findUnique({ where: { id: "main" } });
  let initialConfig: { mcVersion: string; modLoader: string; maxMemory: string };
  if (oldConfig) {
    initialConfig = oldConfig;
  } else {
    try {
      initialConfig = await configuredMinecraft();
    } catch (e) {
      return NextResponse.json({ error: `Couldn't verify the initial Minecraft configuration: ${(e as Error).message}` }, { status: 503 });
    }
  }
  const finalVersion = mcVersion ?? initialConfig.mcVersion;
  const finalLoader = (modLoader ?? initialConfig.modLoader).toLowerCase();

  // Set only when there really was something to confirm, so the operation title cannot
  // claim an override just because a caller sends `confirm` on every request.
  let overrodeMismatch = false;

  /**
   * The guard. This dropdown recreates the container and used to validate **nothing**:
   * 30 versions are offered (down to 1.18.2, measured), the world records 26.1.2 and
   * every installed mod declares 26.1.x, and choosing any of the other 29 answered
   * `{success:true}` and left a permanent "Starting…" with no explanation. See
   * `mc-version-guard.ts` for the forensics.
   *
   * Checked **before** the DB write, not after: writing the row and then refusing is how
   * the configured and running versions came to disagree in the first place, and that
   * divergence is the expensive part — the container boot-looping is merely the symptom.
   */
  {
    const target = {
      version: finalVersion,
      loader: finalLoader,
    };
    const mods: InstalledModFact[] = await db.installedMod
      .findMany({ select: { name: true, mcVersion: true, loader: true } })
      .catch(() => []);
    const mismatches = versionChangeMismatches({
      ...target,
      worldVersion: await readWorldVersion(context.root),
      mods,
    });
    if (mismatches.length > 0 && confirm !== true) {
      // 400 with `needsConfirm`, not 409: 409 means "an operation holds the lock, retry"
      // everywhere else in this app, and the page already treats it that way.
      return NextResponse.json(
        {
          error: versionChangeRefusal(target, mismatches),
          needsConfirm: true,
          mismatches,
        },
        { status: 400 }
      );
    }
    overrodeMismatch = mismatches.length > 0;
  }

  // Always let the admitted operation compare compose and the real container. A
  // matching DB row can be left behind by a previous failed apply and proves nothing.
  try {
    // `applyServiceEnv` owns the compose patch, the graceful stop, `create`
    // (never `up`, so a stopped world stays stopped) and the control lock. This
    // route used to open-code that and got every part of it wrong.
    await applyServiceEnv(
      "minecraft",
      { TYPE: finalLoader.toUpperCase(), VERSION: finalVersion },
      {
        // Name the version in the operation title, and say when it was applied over a
        // refusal: the ledger is the only durable record that someone was told the
        // world and the mods disagree and chose to go ahead, and that is exactly the
        // fact anyone debugging a world that no longer boots will want.
        stage:
          `Changing Minecraft to ${finalLoader} ${finalVersion}` +
          (overrodeMismatch ? " (mismatch confirmed)" : ""),
        setting: "The Minecraft version",
        beforeApply: () => assertMinecraftProfileCurrent(context),
        startedBy: session.user.name,
        onApplied: async () => {
          await db.serverConfig.upsert({
            where: { id: "main" },
            update: { mcVersion: finalVersion, modLoader: finalLoader },
            create: {
              id: "main",
              mcVersion: finalVersion,
              modLoader: finalLoader,
              maxMemory: initialConfig.maxMemory,
              rconPassword: process.env.RCON_PASSWORD || "changeme",
            },
          });
          const saved = await db.serverConfig.findUnique({ where: { id: "main" } });
            if (saved?.mcVersion !== finalVersion || saved?.modLoader !== finalLoader ||
                (!oldConfig && saved?.maxMemory !== initialConfig.maxMemory)) {
            throw new Error("The applied settings could not be read back from the database");
          }
        },
      }
    );
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    return NextResponse.json(
      {
        error:
          `Couldn't finish applying ${finalLoader} ${finalVersion}: ${(e as Error).message}. ` +
          `Retry the change; the next attempt checks the configured and container settings again.`,
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ success: true });
}
