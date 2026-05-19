import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

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
    const detailRes = await fetch(
      `https://api.technicpack.net/modpack/${slug}?build=${TECHNIC_BUILD}`
    );
    if (!detailRes.ok) {
      return NextResponse.json({ error: "Failed to fetch pack details" }, { status: 502 });
    }
    const detail = await detailRes.json();
    const mcVersion = detail.minecraft || null;
    const solderUrl = detail.solder || null;

    interface SolderMod {
      name: string;
      version: string;
      url: string;
    }

    let solderMods: SolderMod[] = [];

    if (solderUrl) {
      try {
        const solderPackRes = await fetch(`${solderUrl}/modpack/${slug}`);
        if (solderPackRes.ok) {
          const solderPack = await solderPackRes.json();
          const buildVersion = solderPack.recommended || solderPack.latest;

          if (buildVersion) {
            const buildRes = await fetch(`${solderUrl}/modpack/${slug}/${buildVersion}`);
            if (buildRes.ok) {
              const buildData = await buildRes.json();
              solderMods = (buildData.mods || []).map((m: any) => ({
                name: m.name,
                version: m.version,
                url: m.url,
              }));
            }
          }
        }
      } catch {}
    }

    if (solderMods.length === 0) {
      return NextResponse.json(
        { error: "Could not fetch mod list. This pack may not use Solder or may be unavailable." },
        { status: 404 }
      );
    }

    const modpack = await db.modpack.create({
      data: {
        name: name || detail.displayName || slug,
        description: `Imported from Technic. ${solderMods.length} mods.`,
        createdBy: session.user.id,
        targetMcVersion: mcVersion,
        targetLoader: "forge",
        mods: {
          create: solderMods.map((m) => ({
            slug: m.name,
            name: m.name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            downloadUrl: m.url,
          })),
        },
      },
      include: { mods: true },
    });

    return NextResponse.json({
      ...modpack,
      totalMods: solderMods.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to import" },
      { status: 500 }
    );
  }
}
