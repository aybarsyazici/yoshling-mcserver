import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";

const execAsync = promisify(exec);
const MC_CONTAINER = "yoshling-mc";
const HISTORY_FILE = "/app/data/stats-history.json";
const MAX_POINTS = 360; // 30 minutes at 5-second intervals

interface HistoryPoint {
  time: number;
  cpu: number;
  memory: number;
}

async function getHistory(): Promise<HistoryPoint[]> {
  try {
    const content = await readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveHistory(history: HistoryPoint[]): Promise<void> {
  await writeFile(HISTORY_FILE, JSON.stringify(history), "utf-8");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { stdout: statsRaw } = await execAsync(
      `docker stats ${MC_CONTAINER} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.PIDs}}" 2>/dev/null`
    );

    const parts = statsRaw.trim().split("|");
    if (parts.length < 5) {
      return NextResponse.json({ error: "Container not running" }, { status: 503 });
    }

    const cpuPercent = parts[0].trim();
    const memUsage = parts[1].trim();
    const memPercent = parts[2].trim();
    const netIO = parts[3].trim();
    const pids = parts[4].trim();

    const cpuNum = parseFloat(cpuPercent);
    const memNum = parseFloat(memPercent);

    // Record to history
    const history = await getHistory();
    history.push({
      time: Date.now(),
      cpu: isNaN(cpuNum) ? 0 : cpuNum,
      memory: isNaN(memNum) ? 0 : memNum,
    });

    // Keep only last MAX_POINTS entries
    const trimmed = history.slice(-MAX_POINTS);
    await saveHistory(trimmed);

    // Get host disk stats
    const { stdout: dfOut } = await execAsync("df -h / | tail -1");
    const dfParts = dfOut.trim().split(/\s+/);
    const diskUsed = dfParts[2] || "?";
    const diskTotal = dfParts[1] || "?";
    const diskPercent = dfParts[4] || "?";

    const { stdout: uptimeOut } = await execAsync("uptime -s 2>/dev/null || echo unknown");
    const hostUptime = uptimeOut.trim();

    return NextResponse.json({
      container: {
        cpu: cpuPercent,
        memory: memUsage,
        memoryPercent: memPercent,
        network: netIO,
        processes: pids,
      },
      host: {
        disk: { used: diskUsed, total: diskTotal, percent: diskPercent },
        uptime: hostUptime !== "unknown" ? hostUptime : null,
      },
      history: trimmed.map((p) => ({
        time: p.time,
        cpu: p.cpu,
        memory: p.memory,
      })),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to get stats" },
      { status: 500 }
    );
  }
}
