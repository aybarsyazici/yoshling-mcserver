import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getProjectVersions, getProject } from "@/lib/modrinth";
import { chooseModpackVersion, modDepsOf, packNeeds } from "@/lib/modpack-resolve";

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
    //
    // **The choice lives in `src/lib/modpack-resolve.ts`**, because
    // `GET /api/modpacks/preview` has to resolve the *same* build: it shows the user which
    // Minecraft version a pack needs before anything is created, and a preview that picked
    // a different build from the import behind it would make the comparison somebody read
    // not the comparison that was applied.
    const cfg = await db.serverConfig.findUnique({ where: { id: "main" } });
    const want = cfg?.mcVersion ?? null;
    const { version, matchedServerVersion } = chooseModpackVersion(versions, want);
    if (!version) {
      return NextResponse.json(
        { error: "No versions found for this modpack" },
        { status: 404 }
      );
    }

    const { mcVersion: targetMcVersion, loader: targetLoader } = packNeeds(version);

    // Modpack versions list their included mods as dependencies (embedded or required);
    // `modDepsOf` applies that rule, shared with the preview so the count the preview
    // promises is the count this creates.
    const modDeps = modDepsOf(version);

    // Fetch project info for each dependency
    const mods = await Promise.all(
      modDeps.map(async (dep) => {
        try {
          const project = await getProject(dep.projectId);
          return {
            modrinthId: (project as any).id || project.project_id || dep.projectId,
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
      matchedServerVersion,
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
