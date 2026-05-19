import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const MC_CONTAINER = "yoshling-mc";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get container stats
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

    // Get host system stats
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
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to get stats" },
      { status: 500 }
    );
  }
}
