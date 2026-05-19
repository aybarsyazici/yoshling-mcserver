export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const { readFile, writeFile } = await import("fs/promises");

    const execAsync = promisify(exec);
    const MC_CONTAINER = "yoshling-mc";
    const HISTORY_FILE = "/app/data/stats-history.json";
    const MAX_POINTS = 360;

    async function collectStats() {
      try {
        const { stdout } = await execAsync(
          `docker stats ${MC_CONTAINER} --no-stream --format "{{.CPUPerc}}|{{.MemPerc}}" 2>/dev/null`
        );
        const parts = stdout.trim().split("|");
        if (parts.length < 2) return;

        const cpu = parseFloat(parts[0]);
        const memory = parseFloat(parts[1]);
        if (isNaN(cpu) || isNaN(memory)) return;

        let history: { time: number; cpu: number; memory: number }[] = [];
        try {
          const content = await readFile(HISTORY_FILE, "utf-8");
          history = JSON.parse(content);
        } catch {}

        history.push({ time: Date.now(), cpu, memory });
        history = history.slice(-MAX_POINTS);
        await writeFile(HISTORY_FILE, JSON.stringify(history), "utf-8");
      } catch {}
    }

    // Collect stats every 5 seconds in background
    setInterval(collectStats, 5000);
    collectStats();
  }
}
