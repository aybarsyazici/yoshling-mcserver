import { Rcon } from "rcon-client";

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

const clients = new Map<string, Rcon>();

function targetKey(t: RconTarget): string {
  return `${t.host}:${t.port}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function getRcon(target: RconTarget, timeoutMs = 3000): Promise<Rcon> {
  const key = targetKey(target);
  const existing = clients.get(key);
  if (existing && existing.authenticated) return existing;

  const client = await withTimeout(Rcon.connect(target), timeoutMs);
  client.on("end", () => {
    if (clients.get(key) === client) clients.delete(key);
  });
  clients.set(key, client);
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

export async function disconnectRcon(target: RconTarget): Promise<void> {
  const key = targetKey(target);
  const client = clients.get(key);
  if (!client) return;
  clients.delete(key);
  try {
    await client.end();
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

export async function sendCommand(command: string): Promise<string> {
  return rconCommand(minecraftTarget(), command);
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
