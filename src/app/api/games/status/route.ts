import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  cachedAllStatus,
  currentControlLock,
  configuredMemoryGb,
  hostTotalGb,
} from "@/lib/game-manager";
import { GAME_LIST, type GameId } from "@/lib/games";
import { hasPermission } from "@/lib/permissions";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Coalesced (3.5s) and copied before mutation: the cache hands out the same object
  // to every caller, and the redaction loop below would otherwise strip player names
  // out of the shared snapshot for whoever polls next.
  const snapshot = await cachedAllStatus();
  const games = { ...snapshot };
  const access = session.user.games;

  // Every world's run state is reported, even ones this user can't open: only
  // one server fits on the box, so their Start button stops whatever is running
  // and the UI has to be able to say so. Who is *playing* it is none of their
  // business, so player names are dropped.
  for (const g of GAME_LIST) {
    if (access.includes(g.id)) continue;
    games[g.id] = { ...games[g.id], players: { online: 0, max: 0, players: [] }, detail: undefined };
  }

  // Whichever world is actually up, from this poll's own probe. Nothing else.
  //
  // This used to fall back to `GameState.activeGame` from the database whenever no world
  // answered — i.e. in exactly the case where the correct answer is `null`. That column
  // is written only by `/api/games/control`, so **every other way a world goes down
  // leaves it stale**: the eviction inside `powerOn`, `withGameStopped`, `setMemory`,
  // the Workshop watcher, a crash, a host reboot. The landing page then lit that world's
  // power-bus branch and said it was running with nothing running at all. The live row
  // reads `{"activeGame":"zomboid"}` and has since 14:44, regardless of what happens to
  // the container.
  //
  // The write sites stay: the column is a write-only audit trail of intent, and nothing
  // now reads it. `containerRunning` per world already carries every fact a UI needs.
  const activeGame =
    GAME_LIST.find((g) => games[g.id].status === "online" || games[g.id].status === "starting")?.id ??
    null;

  // Which worlds have a running container, plural on purpose.
  //
  // Only one world fits on this box, and the oldest open item in CLAUDE.md is that
  // nothing *detects* two running at once — `powerOn` evicts, but the other start paths
  // do not, and no code path reports co-residency. These flags are computed on every
  // poll anyway, so exposing them costs nothing. `activeGame` keeps its exact wire shape
  // for existing readers.
  //
  // Nothing consumes this yet: rendering a warning needs `use-games.ts` and
  // `dash-shell.tsx`, and *refusing* co-residency needs `game-manager.ts`. Both are
  // one-file changes away, with the data already on the wire.
  const running: GameId[] = GAME_LIST.filter((g) => games[g.id].containerRunning).map((g) => g.id);

  // Real values, so the UI never shows a stale hardcoded number.
  const [memoryGb, hostGb] = await Promise.all([configuredMemoryGb(), hostTotalGb()]);

  return NextResponse.json({
    games,
    activeGame,
    running,
    busy: currentControlLock(),
    access,
    // Which power controls this user may actually use. The buttons used to be
    // shown to everyone and only the API refused, so a MEMBER pressed Power on
    // and got "forbidden" with no idea why.
    can: {
      start: hasPermission(session.user.role, "server.start"),
      stop: hasPermission(session.user.role, "server.stop"),
      restart: hasPermission(session.user.role, "server.restart"),
    },
    memoryGb,
    hostGb: Math.round(hostGb * 10) / 10,
    // So elapsed times are measured against the server's clock rather than the
    // browser's. `Date.now() - busy.since` mixed the two.
    serverNow: Date.now(),
  });
}
