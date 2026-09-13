import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { GAME_LIST, otherGames, type GameId } from "@/lib/games";
import { getPlayerList, sendCommand as rconSend } from "@/lib/rcon";
import { getSdtdStatus, sdtdSaveWorld } from "@/lib/telnet";
import { getPzStatus, pzSave } from "@/lib/zomboid";

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
  /** Directory (mounted in the web container) that holds this game's files */
  dir: string;
  ram: string;
}

/** Per-game container + path config. Kept in one place. */
export const RUNTIME: Record<GameId, GameRuntime> = {
  minecraft: {
    container: "yoshling-mc",
    dir: process.env.MC_SERVER_DIR || "/minecraft",
    ram: "4G",
  },
  "7dtd": {
    container: "yoshling-7dtd",
    dir: process.env.SDTD_SERVER_DIR || "/sevendtd",
    ram: "5G",
  },
  zomboid: {
    container: "yoshling-pz",
    dir: process.env.PZ_SERVER_DIR || "/zomboid",
    ram: "4G",
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
const PZ_STOP_TIMEOUT = 120;

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
