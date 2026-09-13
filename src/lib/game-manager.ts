import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { GAME_LIST, otherGames, type GameId } from "@/lib/games";
import { getPlayerList, sendCommand as rconSend } from "@/lib/rcon";
import { getSdtdStatus, sdtdSaveWorld } from "@/lib/telnet";
import { getPzStatus, pzSave } from "@/lib/zomboid";
import { COMPOSE_FILE, patchServiceEnv, readCompose, readServiceEnv, writeCompose } from "@/lib/compose";

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
}

interface GameDriver {
  status(): Promise<GameStatus>;
  start(): Promise<void>;
  /** Graceful: ask the game to save, then stop the container. */
  gracefulStop(): Promise<void>;
  restart(): Promise<void>;
}

function offlineStatus(game: GameId): GameStatus {
  return {
    game,
    status: "offline",
    players: { online: 0, max: DEFAULT_MAX_PLAYERS[game], players: [] },
  };
}

// ── Minecraft driver ────────────────────────────────────────────────────────

const minecraftDriver: GameDriver = {
  async status() {
    const { container } = RUNTIME.minecraft;
    const state = await containerState(container);
    if (state !== "running") return offlineStatus("minecraft");
    const startedAt = await containerStartedAt(container);
    let players = { online: 0, max: 20, players: [] as string[] };
    try {
      players = await getPlayerList();
    } catch {}
    return {
      game: "minecraft",
      status: "online",
      uptime: startedAt ? fmtUptime(startedAt) : undefined,
      players,
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME.minecraft.container}`);
  },
  async gracefulStop() {
    // Save chunks over RCON before pulling the plug so no progress is lost.
    try {
      await rconSend("save-all flush");
      await new Promise((r) => setTimeout(r, 1500));
    } catch {}
    await execAsync(`docker stop ${RUNTIME.minecraft.container}`);
  },
  async restart() {
    try {
      await rconSend("save-all flush");
    } catch {}
    await execAsync(`docker restart ${RUNTIME.minecraft.container}`);
  },
};

// ── 7 Days to Die driver ────────────────────────────────────────────────────

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
      players: s.players,
      detail: s.time ?? undefined,
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME["7dtd"].container}`);
  },
  async gracefulStop() {
    try {
      await sdtdSaveWorld();
      await new Promise((r) => setTimeout(r, 1000));
    } catch {}
    await execAsync(`docker stop ${RUNTIME["7dtd"].container}`);
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
      players: s.players,
    };
  },
  async start() {
    await execAsync(`docker start ${RUNTIME.zomboid.container}`);
  },
  async gracefulStop() {
    try {
      await pzSave();
      await new Promise((r) => setTimeout(r, 1000));
    } catch {}
    await execAsync(`docker stop -t ${PZ_STOP_TIMEOUT} ${RUNTIME.zomboid.container}`);
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

export interface HandoffStep {
  step: string;
  game?: GameId;
}

// ── control lock ─────────────────────────────────────────────────────────────
//
// The box can only be doing ONE power operation at a time. Without this, a user
// spamming Start/Stop/Restart (or two admins in different tabs) would fire
// overlapping `docker` commands and risk a corrupt save or a wedged container.
// A single in-process lock serializes all control actions; a concurrent request
// is rejected with ControlBusyError (surfaced as HTTP 409). The web app runs as
// one long-lived Node process, so this module-level state is shared across all
// requests. A max age guards against a crashed op locking things forever.

export type ControlAction = "start" | "stop" | "restart";
export interface ControlLock {
  game: GameId;
  action: ControlAction;
  since: number;
}

// Generous: a Project Zomboid stop waits for the world to finish saving (up to
// PZ_STOP_TIMEOUT), and a hand-off does that *before* starting the next world.
const LOCK_MAX_MS = 300_000;
let controlLock: ControlLock | null = null;

export class ControlBusyError extends Error {
  lock: ControlLock;
  constructor(lock: ControlLock) {
    super("A server operation is already in progress");
    this.name = "ControlBusyError";
    this.lock = lock;
  }
}

/** The in-flight control operation, or null. Auto-expires stale locks. */
export function currentControlLock(): ControlLock | null {
  if (controlLock && Date.now() - controlLock.since > LOCK_MAX_MS) {
    controlLock = null;
  }
  return controlLock;
}

async function withControlLock<T>(game: GameId, action: ControlAction, fn: () => Promise<T>): Promise<T> {
  const held = currentControlLock();
  if (held) throw new ControlBusyError(held);
  controlLock = { game, action, since: Date.now() };
  try {
    return await fn();
  } finally {
    controlLock = null;
  }
}

/**
 * Power on `game`. Because the host cannot run more than one world at a time,
 * this first gracefully saves + stops any *other* game that is running.
 * Returns the sequence of steps performed (for the UI's live progress display).
 */
export async function powerOn(game: GameId): Promise<HandoffStep[]> {
  return withControlLock(game, "start", async () => {
    const steps: HandoffStep[] = [];

    for (const other of otherGames(game)) {
      if ((await containerState(RUNTIME[other].container)) !== "running") continue;
      steps.push({ step: "save", game: other });
      steps.push({ step: "stop", game: other });
      await DRIVERS[other].gracefulStop();
    }

    steps.push({ step: "start", game });
    await DRIVERS[game].start();
    return steps;
  });
}

export async function powerOff(game: GameId): Promise<void> {
  return withControlLock(game, "stop", () => DRIVERS[game].gracefulStop());
}

export async function restartGame(game: GameId): Promise<void> {
  return withControlLock(game, "restart", () => DRIVERS[game].restart());
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
export async function setMemory(game: GameId, gb: number): Promise<MemoryState> {
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

  return withControlLock(game, "restart", async () => {
    const value = rt.memory!.format(gb);
    const updates = Object.fromEntries(rt.memory!.keys.map((k) => [k, value]));

    const { text, applied } = patchServiceEnv(await readCompose(), rt.service, updates);
    if (applied.length === 0) {
      throw new Error(`Couldn't find ${rt.memory!.keys.join("/")} in the ${rt.service} service`);
    }
    await writeCompose(text);

    const wasRunning = (await containerState(rt.container)) === "running";
    if (wasRunning) {
      // Save first — recreating a running game server is otherwise a hard kill.
      await DRIVERS[game].gracefulStop();
    }

    // Recreate without starting, then start again only if it was running before.
    await recreateService(game, { start: false });
    if (wasRunning) await DRIVERS[game].start();

    return getMemoryState(game);
  });
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
