import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { categoryTags } from "@/lib/modrinth-tags";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const res = await fetch("https://api.modrinth.com/v2/tag/category", {
    headers: {
      "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
    },
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch categories" }, { status: 502 });
  }

  const allCategories = categoryTags(await res.json());
  if (!allCategories) return NextResponse.json({ error: "Invalid category response" }, { status: 502 });

  // Only return categories relevant to mods (not resource packs, shaders, etc.)
  const modCategories = allCategories
    .filter(c => c.project_type === "mod")
    .map(c => ({ name: c.name, icon: c.icon }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json(modCategories);
}
