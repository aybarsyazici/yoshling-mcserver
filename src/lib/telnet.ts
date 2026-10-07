import net from "net";
import { randomUUID } from "node:crypto";

/**
 * Minimal telnet client for the 7 Days to Die dedicated server control port
 * (default 8081). We connect per-request because 7DTD's telnet is chatty and
 * long-lived sockets drift; a short-lived session is more robust.
 *
 * Authenticated sessions send `exit` before closing so 7DTD tears the connection
 * down cleanly. Just dropping the socket makes the server log a noisy
 * "IOException ... socket has been shut down" for every probe — which, at our
 * status-poll rate, floods the game console.
 */

const HOST = process.env.SDTD_TELNET_HOST || "yoshling-7dtd";
const PORT = parseInt(process.env.SDTD_TELNET_PORT || "8081", 10);
const PASSWORD = process.env.SDTD_TELNET_PASSWORD || "yoshlingcontrol";

interface TelnetOpts {
  timeoutMs?: number;
  /** Grace after a complete framed response, never a replacement for completion. */
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
  if (!commands.length || commands.some(command => !command.trim() || /[\r\n\0]/.test(command) || command.length > 1000)) {
    return Promise.reject(new Error("Expected one or more single-line telnet commands"));
  }
  // An unknown command with an unpredictable name is a reply fence. Its complete
  // rejection line proves the server processed the preceding command queue; silence
  // alone never proves completion. Semantic readers still validate their own output.
  const fence = `__yoshling_done_${randomUUID().replaceAll("-", "")}`;
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let login = "";
    let output = "";
    let passwordSent = false;
    let authenticated = false;
    let fenced = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      if (authenticated && !socket.destroyed) {
        socket.end("exit\r\n");
        socket.destroySoon();
      } else socket.destroy();
      if (error) reject(error);
      else resolve(output);
    };
    const hardTimeout = setTimeout(() => finish(new Error(
      authenticated ? "Telnet command completion timed out; the command may have executed, but its result is unconfirmed" : "Telnet authentication timed out"
    )), timeoutMs);
    hardTimeout.unref?.();
    const complete = () => {
      if (!fenced) return;
      if (commands.some(command => !knownReplyComplete(command, output))) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), idleMs);
      idleTimer.unref?.();
    };
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      if (settled) return;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (!authenticated) {
        login += chunk;
        if (/password incorrect|too many failed login attempts|authentication failed|access denied|login failed/i.test(login)) {
          finish(new Error("Telnet authentication was rejected"));
          return;
        }
        if (!passwordSent && /(?:please enter )?password\s*:/i.test(login)) {
          passwordSent = true;
          login = "";
          socket.write(`${PASSWORD}\r\n`);
          return;
        }
        if (passwordSent && /Logon successful\./i.test(login)) {
          authenticated = true;
          login = "";
          socket.write(`${commands.join("\r\n")}\r\n${fence}\r\n`);
        }
        return;
      }
      output += chunk;
      if (output.length > 4 * 1024 * 1024) { finish(new Error("Telnet reply exceeded the response limit")); return; }
      const lines = output.split(/\r?\n/);
      const fenceLine = lines.findIndex((line, index) => index < lines.length - 1 && line.includes(fence) && /unknown command/i.test(line));
      if (fenceLine >= 0) {
        fenced = true;
        // Keep only output before the fence. Execution log echoes of our internal
        // marker are transport framing, not the requested command's result.
        output = lines.slice(0, fenceLine).filter(line => !line.includes(fence)).join("\n");
      }
      const completeOutput = fenced ? output : lines.slice(0, -1).join("\n");
      if (telnetReplyRejected(completeOutput)) { finish(new Error("Telnet command was rejected; inspect the command and server state")); return; }
      complete();
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => {
      if (settled) return;
      if (fenced && commands.every(command => knownReplyComplete(command, output))) finish();
      else finish(new Error(authenticated
        ? "Telnet closed before complete command replies were confirmed; the result is unconfirmed"
        : "Telnet closed before authentication completed"));
    });
    socket.connect(PORT, HOST);
  });
}

export function telnetReplyRejected(out: string): boolean {
  return /(?:^|\n)\s*(?:\*{3}\s*)?(?:ERROR|ERR)\s*:|unknown command|command[^\n]*(?:not found|not allowed|not permitted)|permission denied|access denied|password incorrect|authentication failed|too many failed login attempts/i.test(out);
}

/** Known reads/saves require their terminal semantic marker as well as framing. */
function knownReplyComplete(command: string, output: string): boolean {
  switch (command.trim().toLowerCase()) {
    case "listplayers": return /Total of \d+ in the game/i.test(output);
    case "gettime": return /Day\s+\d+,\s*[\d:]+/i.test(output);
    case "version": return /Game version:\s*V[^\n]+/i.test(output);
    case "saveworld": return /\bWorld saved\b/i.test(output);
    default: return output.trim().length > 0;
  }
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
 * Correction: rejecting only that error still accepted authentication denial and
 * partial probes as a ready game. Readiness now requires complete known player/time/
 * version output. A changed reply format is unconfirmed, not invented readiness.
 */
export function sdtdSessionIsGameReady(out: string): boolean {
  if (!out || telnetReplyRejected(out)) return false;
  return /Total of \d+ in the game/i.test(out) && /Day\s+\d+,\s*[\d:]+/i.test(out) && /Game version:\s*V[^\n]+/i.test(out);
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
