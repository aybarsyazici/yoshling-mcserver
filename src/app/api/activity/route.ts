import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ALL_GAMES, hasPermission } from "@/lib/permissions";
import { isGameId } from "@/lib/games";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `activity.view` was the sixth capability in `permissions.ts` that no caller ever
  // asked about — five others were deleted for that reason, and this one survived the
  // sweep because the route gated on the session alone and happened to agree with the
  // table (all three roles hold it). Wiring it up costs one line and turns "everyone
  // signed in may read the log" from an accident of this handler into a decision
  // visible in the table, revocable from there. It passes for every role today: this
  // is not a behaviour change.
  if (!hasPermission(session.user.role, "activity.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = parseInt(searchParams.get("offset") || "0");

  const access = new Set(session.user.games);
  const hidden = ALL_GAMES.filter((g) => !access.has(g));

  // The log is shared, so entries about a world the user can't open are dropped.
  // Over-fetch a little, since filtering happens after the query (the game lives
  // inside the JSON `details` blob).
  const activities = await db.activity.findMany({
    include: { user: { select: { username: true, avatar: true } } },
    orderBy: { createdAt: "desc" },
    take: hidden.length > 0 ? limit * 3 : limit,
    skip: offset,
  });

  const visible =
    hidden.length === 0
      ? activities
      : activities.filter((a: { details: string }) => {
          let game: unknown;
          try {
            game = JSON.parse(a.details)?.game;
          } catch {}
          // Entries that name no world (mod installs on MC, older rows) stay put.
          return !(typeof game === "string" && isGameId(game) && !access.has(game));
        });

  return NextResponse.json(visible.slice(0, limit));
}
