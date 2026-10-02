import { Rcon } from "rcon-client";
// Runtime import, but not a cycle: `rcon-long` reaches back for `RconTarget` with
// `import type`, which is erased.
import { rconCommandLong } from "@/lib/rcon-long";

/**
 * Source-RCON transport, shared by every game that speaks it: Minecraft
 * (port 25575) and Project Zomboid (port 27015). One cached, authenticated
 * connection per target so rapid status polls reuse a live socket instead of
 * reconnecting each time.
 */
export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

/**
 * The cached socket, **plus the per-packet deadline it was opened with**.
 *
 * That second field is load-bearing and its absence was a silent bug. `rcon-client` keeps
 * its own `config.timeout` (default **2000 ms**) and rejects a `send` itself when it
 * fires; `config` is frozen at connect time. So a socket opened for a 3 s status poll
 * answered every later caller on a 2 s fuse no matter what budget that caller asked for,
 * and the `withTimeout` race below — the only thing a `timeoutMs` argument reached — never
 * got to run. Two callers declared a generosity they were not getting:
 * `FLUSH_RCON_TIMEOUT_MS = 120_000` for `save-all flush` on a 217 MB world, and the ban
 * route's 5 s for a `ban` that may do a Mojang lookup on the server thread. Both were
 * capped at 2 s, which is the shape of defect this project keeps finding: a parameter
 * accepted and ignored.
 */
interface Cached {
  rcon: Rcon;
  /** What was handed to `rcon-client` as `config.timeout`, and so the real ceiling. */
  timeoutMs: number;
}

const clients = new Map<string, Cached>();

function targetKey(t: RconTarget): string {
  return `${t.host}:${t.port}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// `getRcon` and `disconnectRcon` are module-local on purpose. The cached socket is
// the whole point of this file, and handing a raw `Rcon` out means a caller can
// `send` on it without `rconCommand`'s failure handling — which is what evicts a
// socket that died without emitting "end" (what a `docker stop` on the game
// container looks like) and would otherwise make every later call time out.
async function getRcon(target: RconTarget, timeoutMs = 3000): Promise<Rcon> {
  const key = targetKey(target);
  const existing = clients.get(key);
  /**
   * Reuse only a socket whose own fuse is at least as long as this caller's budget.
   *
   * A *shorter* cached fuse cannot be stretched — `config.timeout` is read at send time
   * from an object fixed at connect — so reusing it would silently cap the caller again.
   * A *longer* one is fine: `withTimeout` below then enforces the shorter budget, and
   * `rconCommand` drops the socket on that failure anyway. In practice this costs at most
   * one reconnect per upgrade (3 s poll → 5 s ban → 120 s flush), after which everything
   * shorter reuses it.
   */
  if (existing && existing.rcon.authenticated && existing.timeoutMs >= timeoutMs) {
    return existing.rcon;
  }
  if (existing) await disconnectRcon(target);

  const client = await withTimeout(Rcon.connect({ ...target, timeout: timeoutMs }), timeoutMs);
  client.on("end", () => {
    if (clients.get(key)?.rcon === client) clients.delete(key);
  });
  clients.set(key, { rcon: client, timeoutMs });
  return client;
}

export async function rconCommand(target: RconTarget, command: string, timeoutMs = 3000): Promise<string> {
  const rcon = await getRcon(target, timeoutMs);
  try {
    return await withTimeout(rcon.send(command), timeoutMs);
  } catch (e) {
    // Drop the cached connection on any failure. A socket that died without
    // emitting "end" — which is what a `docker stop` on the game container looks
    // like — still reports `authenticated`, so keeping it would make every later
    // call time out instead of reconnecting once the server is back.
    await disconnectRcon(target);
    throw e;
  }
}

async function disconnectRcon(target: RconTarget): Promise<void> {
  const key = targetKey(target);
  const cached = clients.get(key);
  if (!cached) return;
  clients.delete(key);
  try {
    await cached.rcon.end();
  } catch {
    // already gone
  }
}

// ── Minecraft ───────────────────────────────────────────────────────────────

function minecraftTarget(): RconTarget {
  return {
    host: process.env.RCON_HOST || "127.0.0.1",
    port: parseInt(process.env.RCON_PORT || "25575"),
    password: process.env.RCON_PASSWORD || "changeme",
  };
}

export async function sendCommand(command: string, timeoutMs?: number): Promise<string> {
  return rconCommand(minecraftTarget(), command, timeoutMs);
}

/**
 * The same thing for Minecraft, for a reply that will not fit in one 4096-byte RCON packet.
 *
 * `rconCommand` resolves on the **first** packet and discards the rest. Two independent
 * measurements of the same cliff, both from production:
 *
 * - Project Zomboid's `showoptions` is 6,789 bytes; it came back as 4,102 and the settings
 *   page showed **79 of 137** settings with no error and `available: true`.
 * - Minecraft's `help gamerule` is 5,099 bytes; truncated to 4,096 it parses to **46 of the
 *   58** rules — a dozen missing, 21%. (An earlier draft of this comment said "a third",
 *   which was never measured; the figure is checkable against
 *   `src/lib/__tests__/fixtures/mc-help-gamerule.txt` and this one is.)
 *
 * See `src/lib/rcon-frame.ts` for the framing and why the shared cached socket is
 * deliberately not reused here.
 *
 * **Use this for anything that enumerates.** On Minecraft that is `help gamerule` and
 * `banlist`. `banlist` is the one where truncation is dangerous rather than merely lossy:
 * one line per ban, each carrying a free-text reason, so a few dozen bans is already past
 * the cliff — and a short read makes a real ban read as *absent*, which is the direction
 * that matters, because the read-back is what decides whether a ban is reported as applied.
 * Short control commands (`list`, `difficulty`, `save-all`, `ban`, one `gamerule <id>`
 * query) stay on the cached socket, the right transport for a poll running every few
 * seconds.
 *
 * `timeoutMs` is optional rather than defaulted here on purpose: the default lives in
 * `rconCommandLong`, so a caller that passes its own budget actually gets it. A duplicated
 * default in this wrapper is how the bans route's 5-second budget came to have no effect.
 */
export async function sendCommandLong(command: string, timeoutMs?: number): Promise<string> {
  return rconCommandLong(minecraftTarget(), command, { timeoutMs });
}

export async function getPlayerList(): Promise<{
  online: number;
  max: number;
  players: string[];
}> {
  try {
    const response = await sendCommand("list");
    const match = response.match(
      /There are (\d+) of a max of (\d+) players online:(.*)/
    );

    if (match) {
      const players = match[3]
        .trim()
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      return {
        online: parseInt(match[1]),
        max: parseInt(match[2]),
        players,
      };
    }

    return { online: 0, max: 20, players: [] };
  } catch {
    return { online: 0, max: 20, players: [] };
  }
}
