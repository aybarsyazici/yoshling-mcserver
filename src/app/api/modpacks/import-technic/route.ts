import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { searchMods } from "@/lib/modrinth";

const TECHNIC_BUILD = "1098";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug, name } = await request.json();

  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  try {
    // Get modpack detail to find solder URL and MC version
    const detailRes = await fetch(
      `https://api.technicpack.net/modpack/${slug}?build=${TECHNIC_BUILD}`
    );
    if (!detailRes.ok) {
      return NextResponse.json({ error: "Failed to fetch pack details" }, { status: 502 });
    }
    const detail = await detailRes.json();
    const mcVersion = detail.minecraft || null;
    const solderUrl = detail.solder || null;

    let modNames: string[] = [];

    if (solderUrl) {
      // Fetch mod list from Solder API
      try {
        const solderPackRes = await fetch(`${solderUrl}/modpack/${slug}`);
        if (solderPackRes.ok) {
          const solderPack = await solderPackRes.json();
          const buildVersion = solderPack.recommended || solderPack.latest;

          if (buildVersion) {
            const buildRes = await fetch(`${solderUrl}/modpack/${slug}/${buildVersion}`);
            if (buildRes.ok) {
              const buildData = await buildRes.json();
              modNames = (buildData.mods || []).map((m: any) => m.name as string);
            }
          }
        }
      } catch {}
    }

    // Try to find each mod on Modrinth by name
    const resolvedMods: { modrinthId: string; slug: string; name: string }[] = [];

    for (const modName of modNames.slice(0, 50)) {
      try {
        const cleanName = modName.replace(/[-_]/g, " ");
        const results = await searchMods({
          query: cleanName,
          facets: [["project_type:mod"]],
          limit: 1,
          index: "relevance",
        });
        if (results.hits.length > 0) {
          const hit = results.hits[0];
          resolvedMods.push({
            modrinthId: hit.project_id,
            slug: hit.slug,
            name: hit.title,
          });
        }
      } catch {}
    }

    const modpack = await db.modpack.create({
      data: {
        name: name || detail.displayName || slug,
        description: `Imported from Technic. ${resolvedMods.length} mods found on Modrinth${modNames.length > resolvedMods.length ? ` (${modNames.length - resolvedMods.length} not found)` : ""}.`,
        createdBy: session.user.id,
        targetMcVersion: mcVersion,
        targetLoader: "forge",
        mods: {
          create: resolvedMods.map((m) => ({
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
      totalModsInPack: modNames.length,
      resolvedOnModrinth: resolvedMods.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to import" },
      { status: 500 }
    );
  }
}
