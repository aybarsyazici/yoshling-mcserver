import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getProjectVersions } from "@/lib/modrinth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { modrinthId, slug, name, versionId } = await request.json();

  if (!modrinthId || !slug || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Check if mod already in pack
  const existing = await db.modpackMod.findFirst({
    where: { modpackId: id, modrinthId },
  });

  if (existing) {
    return NextResponse.json({ error: "Mod already in modpack" }, { status: 409 });
  }

  // Get modpack to check target version/loader
  const modpack = await db.modpack.findUnique({ where: { id } });
  if (!modpack) {
    return NextResponse.json({ error: "Modpack not found" }, { status: 404 });
  }

  const targetMcVersion = modpack.targetMcVersion;
  const targetLoader = modpack.targetLoader;

  // If modpack has a target, validate that a compatible version exists
  let resolvedVersionId = versionId || null;

  if (targetMcVersion && targetLoader && !versionId) {
    try {
      const versions = await getProjectVersions(modrinthId, {
        loaders: [targetLoader],
        game_versions: [targetMcVersion],
      });

      if (versions.length === 0) {
        return NextResponse.json(
          {
            error: "incompatible",
            message: `No version of "${name}" exists for MC ${targetMcVersion} (${targetLoader}). This mod cannot be added to this modpack.`,
          },
          { status: 409 }
        );
      }

      resolvedVersionId = versions[0].id;
    } catch {
      // If lookup fails, still add it without a pinned version
    }
  }

  const mod = await db.modpackMod.create({
    data: {
      modpackId: id,
      modrinthId,
      slug,
      name,
      versionId: resolvedVersionId,
    },
  });

  await db.modpack.update({
    where: { id },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json(mod);
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const modId = searchParams.get("modId");

  if (!modId) {
    return NextResponse.json({ error: "modId required" }, { status: 400 });
  }

  await db.modpackMod.delete({ where: { id: modId } });

  return NextResponse.json({ success: true });
}
