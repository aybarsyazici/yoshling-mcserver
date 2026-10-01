import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { applyServiceEnv } from "@/lib/game-manager";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { readWorldVersion } from "@/lib/mc-world-version";
import {
  versionChangeMismatches,
  versionChangeRefusal,
  type InstalledModFact,
} from "@/lib/mc-version-guard";

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
  //
  // `worldVersion` is not a column — it is read out of `world/level.dat`, i.e. from what
  // the *game* last wrote, and it is here so the version dropdown can state the
  // consequence of a change **before** it is saved rather than only in the refusal. The
  // DB and the disk have disagreed before (`ServerConfig` said 26.1.2 while compose said
  // 1.21.4 for weeks), so showing the two side by side is the same
  // configured-vs-live comparison the memory card makes.
  return NextResponse.json({
    id: config.id,
    mcVersion: config.mcVersion,
    modLoader: config.modLoader,
    maxMemory: config.maxMemory,
    worldVersion: await readWorldVersion(),
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
  const { mcVersion, modLoader, confirm } = body;

  const oldConfig = await db.serverConfig.findUnique({ where: { id: "main" } });

  const wantsVersion = mcVersion && mcVersion !== oldConfig?.mcVersion;
  const wantsLoader = modLoader && modLoader !== oldConfig?.modLoader;

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
  if (wantsVersion || wantsLoader) {
    const target = {
      version: mcVersion || oldConfig?.mcVersion || "1.21.4",
      loader: (modLoader || oldConfig?.modLoader || "fabric").toLowerCase(),
    };
    const mods: InstalledModFact[] = await db.installedMod
      .findMany({ select: { name: true, mcVersion: true, loader: true } })
      .catch(() => []);
    const mismatches = versionChangeMismatches({
      ...target,
      worldVersion: await readWorldVersion(),
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

  // The same two booleans the guard above decided on — computed once, so the guard and
  // the apply can never disagree about whether anything changed.
  if (wantsVersion || wantsLoader) {
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
          // Name the version in the operation title, and say when it was applied over a
          // refusal: the ledger is the only durable record that someone was told the
          // world and the mods disagree and chose to go ahead, and that is exactly the
          // fact anyone debugging a world that no longer boots will want.
          stage:
            `Changing Minecraft to ${finalLoader} ${finalVersion}` +
            (overrodeMismatch ? " (mismatch confirmed)" : ""),
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
