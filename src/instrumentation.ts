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

    // ── Project Zomboid Workshop mod updates ────────────────────────────────
    //
    // A mod republished on Steam locks out anyone who logs off, because the
    // version check is client-side and the server keeps serving the old copy.
    // See lib/zomboid-updates.ts for why this polls rather than subscribes.
    //
    // Imported lazily inside the tick, not up here: register() runs before the
    // app is fully booted, and the watcher pulls in the game manager and the
    // Prisma client.
    const POLL_MS = Number(process.env.PZ_UPDATE_POLL_MS || 5 * 60 * 1000);
    // While an update is already known to be pending there is nothing left to
    // discover — we are only waiting for the last player to log off. Checking on
    // the slow cadence meant up to POLL_MS of dead air after the server emptied
    // before the restart even began, which reads as "why isn't it back yet".
    const PENDING_MS = Number(process.env.PZ_UPDATE_PENDING_POLL_MS || 30 * 1000);
    const WATCH = (process.env.PZ_UPDATE_WATCH ?? "true") !== "false";

    if (WATCH) {
      let running = false;
      const tick = async () => {
        if (running) return; // a slow SteamCMD run must not overlap the next tick
        running = true;
        // Re-check soon when the answer can change without anything new being
        // published: "announced" = waiting for players to leave, "skipped" = the
        // world is mid-boot or another op holds the control lock.
        let soon = false;
        try {
          const { pollModUpdates } = await import("@/lib/zomboid-updates");
          const { action, stale } = await pollModUpdates();
          soon = action === "announced" || action === "skipped";
          // Logged on every tick, including "none". A watcher that only speaks up
          // when it acts is indistinguishable from one that silently died — which
          // cost real time to diagnose the first time round.
          const names = stale.map((s) => `${s.title} (${s.id})`).join(", ");
          console.log(`[pz-updates] ${action}${names ? `: ${names}` : ""}`);
        } catch (e) {
          console.error("[pz-updates] failed:", e);
        } finally {
          running = false;
          // Self-scheduling rather than setInterval, so the delay can depend on
          // what the last tick found.
          setTimeout(tick, soon ? PENDING_MS : POLL_MS);
        }
      };
      // Delay the first run so it doesn't race the app's own startup.
      setTimeout(tick, 60_000);
    }
  }
}
