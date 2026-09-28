import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installMod, removeMod } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

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

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  if (!serverConfig) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Use modpack's target version/loader, or explicit overrides, or current config
  const finalMcVersion = mcVersion || modpack.targetMcVersion || serverConfig.mcVersion;
  const finalLoader = modLoader || modpack.targetLoader || serverConfig.modLoader;

  // A modpack that targets a different version/loader is refused, not applied.
  // This branch used to regenerate docker-compose.yml from a two-service template
  // and start Minecraft: that silently deleted the sevendtd and zomboid services
  // plus the volumes the web container mounts, reverted MEMORY to ServerConfig's
  // never-updated maxMemory, and started a world without evicting whichever one
  // held the box or taking the control lock. Switching version/loader belongs to
  // /api/settings, which patches only the minecraft block and RECREATES the
  // container -- the only way a new VERSION/TYPE ever takes effect. Doing half of
  // it here (write compose, don't recreate) would just be the "looks applied and
  // silently isn't" trap again, with mods downloaded for a version that is not
  // running.
  if (finalMcVersion !== serverConfig.mcVersion || finalLoader !== serverConfig.modLoader) {
    return NextResponse.json(
      {
        error:
          `This modpack targets Minecraft ${finalMcVersion} (${finalLoader}) but the server is ` +
          `set to ${serverConfig.mcVersion} (${serverConfig.modLoader}). Change the version and ` +
          `loader on the Minecraft settings page first, then install the modpack.`,
        needsVersionChange: { mcVersion: finalMcVersion, modLoader: finalLoader },
      },
      { status: 409 }
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Auto-backup the world before touching mods. A failure here is reported rather
  // than swallowed: this backup is the entire rollback story for a mod swap that
  // corrupts the world, so "we took one" has to be true and not assumed. It is not
  // fatal though -- a server with no world/ folder yet has nothing to back up.
  try {
    const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
    const BACKUP_DIR = "/app/data/backups";
    await execAsync(`mkdir -p ${BACKUP_DIR}`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await execAsync(
      `tar -czf ${BACKUP_DIR}/auto-before-modpack-${timestamp}.tar.gz -C ${MC_DIR} world`,
      { timeout: 60000 }
    );
  } catch (e: any) {
    warnings.push(
      `World backup failed (${e.message || "unknown error"}) — this install has no rollback point.`
    );
  }

  // Refuse before deleting anything if this pack cannot actually be installed.
  //
  // The order below is destroy-then-create, so a pack whose rows carry no download
  // source wipes every installed jar and puts nothing back. That is not
  // hypothetical: 224 `ModpackMod` rows predate the importer fix in f2018a4
  // (2026-05-27, Modrinth returns `id` not `project_id`), and one saved pack —
  // Fabulously Optimized, 45 mods — has a source for *none* of them. Reporting the
  // 0/45 honestly was only half the fix; the other half is not starting.
  const installable = modpack.mods.filter(
    (m: { downloadUrl?: string | null; modrinthId?: string | null }) =>
      m.downloadUrl || m.modrinthId
  ).length;
  if (installable === 0) {
    return NextResponse.json(
      {
        error:
          `None of the ${modpack.mods.length} mods in "${modpack.name}" has a download source, ` +
          `so installing it would remove every current mod and add nothing. ` +
          `This pack was imported before a fix to the importer — re-import it to repair it.`,
      },
      { status: 409 }
    );
  }
  if (installable < modpack.mods.length) {
    warnings.push(
      `${modpack.mods.length - installable} of ${modpack.mods.length} mods in this pack have no ` +
        `download source and will be skipped — re-import the pack to repair it.`
    );
  }

  // Remove all currently installed mods. A jar that survives this loads alongside
  // the new pack, so a failed removal has to be said out loud.
  const installedMods = await db.installedMod.findMany();
  for (const mod of installedMods) {
    try {
      await removeMod(mod.id, session.user.id);
    } catch (e: any) {
      errors.push(`${mod.name}: could not be removed (${e.message || "failed"})`);
    }
  }

  // Install modpack mods
  let installed = 0;

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
        // Modpacks imported before f2018a4 stored no modrinthId (the Modrinth
        // project endpoint returns `id`, not `project_id`), so whole packs are
        // unusable until they are imported again.
        errors.push(`${mod.name}: no download source recorded — re-import this modpack`);
      }
    } catch (e: any) {
      errors.push(`${mod.name}: ${e.message || "failed"}`);
    }
  }

  // Anything short of every mod is an error, not a success. This used to answer
  // 200 {success:true} whatever happened, so a pack whose rows all lack a download
  // source reported "Installed 0/166 mods" in a green toast.
  const total = modpack.mods.length;
  const complete = installed === total;

  return NextResponse.json(
    {
      success: complete,
      installed,
      total,
      errors,
      warnings,
      ...(complete
        ? {}
        : {
            error:
              installed === 0
                ? `No mods were installed (0 of ${total}). The server's mods are now empty.`
                : `Only ${installed} of ${total} mods were installed.`,
          }),
    },
    { status: complete ? 200 : 500 }
  );
}
