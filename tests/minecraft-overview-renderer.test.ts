import { describe, expect, it } from "vitest";
import { assertOwnedMinecraftOverviewWorker, minecraftOverviewAvailableMemory, minecraftOverviewMemoryBudget, minecraftOverviewTargetSupport, minecraftOverviewWorkerMemory, OVERVIEW_WORKER_MEMORY, MinecraftOverviewRendererError, type MinecraftOverviewWorkerView } from "@/lib/minecraft-overview-renderer";
import type { MinecraftProfileTarget } from "@/lib/minecraft-profile-types";

const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", IMAGE = `sha256:${"c".repeat(64)}`;
const name = `yoshling-overview-${JOB}`;
const target = (mcVersion: string): MinecraftProfileTarget => ({ mcVersion, loader: "fabric", loaderVersion: "0.19.5", javaVariant: "java25" });
function owned(): MinecraftOverviewWorkerView {
  const base = `minecraft-profile-overviews/${PROFILE}/jobs/${JOB}`;
  return { id: "d".repeat(64), image: IMAGE, name: `/${name}`, service: "minecraft-overview", project: "yoshling", job: JOB, worker: "1", state: "running", exitCode: 0, memory: OVERVIEW_WORKER_MEMORY, swap: OVERVIEW_WORKER_MEMORY, cpu: 1_000_000_000, pids: 256, network: "none", readonly: true, privileged: false, capAdd: null, binds: null, devices: null, deviceRequests: null, user: "0:0", pidMode: "", ipcMode: "private", tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m,mode=1777" }, caps: ["ALL"], security: ["no-new-privileges:true"], mounts: [{ Type: "volume", Name: "yoshling_web-data", Destination: "/input", RW: false }, { Type: "volume", Name: "yoshling_web-data", Destination: "/output", RW: true }], hostMounts: [{ Type: "volume", Source: "yoshling_web-data", Target: "/input", ReadOnly: true, VolumeOptions: { Subpath: `${base}/input` } }, { Type: "volume", Source: "yoshling_web-data", Target: "/output", ReadOnly: false, VolumeOptions: { Subpath: `${base}/output` } }] };
}
describe("bounded non-game overview renderer", () => {
  it.each(["26.1.2", "1.21.1"])("accepts a packaged rendering target %s", version => { expect(minecraftOverviewTargetSupport(target(version)).supported).toBe(true); });
  it.each(["latest", "26.3", "1.13.2", "26.1", "1.21.10", "99.1", "../26.1.2"])("refuses a target without packaged proven assets %s", version => { expect(minecraftOverviewTargetSupport(target(version)).supported).toBe(false); });
  it("reads actual MemAvailable rather than treating reclaimable/total bytes as admission", () => { expect(minecraftOverviewAvailableMemory("MemTotal: 999999 kB\nMemFree: 12 kB\nMemAvailable: 3145728 kB\n")).toBe(3 * 1024 ** 3); expect(minecraftOverviewAvailableMemory("MemTotal: 999999 kB\nMemFree: 999999 kB\n")).toBeNull(); expect(minecraftOverviewAvailableMemory("MemAvailable: -1 kB")).toBeNull(); });
  it("reserves worker capacity and native host headroom before launch", () => { expect(minecraftOverviewMemoryBudget(null)).toBe(false); expect(minecraftOverviewMemoryBudget(OVERVIEW_WORKER_MEMORY)).toBe(false); expect(minecraftOverviewMemoryBudget(OVERVIEW_WORKER_MEMORY + 1024 ** 3 - 1)).toBe(false); expect(minecraftOverviewMemoryBudget(OVERVIEW_WORKER_MEMORY + 1024 ** 3)).toBe(true); });
  it("accounts for already-used worker memory without requiring it twice", () => { expect(minecraftOverviewMemoryBudget(2 * 1024 ** 3, 512 * 1024 ** 2)).toBe(true); expect(minecraftOverviewMemoryBudget(1024 ** 3 - 1, OVERVIEW_WORKER_MEMORY)).toBe(false); expect(minecraftOverviewMemoryBudget(10 * 1024 ** 3, OVERVIEW_WORKER_MEMORY + 1)).toBe(false); expect(minecraftOverviewMemoryBudget(10 * 1024 ** 3, Number.NaN)).toBe(false); });
  it("accepts only bounded Docker worker usage readings", () => { expect(minecraftOverviewWorkerMemory("512MiB / 1.5GiB")).toBe(512 * 1024 ** 2); expect(minecraftOverviewWorkerMemory("1.5GiB / 1.5GiB")).toBe(OVERVIEW_WORKER_MEMORY); expect(minecraftOverviewWorkerMemory("2GiB / 1.5GiB")).toBeNull(); expect(minecraftOverviewWorkerMemory("unknown")).toBeNull(); });
  it("accepts the exact non-game identity and private subpath mounts", () => { expect(() => assertOwnedMinecraftOverviewWorker(owned(), name, JOB, PROFILE, IMAGE)).not.toThrow(); });
  it.each(["name", "service", "project", "job", "worker", "image"] as const)("refuses a different worker %s", key => { const view = owned(); view[key] = "foreign"; expect(() => assertOwnedMinecraftOverviewWorker(view, name, JOB, PROFILE, IMAGE)).toThrow(MinecraftOverviewRendererError); });
  it.each(["memory", "swap", "cpu", "pids"] as const)("refuses missing worker %s limits", key => { const view = owned(); view[key] = 0; expect(() => assertOwnedMinecraftOverviewWorker(view, name, JOB, PROFILE, IMAGE)).toThrow(MinecraftOverviewRendererError); });
  it("refuses network/root-write/capability/privilege expansion", () => { for (const patch of [{ network: "yoshling_default" }, { readonly: false }, { caps: [] }, { security: [] }]) expect(() => assertOwnedMinecraftOverviewWorker({ ...owned(), ...patch }, name, JOB, PROFILE, IMAGE)).toThrow(MinecraftOverviewRendererError); });
  it("refuses privileged devices, added caps, host namespaces or unbounded scratch", () => {
    const patches: Partial<MinecraftOverviewWorkerView>[] = [{ privileged: true }, { capAdd: ["SYS_ADMIN"] }, { binds: ["/host:/host"] }, { devices: [{}] }, { deviceRequests: [{}] }, { user: "1000" }, { pidMode: "host" }, { ipcMode: "host" }, { tmpfs: {} }, { tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m,mode=1777" } }, { tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m,mode=1777", "/extra": "rw" } }];
    for (const patch of patches) expect(() => assertOwnedMinecraftOverviewWorker({ ...owned(), ...patch }, name, JOB, PROFILE, IMAGE)).toThrow(MinecraftOverviewRendererError);
  });
  it("refuses a writable source, full web volume, another profile or a Docker socket", () => {
    const writable = owned(); writable.mounts[0].RW = true;
    const full = owned(); delete full.hostMounts[0].VolumeOptions;
    const foreign = owned(); foreign.hostMounts[0].VolumeOptions!.Subpath = `minecraft-profile-overviews/${JOB}/jobs/${JOB}/input`;
    const socket = owned(); socket.mounts.push({ Type: "bind", Destination: "/var/run/docker.sock", RW: true });
    for (const view of [writable, full, foreign, socket]) expect(() => assertOwnedMinecraftOverviewWorker(view, name, JOB, PROFILE, IMAGE)).toThrow(MinecraftOverviewRendererError);
  });
});
