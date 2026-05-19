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

  try {
    // Get ALL versions of the modpack (no filter) and pick the latest
    const versions = await getProjectVersions(modrinthId);

    const version = versions[0];
    if (!version) {
      return NextResponse.json(
        { error: "No versions found for this modpack" },
        { status: 404 }
      );
    }

    const targetMcVersion = version.game_versions[0] || "unknown";
    const targetLoader = version.loaders[0] || "fabric";

    // Modpack versions list their included mods as dependencies (embedded or required)
    const modDeps = version.dependencies.filter(
      (d: any) => (d.dependency_type === "required" || d.dependency_type === "embedded") && d.project_id
    );

    // Fetch project info for each dependency
    const mods = await Promise.all(
      modDeps.map(async (dep: any) => {
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

    const modpack = await db.modpack.create({
      data: {
        name: name || "Imported Modpack",
        description: `Imported from Modrinth. ${validMods.length} mods.`,
        createdBy: session.user.id,
        targetMcVersion,
        targetLoader,
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

    return NextResponse.json({
      ...modpack,
      targetMcVersion,
      targetLoader,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to import modpack" },
      { status: 500 }
    );
  }
}
