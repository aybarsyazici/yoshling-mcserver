import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const res = await fetch(`https://api.modrinth.com/v2/project/${id}`, {
      headers: { "User-Agent": "minecraft-yoshling/1.0.0 (server-manager)" },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const project = await res.json();

    return NextResponse.json({
      title: project.title,
      description: project.description,
      body: project.body,
      icon_url: project.icon_url,
      gallery: project.gallery || [],
      downloads: project.downloads,
      followers: project.followers,
      categories: project.categories || [],
      loaders: project.loaders || [],
      game_versions: project.game_versions || [],
      license: project.license?.id || project.license || null,
      source_url: project.source_url,
      issues_url: project.issues_url,
      wiki_url: project.wiki_url,
      discord_url: project.discord_url,
      date_created: project.published,
      date_modified: project.updated,
      client_side: project.client_side,
      server_side: project.server_side,
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
