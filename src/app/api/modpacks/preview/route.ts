import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { db } from "@/lib/db";
import { getProjectVersions } from "@/lib/modrinth";
import { withMinecraftProfileRead } from "@/lib/minecraft-active-profile";
import {
  chooseModpackVersion,
  modDepsOf,
  packCompatibility,
  packNeeds,
  publishedMcVersions,
} from "@/lib/modpack-resolve";

/**
 * **What applying this pack would mean — answered without applying it, and without
 * saving it.**
 *
 * Before this, the only way to learn what a Modrinth pack needs was to press **Import**,
 * which creates a `Modpack` row, and then press **Install to Server**, which answers a 409
 * in a toast that lives four seconds. So the version mismatch — the single most common
 * reason an apply does nothing on this box, since COBBLEVERSE publishes only MC 1.21.1 and
 * `Hoplite` only up to 1.21.11 against a 26.1.2 server — was discoverable only by
 * attempting it, and every attempt left another row behind. Production has **9 `Modpack`
 * rows for 6 distinct packs**, three of them `(re-imported)` duplicates; this is the shape
 * that produced them.
 *
 * It **writes nothing**: no `Modpack`, no `ModpackMod`, no `Activity`. The version choice
 * is `chooseModpackVersion`, the same function `/api/modpacks/import` uses, so the build
 * this describes is the build that would actually be taken — a preview that resolved a
 * different version from the import behind it would be worse than no preview, because the
 * comparison the user read would not be the comparison that was applied.
 *
 * A read, so it gates on session + world access and no capability — the same shape as
 * `/api/modpacks/search` and `/api/modpacks/[id]/export`. Nothing here is a secret: the
 * pack data is public Modrinth, and the server's own version is already in
 * `/api/mods/search`'s `filter`.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  return withMinecraftProfileRead(async () => {

  const modrinthId = new URL(request.url).searchParams.get("modrinthId");
  if (!modrinthId) {
    return NextResponse.json({ error: "modrinthId required" }, { status: 400 });
  }

  const cfg = await db.serverConfig.findUnique({ where: { id: "main" } });
  // No `ServerConfig` row is a real state (a fresh install), and it has to stay
  // distinguishable from "configured, and it disagrees". `server: null` makes the dialog
  // say it cannot compare rather than comparing against a default it invented.
  const server = cfg ? { mcVersion: cfg.mcVersion, loader: cfg.modLoader } : null;

  let versions;
  try {
    versions = await getProjectVersions(modrinthId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't read this pack from Modrinth" },
      { status: 502 }
    );
  }

  const { version, matchedServerVersion } = chooseModpackVersion(
    versions,
    server?.mcVersion ?? null,
    server?.loader
  );
  if (!version) {
    return NextResponse.json(
      { error: "Modrinth lists no versions for this modpack, so there is nothing to apply." },
      { status: 404 }
    );
  }

  const needs = packNeeds(version, server ?? {});
  const deps = modDepsOf(version);

  return NextResponse.json({
    modrinthId,
    versionId: version.id,
    versionNumber: version.version_number,
    needs,
    server,
    // `null` rather than a guessed verdict when there is no server config to compare
    // against — see `server` above.
    compatibility: server ? packCompatibility(needs, server) : null,
    matchedServerVersion,
    /** How many mods the apply would install, by the same rule the import counts them. */
    modCount: deps.length,
    /**
     * How many of those carry no pinned version.
     *
     * **566 of 569 production `ModpackMod` rows are unpinned**, which means an apply
     * installs the *newest* build of each mod rather than the one the pack author shipped.
     * Pinning them is a separate increment; saying how much of a pack is affected costs
     * nothing and turns a silent incompleteness into a stated one.
     */
    unpinnedCount: deps.filter((d) => d.versionId == null).length,
    /** Capped: a popular pack lists dozens, and this is a sentence, not a table. */
    publishedMcVersions: publishedMcVersions(versions).slice(0, 12),
  });
  });
}
