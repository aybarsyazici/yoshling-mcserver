import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchMods, buildFacets } from "@/lib/modrinth";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const mcVersion = searchParams.get("version") || undefined;
  const loader = searchParams.get("loader") || undefined;
  const category = searchParams.get("category") || undefined;
  const offset = parseInt(searchParams.get("offset") || "0");
  const limit = parseInt(searchParams.get("limit") || "20");
  const sort = searchParams.get("sort") || "relevance";
  const showClientOnly = searchParams.get("showClientOnly") === "true";

  const facets = buildFacets({ mcVersion, loader, category, serverSide: !showClientOnly });

  const results = await searchMods({
    query,
    facets,
    offset,
    limit,
    index: sort,
  });

  return NextResponse.json(results);
}
