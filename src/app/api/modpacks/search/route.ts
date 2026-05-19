import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchMods } from "@/lib/modrinth";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const mcVersion = searchParams.get("version") || undefined;
  const loader = searchParams.get("loader") || undefined;
  const offset = parseInt(searchParams.get("offset") || "0");

  const facets: string[][] = [["project_type:modpack"]];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const results = await searchMods({
    query,
    facets,
    offset,
    limit: 12,
    index: "downloads",
  });

  return NextResponse.json(results);
}
