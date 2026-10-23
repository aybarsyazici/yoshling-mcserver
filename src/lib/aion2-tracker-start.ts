/** Imported only from instrumentation's explicit Node runtime branch. */
export function startAionTracking() {
  const globals = globalThis as typeof globalThis & { __aion2Timer?: ReturnType<typeof setInterval> };
  if ((process.env.AION2_TRACKING ?? "true") === "false" || globals.__aion2Timer) return;
  const tick = async () => {
    try {
      if (process.env.NEXT_RUNTIME !== "nodejs") return;
      const { tickAionTracking } = await import("./aion2-store");
      await tickAionTracking();
    } catch {
      console.warn("[aion2] tracker could not read saved characters");
    }
  };
  globals.__aion2Timer = setInterval(() => { void tick(); }, 60_000);
  globals.__aion2Timer.unref?.();
}
