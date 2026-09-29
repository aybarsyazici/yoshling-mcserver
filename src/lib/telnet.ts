import net from "net";

/**
 * Minimal telnet client for the 7 Days to Die dedicated server control port
 * (default 8081). We connect per-request because 7DTD's telnet is chatty and
 * long-lived sockets drift; a short-lived session is more robust.
 *
 * IMPORTANT: always send `exit` before closing so 7DTD tears the connection
 * down cleanly. Just dropping the socket makes the server log a noisy
 * "IOException ... socket has been shut down" for every probe — which, at our
 * status-poll rate, floods the game console.
 */

const HOST = process.env.SDTD_TELNET_HOST || "yoshling-7dtd";
const PORT = parseInt(process.env.SDTD_TELNET_PORT || "8081", 10);
const PASSWORD = process.env.SDTD_TELNET_PASSWORD || "yoshlingcontrol";

interface TelnetOpts {
  timeoutMs?: number;
  /** How long the socket may stay quiet before we consider the reply done. */
  idleMs?: number;
}

/**
 * Open ONE connection, authenticate, run one or more commands in sequence, then
 * `exit` cleanly. Returns the concatenated output of all commands. Running
 * several commands per connection (instead of one connection each) is what
 * keeps the 7DTD console quiet.
 */
export function telnetSession(commands: string[], opts: TelnetOpts = {}): Promise<string> {
  const { timeoutMs = 6000, idleMs = 400 } = opts;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let authed = false;
    let started = false;
    const queue = [...commands];
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        // Ask the server to close the session cleanly, then end our side.
        socket.write("exit\r\n");
      } catch {}
      socket.end();
      socket.destroy();
      fn();
    };

    const hardTimeout = setTimeout(() => finish(() => resolve(buffer)), timeoutMs);
    hardTimeout.unref?.();

    const sendNext = () => {
      if (queue.length === 0) {
        // small grace for the last reply, then close cleanly
        setTimeout(() => {
          clearTimeout(hardTimeout);
          finish(() => resolve(buffer));
        }, idleMs);
        return;
      }
      const cmd = queue.shift()!;
      socket.write(`${cmd}\r\n`);
    };

    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => sendNext(), idleMs);
      idleTimer.unref?.();
    };

    socket.setEncoding("utf-8");
    socket.connect(PORT, HOST);

    socket.on("connect", () => {
      // If no password prompt appears, start sending shortly regardless.
      setTimeout(() => {
        if (!started && !authed) {
          started = true;
          sendNext();
        }
      }, 600);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (!authed && /password:/i.test(buffer)) {
        socket.write(`${PASSWORD}\r\n`);
        authed = true;
        buffer = "";
        return;
      }
      if (authed && !started && /(Logon successful|Press 'help')/i.test(buffer)) {
        started = true;
        buffer = "";
        sendNext();
        return;
      }
      if (started) bumpIdle();
    });

    socket.on("error", (err) => {
      clearTimeout(hardTimeout);
      finish(() => reject(err));
    });
    socket.on("close", () => {
      clearTimeout(hardTimeout);
      finish(() => resolve(buffer));
    });
  });
}

// Four wrappers used to sit here — `telnetCommand`, `telnetReachable`,
// `getSdtdPlayers` and `getSdtdTime`, the last two labelled "kept for
// compatibility" — and none of them had a caller. Every 7DTD read now goes
// through `getSdtdStatus`, which is the point: it answers listplayers + gettime +
// version in ONE session, and each of those wrappers opened its own. Keeping a
// one-command convenience next to a deliberately batched probe is how a future
// caller re-introduces the connection-per-question pattern this replaced.
// `telnetSession` is the primitive; use it directly if you need something else.

export interface SdtdPlayers {
  online: number;
  max: number;
  players: string[];
}

export interface SdtdStatus {
  reachable: boolean;
  players: SdtdPlayers;
  /** In-game day/time, e.g. "Day 7, 21:40" */
  time: string | null;
  /** Game version string if available, e.g. "V 3.1.0 (b13)" */
  version: string | null;
}

/** Exported for the status test; the parse is pure and the transport is not. */
export function parsePlayers(out: string, maxPlayers: number): SdtdPlayers {
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+id=\d+,\s*([^,]+),/);
    if (m) names.push(m[1].trim());
  }
  const totalMatch = out.match(/Total of (\d+) in the game/i);
  const online = totalMatch ? parseInt(totalMatch[1], 10) : names.length;
  return { online, max: maxPlayers, players: names };
}

/**
 * Whether a status session's output means the **game** is up, not merely that the
 * telnet listener is.
 *
 * 7 Days to Die binds telnet minutes before the world has loaded, and `reachable` used
 * to be `true` for any non-empty session output at all. Measured over three fresh boots
 * by two independent sweeps: status flipped to `online` 37-41 s after container start
 * while `listplayers`, `gettime` and `say` all replied
 * `*** ERROR: Command 'x' can only be executed when a game is started.` and the
 * container log was still at `GenWorldFromRaw`. The world was actually ready at 74-78 s.
 * So the dashboard read **Running · 0/8 players** for ~40 s of every single 7DTD start —
 * and because `game-manager` also gates `snap.boot` on this same flag, the boot progress
 * bar vanished at the same moment, on the one game that has never had an observed
 * in-game join.
 *
 * The marker is the game's own error string, deliberately. Readiness must NOT be made to
 * depend on `gettime`'s output *format* (`time !== null`): a future change to how 7DTD
 * prints the day would then pin the server at "Starting…" forever, which is a worse
 * failure than the one being fixed.
 */
export function sdtdSessionIsGameReady(out: string): boolean {
  if (!out) return false;
  return !/can only be executed when a game is started/i.test(out);
}

/**
 * Single-connection status probe: runs listplayers + gettime + version in ONE
 * telnet session. Replaces the old two-connection approach.
 */
export async function getSdtdStatus(maxPlayers = 8): Promise<SdtdStatus> {
  try {
    const out = await telnetSession(["listplayers", "gettime", "version"], { timeoutMs: 6000, idleMs: 450 });
    if (!sdtdSessionIsGameReady(out)) {
      return { reachable: false, players: { online: 0, max: maxPlayers, players: [] }, time: null, version: null };
    }
    const timeM = out.match(/Day\s+(\d+),\s*([\d:]+)/i);
    const verM = out.match(/Game version:\s*(V[^\n,]+)/i);
    return {
      reachable: true,
      players: parsePlayers(out, maxPlayers),
      time: timeM ? `Day ${timeM[1]}, ${timeM[2]}` : null,
      version: verM ? verM[1].trim() : null,
    };
  } catch {
    return { reachable: false, players: { online: 0, max: maxPlayers, players: [] }, time: null, version: null };
  }
}

/** Ask the server to save the world (used before a graceful shutdown). */
export async function sdtdSaveWorld(): Promise<void> {
  await telnetSession(["saveworld"], { timeoutMs: 15000, idleMs: 1200 });
}

/** Send a raw console command (used by the 7DTD console UI). */
export async function sdtdConsole(command: string): Promise<string> {
  return telnetSession([command], { timeoutMs: 6000, idleMs: 500 });
}
