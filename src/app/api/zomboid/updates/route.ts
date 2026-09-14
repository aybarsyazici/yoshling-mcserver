import { NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { findStaleMods, pollModUpdates, readWatchState } from "@/lib/zomboid-updates";

/**
 * Workshop mod update status. The watcher in `instrumentation.ts` runs this on a
 * timer; this route is so it's inspectable rather than a black box, and so an
 * admin can force a check instead of waiting out the interval.
 */
export async function GET() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  const [stale, state] = await Promise.all([
    findStaleMods().catch(() => null),
    readWatchState(),
  ]);

  return NextResponse.json({
    // null means this request's own check failed (Steam unreachable, no manifest)
    stale,
    /** When the watcher last completed a check — null if it has never run. */
    checkedAt: state.checkedAt || null,
    /** Why that check failed, or "" if it was fine. */
    lastError: state.lastError || "",
    announcedAt: state.announcedAt || null,
    appliedAt: state.appliedAt || null,
    /** So the card can say how long until the next check without hardcoding it. */
    pollMs: Number(process.env.PZ_UPDATE_POLL_MS || 5 * 60 * 1000),
    watching: (process.env.PZ_UPDATE_WATCH ?? "true") !== "false",
  });
}

/** Run a check now. Applies the update only if the server is empty. */
export async function POST() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { action, stale } = await pollModUpdates();
    if (action === "applied" || action === "seeded") {
      await db.activity
        .create({
          data: {
            userId: session.user.id,
            action: "server_restart",
            details: JSON.stringify({
              game: "zomboid",
              reason: "workshop mod update",
              mods: stale.map((s) => s.title),
            }),
          },
        })
        .catch(() => {});
    }
    return NextResponse.json({ action, stale });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
