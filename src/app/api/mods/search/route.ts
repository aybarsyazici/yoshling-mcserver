import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { db } from "@/lib/db";
import { searchMods, buildFacets } from "@/lib/modrinth";
import { withMinecraftProfileRead } from "@/lib/minecraft-active-profile";

/**
 * The literal a caller sends to drop a facet on purpose.
 *
 * A *missing* parameter and an explicitly-widened one used to be the same request, which is
 * why this route listed mods for every Minecraft version ever published: it passed
 * `serverSide: true` but set `versions:` only when the browser had a modpack selected, so the
 * default search — the one everybody uses — was unfiltered by version and loader. Every one of
 * those results now carries an Install button, and `/api/mods/install` refuses the
 * incompatible ones one at a time with "No compatible version found".
 *
 * So the facet defaults to what the server is actually running and widening is a word the
 * caller has to type. The two states are distinguishable in the response (`filter`), because
 * a result list that silently means something different from what the page says it means is
 * the same defect in a new place.
 */
const ANY = "any";

/** `undefined` for "no facet", so `buildFacets` leaves it out. */
function facetValue(requested: string | null, serverValue: string | undefined): string | undefined {
  if (requested === ANY) return undefined;
  return requested || serverValue || undefined;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  return withMinecraftProfileRead(async () => {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const category = searchParams.get("category") || undefined;
  const offset = parseInt(searchParams.get("offset") || "0");
  const limit = parseInt(searchParams.get("limit") || "20");
  const sort = searchParams.get("sort") || "relevance";

  // The same row `/api/settings` GET projects for the version dropdown and
  // `/api/mods/install` reads to resolve a version — one source of truth for "what is this
  // server". A missing row (a fresh install, before the first save) widens rather than
  // refuses: a search is a read, and an empty mod browser would be a worse answer than an
  // unfiltered one.
  const config = await db.serverConfig.findUnique({ where: { id: "main" } });

  const mcVersion = facetValue(searchParams.get("version"), config?.mcVersion);
  // Lowercased because Modrinth's loader facet is a *category* slug (`fabric`, `forge`,
  // `neoforge`), while `ServerConfig.modLoader` is whatever was saved — `/api/settings`
  // uppercases it for compose's `TYPE` and stores the raw value, so the two spellings both
  // exist in this app.
  const loader = facetValue(searchParams.get("loader"), config?.modLoader)?.toLowerCase();

  const facets = buildFacets({ mcVersion, loader, category, serverSide: true });

  const results = await searchMods({
    query,
    facets,
    offset,
    limit,
    index: sort,
  });

  // What was actually filtered on, so the page states the filter rather than guessing it.
  // `null` means the facet was left off — which is the difference between "no mods exist for
  // this server" and "no mods matched your search".
  return NextResponse.json({
    ...results,
    filter: { mcVersion: mcVersion ?? null, loader: loader ?? null },
  });
  });
}
