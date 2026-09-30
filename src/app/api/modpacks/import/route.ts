import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getProjectVersions, getProject } from "@/lib/modrinth";

// Creating a modpack needs a capability, not just world access — see the note in
// `src/app/api/modpacks/route.ts`.

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

  const { modrinthId, name } = await request.json();

  if (!modrinthId) {
    return NextResponse.json({ error: "modrinthId required" }, { status: 400 });
  }

  try {
    const versions = await getProjectVersions(modrinthId);

    // Prefer a build for the version this server actually runs.
    //
    // This used to be `versions[0]` unconditionally — the newest build, whatever it was
    // for. Measured 2026-09-30: re-importing Fabulously Optimized on a server configured
    // for 26.1.2 produced a pack pinned to **26.3**, even though the project publishes a
    // 26.1.2 build. The apply then (correctly) refuses on a version mismatch, so the
    // repair silently produced another unusable pack — the "did something, reported
    // success" shape, one layer along from the missing-download-source bug it was fixing.
    //
    // Falls back to the newest build when the server's version has no release, because a
    // pack you cannot install yet is still worth having on the shelf — but the response
    // says which happened rather than leaving the caller to infer it from a number.
    const cfg = await db.serverConfig.findUnique({ where: { id: "main" } });
    const want = cfg?.mcVersion ?? null;
    const matching = want ? versions.find((v) => v.game_versions?.includes(want)) : undefined;
    const version = matching ?? versions[0];
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
            modrinthId: (project as any).id || project.project_id || dep.project_id,
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
      // Say which build was chosen and why, so "why is this pack 26.3?" is answerable
      // from the response instead of from the Modrinth version list.
      matchedServerVersion: Boolean(matching),
      serverMcVersion: want,
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
