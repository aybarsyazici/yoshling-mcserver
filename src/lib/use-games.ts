"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId, ServerStatus } from "@/lib/games";
import { runningWorlds } from "@/lib/coresidency";
import type { LiveSettings } from "@/lib/live-settings";

export interface GameSnapshot {
  game: GameId;
  status: ServerStatus;
  uptime?: string;
  players: { online: number; max: number; players: string[] };
  detail?: string;
  /**
   * Where a booting server has got to. Present only while `status` is "starting".
   * Project Zomboid needs minutes with a big mod list, and "Working…" alone is
   * indistinguishable from stuck — which is exactly how a working auto-update got
   * reported as not running.
   */
  boot?: { stage: string; percent: number | null; detail?: string };
  /**
   * Whether the container is up, regardless of whether the game answers. The UI
   * needs both facts separately: "not running" and "running but not responding"
   * call for different buttons, and treating them the same left no way to recover
   * a wedged server from the dashboard.
   */
  containerRunning?: boolean;
  /** Container start time in ms, for "it has been like this for N minutes". */
  startedAtMs?: number;
}

export interface ControlLock {
  game: GameId;
  action: "start" | "stop" | "restart";
  since: number;
  /**
   * Last proof-of-life from the holder. It has always been on the wire; it was
   * just never declared here, so nothing could tell a slow operation from a dead
   * one on the client side.
   */
  beat: number;
  /** What the operation is doing right now, e.g. "Downloading updated mods". */
  stage?: string;
}

export interface GamesState {
  games: Record<GameId, GameSnapshot> | null;
  activeGame: GameId | null;
  /**
   * Every world whose container is up — plural, and that is the point.
   *
   * `activeGame` is a singular and cannot express the one state this box must not be in.
   * Only one world fits in 16 GB; `powerOn` evicts, but on 2026-09-26 a hand-run
   * `docker start` put Project Zomboid on top of a 7 Days to Die that had been up two
   * days, and the box was 2.2 GB into swap when it was found — and nothing in the app
   * said so — the dashboard whose whole subject is which world holds the box had no way
   * to report that two did.
   *
   * Server-computed from `containerRunning` so that a world which is up but not answering
   * still counts. `runningWorlds(games)` in `lib/coresidency.ts` re-derives the same list
   * client-side and is the fallback used below, so a browser holding this page across a
   * deploy to an older build does not silently stop reporting.
   */
  running: GameId[];
  /** A server power op is in flight (from any client); disables controls. */
  busy: ControlLock | null;
  /**
   * Worlds this user may open. `games` still carries the run state of the others
   * (one server at a time — starting yours stops theirs), but nothing outside
   * this list gets a card, a nav entry or a page.
   */
  access: GameId[];
  /**
   * Which power controls this user may use, so the UI can disable a button instead of
   * letting it 403.
   *
   * ADMIN and MOD all three; MEMBER none. MOD differs from ADMIN only in *scope*
   * (`access`), not capability — see `permissions.ts`. Changed 2026-09-14; power used to
   * be ADMIN-only.
   *
   * This used to say "Restart is open to MOD; start/stop are ADMIN-only", which the
   * table it describes has contradicted since that change (`"server.start"` and
   * `"server.stop"` are both `["ADMIN","MOD"]`). Worth naming the risk, because the
   * tempting way to "reconcile" a comment with its code is the wrong direction here:
   * tightening `permissions.ts` back to ADMIN-only re-breaks exactly what 2026-09-14
   * fixed — a trusted mod could not restart after a Workshop mod update locked players
   * out. The role table is not restated here; one copy is the only kind that stays true.
   */
  can: {
    start: boolean;
    stop: boolean;
    restart: boolean;
    /** `settings.read` — whether the Settings page is worth offering at all. */
    settings: boolean;
    /**
     * `mods.install` / `mods.remove` — the Minecraft mods page's write controls.
     *
     * Same job as the three power flags, one page later: `/minecraft/mods` offered a
     * MEMBER Create Modpack, Edit, Install to Server, Delete, Remove, + Add to Pack and
     * Import, and every one of them answered a bare 403. Two flags because
     * `permissions.ts` keeps the two capabilities separate.
     */
    modsInstall: boolean;
    modsRemove: boolean;
    settingsEdit?: boolean;
    consoleExecute?: boolean;
    filesDelete?: boolean;
    usersManage?: boolean;
  };
  /** Configured heap per world, from the compose file. null = no heap setting. */
  memoryGb: Partial<Record<GameId, number | null>>;
  /** Total host RAM in GB. */
  hostGb: number | null;
  /**
   * The most heap one world may be given (`maxGameGb()`): host total minus a 2.5 GB
   * reserve, ~13 GB on this box. **It assumes that world is the only one running** — it
   * subtracts nothing for whatever else is up. `perWorldCeiling()` is what turns it into
   * a figure a user can act on; do not render it bare.
   */
  maxGb: number | null;
  /**
   * The server's clock at the last poll, minus the browser's at the same moment.
   * Elapsed times add this: `Date.now() - busy.since` mixes a browser clock with a
   * server epoch, and a machine a few minutes out then shows nonsense or negative
   * durations.
   */
  clockSkewMs: number;
  loading: boolean;
  lastSuccessAt?: number | null;
  pollError?: string | null;
  refresh: () => Promise<void>;
}

/**
 * One read of what a world is **actually running**, for the configured-versus-live
 * comparison on a settings page.
 *
 * Deliberately a plain function and not a hook: it is fetched when a settings panel opens
 * and again after a save, never on a timer. The values it returns only change when the
 * game restarts, and the probe costs a telnet session or an RCON round trip — so a second
 * poller next to `useGames`' 4 s one would be pure cost. It rides `/api/games/status` with
 * `?live=` rather than a new endpoint, and the server does the work only when asked.
 *
 * Returns `null` when the request itself failed (offline, 401, a deploy mid-flight). The
 * caller must render that as "not compared", never as a mismatch — `compareSetting()`
 * takes `null` and answers `unknown` for exactly this reason.
 */
export async function fetchLiveSettings(
  game: GameId,
  /**
   * Pass `true` immediately after a write. It skips the server's 10 s cache, which otherwise
   * answers with the pre-write snapshot and makes the chip claim a just-applied setting is
   * not running. Leave it off for anything periodic — the cache exists because this endpoint
   * is polled by every open tab.
   */
  fresh = false
): Promise<LiveSettings | null> {
  try {
    const res = await fetch(
      `/api/games/status?live=${encodeURIComponent(game)}${fresh ? "&fresh=1" : ""}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Shape-checked rather than cast: a browser can hold a page across a deploy, and an
    // older build answers this request with no `live` field at all.
    const live = data?.live;
    if (!live || typeof live !== "object" || typeof live.available !== "boolean") return null;
    return live as LiveSettings;
  } catch {
    return null;
  }
}

/**
 * The interval for a surface that reads `can` and nothing else.
 *
 * Mod controls and the shared settings editor use this cadence for capabilities/world
 * access, rather than a run-state display. Polling makes role/grant changes reach an open
 * page; routes still enforce the current policy if a stale control is pressed.
 *
 * One exported constant rather than a literal per file, because four copies of a number are
 * four things to notice when one of them is wrong.
 */
export const CAPABILITY_POLL_MS = 30_000;

/** Polls /api/games/status. `interval` in ms; pass 0 to disable polling. */
export function useGames(interval = 5000): GamesState {
  const [games, setGames] = useState<Record<GameId, GameSnapshot> | null>(null);
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const [running, setRunning] = useState<GameId[]>([]);
  const [busy, setBusy] = useState<ControlLock | null>(null);
  const [access, setAccess] = useState<GameId[]>([]);
  // Privileged controls and navigation require a successful capability read.
  const [can, setCan] = useState({
    start: false,
    stop: false,
    restart: false,
    settings: false,
    modsInstall: false,
    modsRemove: false,
    settingsEdit: false,
    consoleExecute: false,
    filesDelete: false,
    usersManage: false,
  });
  const [memoryGb, setMemoryGb] = useState<Partial<Record<GameId, number | null>>>({});
  const [hostGb, setHostGb] = useState<number | null>(null);
  const [maxGb, setMaxGb] = useState<number | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const receivedAt = Date.now();
      const res = await fetch("/api/games/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`Status refresh failed (HTTP ${res.status})`);
      const data = await res.json();
      if (!data?.games || !["minecraft", "7dtd", "zomboid"].every((g) => {
        const snap = data.games[g];
        return snap && ["online", "offline", "starting", "stopping", "installing"].includes(snap.status) && snap.players &&
          typeof snap.players.online === "number" && typeof snap.players.max === "number" && Array.isArray(snap.players.players);
      })) throw new Error("Status response is incomplete");
      if (!alive.current || generation !== requestGeneration.current) return;
      setLastSuccessAt(Date.now()); setPollError(null);
      if (typeof data.serverNow === "number") setClockSkewMs(data.serverNow - receivedAt);
      setGames(data.games);
      setActiveGame(data.activeGame ?? null);
      // Prefer the server's list; fall back to deriving it from the snapshot it just
      // sent. The fallback is not defensive padding — a browser can hold this page
      // across a deploy, and an older build that has `games` but no `running` would
      // otherwise report "one world up" while two were, which is the exact silence
      // this field exists to end.
      setRunning(Array.isArray(data.running) ? data.running : runningWorlds(data.games));
      setBusy(data.busy ?? null);
      setAccess(Array.isArray(data.access) ? data.access : []);
      // A response from an older build cannot vouch for newly added capabilities.
      if (data.can)
        setCan({
          ...data.can,
          settings: data.can.settings ?? false,
          modsInstall: data.can.modsInstall ?? false,
          modsRemove: data.can.modsRemove ?? false,
          settingsEdit: data.can.settingsEdit ?? false,
          consoleExecute: data.can.consoleExecute ?? false,
          filesDelete: data.can.filesDelete ?? false,
          usersManage: data.can.usersManage ?? false,
        });
      setMemoryGb(data.memoryGb ?? {});
      setHostGb(typeof data.hostGb === "number" ? data.hostGb : null);
      setMaxGb(typeof data.maxGb === "number" ? data.maxGb : null);
    } catch (error) {
      if (alive.current && generation === requestGeneration.current) setPollError(error instanceof Error ? error.message : "Couldn't refresh server status");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    if (interval > 0) {
      const id = setInterval(refresh, interval);
      return () => {
        alive.current = false;
        clearInterval(id);
      };
    }
    return () => {
      alive.current = false;
    };
  }, [refresh, interval]);

  return {
    games,
    activeGame,
    running,
    busy,
    access,
    can,
    memoryGb,
    hostGb,
    maxGb,
    clockSkewMs,
    loading,
    lastSuccessAt, pollError,
    refresh,
  };
}
