import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getProjectVersions } from "@/lib/modrinth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const modpack = await db.modpack.findUnique({
    where: { id },
    include: { mods: true },
  });

  if (!modpack) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  const mcVersion = serverConfig?.mcVersion || "1.21.4";
  const loader = serverConfig?.modLoader || "fabric";

  const modsWithUrls = await Promise.all(
    modpack.mods.map(async (mod: any) => {
      try {
        const versions = await getProjectVersions(mod.modrinthId, {
          loaders: [loader],
          game_versions: [mcVersion],
        });
        const version = mod.versionId
          ? versions.find((v) => v.id === mod.versionId)
          : versions[0];

        const file = version?.files.find((f) => f.primary) || version?.files[0];
        return {
          name: mod.name,
          slug: mod.slug,
          modrinthId: mod.modrinthId,
          fileName: file?.filename || null,
          downloadUrl: file?.url || null,
          version: version?.version_number || null,
        };
      } catch {
        return {
          name: mod.name,
          slug: mod.slug,
          modrinthId: mod.modrinthId,
          fileName: null,
          downloadUrl: null,
          version: null,
        };
      }
    })
  );

  return NextResponse.json({
    modpack: {
      name: modpack.name,
      description: modpack.description,
      mcVersion,
      loader,
    },
    mods: modsWithUrls,
  });
}
