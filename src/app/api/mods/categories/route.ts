import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch("https://api.modrinth.com/v2/tag/category", {
    headers: {
      "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)",
    },
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch categories" }, { status: 502 });
  }

  const allCategories = await res.json();

  // Only return categories relevant to mods (not resource packs, shaders, etc.)
  const modCategories = allCategories
    .filter((c: any) => c.project_type === "mod")
    .map((c: any) => ({ name: c.name, icon: c.icon }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  return NextResponse.json(modCategories);
}
