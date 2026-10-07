import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { gameVersionTags } from "@/lib/modrinth-tags";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

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

    const allVersions = gameVersionTags(await res.json());
    if (!allVersions) return NextResponse.json({ error: "Invalid version response" }, { status: 502 });

    const releaseVersions = allVersions
      .filter(v => v.version_type === "release")
      .map(v => v.version)
      .slice(0, 30);

    return NextResponse.json({ versions: releaseVersions });
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
