export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const { readFile, writeFile } = await import("fs/promises");

    const execAsync = promisify(exec);
    const MAX_POINTS = 360; // 30 minutes at 5s intervals

    // Record CPU/memory history per game container so each world's Monitor
    // tab keeps its own graph, independent of which one is currently running.
    // Kept inline (not imported from game-manager) because this runs before the
    // app boots; keep it in step with RUNTIME there.
    const CONTAINERS: Record<string, string> = {
      minecraft: "yoshling-mc",
      "7dtd": "yoshling-7dtd",
      zomboid: "yoshling-pz",
    };

    async function collectFor(game: string, container: string) {
      try {
        const { stdout } = await execAsync(
          `docker stats ${container} --no-stream --format "{{.CPUPerc}}|{{.MemPerc}}" 2>/dev/null`
        );
        const parts = stdout.trim().split("|");
        if (parts.length < 2) return;

        const cpu = parseFloat(parts[0]);
        const memory = parseFloat(parts[1]);
        if (isNaN(cpu) || isNaN(memory)) return;

        const file = `/app/data/stats-${game}.json`;
        let history: { time: number; cpu: number; memory: number }[] = [];
        try {
          history = JSON.parse(await readFile(file, "utf-8"));
        } catch {}

        history.push({ time: Date.now(), cpu, memory });
        history = history.slice(-MAX_POINTS);
        await writeFile(file, JSON.stringify(history), "utf-8");
      } catch {}
    }

    async function collectStats() {
      await Promise.all(
        Object.entries(CONTAINERS).map(([game, container]) => collectFor(game, container))
      );
    }

    // Collect stats every 5 seconds in background
    setInterval(collectStats, 5000);
    collectStats();
  }
}
