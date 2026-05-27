import { Rcon } from "rcon-client";

let rconClient: Rcon | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function getRcon(): Promise<Rcon> {
  if (rconClient && rconClient.authenticated) {
    return rconClient;
  }

  rconClient = await withTimeout(Rcon.connect({
    host: process.env.RCON_HOST || "127.0.0.1",
    port: parseInt(process.env.RCON_PORT || "25575"),
    password: process.env.RCON_PASSWORD || "changeme",
  }), 3000);

  rconClient.on("end", () => {
    rconClient = null;
  });

  return rconClient;
}

export async function sendCommand(command: string): Promise<string> {
  const rcon = await getRcon();
  return rcon.send(command);
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

export async function disconnectRcon(): Promise<void> {
  if (rconClient) {
    await rconClient.end();
    rconClient = null;
  }
}
