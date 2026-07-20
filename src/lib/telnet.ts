import net from "net";

/**
 * Minimal telnet client for the 7 Days to Die dedicated server control port.
 * 7DTD exposes a plaintext telnet console (default port 8081). We connect
 * per-command because the server's telnet is chatty and long-lived sockets
 * drift; a short-lived request/response is far more robust here.
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
 * Open a connection, authenticate if prompted, send one command, and return
 * everything the server said back. Resolves even on partial output.
 */
export function telnetCommand(command: string, opts: TelnetOpts = {}): Promise<string> {
  const { timeoutMs = 4000, idleMs = 350 } = opts;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let authed = false;
    let sentCommand = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      socket.destroy();
      fn();
    };

    const hardTimeout = setTimeout(() => {
      // Return whatever we captured; a timeout with data is still useful.
      finish(() => resolve(buffer));
    }, timeoutMs);
    hardTimeout.unref?.();

    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clearTimeout(hardTimeout);
        finish(() => resolve(buffer));
      }, idleMs);
      idleTimer.unref?.();
    };

    socket.setEncoding("utf-8");
    socket.connect(PORT, HOST);

    socket.on("connect", () => {
      // If the server uses no telnet password it won't prompt; send the
      // command shortly regardless so we don't hang waiting for a prompt.
      setTimeout(() => {
        if (!sentCommand && !authed) {
          socket.write(`${command}\r\n`);
          sentCommand = true;
          bumpIdle();
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

      if (authed && !sentCommand && /(Logon successful|Press 'help')/i.test(buffer)) {
        buffer = "";
        socket.write(`${command}\r\n`);
        sentCommand = true;
      }

      if (sentCommand) bumpIdle();
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

/** True if the telnet console accepts a connection & responds (server is up). */
export async function telnetReachable(): Promise<boolean> {
  try {
    const out = await telnetCommand("version", { timeoutMs: 2500, idleMs: 250 });
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

/** Parse `listplayers` output into a player list. */
export async function getSdtdPlayers(maxPlayers = 8): Promise<SdtdPlayers> {
  try {
    const out = await telnetCommand("listplayers");
    // Lines look like: "0. id=171, NAME, pos=(...), ..." and end with
    // "Total of N in the game"
    const names: string[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*\d+\.\s+id=\d+,\s*([^,]+),/);
      if (m) names.push(m[1].trim());
    }
    const totalMatch = out.match(/Total of (\d+) in the game/i);
    const online = totalMatch ? parseInt(totalMatch[1], 10) : names.length;
    return { online, max: maxPlayers, players: names };
  } catch {
    return { online: 0, max: maxPlayers, players: [] };
  }
}

/** Get the in-game day/time, e.g. "Day 7, 21:40". */
export async function getSdtdTime(): Promise<string | null> {
  try {
    const out = await telnetCommand("gettime");
    const m = out.match(/Day\s+(\d+),\s*([\d:]+)/i);
    return m ? `Day ${m[1]}, ${m[2]}` : null;
  } catch {
    return null;
  }
}

/** Ask the server to save the world (used before a graceful shutdown). */
export async function sdtdSaveWorld(): Promise<void> {
  await telnetCommand("saveworld", { timeoutMs: 15000, idleMs: 1200 });
}

/** Send a raw console command (used by the 7DTD console UI). */
export async function sdtdConsole(command: string): Promise<string> {
  return telnetCommand(command, { timeoutMs: 6000, idleMs: 500 });
}
