import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { db } from "@/lib/db";
import { getModsDir } from "@/lib/server-manager";
import { reconcileMods } from "@/lib/mod-inventory";

/**
 * **What is installed — reconciled against the directory, not recited from the database.**
 *
 * This was `db.installedMod.findMany()` and nothing more, and there was no `readdir`
 * anywhere in the mod code: the page headed "Installed" showed what the app last
 * remembered writing, which is a different claim from what the server will load. Today DB
 * and disk agree on production (3 rows, 3 jars) — but nothing had ever checked, so "they
 * agree" was not a thing anybody could know, and the two writers plus the file browser
 * plus a restore from an archive with no inventory are four ways to part them. See
 * `reconcileMods` for the list.
 *
 * The answer names the members of each group. A count of untracked jars cannot be acted
 * on; `xaerominimap-fabric-26.1.2-25.3.14.jar` can.
 *
 * `?hash=1` adds a sha512 per jar. Off by default — the reconcile verdict does not depend
 * on it and this endpoint is fetched on page mount; the full argument is on
 * `reconcileMods`.
 *
 * **The response is an object, not the array this used to return.** The one caller
 * (`installed-mods.tsx`) reads `.mods`; a client left open across a deploy reads neither
 * and renders its empty state until it is reloaded.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  const hash = new URL(request.url).searchParams.get("hash") === "1";

  const rows = await db.installedMod.findMany({
    orderBy: { installedAt: "desc" },
  });

  // `InstalledMod.installedBy` is a plain column with no relation, so "who installed this"
  // needs its own lookup — one query for the distinct ids, not one per row. An id that
  // does not resolve is left out of the map and the surface then says nothing about who,
  // which is the only honest option: the column holds whatever `session.user.id` was, and
  // an account can be gone.
  const actorIds = [...new Set(rows.map((r: { installedBy: string }) => r.installedBy))].filter(
    Boolean
  );
  const actorNames: Record<string, string> = {};
  if (actorIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, username: true },
    });
    for (const u of users as { id: string; username: string }[]) actorNames[u.id] = u.username;
  }

  return NextResponse.json(await reconcileMods(rows, getModsDir(), { hash, actorNames }));
}
