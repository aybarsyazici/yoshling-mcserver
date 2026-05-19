import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installMod, removeMod } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";

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
