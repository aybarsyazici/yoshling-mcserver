import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
const tick = vi.hoisted(() => vi.fn());
vi.mock("@/lib/minecraft-profile-overview-queue", () => ({ tickMinecraftProfileOverviews: tick }));
vi.mock("child_process", () => ({ exec: vi.fn() }));
vi.mock("util", () => ({ promisify: () => async () => ({ stdout: "false" }) }));
vi.mock("fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("MC_OVERVIEWS", "true"); vi.stubEnv("PZ_UPDATE_WATCH", "false"); vi.stubEnv("BACKUP_SCHEDULE", "off"); tick.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("automatic overview boot timer", () => {
  it("first runs after 90 seconds then every 60 seconds", async () => {
    await register(); await vi.advanceTimersByTimeAsync(89999); expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59999); expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(2);
  });
  it("does not overlap a pending admission and resumes after it settles", async () => {
    let release!: () => void; tick.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await register(); await vi.advanceTimersByTimeAsync(90000); await vi.advanceTimersByTimeAsync(180000); expect(tick).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(60000); expect(tick).toHaveBeenCalledTimes(2);
  });
  it("continues after an error without exposing arbitrary error values", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); tick.mockRejectedValueOnce({ private: "secret" });
    await register(); await vi.advanceTimersByTimeAsync(90000); expect(log).toHaveBeenCalledWith("[minecraft-overviews] tick failed:", "unknown overview error");
    await vi.advanceTimersByTimeAsync(60000); expect(tick).toHaveBeenCalledTimes(2);
  });
  it("respects the off switch and non-Node runtime", async () => {
    vi.stubEnv("MC_OVERVIEWS", "false"); await register(); await vi.advanceTimersByTimeAsync(300000); expect(tick).not.toHaveBeenCalled();
    vi.stubEnv("MC_OVERVIEWS", "true"); vi.stubEnv("NEXT_RUNTIME", "edge"); await register(); await vi.advanceTimersByTimeAsync(300000); expect(tick).not.toHaveBeenCalled();
  });
});
