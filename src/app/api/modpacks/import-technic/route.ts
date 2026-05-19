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

    interface ModEntry {
      name: string;
      slug: string;
      downloadUrl: string | null;
    }

    let mods: ModEntry[] = [];

    // Try Solder API first
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
              mods = (buildData.mods || []).map((m: any) => ({
                name: m.name.replace(/[-_]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
                slug: m.name,
                downloadUrl: m.url || null,
              }));
            }
          }
        }
      } catch {}
    }

    // If Solder didn't work, try the pack's direct download URL
    if (mods.length === 0 && detail.url) {
      // For non-solder packs, we can't get individual mods.
      // Create modpack with the pack's download info so users know where to get it.
      const modpack = await db.modpack.create({
        data: {
          name: name || detail.displayName || slug,
          description: `Imported from Technic. This pack doesn't use Solder — download it directly via the Technic Launcher or from the Technic website.`,
          createdBy: session.user.id,
          targetMcVersion: mcVersion,
          targetLoader: "forge",
          mods: { create: [] },
        },
        include: { mods: true },
      });

      return NextResponse.json({
        ...modpack,
        totalMods: 0,
        note: "This pack doesn't expose individual mods. Use the Technic Launcher to install it, or add mods manually from the Browse tab.",
      });
    }

    const modpack = await db.modpack.create({
      data: {
        name: name || detail.displayName || slug,
        description: `Imported from Technic. ${mods.length} mods.`,
        createdBy: session.user.id,
        targetMcVersion: mcVersion,
        targetLoader: "forge",
        mods: {
          create: mods.map((m) => ({
            slug: m.slug,
            name: m.name,
            downloadUrl: m.downloadUrl,
          })),
        },
      },
      include: { mods: true },
    });

    return NextResponse.json({
      ...modpack,
      totalMods: mods.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to import" },
      { status: 500 }
    );
  }
}
