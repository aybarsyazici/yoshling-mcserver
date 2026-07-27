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

/** Backwards-compatible single-command helper. */
export function telnetCommand(command: string, opts: TelnetOpts = {}): Promise<string> {
  return telnetSession([command], opts);
}

/** True if the telnet console accepts a connection & responds (server is up). */
export async function telnetReachable(): Promise<boolean> {
  try {
    const out = await telnetSession(["version"], { timeoutMs: 2500, idleMs: 250 });
    return out.length > 0;
  } catch {
    return false;
  }
}

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

function parsePlayers(out: string, maxPlayers: number): SdtdPlayers {
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
 * Single-connection status probe: runs listplayers + gettime + version in ONE
 * telnet session. Replaces the old two-connection approach.
 */
export async function getSdtdStatus(maxPlayers = 8): Promise<SdtdStatus> {
  try {
    const out = await telnetSession(["listplayers", "gettime", "version"], { timeoutMs: 6000, idleMs: 450 });
    if (!out) return { reachable: false, players: { online: 0, max: maxPlayers, players: [] }, time: null, version: null };
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

/** Get just the player list (kept for compatibility). */
export async function getSdtdPlayers(maxPlayers = 8): Promise<SdtdPlayers> {
  return (await getSdtdStatus(maxPlayers)).players;
}

/** Get the in-game day/time (kept for compatibility). */
export async function getSdtdTime(): Promise<string | null> {
  return (await getSdtdStatus()).time;
}

/** Ask the server to save the world (used before a graceful shutdown). */
export async function sdtdSaveWorld(): Promise<void> {
  await telnetSession(["saveworld"], { timeoutMs: 15000, idleMs: 1200 });
}

/** Send a raw console command (used by the 7DTD console UI). */
export async function sdtdConsole(command: string): Promise<string> {
  return telnetSession([command], { timeoutMs: 6000, idleMs: 500 });
}
