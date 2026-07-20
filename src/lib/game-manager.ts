import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { type GameId } from "@/lib/games";
import { getPlayerList, sendCommand as rconSend } from "@/lib/rcon";
import { getSdtdPlayers, getSdtdTime, sdtdSaveWorld } from "@/lib/telnet";

const execAsync = promisify(exec);

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

// ── Minecraft driver ────────────────────────────────────────────────────────

const minecraftDriver: GameDriver = {
  async status() {
    const { container } = RUNTIME.minecraft;
    const state = await containerState(container);
    if (state !== "running") {
      return { game: "minecraft", status: "offline", players: { online: 0, max: 20, players: [] } };
    }
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
    if (state === "missing") {
      return { game: "7dtd", status: "offline", players: { online: 0, max: 8, players: [] } };
    }
    if (state !== "running") {
      return { game: "7dtd", status: "offline", players: { online: 0, max: 8, players: [] } };
    }
    const startedAt = await containerStartedAt(container);
    // The container can be "running" while SteamCMD is still installing or the
    // world is still generating; probe telnet to see if the game is truly up.
    let players = { online: 0, max: 8, players: [] as string[] };
    let detail: string | undefined;
    let reachable = false;
    try {
      players = await getSdtdPlayers(8);
      const day = await getSdtdTime();
      if (day) detail = day;
      reachable = true;
    } catch {}
    return {
      game: "7dtd",
      status: reachable ? "online" : "starting",
      uptime: startedAt ? fmtUptime(startedAt) : undefined,
      players,
      detail,
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

const DRIVERS: Record<GameId, GameDriver> = {
  minecraft: minecraftDriver,
  "7dtd": sevenDtdDriver,
};

// ── public API ──────────────────────────────────────────────────────────────

export async function getGameStatus(game: GameId): Promise<GameStatus> {
  return DRIVERS[game].status();
}

export async function getAllStatus(): Promise<Record<GameId, GameStatus>> {
  const [mc, sd] = await Promise.all([
    DRIVERS.minecraft.status().catch(() => ({
      game: "minecraft" as GameId,
      status: "offline" as RunStatus,
      players: { online: 0, max: 20, players: [] },
    })),
    DRIVERS["7dtd"].status().catch(() => ({
      game: "7dtd" as GameId,
      status: "offline" as RunStatus,
      players: { online: 0, max: 8, players: [] },
    })),
  ]);
  return { minecraft: mc, "7dtd": sd };
}

export interface HandoffStep {
  step: string;
  game?: GameId;
}

/**
 * Power on `game`. Because the host cannot run both at once, this first
 * gracefully saves + stops the *other* game if it is running. Returns the
 * sequence of steps performed (for the UI's live progress display).
 */
export async function powerOn(game: GameId): Promise<HandoffStep[]> {
  const other: GameId = game === "minecraft" ? "7dtd" : "minecraft";
  const steps: HandoffStep[] = [];

  const otherState = await containerState(RUNTIME[other].container);
  if (otherState === "running") {
    steps.push({ step: "save", game: other });
    steps.push({ step: "stop", game: other });
    await DRIVERS[other].gracefulStop();
  }

  steps.push({ step: "start", game });
  await DRIVERS[game].start();
  return steps;
}

export async function powerOff(game: GameId): Promise<void> {
  await DRIVERS[game].gracefulStop();
}

export async function restartGame(game: GameId): Promise<void> {
  await DRIVERS[game].restart();
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
