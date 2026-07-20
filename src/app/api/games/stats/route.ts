import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { isGameId } from "@/lib/games";
import { RUNTIME } from "@/lib/game-manager";

const execAsync = promisify(exec);

interface HistoryPoint {
  time: number;
  cpu: number;
  memory: number;
}

async function getHistory(game: string): Promise<HistoryPoint[]> {
  try {
    return JSON.parse(await readFile(`/app/data/stats-${game}.json`, "utf-8"));
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const game = new URL(request.url).searchParams.get("game") || "minecraft";
  if (!isGameId(game)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  }
  const container = RUNTIME[game].container;
  const history = await getHistory(game);

  try {
    const { stdout: statsRaw } = await execAsync(
      `timeout 3 docker stats ${container} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.PIDs}}" 2>/dev/null`
    );

    const parts = statsRaw.trim().split("|");
    if (parts.length < 5) {
      // Container is off — still return disk/host info + history so the graph
      // shows the last session rather than an error.
      const host = await getHostStats();
      return NextResponse.json({
        offline: true,
        container: { cpu: "0%", memory: "0B / 0B", memoryPercent: "0%", network: "—", processes: "0" },
        host,
        history: history.map((p) => ({ time: p.time, cpu: p.cpu, memory: p.memory })),
      });
    }

    const host = await getHostStats();

    return NextResponse.json({
      offline: false,
      container: {
        cpu: parts[0].trim(),
        memory: parts[1].trim(),
        memoryPercent: parts[2].trim(),
        network: parts[3].trim(),
        processes: parts[4].trim(),
      },
      host,
      history: history.map((p) => ({ time: p.time, cpu: p.cpu, memory: p.memory })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to get stats";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function getHostStats() {
  let disk = { used: "?", total: "?", percent: "?" };
  let uptime: string | null = null;
  try {
    const { stdout: dfOut } = await execAsync("df -h / | tail -1");
    const p = dfOut.trim().split(/\s+/);
    disk = { used: p[2] || "?", total: p[1] || "?", percent: p[4] || "?" };
  } catch {}
  try {
    const { stdout } = await execAsync("uptime -s 2>/dev/null || echo unknown");
    const t = stdout.trim();
    uptime = t !== "unknown" ? t : null;
  } catch {}
  return { disk, uptime };
}
