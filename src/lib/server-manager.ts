import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

const MC_CONTAINER = "yoshling-mc";
const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";

export type ServerStatus = "online" | "offline" | "starting" | "stopping";

export async function getServerStatus(): Promise<{
  status: ServerStatus;
  uptime?: string;
}> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Status}}' ${MC_CONTAINER} 2>/dev/null`
    );
    const state = stdout.trim();

    if (state === "running") {
      let uptime: string | undefined;
      try {
        const { stdout: startedAt } = await execAsync(
          `docker inspect --format='{{.State.StartedAt}}' ${MC_CONTAINER}`
        );
        const start = new Date(startedAt.trim());
        const diff = Date.now() - start.getTime();
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        uptime = `${hours}h ${minutes}m`;
      } catch {}
      return { status: "online", uptime };
    }

    return { status: "offline" };
  } catch {
    return { status: "offline" };
  }
}

export async function startServer(): Promise<void> {
  await execAsync(`docker start ${MC_CONTAINER}`);
}

export async function stopServer(): Promise<void> {
  await execAsync(`docker stop ${MC_CONTAINER}`);
}

export async function restartServer(): Promise<void> {
  await execAsync(`docker restart ${MC_CONTAINER}`);
}

export async function getServerProperties(): Promise<Record<string, string>> {
  const filePath = path.join(MC_DIR, "server.properties");
  const content = await readFile(filePath, "utf-8");
  const properties: Record<string, string> = {};

  for (const line of content.split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...valueParts] = line.split("=");
    properties[key.trim()] = valueParts.join("=").trim();
  }

  return properties;
}

export function getModsDir(): string {
  return path.join(MC_DIR, "mods");
}
