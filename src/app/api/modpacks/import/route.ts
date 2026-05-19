import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getProjectVersions, getProject } from "@/lib/modrinth";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { modrinthId, name } = await request.json();

  if (!modrinthId) {
    return NextResponse.json({ error: "modrinthId required" }, { status: 400 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });
  const mcVersion = serverConfig?.mcVersion || "1.21.4";
  const loader = serverConfig?.modLoader || "fabric";

  try {
    // Get the latest version of the modpack for our MC version/loader
    const versions = await getProjectVersions(modrinthId, {
      loaders: [loader],
      game_versions: [mcVersion],
    });

    const version = versions[0];
    if (!version) {
      return NextResponse.json(
        { error: `No version found for ${mcVersion} / ${loader}` },
        { status: 404 }
      );
    }

    // Modpack versions list their included mods as dependencies
    const modDeps = version.dependencies.filter(
      (d) => d.dependency_type === "required" && d.project_id
    );

    // Fetch project info for each dependency
    const mods = await Promise.all(
      modDeps.map(async (dep) => {
        try {
          const project = await getProject(dep.project_id!);
          return {
            modrinthId: project.project_id,
            slug: project.slug,
            name: project.title,
          };
        } catch {
          return null;
        }
      })
    );

    const validMods = mods.filter(Boolean) as {
      modrinthId: string;
      slug: string;
      name: string;
    }[];

    // Create the modpack locally
    const modpack = await db.modpack.create({
      data: {
        name: name || `Imported Modpack`,
        description: `Imported from Modrinth. ${validMods.length} mods.`,
        createdBy: session.user.id,
        mods: {
          create: validMods.map((m) => ({
            modrinthId: m.modrinthId,
            slug: m.slug,
            name: m.name,
          })),
        },
      },
      include: { mods: true },
    });

    return NextResponse.json(modpack);
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to import modpack" },
      { status: 500 }
    );
  }
}
