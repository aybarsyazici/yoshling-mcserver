import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { GAMES, GAME_LIST, otherGames, type GameId } from "@/lib/games";
import { sendCommand as rconSend } from "@/lib/rcon";
import { getSdtdStatus, sdtdSaveWorld } from "@/lib/telnet";
import { getPzStatus, pzSave, readModState } from "@/lib/zomboid";
import { COMPOSE_FILE, patchServiceEnv, readCompose, readServiceEnv, writeCompose } from "@/lib/compose";
import {
  POWER_RESOURCES,
  runOperation,
  type ControlAction,
  type OperationFact,
  type OperationKind,
  type OpHandle,
  type OpSuccess,
} from "@/lib/operations";

const execAsync = promisify(exec);

/**
 * Wrap a live probe (7DTD telnet, PZ RCON) so N browser tabs / rapid polls
 * share ONE connection instead of each opening its own — which spammed the
 * game console and churned the socket. Short TTL keeps the UI feeling live;
 * single-flight coalesces concurrent callers onto the same request.
 */
function cachedProbe<T>(ttlMs: number, probe: () => Promise<T>): () => Promise<T> {
  let cache: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.data);
    if (inflight) return inflight;
    inflight = probe()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

const PROBE_TTL = 4000;
const cachedSdtdStatus = cachedProbe(PROBE_TTL, () => getSdtdStatus(8));
const cachedPzStatus = cachedProbe(PROBE_TTL, () => getPzStatus());

export type RunStatus = "online" | "offline" | "starting" | "stopping" | "installing";

export interface GameRuntime {
  container: string;
  /** docker-compose service name — NOT the same as the container name */
  service: string;
  /** Directory (mounted in the web container) that holds this game's files */
  dir: string;
  ram: string;
  /**
   * How this game's JVM heap is configured, or undefined when it has none.
   * 7 Days to Die is a Unity native server with no heap setting, so there is
   * genuinely nothing to change there.
   */
  memory?: { keys: string[]; format: (gb: number) => string };
}

/** Per-game container + path config. Kept in one place. */
export const RUNTIME: Record<GameId, GameRuntime> = {
  minecraft: {
    container: "yoshling-mc",
    service: "minecraft",
    dir: process.env.MC_SERVER_DIR || "/minecraft",
    ram: "4G",
    // itzg/minecraft-server: MEMORY sets both -Xms and -Xmx.
    memory: { keys: ["MEMORY"], format: (gb) => `${gb}G` },
  },
  "7dtd": {
    container: "yoshling-7dtd",
    service: "sevendtd",
    dir: process.env.SDTD_SERVER_DIR || "/sevendtd",
    ram: "5G",
  },
  zomboid: {
    container: "yoshling-pz",
    service: "zomboid",
    dir: process.env.PZ_SERVER_DIR || "/zomboid",
    ram: "4G",
    // The PZ image passes MAX_MEMORY straight to -Xmx.
    memory: { keys: ["MAX_MEMORY"], format: (gb) => `${gb * 1024}m` },
  },
};

/** Player cap to show before the game itself can tell us (i.e. while offline). */
const DEFAULT_MAX_PLAYERS: Record<GameId, number> = {
  minecraft: 20,
  "7dtd": 8,
  zomboid: 16,
};

// ── low-level docker helpers ────────────────────────────────────────────────

async function containerState(container: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Status}}' ${container} 2>/dev/null`
    );
    return stdout.trim().replace(/'/g, "");
  } catch {
    return "missing";
  }
}

async function containerStartedAt(container: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.StartedAt}}' ${container}`
    );
    const t = new Date(stdout.trim().replace(/'/g, "")).getTime();
    return isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * Every recreate goes through compose, pinned to the same project name, so the
 * new container inherits the labels, network aliases, ports and mounts of the
 * old one. Hand-building `docker run` instead is what produces a container
 * compose can't adopt — and then the next `docker compose up` either errors on
 * the name or orphans it.
 */
export const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || "yoshling";

function composeCmd(args: string): string {
  return `cd ${path.dirname(COMPOSE_FILE)} && docker compose -p ${COMPOSE_PROJECT} ${args}`;
}

/**
 * After any recreate: exactly one container may own the name, and it must be
 * compose-managed. Anything else means we've made a mess and should say so
 * loudly rather than leave a duplicate or an orphan behind.
 */
async function assertSingleContainer(name: string, service: string): Promise<void> {
  const { stdout } = await execAsync(
    `docker ps -a --filter name=^/${name}$ --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'`
  );
  const rows = stdout.trim().split("\n").filter(Boolean);

  if (rows.length === 0) throw new Error(`${name} is gone after the recreate — check the server`);
  if (rows.length > 1) {
    throw new Error(
      `${name} now has ${rows.length} containers. Remove the extras with \`docker rm\` before continuing.`
    );
  }
  const [, project, svc] = rows[0].split("|");
  if (project !== COMPOSE_PROJECT || svc !== service) {
    throw new Error(
      `${name} isn't managed by compose any more (project=${project || "none"}, service=${svc || "none"}). ` +
        `Recreate it with \`docker compose up -d --no-deps ${service}\`.`
    );
  }
}

function fmtUptime(startMs: number): string {
  const diff = Date.now() - startMs;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// ── driver abstraction ──────────────────────────────────────────────────────

export interface GameStatus {
  game: GameId;
  status: RunStatus;
  uptime?: string;
  players: { online: number; max: number; players: string[] };
  /** Free-form extra info: MC version, or 7DTD in-game day */
  detail?: string;
  /**
   * Where a booting server has got to. Only set while `status` is "starting".
   * Every game takes minutes to come up — PZ with a large mod list, 7DTD when
   * SteamCMD is fetching 17 GB — and without this the UI can only say "Working…",
   * which is indistinguishable from stuck.
   *
   * `detail` is the most recent concrete thing that happened (the mod currently
   * loading, the file being downloaded). It answers "is it moving?" in a way a
   * percentage cannot when the percentage sits still for a minute.
   */
  boot?: { stage: string; percent: number | null; detail?: string };
  /**
   * Whether the CONTAINER is up, independent of whether the game answers.
   *
   * These are different facts and conflating them cost two evenings: a wedged
   * game means the probe fails, the UI renders it as stopped, and it then offers
   * "Power on" — which runs `docker start` on an already-running container, a
   * silent no-op. Knowing the container is up is what lets the UI offer the action
   * that can actually recover it (Restart) and refuse the one that cannot.
   */
  containerRunning: boolean;
  /** Container start time in ms, so the UI can say how long it has been like this. */
  startedAtMs?: number;
}

interface GameDriver {
  status(): Promise<GameStatus>;
  start(): Promise<void>;
  /**
   * Ask the game to write the world out. Split from `stop()` so the two can be
   * narrated separately: for Project Zomboid the save takes 433 ms and the stop
   * takes the full 300 s, and one combined "Saving and stopping" step spends five
   * minutes implying the save is what's slow.
   *
   * **Returns whether the game actually answered.** It used to swallow every error in a
   * bare `catch {}` and return `void`, so `narratedStop` settled "Saved Project Zomboid"
   * on a thrown RCON call — and a stop of a *wedged* server (the documented 2026-09-22
   * state, where RCON is exactly what stops answering) claimed the one thing a player's
   * data depends on without having done it.
   */
  save(): Promise<boolean>;
  /** Stop the container, with this game's own grace period. */
  stop(): Promise<void>;
  /** Graceful: `save()` then `stop()`. */
  gracefulStop(): Promise<void>;
  restart(): Promise<void>;
}

function offlineStatus(game: GameId): GameStatus {
  return {
    game,
    status: "offline",
    players: { online: 0, max: DEFAULT_MAX_PLAYERS[game], players: [] },
    containerRunning: false,
  };
}

/**
 * `--since` for "this run only", as a `docker logs` argument.
 *
 * Every reader of a booting container's log needs it, and each one computing it costs a
 * `docker inspect` fork — so a probe that needs both the marker counts and the last
 * matching line works it out once and passes it to both.
 */
async function logSince(container: string): Promise<string> {
  const started = await containerStartedAt(container);
  return started ? new Date(started).toISOString() : "15m";
}

/**
 * Count log markers for a booting container in one `docker logs | awk` pass.
 *
 * One subprocess per probe rather than one per pattern, because the status
 * endpoint is polled by every open tab. Returns an empty object if the container
 * has no logs yet, so callers fall back to a generic stage instead of throwing.
 */
async function bootMarkers(
  container: string,
  awkProgram: string,
  sinceArg?: string
): Promise<Record<string, number>> {
  const since = sinceArg ?? (await logSince(container));
  const { stdout } = await execAsync(
    `docker logs --since '${since}' ${container} 2>&1 | awk '${awkProgram}'`,
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const out: Record<string, number> = {};
  for (const pair of stdout.trim().split(/\s+/)) {
    const [k, v] = pair.split("=");
    if (k) out[k] = Number(v) || 0;
  }
  return out;
}

/**
 * Last line matching `grep -E pattern`, trimmed — the "what just happened" line.
 *
 * **Scoped to the current run**, exactly as `bootMarkers` is. Without `--since` it read
 * the whole container log, so for the first ~20 s of every boot the row's detail line was
 * the PREVIOUS run's last match. Measured on production 2026-09-29: a fresh Project
 * Zomboid boot rendered "Scanning maps / 5%" with the detail "RCON: listening on port
 * 27015" from the run that had just been SIGKILLed — a line that, had it belonged to this
 * run, would have made the stage "Ready / 100%" by the probe's own branch order. The
 * stage and the detail contradicted each other on the one surface this whole feature
 * exists to make trustworthy.
 */
async function lastLogLine(
  container: string,
  pattern: string,
  sinceArg?: string
): Promise<string | undefined> {
  try {
    const since = sinceArg ?? (await logSince(container));
    const { stdout } = await execAsync(
      `docker logs --since '${since}' --tail 4000 ${container} 2>&1 | grep -E ${JSON.stringify(
        pattern
      )} | tail -1`,
      { maxBuffer: 4 * 1024 * 1024 }
    );
    const line = stdout.trim();
    return line ? line.slice(0, 160) : undefined;
  } catch {
    return undefined;
  }
}

/** Widest tail the console pane may ask for, and the default when it asks for nonsense. */
const MAX_LOG_LINES = 1000;
const DEFAULT_LOG_LINES = 200;

/**
 * Tail a game container's log for the console pane.
 *
 * `lines` comes off a query string, so it is clamped and NaN-guarded here rather
 * than trusted: `parseInt("abc")` is NaN, `docker logs --tail NaN` dumps the
 * ENTIRE log — 123 MB for Project Zomboid, measured 2026-09-28 — which overran
 * exec's buffer, whereupon the console route handed the buffer error back as if
 * the server had printed it. One place for the clamp and the buffer so the three
 * console routes cannot drift apart again (only PZ's had a `maxBuffer`).
 * 1000 lines of PZ log measures ~167 KB, so 4 MB leaves a wide margin.
 */
export async function tailContainerLog(game: GameId, lines: number): Promise<string> {
  const tail = Number.isFinite(lines)
    ? Math.min(Math.max(Math.trunc(lines), 1), MAX_LOG_LINES)
    : DEFAULT_LOG_LINES;
  const { stdout } = await execAsync(
    `docker logs --tail ${tail} ${RUNTIME[game].container} 2>&1`,
    { maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
}

// ── Minecraft driver ────────────────────────────────────────────────────────

/**
 * How far Minecraft has got. Marker flags come from one `awk` pass; the line that
 * carries a number is fetched separately and parsed here, because extracting a
 * capture group inside awk needs gawk's `match(s, re, arr)` and Debian ships mawk.
 */
const cachedMcBoot = cachedProbe(
  3000,
  async (): Promise<{ stage: string; percent: number | null; detail?: string }> => {
    const c = RUNTIME.minecraft.container;
    // One `docker inspect` for both reads below, so scoping them to this run costs
    // nothing extra on a status poll.
    const since = await logSince(c);
    let m: Record<string, number>;
    try {
      m = await bootMarkers(
        c,
        // The first three markers are the ones that make this ladder observable at all.
        // Measured on production 2026-09-29: `yoshling-mc` spends 26 of its 28 boot
        // seconds inside the image's `[init]` phase, and the four original markers all
        // land in the last two — so every sample of a real Minecraft boot returned the 5%
        // floor and the ladder never moved. `[init]` starts at t+0, the Fabric line at
        // t+12s and the mod count immediately after it.
        "/\\[init\\]/{i=1} /Loading Minecraft .* with Fabric Loader/{f=1} " +
          "/Loading [0-9]+ mods/{md=1} " +
          "/Starting minecraft server/{a=1} /Preparing level/{b=1} " +
          "/Preparing spawn area/{c=1} /Done \\(/{d=1} " +
          'END{printf "init=%d fabric=%d mods=%d start=%d level=%d spawn=%d done=%d", ' +
          "i+0, f+0, md+0, a+0, b+0, c+0, d+0}",
        since
      );
    } catch {
      return { stage: "Starting up", percent: null };
    }

    const detail = await lastLogLine(
      c,
      "Done \\(|Preparing spawn area|Preparing level|Starting minecraft server|" +
        "Loading [0-9]+ mods|Loading Minecraft .* with Fabric Loader|\\[init\\]",
      since
    );

    if (m.done) return { stage: "Ready", percent: 100, detail };
    if (m.spawn) {
      // "Preparing spawn area: 62%" — the only phase that reports its own progress.
      const pct = detail ? Number(/(\d+)%/.exec(detail)?.[1] ?? NaN) : NaN;
      return {
        stage: Number.isFinite(pct) ? `Generating spawn area (${pct}%)` : "Generating spawn area",
        percent: Number.isFinite(pct) ? Math.round(50 + (pct / 100) * 45) : 50,
        detail,
      };
    }
    if (m.level) return { stage: "Preparing the world", percent: 45, detail };
    if (m.start) return { stage: "Starting the server", percent: 35, detail };
    if (m.mods) {
      // "Loading 44 mods:" — the count is real, so it is shown rather than a spinner.
      const n = detail ? Number(/Loading (\d+) mods/.exec(detail)?.[1] ?? NaN) : NaN;
      return {
        stage: Number.isFinite(n) ? `Loading mods (${n})` : "Loading mods",
        percent: 20,
        detail,
      };
    }
    if (m.fabric) return { stage: "Loading the mod loader", percent: 12, detail };
    if (m.init) return { stage: "Preparing the container", percent: 6, detail };
    return { stage: "Starting container", percent: 5, detail };
  }
);

const minecraftDriver: GameDriver = {
  async status() {
    const { container } = RUNTIME.minecraft;
    const state = await containerState(container);
    if (state !== "running") return offlineStatus("minecraft");
    const startedAt = await containerStartedAt(container);

    // This used to report "online" the moment the container was up, which is a lie
    // while the world is still generating — and it meant Minecraft could never show
    // boot progress at all. `list` throwing is what distinguishes booting from up.
    let reachable = false;
    let players = { online: 0, max: DEFAULT_MAX_PLAYERS.minecraft, players: [] as string[] };
    try {
      const res = await rconSend("list");
      reachable = true;
      const m = /There are (\d+) of a max of (\d+) players online:(.*)/.exec(res);
      if (m) {
        players = {
          online: Number(m[1]),
          max: Number(m[2]),
          players: m[3].split(",").map((x) => x.trim()).filter(Boolean),
        };
      }
    } catch {}

    return {
      game: "minecraft",
      status: reachable ? "online" : "starting",
      uptime: startedAt ? fmtUptime(startedAt) : undefined,
      startedAtMs: startedAt ? new Date(startedAt).getTime() : undefined,
      containerRunning: true,
      players,
      boot: reachable ? undefined : await cachedMcBoot().catch(() => undefined),
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME.minecraft.container}`);
  },
  async save() {
    // Save chunks over RCON before pulling the plug so no progress is lost.
    try {
      await rconSend("save-all flush");
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    } catch {
      return false;
    }
  },
  async stop() {
    await execAsync(`docker stop ${RUNTIME.minecraft.container}`);
  },
  async gracefulStop() {
    await minecraftDriver.save();
    await minecraftDriver.stop();
  },
  async restart() {
    try {
      await rconSend("save-all flush");
    } catch {}
    await execAsync(`docker restart ${RUNTIME.minecraft.container}`);
  },
};

// ── 7 Days to Die driver ────────────────────────────────────────────────────

/**
 * How far 7DTD has got. Worth real detail because a first install downloads
 * ~17 GB through SteamCMD before the game even starts — that phase reports its own
 * byte progress, and without surfacing it the server looks hung for 20 minutes.
 */
const cachedSdtdBoot = cachedProbe(
  3000,
  async (): Promise<{ stage: string; percent: number | null; detail?: string }> => {
    const c = RUNTIME["7dtd"].container;
    const since = await logSince(c);
    let m: Record<string, number>;
    try {
      m = await bootMarkers(
        c,
        "/Update state .*downloading/{dl=1} /Update state .*verifying|Validating/{vf=1} " +
          // No `$` anchor: it failed to match in practice against the real log. Matching
          // "StartGame done" too is harmless, because `done` is checked first below.
          "/INF StartGame/{sg=1} /Loading players.xml/{pl=1} " +
          "/Calculating world hashes/{wh=1} /chunk groups/{ch=1} /StartGame done/{dn=1} " +
          'END{printf "dl=%d vf=%d sg=%d pl=%d wh=%d ch=%d done=%d", dl+0, vf+0, sg+0, pl+0, wh+0, ch+0, dn+0}',
        since
      );
    } catch {
      return { stage: "Starting up", percent: null };
    }

    const detail = await lastLogLine(
      c,
      "StartGame done|chunk groups|Calculating world hashes|Loading players.xml|INF StartGame|Update state|Validating",
      since
    );

    if (m.done) return { stage: "Opening the server to players", percent: 97, detail };
    if (m.ch) return { stage: "Indexing world chunks", percent: 88, detail };
    if (m.wh) return { stage: "Checking the world", percent: 80, detail };
    if (m.pl) return { stage: "Loading players", percent: 72, detail };
    if (m.sg) return { stage: "Starting the game", percent: 65, detail };
    if (m.vf) return { stage: "Verifying game files", percent: 58, detail };
    if (m.dl) {
      // "Update state (0x61) downloading, progress: 39.24 (6945342749 / 17701152170)"
      const pct = detail ? Number(/progress:\s*([0-9.]+)/.exec(detail)?.[1] ?? NaN) : NaN;
      const gb = detail ? /\((\d+) \/ (\d+)\)/.exec(detail) : null;
      const size = gb
        ? ` — ${(Number(gb[1]) / 1e9).toFixed(1)} of ${(Number(gb[2]) / 1e9).toFixed(1)} GB`
        : "";
      return {
        stage: Number.isFinite(pct)
          ? `Downloading game files (${pct.toFixed(0)}%)${size}`
          : "Downloading game files",
        // The download is the bulk of a first boot, so it owns 5-55%.
        percent: Number.isFinite(pct) ? Math.round(5 + (pct / 100) * 50) : null,
        detail,
      };
    }
    return { stage: "Starting container", percent: 3, detail };
  }
);

const sevenDtdDriver: GameDriver = {
  async status() {
    const { container } = RUNTIME["7dtd"];
    const state = await containerState(container);
    if (state !== "running") return offlineStatus("7dtd");
    const startedAt = await containerStartedAt(container);
    // The container can be "running" while SteamCMD is still installing or the
    // world is still generating; probe telnet (ONE session) to see if the game
    // is truly up. Cached below so many tabs don't each hammer telnet.
    const s = await cachedSdtdStatus();
    return {
      game: "7dtd",
      status: s.reachable ? "online" : "starting",
      uptime: startedAt ? fmtUptime(startedAt) : undefined,
      startedAtMs: startedAt ? new Date(startedAt).getTime() : undefined,
      containerRunning: true,
      players: s.players,
      detail: s.time ?? undefined,
      boot: s.reachable ? undefined : await cachedSdtdBoot().catch(() => undefined),
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME["7dtd"].container}`);
  },
  async save() {
    try {
      await sdtdSaveWorld();
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    } catch {
      return false;
    }
  },
  async stop() {
    await execAsync(`docker stop ${RUNTIME["7dtd"].container}`);
  },
  async gracefulStop() {
    await sevenDtdDriver.save();
    await sevenDtdDriver.stop();
  },
  async restart() {
    try {
      await sdtdSaveWorld();
    } catch {}
    await execAsync(`docker restart ${RUNTIME["7dtd"].container}`);
  },
};

// ── Project Zomboid driver ──────────────────────────────────────────────────

// The container's entrypoint traps SIGTERM, writes `quit` to the server console
// and blocks until the world is written out. Saving can take well over docker's
// default 10s grace period, so every stop/restart passes an explicit timeout.
// 120s proved too short with a player connected — docker escalated to SIGKILL
// mid-save. Keep this in step with `stop_grace_period` in docker-compose.yml.
const PZ_STOP_TIMEOUT = 300;

/**
 * How far into its boot Project Zomboid is, read out of the container log.
 *
 * Mod loading dominates (89 mods ≈ minutes), and each one logs `> loading <id>`,
 * so counting those against the length of `Mods=` gives a real percentage rather
 * than a spinner. One `docker logs | awk` pass rather than streaming the whole
 * log into node — it can be 100k+ lines.
 */
const cachedPzBoot = cachedProbe(
  3000,
  async (): Promise<{ stage: string; percent: number | null; detail?: string }> => {
  const since = await logSince(RUNTIME.zomboid.container);
  let counts = { loading: 0, started: 0, rcon: 0, maps: 0, workshop: 0, jvm: 0 };
  try {
    const { stdout } = await execAsync(
      `docker logs --since '${since}' ${RUNTIME.zomboid.container} 2>&1 | awk '` +
        `/> loading /{l++} /SERVER STARTED/{s=1} /RCON: listening/{r=1} ` +
        `/Found [0-9]+ map\\(s\\)|INFO: Added maps/{m=1} /Workshop: /{w=1} /using jvm/{j=1} ` +
        `END{printf "%d %d %d %d %d %d", l+0, s+0, r+0, m+0, w+0, j+0}'`,
      { maxBuffer: 1024 * 1024 }
    );
    const [l, st, r, m, w, j] = stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
    counts = { loading: l, started: st, rcon: r, maps: m, workshop: w, jvm: j };
  } catch {
    return { stage: "Starting up", percent: null };
  }

  // Total comes from Mods=, so the denominator is whatever is actually enabled.
  let total = 0;
  try {
    total = (await readModState()).modIds.length;
  } catch {}

  // PZ has the most to say while booting: an 89-mod load can sit on one percentage
  // for a minute, so naming the mod currently loading is what shows it is moving.
  const detail = await lastLogLine(
    RUNTIME.zomboid.container,
    "> loading |Workshop: |SERVER STARTED|RCON: listening",
    since
  );

  if (counts.rcon) return { stage: "Ready", percent: 100, detail };
  if (counts.started) return { stage: "Opening the server to players", percent: 97, detail };
  if (counts.loading > 0) {
    // Mods are ~15%→90% of the wait; the world still has to load afterwards.
    const frac = total > 0 ? Math.min(1, counts.loading / total) : 0;
    return {
      stage: total > 0
        ? `Loading mods (${Math.min(counts.loading, total)} of ${total})`
        : `Loading mods (${counts.loading})`,
      percent: total > 0 ? Math.round(15 + frac * 75) : null,
      detail,
    };
  }
  if (counts.jvm) return { stage: "Loading the game", percent: 12, detail };
  if (counts.workshop) return { stage: "Checking Workshop mods", percent: 8, detail };
  if (counts.maps) return { stage: "Scanning maps", percent: 5, detail };
  return { stage: "Starting container", percent: 2, detail };
});

const zomboidDriver: GameDriver = {
  async status() {
    const { container } = RUNTIME.zomboid;
    const state = await containerState(container);
    if (state !== "running") return offlineStatus("zomboid");
    const startedAt = await containerStartedAt(container);
    // The container is "running" while the JVM boots and Workshop mods
    // download; RCON only answers once the world is actually loaded.
    const s = await cachedPzStatus();
    return {
      game: "zomboid",
      status: s.reachable ? "online" : "starting",
      uptime: startedAt ? fmtUptime(startedAt) : undefined,
      startedAtMs: startedAt ? new Date(startedAt).getTime() : undefined,
      containerRunning: true,
      players: s.players,
      // Only while booting: once RCON answers there's nothing left to report.
      boot: s.reachable ? undefined : await cachedPzBoot().catch(() => undefined),
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME.zomboid.container}`);
  },
  async save() {
    try {
      await pzSave();
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    } catch {
      return false;
    }
  },
  async stop() {
    await execAsync(`docker stop -t ${PZ_STOP_TIMEOUT} ${RUNTIME.zomboid.container}`);
  },
  async gracefulStop() {
    await zomboidDriver.save();
    await zomboidDriver.stop();
  },
  async restart() {
    try {
      await pzSave();
    } catch {}
    await execAsync(`docker restart -t ${PZ_STOP_TIMEOUT} ${RUNTIME.zomboid.container}`);
  },
};

const DRIVERS: Record<GameId, GameDriver> = {
  minecraft: minecraftDriver,
  "7dtd": sevenDtdDriver,
  zomboid: zomboidDriver,
};

// ── public API ──────────────────────────────────────────────────────────────

export async function getGameStatus(game: GameId): Promise<GameStatus> {
  return DRIVERS[game].status();
}

export async function getAllStatus(): Promise<Record<GameId, GameStatus>> {
  const entries = await Promise.all(
    GAME_LIST.map(
      async (g) => [g.id, await DRIVERS[g.id].status().catch(() => offlineStatus(g.id))] as const
    )
  );
  return Object.fromEntries(entries) as Record<GameId, GameStatus>;
}

/**
 * `getAllStatus`, coalesced.
 *
 * A full sweep is ~6 `docker inspect` forks at rest and ~15 while a world boots
 * (`docker logs | awk` plus a `lastLogLine`). `/api/games/status` is polled every
 * 4s by up to six independent `useGames` instances on one page, and the operations
 * endpoint polls every 1.5s for the boot projection — so without a shared cache
 * the ledger would multiply a measured problem. 3.5s is under the status poll's own
 * interval, so no consumer sees data older than it already tolerates.
 */
export const cachedAllStatus = cachedProbe(3500, getAllStatus);

export interface HandoffStep {
  step: string;
  game?: GameId;
}

// ── power operations ─────────────────────────────────────────────────────────
//
// The box can only be doing ONE power operation at a time. Without that, a user
// spamming Start/Stop/Restart (or two admins in different tabs) would fire
// overlapping `docker` commands and risk a corrupt save or a wedged container.
//
// The lock itself now lives in `src/lib/operations.ts`, as the registry entry
// holding the `"power"` resource — `currentControlLock()` is a projection of it,
// so `busy` keeps its exact wire shape. Expiry is still judged on the heartbeat and
// there is still **no cap on total duration**: at 300s that cap was shorter than a
// single Project Zomboid graceful stop, so a mod-update apply lost its own lock
// partway through, a second operation started on top, and two SteamCMD runs raced
// on the workshop volume until one reported "updated 0 of 1 mods".

export {
  ControlBusyError,
  OperationConflictError,
  currentControlLock,
  setControlStage,
  type ControlAction,
  type ControlLock,
} from "@/lib/operations";

/**
 * Run a power-adjacent operation. Holds `"power"` plus every `files:` lane, since
 * saving and stopping a world writes that world's files.
 *
 * Always records where the world was left, **including on the failure path**: a
 * failed summary that doesn't say whether the server came back is the least useful
 * sentence we could write, because `restart: "no"` means nothing revives Project
 * Zomboid and nothing else on the page says so either.
 */
async function withPowerOperation<T>(
  spec: {
    kind: OperationKind;
    game: GameId;
    action: ControlAction;
    title: string;
    startedBy?: string | null;
  },
  fn: (op: OpHandle) => Promise<OpSuccess<T>>
): Promise<T> {
  return runOperation(
    {
      kind: spec.kind,
      game: spec.game,
      action: spec.action,
      title: spec.title,
      resources: POWER_RESOURCES,
      startedBy: spec.startedBy ? { name: spec.startedBy } : null,
    },
    async (op) => {
      try {
        return await fn(op);
      } catch (err) {
        try {
          const state = await containerState(RUNTIME[spec.game].container);
          op.fact({
            label: "Power",
            value: state === "running" ? "still running" : "still powered off",
          });
        } catch {
          /* nothing to add; the summary falls back to "check its page" */
        }
        throw err;
      }
    }
  );
}

/** Read back what happened to the process, not just whether `docker` exited 0. */
async function containerExit(container: string): Promise<{ state: string; exitCode: number | null }> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Status}}|{{.State.ExitCode}}' ${container}`
    );
    const [state, code] = stdout.trim().replace(/'/g, "").split("|");
    const n = Number(code);
    return { state, exitCode: Number.isFinite(n) ? n : null };
  } catch {
    return { state: "missing", exitCode: null };
  }
}

/**
 * Save the world and stop the container, as two named steps, and say what actually
 * became of the process.
 *
 * `docker stop -t 300` exits 0 whether the container went quietly or was SIGKILLed
 * at the end of the grace period — and **Project Zomboid never exits on SIGTERM**,
 * so every PZ stop reported a clean success and hid the kill. `.State.ExitCode` is
 * the only place that fact exists; 137 is 128 + SIGKILL.
 *
 * ## Why it reads the container first
 *
 * `.State.ExitCode` **persists across runs**, so reading it without having observed
 * this operation stop something attributes the previous run's death to this one.
 * Measured on production 2026-09-29: a 135 ms stop of an already-exited Project Zomboid
 * reported `Shutdown: killed after 300s` (verdict warn → amber `partial`) and summarised
 * as "stopped in 0s, but it had to be killed after 300s" — a sentence that refutes
 * itself, built from a 137 left by an operation that had ended 2m 47s earlier. The same
 * path reported "Saved Minecraft" and "exited cleanly (code 0)" for `yoshling-mc` in
 * state `created`, which had never run at all: code 0 is docker's zero value.
 *
 * So: observe `running` first, or claim nothing. Having observed it, the exit code that
 * follows our own `docker stop` cannot belong to another run.
 *
 * Returns whether a running container was actually stopped, so callers can avoid
 * recording durable side effects (an Activity row) for a no-op.
 */
async function narratedStop(op: OpHandle, game: GameId): Promise<boolean> {
  const name = GAMES[game].name;
  if ((await containerState(RUNTIME[game].container)) !== "running") {
    op.step(`Checking ${name}`, { game });
    op.settle(`${name} was already stopped — nothing to save or stop`, { kind: "noop" });
    return false;
  }

  op.step(`Saving ${name}`, { game });
  const t0 = Date.now();
  const saved = await DRIVERS[game].save();
  const savedMs = Date.now() - t0;
  if (saved) {
    op.settle(`Saved ${name}`);
  } else {
    // The game did not answer, so the world was NOT written out. This is the one claim
    // in a stop that a player's data depends on, and it is exactly the claim a wedged
    // server cannot honour.
    op.settle(`Could not save ${name} — it did not answer`, { kind: "noop" });
    op.fact({
      label: "Save",
      value: "the world was not saved — the server did not answer",
      verdict: "warn",
      game,
    });
  }

  const grace = game === "zomboid" ? PZ_STOP_TIMEOUT : null;
  op.step(`Stopping ${name}`, { game });
  op.detail(
    grace
      ? `${saved ? `Saved in ${savedMs} ms` : "Not saved"} — waiting up to ${grace}s for the process to exit`
      : `${saved ? `Saved in ${savedMs} ms` : "Not saved"} — waiting for the process to exit`
  );
  await DRIVERS[game].stop();

  const { state, exitCode } = await containerExit(RUNTIME[game].container);
  if (state === "running") {
    // Proceeding here is how two worlds end up co-resident, which is an open
    // defect on this box. Refuse instead.
    throw new Error(
      `${name}'s container is still running after docker stop — nothing else was done. ` +
        `Check the server before trying again.`
    );
  }
  // `game` on the fact, always: on a hand-off the operation's own world is the one
  // coming UP, and the summary used to blame it for this world's SIGKILL.
  if (exitCode === 137 && grace) {
    op.settle(`Stopped ${name} — killed after ${grace}s`);
    op.fact({ label: "Shutdown", value: `killed after ${grace}s`, verdict: "warn", game });
  } else if (exitCode === 137) {
    op.settle(`Stopped ${name} — killed at the end of the grace period`);
    op.fact({
      label: "Shutdown",
      value: "killed at the end of the grace period",
      verdict: "warn",
      game,
    });
  } else {
    op.settle(`Stopped ${name}`);
    op.fact({ label: "Shutdown", value: `exited cleanly (code ${exitCode ?? "?"})`, game });
  }
  return true;
}

/**
 * The narrated stop and start, for a route that already holds an operation.
 *
 * `/api/7dtd/reset` is the case: it needs a stop and a start *inside* one operation,
 * and `powerOff`/`restartGame` each enter an operation of their own, which this one's
 * own resources would refuse. Before this it called them anyway — acquiring and
 * releasing the lock twice — which left two unlocked windows in the middle of a
 * destructive operation for a Power on to interleave with.
 */
export async function stopGameForOperation(op: OpHandle, game: GameId): Promise<boolean> {
  return narratedStop(op, game);
}

export async function startGameForOperation(op: OpHandle, game: GameId): Promise<void> {
  return narratedStart(op, game);
}

export async function containerIsRunning(game: GameId): Promise<boolean> {
  return (await containerState(RUNTIME[game].container)) === "running";
}

/** Start the container and prove it came up, rather than assuming `docker start` meant it. */
async function narratedStart(op: OpHandle, game: GameId): Promise<void> {
  const name = GAMES[game].name;
  op.step(`Starting ${name}`, { game });
  await DRIVERS[game].start();
  const state = await containerState(RUNTIME[game].container);
  if (state === "running") {
    op.settle("Started the container");
    op.fact({ label: "Power", value: "running" });
  } else {
    // `docker start` exited 0 and the container is not up: a crash-loop looks
    // exactly like this, and calling it a success is the defect this whole module
    // exists to stop.
    op.settle(`Ran docker start — the container is "${state}"`, { kind: "noop" });
    op.fact({ label: "Power", value: state, verdict: "bad" });
  }
}

/**
 * Power on `game`. Because the host cannot run more than one world at a time,
 * this first gracefully saves + stops any *other* game that is running.
 * Returns the sequence of steps performed (for the UI's live progress display).
 */
export async function powerOn(game: GameId, startedBy?: string | null): Promise<HandoffStep[]> {
  // Probed before admission ONLY so the operation can name itself accurately in the
  // ledger; every authoritative check is repeated inside, under the lock.
  const runningOthers: GameId[] = [];
  for (const other of otherGames(game)) {
    if ((await containerState(RUNTIME[other].container)) === "running") runningOthers.push(other);
  }
  const title = runningOthers.length
    ? `Starting ${GAMES[game].name} — saving and stopping ${runningOthers
        .map((g) => GAMES[g].name)
        .join(" and ")} first`
    : `Starting ${GAMES[game].name}`;

  return withPowerOperation(
    { kind: "power", game, action: "start", title, startedBy },
    async (op) => {
      const steps: HandoffStep[] = [];

      // Refuse rather than silently succeed. `docker start` on a running container
      // is a no-op, so a wedged server used to report "powering on" and then do
      // nothing at all — which reads as the dashboard being broken. Say what is true
      // and name the action that would help.
      //
      // Two cases, and they are not the same claim. If the game ANSWERS, "it just isn't
      // responding yet. Use Restart" is false twice over and pinned a red FAILED card to
      // every page for six hours recommending a pointless restart of a healthy server
      // (observed on production against a PZ reporting 0/32 players over RCON); that is a
      // no-op, not a failure. If the container is up and the game is silent, the original
      // sentence is exactly right and stays.
      if ((await containerState(RUNTIME[game].container)) === "running") {
        const answering = await DRIVERS[game]
          .status()
          .then((s) => s.status === "online")
          .catch(() => false);
        if (answering) {
          op.step(`Checking ${GAMES[game].name}`, { game });
          op.settle(`${GAMES[game].name} was already running and answering`, { kind: "noop" });
          op.fact({ label: "Power", value: "running and answering", game });
          return { value: steps };
        }
        throw new Error(
          `${GAMES[game].name} is already running — it just isn't responding yet. ` +
            `Use Restart if it stays that way.`
        );
      }

      for (const other of otherGames(game)) {
        if ((await containerState(RUNTIME[other].container)) !== "running") continue;
        steps.push({ step: "save", game: other });
        steps.push({ step: "stop", game: other });
        await narratedStop(op, other);
      }

      steps.push({ step: "start", game });
      await narratedStart(op, game);
      return { value: steps };
    }
  );
}

/**
 * Power `game` off. Returns whether a running container was actually stopped, so the
 * caller can skip the durable Activity row when nothing happened.
 *
 * ## The already-stopped case is answered BEFORE admission, on purpose
 *
 * A stop of a world that is already down must not be admitted as a power operation at
 * all, because admission is what marks every in-flight file operation `preempted`.
 * Measured on production 2026-09-29: two 135 ms / 89 ms no-op stops invalidated and
 * **deleted** a 7 Days to Die backup that had already written a 290 MB archive, on the
 * grounds that it had been "taken across a save-and-shutdown boundary". There was no
 * boundary; nothing on the box moved in that window (`docker events` over it is empty).
 * A record that holds no resources cannot pre-empt anything, and the mirror of
 * `powerOn`'s own guard is what this always should have been.
 */
export async function powerOff(game: GameId, startedBy?: string | null): Promise<boolean> {
  if ((await containerState(RUNTIME[game].container)) !== "running") {
    return runOperation(
      {
        kind: "power",
        game,
        action: "stop",
        title: `Saving and stopping ${GAMES[game].name}`,
        // Deliberately empty: nothing is going to be touched, so nothing may be held
        // and nothing may be pre-empted.
        resources: [],
        startedBy: startedBy ? { name: startedBy } : null,
      },
      async (op) => {
        op.step(`Checking ${GAMES[game].name}`, { game });
        op.settle(`${GAMES[game].name} was already powered off`, { kind: "noop" });
        op.fact({ label: "Power", value: "powered off", game });
        return { value: false };
      }
    );
  }

  return withPowerOperation(
    {
      kind: "power",
      game,
      action: "stop",
      title: `Saving and stopping ${GAMES[game].name}`,
      startedBy,
    },
    async (op) => {
      const stopped = await narratedStop(op, game);
      op.fact({ label: "Power", value: "powered off" });
      return { value: stopped };
    }
  );
}

/**
 * Save + stop `game`, run `whileStopped`, then start it again — all while
 * holding the control lock, so a restart from the UI can't interleave.
 *
 * Exists for the Workshop mod updater: replacing mod files under a running
 * server means overwriting files the JVM has open and partly mmap'd, so the
 * download has to happen with the world down. A world that was already stopped
 * stays stopped, and `restarted` says which it was.
 *
 * The restart is in a `finally` because `seedMods` throws on a partial SteamCMD
 * download ("updated 0 of 1 mods"). Without it the start was simply skipped and
 * Project Zomboid stayed down for good — `restart: "no"` means nothing revives
 * it — so a failed mod update took the server offline until someone noticed. The
 * error still propagates; the world is just not collateral damage.
 */
export async function withGameStopped(
  game: GameId,
  action: ControlAction,
  /**
   * The work to do while the world is down. Receives the operation handle, so a
   * caller can name its own steps and — more importantly — attach the evidence
   * that decides the outcome. Callers that don't need it can ignore the argument.
   */
  whileStopped: (op: OpHandle) => Promise<void>,
  opts: {
    /** What to say while the callback runs. Surfaces in the ledger. */
    stage?: string;
    /** What kind of operation this really is, so the summary reads correctly. */
    kind?: OperationKind;
    /** Present-tense title, rendered verbatim. */
    title?: string;
    startedBy?: string | null;
    /**
     * Whether to start the world again when the callback *throws*.
     *
     * The two callers want opposite things, and getting it backwards is silent.
     *
     * A mod update wants `true`: `seedMods` throws on a partial download, and
     * leaving the world down for a mod that failed to fetch is a worse outcome
     * than booting the previous version — `restart: "no"` means nothing else will
     * ever revive it.
     *
     * A **restore** wants `false`. If the extract or the copy dies partway, the
     * save and the player DB are half-replaced, and booting onto that is worse
     * than staying down: the game will happily rewrite the mess on its first
     * autosave and take the archive's contents with it. Staying stopped is
     * recoverable — it leaves the archive intact and a second restore possible.
     */
    restartOnFailure?: boolean;
  } = {}
): Promise<{ restarted: boolean }> {
  const { stage, restartOnFailure = true, kind = "power", title, startedBy } = opts;
  return withPowerOperation(
    {
      kind,
      game,
      action,
      title: title ?? `Restarting ${GAMES[game].name}`,
      startedBy,
    },
    async (op) => {
      const wasRunning = (await containerState(RUNTIME[game].container)) === "running";
      if (wasRunning) await narratedStop(op, game);
      let failed = false;
      try {
        // Only open a step when the caller gave one. A caller that narrates itself
        // (`op.step` / `op.settle`, or the legacy `setControlStage` shim) would
        // otherwise leave a stray "Working" row settled above its own.
        if (stage) op.step(stage, { game });
        await whileStopped(op);
        if (stage) op.settle(stage);
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        if (wasRunning && (!failed || restartOnFailure)) {
          await narratedStart(op, game);
        } else if (!wasRunning) {
          op.fact({ label: "Power", value: "powered off" });
        }
      }
      // "Restored but the world stayed down" is a materially different outcome from
      // "restored and it's coming back up", and nothing else on the page says which.
      op.fact({ label: "Server", value: wasRunning ? "starting again" : "left powered off" });
      return { value: { restarted: wasRunning } };
    }
  );
}

/** The image the game's container was created from, for one-off helper runs. */
export async function containerImage(game: GameId): Promise<string> {
  const { stdout } = await execAsync(
    `docker inspect ${RUNTIME[game].container} --format '{{.Config.Image}}'`
  );
  return stdout.trim();
}

/**
 * Restart, as stop-then-start rather than `driver.restart()`.
 *
 * Every driver's `restart()` is "save, then `docker restart`" — one opaque call,
 * so it could not report which half it was in. For Project Zomboid the stop half
 * alone is up to `PZ_STOP_TIMEOUT` (300s), and with no stage set the UI showed a
 * spinning "Restarting…" and nothing else for minutes, which reads as hung.
 * Splitting it is behaviourally identical (`gracefulStop` = save + `docker stop
 * -t N`, `start` = `docker start`) and lets each phase name itself.
 *
 * `start()` returns as soon as the container is up, so the lock releases early
 * and the UI falls through to the richer per-boot progress (`snap.boot`).
 */
export async function restartGame(game: GameId, startedBy?: string | null): Promise<void> {
  return withPowerOperation(
    {
      kind: "power",
      game,
      action: "restart",
      title: `Restarting ${GAMES[game].name}`,
      startedBy,
    },
    async (op) => {
      // Checked here rather than inside `narratedStop`, so a restart of a world that is
      // already down records "nothing to stop" as evidence instead of a `noop` step —
      // which would drag the whole record to `partial` and a "but it did not go cleanly"
      // sentence about an operation that did exactly what was asked.
      const wasRunning = (await containerState(RUNTIME[game].container)) === "running";
      if (wasRunning) await narratedStop(op, game);
      await narratedStart(op, game);
      if (!wasRunning) {
        op.fact({ label: "Shutdown", value: "nothing to stop — it was already off", game });
      }
      return { value: undefined as void };
    }
  );
}

// ── server memory ────────────────────────────────────────────────────────────
//
// A container's environment is fixed when the container is CREATED. `docker
// restart` re-runs the same container with the same env, so editing compose and
// restarting looks like it worked and silently doesn't — which is exactly the
// trap this hit before. The only thing that applies a new heap size is
// recreating the container, so that's what setMemory does, and it reads the
// value back off the new container afterwards to prove it took.

/**
 * The most heap we can hand a game, worked out from the host rather than
 * guessed. Two things eat memory beyond `-Xmx`:
 *   - the JVM's own off-heap use. Measured on this box: Project Zomboid's RSS
 *     runs ~0.9 GB above its heap (native Steam libs, mmap'd map/tile data).
 *   - the OS, docker and the dashboard: ~1.6 GB measured.
 * So reserve 2.5 GB and the rest is available as heap. A hardcoded number was
 * wrong here — it offered 6 GB on a 7.5 GB box, which OOM-kills the server.
 */
const HOST_RESERVE_GB = 2.5;

export async function hostTotalGb(): Promise<number> {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf-8");
    const kb = Number(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
    if (kb > 0) return kb / 1024 / 1024;
  } catch {}
  return 8;
}

export async function maxGameGb(): Promise<number> {
  return Math.max(1, Math.floor((await hostTotalGb()) - HOST_RESERVE_GB));
}

/**
 * Replace a game's container from the compose file — the ONLY sanctioned way to
 * apply a configuration change, because a container's env, ports and mounts are
 * fixed when it's created.
 *
 * `start: false` uses `compose create`, which recreates the container without
 * running it: a stopped world must stay stopped, or changing its settings would
 * quietly start it and evict whichever world currently holds the box.
 * Either way the result is checked for duplicates before we return.
 *
 * **This function takes no lock and enters no operation.** It reads as the
 * sanctioned safe helper and is not a complete one: that is precisely why
 * `/api/7dtd/update` — its only direct caller — was entirely untracked, leaving a
 * 17 GB SteamCMD download running inside a container that nothing was watching and
 * nothing would refuse to interleave with. Call it from inside `runOperation` (or
 * `applyServiceEnv`), never straight from a route.
 */
export async function recreateService(
  game: GameId,
  { start }: { start: boolean }
): Promise<void> {
  const rt = RUNTIME[game];
  await execAsync(
    composeCmd(
      start
        ? `up -d --no-deps --force-recreate ${rt.service}`
        : `create --force-recreate ${rt.service}`
    ),
    { timeout: 180000 }
  );
  await assertSingleContainer(rt.container, rt.service);
}

/**
 * The heap size compose is configured with, per game. Read from the compose file
 * (not `docker inspect`, which forks a process) and cached, because the status
 * endpoint that shows it is polled every few seconds by every open tab.
 *
 * The UI used to display a hardcoded `ramGb` from games.ts, which silently went
 * stale the moment anyone changed the setting or resized the box.
 */
const configuredMemory = cachedProbe(15_000, async (): Promise<Record<GameId, number | null>> => {
  let compose = "";
  try {
    compose = await readCompose();
  } catch {
    return { minecraft: null, "7dtd": null, zomboid: null };
  }
  const out = {} as Record<GameId, number | null>;
  for (const g of GAME_LIST) {
    const rt = RUNTIME[g.id];
    out[g.id] = rt.memory ? parseGb(readServiceEnv(compose, rt.service, rt.memory.keys[0])) : null;
  }
  return out;
});

export async function configuredMemoryGb(): Promise<Record<GameId, number | null>> {
  return configuredMemory();
}

export interface MemoryState {
  game: GameId;
  /** Total host RAM, so the UI can explain the ceiling. */
  hostGb: number;
  /** False for games with no configurable heap (7 Days to Die). */
  supported: boolean;
  reason?: string;
  /** What docker-compose.yml says. */
  configuredGb: number | null;
  /** What the existing container was actually created with. */
  liveGb: number | null;
  /** configured === live, i.e. the setting is really in effect. */
  applied: boolean;
  running: boolean;
  maxGb: number;
}

/** "4G" / "4096m" → GB. */
function parseGb(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d+)\s*([gGmM])?$/.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (m[2] || "m").toLowerCase() === "g" ? n : Math.round((n / 1024) * 100) / 100;
}

/** The value a key has in the container that exists right now. */
async function liveEnv(container: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `docker inspect ${container} --format '{{range .Config.Env}}{{println .}}{{end}}'`
    );
    for (const line of stdout.split("\n")) {
      const [k, ...rest] = line.split("=");
      if (k.trim() === key) return rest.join("=").trim();
    }
  } catch {}
  return null;
}

export async function getMemoryState(game: GameId): Promise<MemoryState> {
  const rt = RUNTIME[game];
  const running = (await containerState(rt.container)) === "running";
  const base = {
    game,
    running,
    maxGb: await maxGameGb(),
    hostGb: Math.round((await hostTotalGb()) * 10) / 10,
  };

  if (!rt.memory) {
    return {
      ...base,
      supported: false,
      reason: `${game === "7dtd" ? "7 Days to Die" : game} has no memory setting — it's a native server, not a JVM, so the container uses what it needs.`,
      configuredGb: null,
      liveGb: null,
      applied: true,
    };
  }

  const key = rt.memory.keys[0];
  let configuredGb: number | null = null;
  try {
    configuredGb = parseGb(readServiceEnv(await readCompose(), rt.service, key));
  } catch {
    return {
      ...base,
      supported: false,
      reason: `Can't read ${COMPOSE_FILE}. Memory can only be changed on the server itself.`,
      configuredGb: null,
      liveGb: null,
      applied: true,
    };
  }

  const liveGb = parseGb(await liveEnv(rt.container, key));
  return {
    ...base,
    supported: true,
    configuredGb,
    liveGb,
    // No container yet = nothing to disagree with; it'll be created with the
    // configured value on first power on.
    applied: liveGb === null || liveGb === configuredGb,
  };
}

/**
 * Change the heap size and make it take effect. Serialized with the power
 * controls, because it stops and recreates a container.
 */
/**
 * Apply a compose-env change to one service and recreate it, safely.
 *
 * A container's env is fixed when it is created, so a new value only takes effect
 * on a recreate — and a recreate has three traps this encodes once so no caller has
 * to remember them:
 *
 *  1. **`create`, never `up`.** `up` starts the container, so applying a setting to
 *     a *stopped* world would boot it — and since only one world fits on the box,
 *     that quietly produces two running at once. Start it again afterwards only if
 *     it was running to begin with.
 *  2. **Save first.** Recreating a running game server is otherwise a hard kill.
 *  3. **Take the control lock**, so this cannot interleave with a power operation.
 *
 * `/api/settings` (Minecraft version/loader) open-coded a `docker compose up -d
 * --force-recreate` and got all three wrong; `setMemory` had them right. Both now
 * come through here.
 */
export async function applyServiceEnv(
  game: GameId,
  updates: Record<string, string>,
  { stage, setting, startedBy }: { stage: string; setting?: string; startedBy?: string | null }
): Promise<void> {
  const rt = RUNTIME[game];
  return withPowerOperation(
    { kind: "settings", game, action: "restart", title: stage, startedBy },
    async (op) => {
      op.step("Editing docker-compose.yml", { game });
      const { text, applied } = patchServiceEnv(await readCompose(), rt.service, updates);
      if (applied.length === 0) {
        throw new Error(
          `Couldn't find ${Object.keys(updates).join("/")} in the ${rt.service} service block of docker-compose.yml`
        );
      }
      await writeCompose(text);
      op.settle(`Patched ${applied.join(", ")} in docker-compose.yml`);

      const wasRunning = (await containerState(rt.container)) === "running";
      if (wasRunning) await narratedStop(op, game);

      op.step("Recreating the container", { game });
      await recreateService(game, { start: false });
      op.settle("Recreated the container");

      if (wasRunning) await narratedStart(op, game);
      else op.fact({ label: "Power", value: "powered off" });

      // Read the env back off the NEW container. A container's env is fixed when it
      // is created, so "we wrote the compose file" proves nothing on its own — this
      // is the same configured-vs-live comparison the memory card makes, which is
      // the one report in this codebase that has never been wrong.
      await recordEnvApplied(op, game, updates, setting ?? Object.keys(updates).join("/"));
      return { value: undefined as void };
    }
  );
}

/** Compare what compose now says against what the new container was created with. */
async function recordEnvApplied(
  op: OpHandle,
  game: GameId,
  updates: Record<string, string>,
  setting: string
): Promise<void> {
  const rt = RUNTIME[game];
  const wanted = Object.entries(updates)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const live: string[] = [];
  let agrees = true;
  for (const [k, v] of Object.entries(updates)) {
    const got = await liveEnv(rt.container, k);
    live.push(`${k}=${got ?? "unset"}`);
    if (got !== v) agrees = false;
  }
  op.fact({ label: "Setting", value: setting });
  op.fact({ label: "Configured", value: wanted });
  op.fact({ label: "Container", value: live.join(", "), verdict: agrees ? undefined : "warn" });
}

export async function setMemory(game: GameId, gb: number, startedBy?: string | null): Promise<MemoryState> {
  const rt = RUNTIME[game];
  if (!rt.memory) throw new Error("This server has no memory setting");
  const cap = await maxGameGb();
  if (!Number.isFinite(gb) || gb < 1 || gb > cap) {
    throw new Error(
      `Memory must be between 1 and ${cap} GB. This host has ` +
        `${Math.round(await hostTotalGb())} GB, and the server needs roughly a gigabyte ` +
        `above its heap plus room for the OS and the dashboard.`
    );
  }

  return withPowerOperation(
    {
      kind: "settings",
      game,
      action: "restart",
      title: `Changing ${GAMES[game].name}'s memory setting`,
      startedBy,
    },
    async (op) => {
      const value = rt.memory!.format(gb);
      const updates = Object.fromEntries(rt.memory!.keys.map((k) => [k, value]));

      // This used to set no stage at all — `applyServiceEnv` sets four — so a
      // Project Zomboid memory change showed a bare "Restarting" for the whole 300s
      // stop, which is exactly the "indistinguishable from hung" failure that
      // splitting `restartGame` into save/stop/start was meant to eliminate.
      op.step("Editing docker-compose.yml", { game });
      const { text, applied } = patchServiceEnv(await readCompose(), rt.service, updates);
      if (applied.length === 0) {
        throw new Error(`Couldn't find ${rt.memory!.keys.join("/")} in the ${rt.service} service`);
      }
      await writeCompose(text);
      op.settle(`Set ${applied.join(", ")} to ${value} in docker-compose.yml`);

      const wasRunning = (await containerState(rt.container)) === "running";
      // Save first — recreating a running game server is otherwise a hard kill.
      if (wasRunning) await narratedStop(op, game);

      // Recreate without starting, then start again only if it was running before.
      op.step("Recreating the container", { game });
      await recreateService(game, { start: false });
      op.settle("Recreated the container");

      if (wasRunning) await narratedStart(op, game);
      else op.fact({ label: "Power", value: "powered off" });

      const state = await getMemoryState(game);
      op.fact({ label: "Setting", value: "Memory" });
      op.fact({ label: "Configured", value: `${state.configuredGb ?? gb} GB` });
      op.fact({
        label: "Container",
        value: state.liveGb != null ? `${state.liveGb} GB` : "no container yet",
        verdict: state.applied ? undefined : "warn",
      });
      return { value: state };
    }
  );
}

// ── config file readers (shared) ─────────────────────────────────────────────

export async function getMinecraftProperties(): Promise<Record<string, string>> {
  const filePath = path.join(RUNTIME.minecraft.dir, "server.properties");
  const content = await readFile(filePath, "utf-8");
  const properties: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...valueParts] = line.split("=");
    properties[key.trim()] = valueParts.join("=").trim();
  }
  return properties;
}
