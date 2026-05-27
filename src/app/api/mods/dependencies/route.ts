import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getProjectVersions, getProject } from "@/lib/modrinth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const modrinthId = searchParams.get("modrinthId");

  if (!modrinthId) {
    return NextResponse.json({ error: "modrinthId required" }, { status: 400 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  const mcVersion = serverConfig?.mcVersion || "1.21.4";
  const loader = serverConfig?.modLoader || "fabric";

  try {
    const versions = await getProjectVersions(modrinthId, {
      loaders: [loader],
      game_versions: [mcVersion],
    });

    const latestVersion = versions[0];
    if (!latestVersion) {
      return NextResponse.json({ dependencies: [] });
    }

    const requiredDeps = latestVersion.dependencies.filter(
      (d) => d.dependency_type === "required" && d.project_id
    );

    const deps = await Promise.all(
      requiredDeps.map(async (dep) => {
        try {
          const project = await getProject(dep.project_id!);
          return {
            modrinthId: (project as any).id || project.project_id || dep.project_id,
            slug: project.slug,
            name: project.title,
          };
        } catch {
          return null;
        }
      })
    );

    return NextResponse.json({
      dependencies: deps.filter(Boolean),
    });
  } catch {
    return NextResponse.json({ dependencies: [] });
  }
}
