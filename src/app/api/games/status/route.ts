import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  cachedAllStatus,
  currentControlLock,
  configuredMemoryGb,
  hostTotalGb,
  liveSettings,
  maxGameGb,
} from "@/lib/game-manager";
import { GAME_LIST, type GameId } from "@/lib/games";
import type { LiveSettings } from "@/lib/live-settings";
import { hasPermission } from "@/lib/permissions";

export async function GET(request: Request) {
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
  // Only one world fits on this box, and nothing in the app *detected* two running at
  // once — `powerOn` evicts, but no code path reported co-residency. These flags are
  // computed on every poll anyway, so exposing them costs nothing. `activeGame` keeps its
  // exact wire shape for existing readers.
  //
  // `containerRunning`, not `status`: a container that is up but not answering RCON
  // reports `status: "offline"` (the `a7d76b8` split) and is still holding its memory, so
  // deriving this from `status` would miss exactly the wedged case. The same choice is
  // made, and explained at length, in `runningWorlds()` in `lib/coresidency.ts` — which
  // is what consumes this, on every power surface.
  const running: GameId[] = GAME_LIST.filter((g) => games[g.id].containerRunning).map((g) => g.id);

  // Real values, so the UI never shows a stale hardcoded number.
  //
  // `maxGb` is `maxGameGb()` — MemTotal minus a 2.5 GB host reserve. It is on the wire so
  // the landing page can state the per-world ceiling *and* the assumption baked into it:
  // the figure subtracts nothing for whatever else is running, which `CLAUDE.md` has
  // recorded for weeks in a place no user reads. `perWorldCeiling()` is the consumer.
  const [memoryGb, hostGb, maxGb] = await Promise.all([
    configuredMemoryGb(),
    hostTotalGb(),
    maxGameGb(),
  ]);

  // What one world is *actually running*, on request only.
  //
  // **Opt-in, and that is the whole design.** This endpoint is polled every 4 s by up to
  // six `useGames` instances per page; asking the game what it is running costs a telnet
  // session or an RCON round trip (measured: ~100 ms for Project Zomboid, ~60 ms for
  // 7 Days to Die) and nothing on a status poll needs it. So the default response keeps
  // exactly the fields it had, and the settings panel — which needs this once when it opens
  // and again after a save — asks for it with `?live=<game>`. No second endpoint, no second
  // poller. `liveSettings()` is itself cached 10 s and single-flighted.
  //
  // Gated like the config GETs it accompanies: world access AND `settings.read`. The two
  // probes measurably return no secret-named key today, and `redactSecretKeys()` drops any
  // that appear later — but a live settings dump is still the same class of data as the
  // file it is compared against, so it gets the same gate rather than session-only.
  const params = new URL(request.url).searchParams;
  const wanted = params.get("live");
  const wantedGame = GAME_LIST.find((g) => g.id === wanted)?.id;
  // `?fresh=1` skips the 10 s cache, and only the post-write re-read asks for it. Without it
  // a save inside ten seconds of the panel loading got the pre-write snapshot back and
  // rendered amber "running: <old value>" for the write it had just applied.
  const fresh = params.get("fresh") === "1";
  let live: LiveSettings | undefined;
  if (wantedGame) {
    const allowed = access.includes(wantedGame) && hasPermission(session.user.role, "settings.read");
    live = allowed
      ? await liveSettings(wantedGame, { fresh })
      : {
          game: wantedGame,
          available: false,
          // Said rather than silently omitted: a missing comparison that looks like a
          // working one is how someone concludes the settings they see are the live ones.
          // Covers both halves of the gate (world access, and the settings role), so it
          // does not name a cause it cannot distinguish.
          reason: "This account can't read the running server's settings, so nothing was compared.",
          values: {},
          readAt: Date.now(),
        };
  }

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
      // `settings.read` gates the config GETs, which carry `ServerPassword` for 7DTD and
      // `Password`/`DiscordToken` for PZ. Reported here so the sidebar can omit the
      // Settings link rather than sending a MEMBER to a page whose every panel 403s on
      // load — the same reason the three power booleans exist.
      settings: hasPermission(session.user.role, "settings.read"),
      // The mods page's write controls, added for the reason the three power booleans
      // were: `/minecraft/mods` showed a MEMBER Create Modpack, Edit, Install to Server,
      // Delete, Remove, + Add to Pack and Import, and every one of them answered a bare
      // 403 with nothing saying why.
      //
      // `mods.install` is what POST `/api/modpacks`, `/api/modpacks/[id]/mods`,
      // `/api/modpacks/import`, `/api/mods/install` and `/api/mods/install-modpack`
      // check, plus PUT `/api/modpacks/[id]`. `mods.remove` is what DELETE
      // `/api/mods/[id]`, `/api/modpacks/[id]` and `/api/modpacks/[id]/mods` check. Two
      // flags rather than one because the table keeps them separate, and a future owner
      // may want "may add to a pack" without "may delete a pack".
      //
      // Deliberately NOT covering Export (`/api/modpacks/[id]/export`): that route gates
      // on world access alone and answers a MEMBER happily, because it is a read that
      // hands back download links for a player's own launcher. Hiding it would remove a
      // capability a read-only viewer has rather than one they are refused.
      modsInstall: hasPermission(session.user.role, "mods.install"),
      modsRemove: hasPermission(session.user.role, "mods.remove"),
    },
    memoryGb,
    hostGb: Math.round(hostGb * 10) / 10,
    maxGb,
    // Absent unless `?live=` asked for it, so `busy`, `games`, `can` and every other
    // field keep the exact shape `useGames` (and three power surfaces) read today.
    ...(live ? { live } : {}),
    // So elapsed times are measured against the server's clock rather than the
    // browser's. `Date.now() - busy.since` mixed the two.
    serverNow: Date.now(),
  });
}
