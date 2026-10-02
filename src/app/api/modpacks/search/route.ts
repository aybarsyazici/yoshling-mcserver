import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { db } from "@/lib/db";
import { searchMods } from "@/lib/modrinth";

/**
 * The literal a caller sends to drop a facet on purpose — the same word, for the same
 * reason, as `/api/mods/search`'s. A *missing* parameter and an explicitly-widened one
 * must not be the same request.
 */
const ANY = "any";

/** `undefined` for "no facet", so it is left out of the facet array entirely. */
function facetValue(requested: string | null, serverValue: string | undefined): string | undefined {
  if (requested === ANY) return undefined;
  return requested || serverValue || undefined;
}

/**
 * Search Modrinth for modpacks, **faceted on what this server actually runs**.
 *
 * This route sent `versions:` and `categories:` only when the caller passed them, and the
 * one caller never did — so the pack browser listed every modpack Modrinth publishes,
 * against a 26.1.2 Fabric server, and the apply refused them one at a time with a version
 * mismatch. That is the identical defect `/api/mods/search` was fixed for on 2026-10-02,
 * one route along, and it matters more here: a modpack apply is the most destructive
 * endpoint in the app, so "this list is things you can apply" has to be true of the list.
 *
 * The widening word is `any`, sent only by the "show all versions" control, and the
 * response says what was faceted. An omission must never mean "every version".
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const offset = parseInt(searchParams.get("offset") || "0");
  const sort = searchParams.get("sort") || "downloads";

  // A missing `ServerConfig` row (a fresh install) widens rather than refuses: a search is
  // a read, and an empty pack browser is a worse answer than an unfiltered one. The
  // `filter` below is what tells the two apart.
  const config = await db.serverConfig.findUnique({ where: { id: "main" } });
  const mcVersion = facetValue(searchParams.get("version"), config?.mcVersion);
  // Lowercased for the same reason as the mod search: Modrinth's loader facet is a
  // *category* slug (`fabric`), while `ServerConfig.modLoader` holds whatever was saved and
  // `/api/settings` uppercases it for compose's `TYPE`. `categories:FABRIC` matches nothing
  // and the symptom is an empty browser with no stated cause.
  const loader = facetValue(searchParams.get("loader"), config?.modLoader)?.toLowerCase();

  const facets: string[][] = [["project_type:modpack"]];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const results = await searchMods({
    query,
    facets,
    offset,
    limit: 12,
    index: sort,
  });

  return NextResponse.json({
    ...results,
    filter: { mcVersion: mcVersion ?? null, loader: loader ?? null },
  });
}
