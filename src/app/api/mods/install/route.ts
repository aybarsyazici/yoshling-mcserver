import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { installMod } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { modrinthId, slug, name, versionId } = body;

  if (!modrinthId || !slug || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  if (!serverConfig) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const versions = await getProjectVersions(modrinthId, {
    loaders: [serverConfig.modLoader],
    game_versions: [serverConfig.mcVersion],
  });

  let selectedVersion = versionId
    ? versions.find((v) => v.id === versionId)
    : versions[0];

  if (!selectedVersion) {
    return NextResponse.json(
      {
        error: "incompatible",
        message: `No compatible version found for Minecraft ${serverConfig.mcVersion} with ${serverConfig.modLoader}. Ask an Admin to change the server version, or choose a different mod version.`,
        serverVersion: serverConfig.mcVersion,
        serverLoader: serverConfig.modLoader,
      },
      { status: 409 }
    );
  }

  const existing = await db.installedMod.findFirst({
    where: { modrinthId },
  });

  if (existing) {
    return NextResponse.json(
      { error: "Mod is already installed", installed: existing },
      { status: 409 }
    );
  }

  await installMod({
    modrinthId,
    slug,
    name,
    version: selectedVersion,
    userId: session.user.id,
  });

  return NextResponse.json({ success: true, message: "Mod installed. Restart server to activate." });
}
