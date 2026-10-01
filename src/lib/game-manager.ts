import { readFile } from "fs/promises";
import path from "path";
import { GAMES, GAME_LIST, otherGames, type GameId } from "@/lib/games";
import { sendCommand as rconSend } from "@/lib/rcon";
import { getSdtdStatus, sdtdSaveWorld, sdtdSessionIsGameReady, telnetSession } from "@/lib/telnet";
import { getPzStatus, pzConsole, pzSave, readModState } from "@/lib/zomboid";
import {
  parseGamePrefs,
  parseMcDifficulty,
  parseMcMaxPlayers,
  parsePzOptions,
  redactSecretKeys,
  type LiveSettings,
} from "@/lib/live-settings";
import {
  COMPOSE_FILE,
  ENV_FILE,
  patchEnvFile,
  readCompose,
  readEnvFile,
  readEnvMap,
  readServiceEnv,
  writeEnvFile,
} from "@/lib/compose";
import { runCommand } from "@/lib/docker-cli";
import {
  runOperation,
  type ControlAction,
  type OperationFact,
  type OperationKind,
  type OperationResource,
  type OpHandle,
  type OpSuccess,
} from "@/lib/operations";

/**
 * Every `docker` fork in this module goes through the runner in `docker-cli.ts`
 * rather than a local `promisify(exec)`.
 *
 * That indirection is the only reason anything below is testable. The properties this
 * module exists to hold — that `powerOn` stops every *other* running world before
 * starting one, that `withGameStopped` never starts a world that was already stopped,
 * that a settings change uses `compose create` and never `compose up` — are all
 * statements about which commands run and in what order, and until the runner could be
 * substituted, not one of them had a test. Several were asserted only by a comment, and
 * three audits' worth of findings claimed the opposite.
 *
 * Kept under the old name so no call site below changed: this is a seam, not a rewrite.
 */
const execAsync = runCommand;

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
  /**
   * Compose env key → the `.env` key that compose interpolates it from.
   *
   * This table is what stops the app writing `docker-compose.yml`. Compose is tracked
   * in git and `deploy.sh` runs `git checkout -f`, so every value the UI patched into
   * compose was thrown away by the next deploy — once undone by hand (`f0cf692`), then
   * made loud by `deploy.sh` refusing, but never actually fixed. `.env` is gitignored,
   * so a value written there survives.
   *
   * **Per-service names, deliberately.** `VERSION` is the Minecraft version in one
   * compose block and the Steam branch in another, so a shared `VERSION` key would make
   * editing Minecraft change which build 7 Days to Die downloads. That is the same trap
   * `patchServiceEnv`'s scoping exists for, one layer down.
   *
   * A key absent from here cannot be applied at all: `applyServiceEnv` refuses rather
   * than falling back to patching compose. Falling back is how this feature would
   * silently reacquire the deploy collision it was written to remove.
   */
  envKeys: Record<string, string>;
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
    envKeys: { TYPE: "MC_TYPE", VERSION: "MC_VERSION", MEMORY: "MC_MEMORY" },
    // itzg/minecraft-server: MEMORY sets both -Xms and -Xmx.
    memory: { keys: ["MEMORY"], format: (gb) => `${gb}G` },
  },
  "7dtd": {
    container: "yoshling-7dtd",
    service: "sevendtd",
    dir: process.env.SDTD_SERVER_DIR || "/sevendtd",
    // Nothing. `START_MODE` and `VERSION` are read and written on the compose file
    // itself by `/api/7dtd/update`, which flips START_MODE to 3 and back to 1 within
    // one operation — moving either to `.env` would have the first update rewrite the
    // `${...}` reference into a literal and detach the line permanently. See the
    // comment on those lines in docker-compose.yml.
    envKeys: {},
  },
  zomboid: {
    container: "yoshling-pz",
    service: "zomboid",
    dir: process.env.PZ_SERVER_DIR || "/zomboid",
    envKeys: { MAX_MEMORY: "PZ_MAX_MEMORY" },
    // The PZ image passes MAX_MEMORY straight to -Xmx. Verified on production
    // 2026-09-30: the container's own log shows `-Xms2048m -Xmx12288m` against
    // MIN_MEMORY=2048m / MAX_MEMORY=12288m in compose.
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
   * narrated separately: for Project Zomboid the save takes ~100–170 ms while the
   * stop used to take the full 300 s, and one combined "Saving and stopping" step
   * spends five minutes implying the save is what's slow.
   *
   * **Returns whether the game actually answered.** It used to swallow every error in a
   * bare `catch {}` and return `void`, so `narratedStop` settled "Saved Project Zomboid"
   * on a thrown RCON call — and a stop of a *wedged* server (the documented 2026-09-22
   * state, where RCON is exactly what stops answering) claimed the one thing a player's
   * data depends on without having done it.
   */
  save(): Promise<boolean>;
  /**
   * Stop the container, with this game's own grace period.
   *
   * Both options exist for Project Zomboid, the one game that does not stop on
   * SIGTERM (see `PZ_STOP_TIMEOUT`); Minecraft and 7 Days to Die ignore them and
   * are plain `docker stop`.
   *
   * - `narrate` reports what the stop is *currently* waiting on. A stop that takes
   *   more than a moment has to be able to say why, or it is indistinguishable from
   *   hung — which is precisely how PZ's five-minute stop got reported.
   * - `answering` is whether the game replied to the `save()` that just ran. It is
   *   the only cheap evidence of whether asking it anything else is worth trying,
   *   and it keeps a wedged server's stop from paying for a shutdown handshake it
   *   provably cannot complete.
   */
  stop(opts?: { narrate?: (detail: string) => void; answering?: boolean }): Promise<void>;
  /**
   * Ask the game what settings it is **currently running**, over the channel this module
   * already holds open for status probes.
   *
   * This is the general form of the memory card's configured-versus-live comparison, and
   * it exists because the one defect this codebase keeps shipping is a settings write that
   * reports success without reaching the game. A dashboard that can only read the file it
   * just wrote can never notice that.
   *
   * **Throwing is the contract for "no answer".** `liveSettings()` turns a throw into
   * `available: false` with a reason, and `compareSetting()` turns that into `unknown` —
   * never into a disagreement. Returning a partial map instead of throwing would be read
   * as evidence, so a reader that cannot tell "the game said nothing" from "the game said
   * this" must throw.
   */
  readLive(): Promise<Record<string, string>>;
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
 * 1000 lines of PZ log measures ~85 KB (87,394 bytes, measured 2026-09-29 — three
 * identical reads of `docker logs --tail 1000 yoshling-pz | wc -c`), so 4 MB leaves a
 * wide margin. This said ~167 KB, which was not measured against this world.
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
  /**
   * Two commands on the RCON socket this module already keeps authenticated, so a live
   * read costs no new connection.
   *
   * **Two keys, out of everything the settings page exposes** — that is the honest size of
   * it, because Minecraft has no "dump your properties" command and these are the two it
   * will answer. They are also two worth having: `difficulty` and `max-players` are read at
   * startup only,
   * so an edit that is never applied leaves the file and the world disagreeing silently,
   * which is this project's entire defect class.
   *
   * Measured on production 2026-10-01, three consecutive calls each: `difficulty` → `The
   * difficulty is Hard` in 1.1-1.5 ms (22 bytes), `list` → `There are 0 of a max of 20
   * players online: ` in the same (43 bytes). Sequential rather than `Promise.all`: one
   * socket, and rcon-client correlates by request id — two in flight is a needless race
   * for 1 ms.
   */
  async readLive() {
    const difficulty = parseMcDifficulty(await rconSend("difficulty"));
    const maxPlayers = parseMcMaxPlayers(await rconSend("list"));
    const values: Record<string, string> = {};
    if (difficulty) values["difficulty"] = difficulty;
    if (maxPlayers) values["max-players"] = maxPlayers;
    return values;
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
  /**
   * `getgamepref` in ONE telnet session, the way every other 7DTD read is batched.
   *
   * Measured on production 2026-10-01: 153 `GamePref.` lines, 5,453 bytes, last byte 31 /
   * 81 / 57 ms after the command on three consecutive runs. 61 of those names are also in
   * `sdtdserver.xml`'s 69 properties, and the settings panel hides 5 of the 8 it does not
   * report (`LOCKED` in `/api/7dtd/config/all`) — so **61 of the 64 settings the panel
   * shows are checkable** and exactly three read "not reported": `ServerPassword`,
   * `TelnetFailedLoginLimit`, `TelnetFailedLoginsBlocktime`. Unreported is not a mismatch,
   * and these three are why: they are real properties the game simply does not print.
   *
   * The ready check matters: 7DTD binds telnet **minutes** before the world loads and
   * answers every command with `*** ERROR: Command 'x' can only be executed when a game is
   * started.` for ~40 s of each boot (see `sdtdSessionIsGameReady`). Parsing that output
   * yields zero prefs, which would otherwise be published as "the server reports nothing"
   * — a sentence about the game rather than about the probe.
   */
  async readLive() {
    const out = await telnetSession(["getgamepref"], { timeoutMs: 9000, idleMs: 600 });
    if (!sdtdSessionIsGameReady(out)) {
      throw new Error("7 Days to Die has not started its world yet");
    }
    const values = parseGamePrefs(out);
    if (Object.keys(values).length === 0) {
      throw new Error("getgamepref returned nothing readable");
    }
    return values;
  },
};

// ── Project Zomboid driver ──────────────────────────────────────────────────

// ## Why Project Zomboid needs a shutdown command and the other two do not
//
// This comment used to say: "the container's entrypoint traps SIGTERM, writes
// `quit` to the server console and blocks until the world is written out […] 120s
// proved too short with a player connected — docker escalated to SIGKILL mid-save."
//
// **Every clause of that was false, and it cost three audits.** It described a
// working graceful shutdown whose only problem was being slow, so each audit read
// "PZ stops take five minutes" as a tuning question that had already been answered
// and moved on. Measured on production 2026-09-29:
//
//   - There is no trap. `grep -c trap /server/scripts/entry.sh` → 0, and
//     `grep -rn trap /server/scripts/` is empty across every script in the image.
//   - `entry.sh` is a bash script running as PID 1, and it launches the game through
//     `su - steam -c`, so the JVM is a *grandchild* in its own session and process
//     group — nothing would forward a signal to it even if something caught one.
//   - `grep SigCgt /proc/1/status` → `0000000000010002`, i.e. bits 1 and 16 =
//     SIGINT(2) and SIGCHLD(17). SIGTERM(15) would be bit 14 (`0x4000`) and is not
//     there. **The kernel discards uncaught signals sent to a namespace's PID 1**, so
//     `docker stop`'s SIGTERM is not merely unforwarded — it is thrown away. The
//     process could never have exited on it, at any timeout.
//   - The 120s→300s causation was impossible. A save takes ~100–170 ms: ten consecutive
//     RCON `save` calls answered in 100.7–101.1 ms, and the game's own log reported
//     102.6–170.9 ms for the saves themselves. Nothing was ever "SIGKILLed mid-save" —
//     it is three orders of magnitude inside a 120s budget. Raising the timeout only
//     bought a longer wait before the identical SIGKILL, which is what
//     `journalctl -u docker` shows: 14 × "failed to exit within 5m0s of signal 15" in
//     three days, every one of them this container (`yoshling-pz` is the only service
//     with a 300s `StopTimeout`, and all 14 lines say 5m0s).
//
// So the world was never being written out by signal handling. It was written by the
// `save()` this module sends over RCON just before the stop, and the five minutes
// that followed were pure waiting for a SIGKILL.
//
// What actually makes it exit is asking the game itself: RCON `quit`
// ("* quit : Save and quit the server", confirmed against the live server's `help`).
// `stop()` below does that first and keeps `docker stop` as the fallback.
//
// Verified end-to-end against production on 2026-09-29, 0 players: `save` then `quit`
// over RCON, and the container was `exited` **9.0 s** later (quit at 15:53:33.758Z,
// `.State.FinishedAt` 15:53:42.680Z) with **exit code 0, not 137**. Its log ran
// "Saving took 115.79 ms" → "waiting for UdpEngine thread termination" → "Shutdown
// handling finished", and `journalctl -u docker` gained **no** new "failed to exit"
// line. Same operation before this change: 300 s and a SIGKILL, every time.
//
// `PZ_STOP_TIMEOUT` therefore stays at 300 and stays in step with
// `stop_grace_period` in docker-compose.yml. It is **not** headroom for a slow save;
// it is the budget for a server that has stopped answering RCON at all — the
// documented 2026-09-22 wedge, where `quit` is exactly the thing that cannot land.
// Lowering it without a mechanism that makes the process genuinely exit just
// SIGKILLs a wedged world sooner.
const PZ_STOP_TIMEOUT = 300;

/**
 * How long to wait for an RCON `quit` to actually take the container down before
 * falling back to `docker stop`.
 *
 * A clean quit is fast — measured 9.0 s end to end on production (the save is ~100–170
 * ms; the rest is the UdpEngine thread and JVM teardown). 60 s is ~6× that, because the
 * costs are asymmetric: being too generous adds seconds to the rare fallback path, while
 * being too mean abandons a shutdown that was working and SIGKILLs the world mid-exit.
 *
 * This is a bound on the wait, not an expectation. The loop below exits as soon as the
 * container does, so the healthy path never spends it.
 */
const PZ_QUIT_WAIT_MS = 60_000;
const PZ_QUIT_POLL_MS = 500;

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
  /**
   * Ask the game to quit, then fall back to `docker stop`.
   *
   * See the comment above `PZ_STOP_TIMEOUT` for why `docker stop` alone can never
   * work here: SIGTERM is discarded by the kernel, so this was a guaranteed 300s
   * wait ending in SIGKILL, 14 times in the three days before this was written.
   */
  async stop(opts) {
    const { container } = RUNTIME.zomboid;

    // `answering === false` means the `save()` that just ran got no reply, so the
    // server is not listening on RCON and `quit` provably cannot land either. Skip
    // the handshake rather than spending PZ_QUIT_WAIT_MS proving it again — that
    // would make the one genuinely broken case (the 2026-09-22 wedge) *slower* than
    // it is today, which is the opposite of the point.
    if (opts?.answering === false) {
      opts?.narrate?.(
        `The server is not answering RCON, so it cannot be asked to quit — waiting up to ` +
          `${PZ_STOP_TIMEOUT}s for SIGTERM, which it will not act on, then the kernel kills it`
      );
      await execAsync(`docker stop -t ${PZ_STOP_TIMEOUT} ${container}`);
      return;
    }

    try {
      await pzConsole("quit");
    } catch {
      // Not necessarily a failure. `quit` makes the server close the connection, so
      // losing the reply is an expected *shape of success* and is indistinguishable
      // here from a refusal. Either way the poll below reads the container rather
      // than trusting the reply, and `docker stop` settles whatever it finds — so
      // there is nothing to decide at this point.
    }

    const t0 = Date.now();
    opts?.narrate?.("Asked the server to quit over RCON — waiting for it to exit");
    let exited = false;
    while (Date.now() - t0 < PZ_QUIT_WAIT_MS) {
      if ((await containerState(container)) !== "running") {
        exited = true;
        opts?.narrate?.(`Exited on its own ${((Date.now() - t0) / 1000).toFixed(1)}s after being asked`);
        break;
      }
      await new Promise((r) => setTimeout(r, PZ_QUIT_POLL_MS));
    }
    if (!exited) {
      // The one case this change makes SLOWER, and it is worth saying so: a server that
      // answered the save but then ignored `quit` costs PZ_QUIT_WAIT_MS before the
      // fallback starts its own PZ_STOP_TIMEOUT. That is a failure mode we have never
      // observed — and being told which of the two mechanisms is being waited on is
      // worth more than the seconds, because "Restarting…" with no stage for five
      // minutes is the complaint that started all of this.
      opts?.narrate?.(
        `Still running ${PZ_QUIT_WAIT_MS / 1000}s after being asked to quit — falling back to ` +
          `SIGTERM and up to ${PZ_STOP_TIMEOUT}s before the kernel kills it`
      );
    }

    // UNCONDITIONAL, and must stay that way. On a container that has already exited
    // this is an instant no-op, so it costs nothing on the happy path — and it is the
    // entire fallback when `quit` did not take. Making it conditional on the poll
    // having seen the exit would leave a server that ignored `quit` running while this
    // returned success, which is the defect class this module exists to prevent.
    await execAsync(`docker stop -t ${PZ_STOP_TIMEOUT} ${container}`);
  },
  /**
   * One RCON `showoptions`, on the socket the status probe already holds.
   *
   * Measured on production 2026-10-01 against the live 89-mod world: 137 `* Key=Value`
   * lines, 6,774 bytes, reply 101.4 / 101.5 / 101.4 ms on three consecutive reads — the
   * same ~100 ms round trip the `save` command measures. Those 137 are **all 144 `.ini`
   * keys except** `Password`, `RCONPassword`, `RCONPort`, `DiscordToken` and the three
   * Discord channel names.
   *
   * What that leaves checkable is **derived, not a constant** — recompute it rather than
   * trusting a number here, because an earlier version of this comment said "133 of the
   * 138" and was made wrong by `Map` joining `CARD_OWNED_KEYS` one commit away. The panel
   * hides `INFRA_KEYS` (4) + `CARD_OWNED_KEYS` (3) = 7 of the 144, so it shows **137**;
   * `RCONPassword`/`RCONPort` are in both the hidden set and the unreported set, so the
   * overlap costs nothing and **5** of what it shows read "not reported" (`Password`,
   * `DiscordToken`, the three channels) — **132 checkable**. And all 137 agreed with the
   * file character for character at the time of measurement, so on this box the
   * comparison's resting state is quiet, which is what makes an amber chip mean
   * something.
   */
  async readLive() {
    const values = parsePzOptions(await pzConsole("showoptions", 9000));
    if (Object.keys(values).length === 0) {
      throw new Error("showoptions returned nothing readable");
    }
    return values;
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

/**
 * How long a live-settings read is reused.
 *
 * These values only change when the game is restarted or told to change one at runtime
 * (PZ's `changeoption`), so a short TTL buys nothing — and the read is the expensive half
 * of the comparison (~100 ms for PZ, ~60 ms for 7DTD, ~3 ms for Minecraft, all measured).
 * 10 s is long enough that opening a settings page and saving twice costs one probe, and
 * short enough that the stalest a value can be after a restart is 10 s. It is NOT on the
 * status poll's path: `/api/games/status` only reads this when asked with `?live=`, so the
 * endpoint every tab polls every 4 s is exactly as expensive as it was.
 */
const LIVE_TTL = 10_000;

/**
 * What one game is actually running, or why that is unknown.
 *
 * Behind `cachedProbe` like every other live read in this file, so N tabs opening the
 * settings page coalesce onto one telnet session / one RCON call instead of each opening
 * their own — the same reason `cachedSdtdStatus` exists.
 *
 * **Reachability is decided before the socket is touched**, from the status snapshot this
 * module already caches (3.5 s), and the three outcomes are worded differently on purpose.
 * Two of the three worlds are stopped at any moment, so "stopped" is the *normal* answer
 * here and it must read as an absence of evidence rather than as a finding — an amber
 * "configured does not match live" on a stopped server would make this feature worse than
 * nothing.
 */
async function readLiveSettings(game: GameId): Promise<LiveSettings> {
  const name = GAMES[game].name;
  const unavailable = (reason: string): LiveSettings => ({
    game,
    available: false,
    reason,
    values: {},
    readAt: Date.now(),
  });

  let snap: GameStatus;
  try {
    snap = (await cachedAllStatus())[game];
  } catch {
    return unavailable(`Couldn't tell whether ${name} is running, so nothing was compared.`);
  }

  if (!snap.containerRunning) {
    return unavailable(`${name} is stopped, so there is nothing to compare these against.`);
  }
  if (snap.status !== "online") {
    // The `a7d76b8` split: the container is up but the game is not answering — either
    // still booting or wedged. Either way it cannot say what it is running.
    return unavailable(
      `${name} is running but not answering yet, so there is nothing to compare these against.`
    );
  }

  try {
    const values = redactSecretKeys(await DRIVERS[game].readLive());
    if (Object.keys(values).length === 0) {
      return unavailable(`${name} answered but reported no settings, so nothing was compared.`);
    }
    return { game, available: true, values, readAt: Date.now() };
  } catch {
    return unavailable(`Couldn't read what ${name} is running, so nothing was compared.`);
  }
}

const cachedLive: Record<GameId, () => Promise<LiveSettings>> = {
  minecraft: cachedProbe(LIVE_TTL, () => readLiveSettings("minecraft")),
  "7dtd": cachedProbe(LIVE_TTL, () => readLiveSettings("7dtd")),
  zomboid: cachedProbe(LIVE_TTL, () => readLiveSettings("zomboid")),
};

/**
 * The settings `game` is currently running — cached, single-flighted, and never throwing.
 *
 * A caller gets a `LiveSettings` either way: `available: false` with a reason is the answer
 * for a stopped or silent server, not an error to handle. That is deliberate, because the
 * one thing a caller must not be able to do by accident is treat "I don't know" as "these
 * disagree".
 */
export async function liveSettings(
  game: GameId,
  /**
   * Bypass the cache. Used only immediately after a write.
   *
   * `cachedProbe` is a hard 10 s TTL with no background refresh, and `config-panel.tsx`
   * re-reads the live side the instant a PUT succeeds — so within 10 s of the panel's own
   * load it got the **pre-write** snapshot and rendered amber "running: <old value>" for a
   * setting the route had just applied with `reloadoptions`. Guaranteed on any second save
   * inside ten seconds of the first.
   *
   * That is worse than having no signal: the whole value of this chip is that it is rare, so
   * crying wolf on the write it just proved live trains everyone to ignore it. The cache is
   * right for the polling path (every open tab, every 4 s) and wrong for exactly this one
   * caller, which is why it is a parameter rather than a shorter TTL.
   */
  opts: { fresh?: boolean } = {}
): Promise<LiveSettings> {
  if (opts.fresh) return readLiveSettings(game);
  return cachedLive[game]();
}

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
 * Run a power-adjacent operation. Holds `"power"` plus the `files:` lane of the
 * world it is about to save and stop.
 *
 * It used to hold every world's file lane unconditionally (`POWER_RESOURCES`). That
 * was too broad: admission is what marks in-flight file operations `preempted`, and a
 * power operation on one world was therefore deleting finished backups of worlds it
 * had never touched — see the comment on `POWER_RESOURCES`. `resources` is now
 * overridable for the one case that legitimately needs more than one lane, a hand-off,
 * where `powerOn` names the worlds it found running.
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
    /** Omit for the kind's default (`power` + this world's files). */
    resources?: OperationResource[];
  },
  fn: (op: OpHandle) => Promise<OpSuccess<T>>
): Promise<T> {
  return runOperation(
    {
      kind: spec.kind,
      game: spec.game,
      action: spec.action,
      title: spec.title,
      resources: spec.resources,
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
 * `zomboidDriver.stop()` now asks the game to quit over RCON first, so the healthy
 * path exits 0 and this reports it as such. That makes the check *more* load-bearing,
 * not less: a 137 here is now a real signal — it means `quit` did not land and the
 * fallback had to kill a wedged server — where before it was the routine outcome and
 * told nobody anything.
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

  // The save result stays on the line for the whole stop. It is the fact a player's
  // data depends on, and a stop can run for minutes — so it must not be replaced by
  // the driver's progress, only extended by it.
  const savedPrefix = saved ? `Saved in ${savedMs} ms` : "Not saved";
  // Zomboid's driver narrates its own phases within a few hundred ms and the first of
  // them is "asked it to quit", so do NOT open with "waiting up to 300s" here: that is
  // the fallback budget, and stating it up front is what made a 9-second stop look like
  // a five-minute one before the operator had any other line to read.
  op.detail(
    grace
      ? `${savedPrefix} — asking it to shut down`
      : `${savedPrefix} — waiting for the process to exit`
  );
  await DRIVERS[game].stop({
    answering: saved,
    narrate: (line) => op.detail(`${savedPrefix} — ${line}`),
  });

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
  } else if (exitCode !== 0) {
    // Only 137 used to be special-cased, so every other non-zero code fell into the
    // `else` and was reported with the words "exited cleanly". Measured on production
    // 2026-09-29: a Minecraft stop that ran 60.5 s and exited **255** recorded
    // `Shutdown: exited cleanly (code 255)` with no verdict and summarised as a plain
    // "Stopped Minecraft"; the only warning anywhere came from the save having failed.
    // For contrast, in the same session every healthy stop really was 0 — MC 0.7 s ×4,
    // 7DTD 31.8-33.7 s, PZ 12.5-20.3 s. Whether the world was written out is the one
    // fact a player's save depends on, so a code we cannot vouch for must not be dressed
    // up as one we can. `null` means `docker inspect` gave us nothing, which is also not
    // evidence of a clean exit.
    const code = exitCode ?? "unknown";
    op.settle(`Stopped ${name} — exited with code ${code}`);
    op.fact({ label: "Shutdown", value: `exited with code ${code}`, verdict: "warn", game });
  } else {
    op.settle(`Stopped ${name}`);
    op.fact({ label: "Shutdown", value: `exited cleanly (code ${exitCode})`, game });
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
 *
 * ## The already-running cases are answered BEFORE admission, on purpose
 *
 * This is the mirror of `powerOff`'s guard, and it is what that guard's own comment
 * said it always should have been. Admission is what marks every in-flight file
 * operation `preempted`, so an operation that is going to touch nothing must hold
 * nothing. Measured on production 2026-09-29: a `start zomboid` against a running,
 * answering Project Zomboid returned `{changed:false, steps:[]}`, concluded `nothing`,
 * wrote no Activity row, and `docker events` across the whole window is empty — yet it
 * was admitted holding `power` plus all three file lanes, marked a live 7 Days to Die
 * backup `preempted`, and 26 s later that backup deleted its own finished 304 MB
 * archive on the grounds that it "was taken across a save-and-shutdown boundary".
 * There was no boundary. The control case proves the mechanism: a *no-op stop* eleven
 * seconds earlier, which already answered before admission with `resources: []`, left
 * `preempted` unset.
 */
export async function powerOn(game: GameId, startedBy?: string | null): Promise<HandoffStep[]> {
  // Two cases, and they are not the same claim. If the game ANSWERS, "it just isn't
  // responding yet. Use Restart" is false twice over and pinned a red FAILED card to
  // every page for six hours recommending a pointless restart of a healthy server
  // (observed on production against a PZ reporting 0/32 players over RCON); that is a
  // no-op, not a failure. If the container is up and the game is silent, the original
  // sentence is exactly right and stays. Both branches hold no resources and return no
  // steps, so the route's `changed = steps.length > 0` keeps working unchanged.
  if ((await containerState(RUNTIME[game].container)) === "running") {
    const answering = await DRIVERS[game]
      .status()
      .then((s) => s.status === "online")
      .catch(() => false);
    return runOperation(
      {
        kind: "power",
        game,
        action: "start",
        title: `Starting ${GAMES[game].name}`,
        // Deliberately empty, in both branches: nothing is going to be touched, so
        // nothing may be held and nothing may be pre-empted. The refusal below is the
        // case that was still doing damage after `powerOff` was fixed — a refusal that
        // changes nothing was being admitted with `holdsPower: true`, pre-empting live
        // backups and then keeping a `failed` record for six hours.
        resources: [],
        startedBy: startedBy ? { name: startedBy } : null,
      },
      async (op) => {
        op.step(`Checking ${GAMES[game].name}`, { game });
        if (answering) {
          op.settle(`${GAMES[game].name} was already running and answering`, { kind: "noop" });
          op.fact({ label: "Power", value: "running and answering", game });
          return { value: [] as HandoffStep[] };
        }
        op.reject(`${GAMES[game].name} is already running but not answering`);
        op.fact({ label: "Power", value: "running, not answering", verdict: "warn", game });
        throw new Error(
          `${GAMES[game].name} is already running — it just isn't responding yet. ` +
            `Use Restart if it stays that way.`
        );
      }
    );
  }

  // Probed before admission so the operation can name itself accurately in the ledger
  // AND so it can declare exactly the file lanes it may write. Admission is conflict-
  // checked on `power`, which every world-starting path in this app claims, so between
  // this probe and admission no app path can change which worlds are up; the only
  // remaining case is an out-of-band `docker start`, and the loop below refuses that by
  // name rather than quietly stopping a world it never claimed.
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
    {
      kind: "power",
      game,
      action: "start",
      title,
      startedBy,
      resources: [
        "power",
        `files:${game}`,
        ...runningOthers.map((g) => `files:${g}` as OperationResource),
      ],
    },
    async (op) => {
      const steps: HandoffStep[] = [];

      for (const other of otherGames(game)) {
        if ((await containerState(RUNTIME[other].container)) !== "running") continue;
        if (!runningOthers.includes(other)) {
          // A world came up between the probe and admission, so this operation never
          // claimed its file lane and must not write to it. Only an out-of-band
          // `docker start` can produce this — and it is what produced the 2026-09-26
          // two-worlds-at-once overlap. First code path in the app that detects and
          // reports co-residency instead of silently working around it.
          throw new Error(
            `${GAMES[other].name} started while this operation was being admitted, so ` +
              `${GAMES[game].name} was not started and nothing was stopped. ` +
              `Check which worlds are running and try again.`
          );
        }
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
 * Restart, as `narratedStop` then `narratedStart` — two named phases, never one
 * opaque `docker restart`.
 *
 * Each driver used to carry a `restart()` ("save, then `docker restart`") and a
 * `gracefulStop()` ("save, then `stop`"). Both were deleted in this pass, because
 * **both had zero callers** and the one that remained reachable was a trap: PZ's was
 * a bare `docker restart -t 300`, i.e. exactly the single opaque call this function
 * was written to replace, left sitting in the driver ready for the next person to
 * reach for. One combined call cannot report which half it is in, and for Project
 * Zomboid the stop half dominates — so the UI showed a spinning "Restarting…" with no
 * stage for minutes, which is indistinguishable from hung and got reported as hung.
 *
 * Deleting them is **not** licence to reintroduce a `docker restart`. The `save()` /
 * `stop()` split on `GameDriver` stays: it is what lets each phase name itself, and
 * it is what lets `stop()` know whether the game answered the save — which is now
 * load-bearing for PZ's shutdown (see `PZ_STOP_TIMEOUT`).
 *
 * `narratedStart` returns as soon as the container is up, so the lock releases early
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
  let env: Record<string, string> = {};
  try {
    compose = await readCompose();
    // `.env` is where the UI-owned values now live, and compose only holds a
    // `${MC_MEMORY:-4G}` reference to them. Reading compose alone would answer the
    // literal `${...}` string, `parseGb` would return null, and the card would show
    // "unknown" for a setting that is in fact applied.
    env = await readEnvMap();
  } catch {
    return { minecraft: null, "7dtd": null, zomboid: null };
  }
  const out = {} as Record<GameId, number | null>;
  for (const g of GAME_LIST) {
    const rt = RUNTIME[g.id];
    out[g.id] = rt.memory
      ? parseGb(readServiceEnv(compose, rt.service, rt.memory.keys[0], env))
      : null;
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
  /**
   * The lowest heap this service will accept, from the compose block's `MIN_MEMORY`
   * (`-Xms`). `1` when there is no floor.
   *
   * Reported so the card can stop offering a value `setMemory` will refuse. Project
   * Zomboid's floor is 2 GB — measured on production 2026-09-30, `-Xms2048m -Xmx12288m` in
   * the live JVM — and the card offered 1G, which wrote `-Xmx` under `-Xms` and produced a
   * JVM that will not start. The refusal is the safety net; not offering it is the fix.
   */
  minGb: number;
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
    // `?? 1`: no MIN_MEMORY in the block means no floor (Minecraft's single `MEMORY` sets
    // both bounds), and an unreadable compose is reported by the branches below rather
    // than by pretending there is a floor.
    minGb: (await heapFloorGb(game)) ?? 1,
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
    configuredGb = parseGb(readServiceEnv(await readCompose(), rt.service, key, await readEnvMap()));
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
 * Write UI-owned service settings into `.env`, and prove compose will read them back.
 *
 * ## Why `.env` and not `docker-compose.yml`
 *
 * Compose is tracked in git and the deploy is `git checkout -f -B main FETCH_HEAD`, so
 * every value the dashboard patched into compose was discarded by the next deploy. That
 * was papered over once by hand (`f0cf692`) and then made loud (`deploy.sh` refuses and
 * prints the diff) but never closed. `.env` is gitignored, sits in the directory
 * `composeCmd` `cd`s into — which is the project directory compose loads `.env` from —
 * and compose already interpolated `RCON_PASSWORD` and `SDTD_TELNET_PASSWORD` from it,
 * so the mechanism was proven before this used it.
 *
 * ## The proof, and why it is not optional
 *
 * Writing a key into `.env` establishes nothing on its own: the compose line has to
 * actually reference *that* key. Get the name wrong, or edit compose back to a literal,
 * and the write succeeds, the container is recreated, and the setting silently does not
 * change — the exact "reports success after doing nothing" defect this codebase keeps
 * producing. So after writing, this re-reads both files and resolves the compose line
 * through `.env`; if the answer is not the value asked for, it throws instead of
 * recreating a container for nothing.
 *
 * Refusing an unmapped key matters for the same reason. A key with no `envKeys` entry
 * must not quietly fall back to patching compose, because that is how the deploy
 * collision would come back without anyone changing a line of policy.
 */
async function writeServiceEnvToDotEnv(
  game: GameId,
  updates: Record<string, string>
): Promise<{ applied: string[]; added: string[] }> {
  const rt = RUNTIME[game];

  const mapped: Record<string, string> = {};
  for (const [composeKey, value] of Object.entries(updates)) {
    const envKey = rt.envKeys[composeKey];
    if (!envKey) {
      throw new Error(
        `${composeKey} is not a UI-owned setting for ${rt.service}: it has no .env key in ` +
          `RUNTIME["${game}"].envKeys, so it can only be changed in docker-compose.yml on the server.`
      );
    }
    mapped[envKey] = value;
  }

  const { text, applied, added } = patchEnvFile(await readEnvFile(), mapped);
  await writeEnvFile(text);

  // Read both files back and resolve the compose line through the `.env` we just wrote.
  // This is the same configured-vs-live shape as the memory card, one level earlier: it
  // catches a compose line that no longer interpolates the key we own.
  const compose = await readCompose();
  const env = await readEnvMap();
  for (const [composeKey, value] of Object.entries(updates)) {
    const effective = readServiceEnv(compose, rt.service, composeKey, env);
    if (effective !== value) {
      throw new Error(
        `Wrote ${rt.envKeys[composeKey]}=${value} to ${ENV_FILE}, but the ${rt.service} service's ` +
          `${composeKey} still resolves to ${effective === null ? "nothing" : `"${effective}"`}. ` +
          `docker-compose.yml must read it as \${${rt.envKeys[composeKey]}:-…} — nothing was recreated.`
      );
    }
  }

  return { applied, added };
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
 *
 * The values land in `.env`, not in compose — see `writeServiceEnvToDotEnv` for why,
 * and for the read-back that proves compose will actually pick them up.
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
      op.step(`Editing ${ENV_FILE}`, { game });
      const { applied } = await writeServiceEnvToDotEnv(game, updates);
      op.settle(`Set ${applied.join(", ")} in ${ENV_FILE}`);

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

/**
 * The floor a game's heap may not go under, because `-Xmx` below `-Xms` is a JVM that
 * refuses to start at all.
 *
 * Project Zomboid's compose block sets both, and only `MAX_MEMORY` is UI-owned
 * (`RUNTIME.zomboid.memory.keys`). Measured on production 2026-09-30, from the
 * container's own log: `-Xms2048m -Xmx12288m` against `MIN_MEMORY: "2048m"` and
 * `MAX_MEMORY: "12288m"` — the two lines reach the JVM verbatim. So picking 1 GB on the
 * memory card wrote `-Xmx1024m` under `-Xms2048m`, and the JVM dies on
 * "Initial heap size set to a larger value than the maximum heap size" before the game
 * exists. The card then compared configured against live, found them equal, and rendered
 * the setting as applied — green, correct by its own lights, and the world unbootable.
 *
 * Returns null when the service declares no minimum (Minecraft: `MEMORY` sets both).
 */
async function heapFloorGb(game: GameId): Promise<number | null> {
  const rt = RUNTIME[game];
  try {
    const compose = await readCompose();
    const env = await readEnvMap();
    return parseGb(readServiceEnv(compose, rt.service, "MIN_MEMORY", env));
  } catch {
    // Unreadable compose is already handled by `getMemoryState`, which says so. Not
    // being able to read the floor is not a reason to refuse a change outright.
    return null;
  }
}

/**
 * A heap value that cannot be applied — out of range, or under the service's `-Xms`.
 *
 * A distinct class so `/api/games/memory` can answer **400** rather than 500. The message
 * reached the user either way (the card toasts `data.error`), but a 500 says "the server
 * broke", and this is the server working correctly and declining. The status code is what a
 * log, a monitor or a future retry reads.
 */
export class MemoryRangeError extends Error {
  readonly isMemoryRange = true;
}

export function isMemoryRangeError(e: unknown): e is MemoryRangeError {
  return e instanceof Error && (e as MemoryRangeError).isMemoryRange === true;
}

export async function setMemory(game: GameId, gb: number, startedBy?: string | null): Promise<MemoryState> {
  const rt = RUNTIME[game];
  if (!rt.memory) throw new Error("This server has no memory setting");
  const cap = await maxGameGb();
  if (!Number.isFinite(gb) || gb < 1 || gb > cap) {
    throw new MemoryRangeError(
      `Memory must be between 1 and ${cap} GB. This host has ` +
        `${Math.round(await hostTotalGb())} GB, and the server needs roughly a gigabyte ` +
        `above its heap plus room for the OS and the dashboard.`
    );
  }

  // Checked BEFORE the operation is admitted, like the cap above: a change that cannot
  // be applied must not stop the world, recreate its container, or mark an in-flight
  // backup pre-empted on the way to failing.
  const floorGb = await heapFloorGb(game);
  if (floorGb !== null && gb < floorGb) {
    throw new MemoryRangeError(
      `${GAMES[game].name}'s heap can't be set below ${floorGb} GB: docker-compose.yml also ` +
        `sets MIN_MEMORY (-Xms) to ${floorGb} GB, and a JVM with -Xmx under -Xms refuses to ` +
        `start. Nothing was changed. Lower MIN_MEMORY on the server first if you really need ` +
        `${gb} GB.`
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
      op.step(`Editing ${ENV_FILE}`, { game });
      const { applied } = await writeServiceEnvToDotEnv(game, updates);
      op.settle(`Set ${applied.join(", ")} to ${value} in ${ENV_FILE}`);

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
