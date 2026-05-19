import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await fetch(
      "https://api.modrinth.com/v2/tag/game_version",
      {
        headers: { "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)" },
        next: { revalidate: 3600 },
      }
    );

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch versions" }, { status: 502 });
    }

    const allVersions = await res.json();

    const releaseVersions = allVersions
      .filter((v: any) => v.version_type === "release")
      .map((v: any) => v.version)
      .slice(0, 30);

    return NextResponse.json({ versions: releaseVersions });
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
