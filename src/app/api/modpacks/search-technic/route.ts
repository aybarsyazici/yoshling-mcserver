import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const TECHNIC_BUILD = "1098";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";

  if (!query.trim()) {
    return NextResponse.json({ packs: [] });
  }

  try {
    const res = await fetch(
      `https://api.technicpack.net/search?build=${TECHNIC_BUILD}&q=${encodeURIComponent(query)}`,
      { next: { revalidate: 300 } }
    );

    if (!res.ok) {
      return NextResponse.json({ packs: [] });
    }

    const data = await res.json();
    const modpacks = data.modpacks || [];

    // Fetch details for each to get download counts and MC version
    const detailed = await Promise.all(
      modpacks.slice(0, 12).map(async (pack: any) => {
        try {
          const detailRes = await fetch(
            `https://api.technicpack.net/modpack/${pack.slug}?build=${TECHNIC_BUILD}`,
            { next: { revalidate: 300 } }
          );
          if (!detailRes.ok) return null;
          const detail = await detailRes.json();
          // Only include packs that have Solder (official / properly set up packs)
          if (!detail.solder) return null;
          return {
            name: detail.name,
            displayName: detail.displayName || detail.name,
            url: detail.url || `https://www.technicpack.net/modpack/${pack.slug}`,
            iconUrl: detail.icon?.url || pack.iconUrl || null,
            downloads: detail.installs || 0,
            mcVersion: detail.minecraft || "unknown",
            solder: detail.solder || null,
          };
        } catch {
          return null;
        }
      })
    );

    return NextResponse.json({
      packs: detailed.filter(Boolean),
    });
  } catch {
    return NextResponse.json({ packs: [] });
  }
}
