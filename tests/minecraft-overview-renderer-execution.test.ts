import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { OpHandle } from "@/lib/operations";
import { renderMinecraftProfileOverview, OVERVIEW_WORKER_MEMORY } from "@/lib/minecraft-overview-renderer";

const mocks = vi.hoisted(() => ({ command: vi.fn(), readFile: vi.fn(), lstat: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), readdir: vi.fn(), status: vi.fn(), lock: vi.fn(), ops: vi.fn(), json: vi.fn(), bytes: vi.fn() }));
vi.mock("node:util", async importOriginal => ({ ...await importOriginal<typeof import("node:util")>(), promisify: () => mocks.command }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, lstat: mocks.lstat, mkdir: mocks.mkdir, rm: mocks.rm, readdir: mocks.readdir }));
vi.mock("@/lib/compose", () => ({ COMPOSE_FILE: "/opt/yoshling/docker-compose.yml" }));
vi.mock("@/lib/game-manager", () => ({ getAllStatus: mocks.status }));
vi.mock("@/lib/operations", () => ({ currentControlLock: mocks.lock, listOperations: mocks.ops }));
vi.mock("@/lib/minecraft-profile-overview-store", () => ({ overviewRoot: () => "/app/data/minecraft-profile-overviews", overviewPath: async (relative: string) => `/app/data/minecraft-profile-overviews/${relative}`, readOverviewJSON: mocks.json, readOverviewBytes: mocks.bytes, overviewHash: (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex") }));
const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ID = "d".repeat(64), IMAGE = `sha256:${"c".repeat(64)}`;
const name = `yoshling-overview-${JOB}`, relative = `${PROFILE}/jobs/${JOB}`;
const input = { profileId: PROFILE, jobId: JOB, jobRelativePath: relative, source: { kind: "saved-copy" as const, id: "copy", sha256: "e".repeat(64), snapshotAt: "2026-10-08T00:00:00.000Z", sourceSavedAt: null }, target: { mcVersion: "26.1.2", loader: "fabric" as const, loaderVersion: "0.19.5", javaVariant: "java25" as const } };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function view(state = "exited") { const base = `minecraft-profile-overviews/${relative}`; return { id: ID, image: IMAGE, name: `/${name}`, service: "minecraft-overview", project: "yoshling", job: JOB, worker: "1", state, exitCode: 0, memory: OVERVIEW_WORKER_MEMORY, swap: OVERVIEW_WORKER_MEMORY, cpu: 1_000_000_000, pids: 256, network: "none", readonly: true, privileged: false, capAdd: null, binds: null, devices: null, deviceRequests: null, user: "0:0", pidMode: "", ipcMode: "private", tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m,mode=1777" }, caps: ["ALL"], security: ["no-new-privileges:true"], mounts: [{ Type: "volume", Name: "yoshling_web-data", Destination: "/input", RW: false }, { Type: "volume", Name: "yoshling_web-data", Destination: "/output", RW: true }], hostMounts: [{ Type: "volume", Source: "yoshling_web-data", Target: "/input", ReadOnly: true, VolumeOptions: { Subpath: `${base}/input` } }, { Type: "volume", Source: "yoshling_web-data", Target: "/output", VolumeOptions: { Subpath: `${base}/output` } }] }; }
const op = () => ({ preempted: false } as OpHandle);
let exists = false, current = view();
function missing() { throw Object.assign(new Error("missing"), { stderr: "No such object" }); }
beforeEach(() => {
  vi.clearAllMocks(); exists = false; current = view();
  mocks.lock.mockReturnValue(null); mocks.ops.mockReturnValue([]);
  mocks.readFile.mockResolvedValue("MemAvailable: 4194304 kB\n");
  mocks.status.mockResolvedValue({ minecraft: { status: "offline" }, "7dtd": { status: "offline" }, zomboid: { status: "offline" } });
  mocks.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid?.() });
  mocks.mkdir.mockResolvedValue(undefined); mocks.rm.mockResolvedValue(undefined); mocks.readdir.mockResolvedValue([]);
  mocks.bytes.mockResolvedValue(png);
  mocks.json.mockImplementation(async (file: string) => file.endsWith("manifest.json") ? { format: 1, profileId: PROFILE, jobId: JOB, source: input.source, center: { x: 0, z: 0 }, radius: 64, dimension: "overworld" } : { format: 1, profileId: PROFILE, jobId: JOB, sourceSha256: input.source.sha256, renderer: { name: "bluemap", version: "5.28" }, center: { x: 0, z: 0 }, radius: 64, dimension: "overworld", width: 1, height: 1, image: { file: "overview.png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") } });
  mocks.command.mockImplementation(async (_binary: string, args: string[]) => {
    if (args[0] === "ps") return { stdout: "" };
    if (args[0] === "image") return { stdout: IMAGE };
    if (args[0] === "compose") { exists = true; return { stdout: ID }; }
    if (args[0] === "stats") return { stdout: "1MiB / 1.5GiB" };
    if (args[0] === "stop") { current.state = "exited"; return { stdout: ID }; }
    if (args[0] === "rm") { exists = false; return { stdout: ID }; }
    if (args[0] === "inspect" && args.includes("yoshling-mc")) return { stdout: "created\nexited\nexited" };
    if (args[0] === "inspect") return exists ? { stdout: JSON.stringify(current) } : missing();
    throw new Error("Unexpected Docker command");
  });
});
const commands = () => mocks.command.mock.calls.map(call => call[1] as string[]);
describe("overview worker execution and independent receipts", () => {
  it("uses detached Compose with only private job paths, checks pixels, then removes owned worker", async () => {
    await expect(renderMinecraftProfileOverview(input, op())).resolves.toEqual({ renderer: { name: "bluemap", version: "5.28" }, width: 1, height: 1 });
    const run = mocks.command.mock.calls.find(call => call[1][0] === "compose")!;
    expect(run[1]).toContain("--no-deps"); expect(run[1]).toContain("--detach");
    expect(run[2].env.MC_OVERVIEW_INPUT_SUBPATH).toBe(`minecraft-profile-overviews/${relative}/input`);
    expect(run[2].env.MC_OVERVIEW_OUTPUT_SUBPATH).toBe(`minecraft-profile-overviews/${relative}/output`);
    expect(commands().some(args => args[0] === "rm" && args[1] === ID)).toBe(true); expect(exists).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it("refuses before launching when power, memory or game probe is unknown", async () => {
    for (const setup of [() => mocks.lock.mockReturnValue({}), () => mocks.readFile.mockRejectedValue(new Error("unknown")), () => mocks.status.mockRejectedValue(new Error("unknown")), () => mocks.status.mockResolvedValue({ minecraft: { status: "starting" }, "7dtd": { status: "offline" }, zomboid: { status: "offline" } })]) {
      mocks.lock.mockReturnValue(null); mocks.readFile.mockResolvedValue("MemAvailable: 4194304 kB\n"); mocks.status.mockResolvedValue({ minecraft: { status: "offline" }, "7dtd": { status: "offline" }, zomboid: { status: "offline" } }); setup();
      await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_deferred" });
    }
    expect(commands().some(args => args[0] === "compose")).toBe(false);
  });
  it("refuses any persisted worker from an earlier job before launching", async () => {
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation((binary: string, args: string[]) => args[0] === "ps" ? Promise.resolve({ stdout: "f".repeat(64) }) : original(binary, args));
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" }); expect(commands().some(args => args[0] === "compose")).toBe(false);
  });
  it("bounds hung game probes before launching", async () => {
    vi.useFakeTimers(); mocks.status.mockReturnValue(new Promise(() => {}));
    try { let settled = false; const result = renderMinecraftProfileOverview(input, op()).finally(() => { settled = true; }); const assertion = expect(result).rejects.toMatchObject({ code: "overview_deferred" }); await vi.advanceTimersByTimeAsync(5001); expect(settled).toBe(true); await assertion; expect(commands().some(args => args[0] === "compose")).toBe(false); } finally { vi.useRealTimers(); }
  });
  it("does not infer offline from a failed readiness probe of an actually running game", async () => {
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation((binary: string, args: string[]) => args.includes("yoshling-mc") ? Promise.resolve({ stdout: "running\nexited\nexited" }) : original(binary, args));
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_deferred" });
    expect(commands().some(args => args[0] === "compose")).toBe(false);
  });
  it("preemption stops only the admitted worker and resets verified scratch before retry", async () => {
    current = view("running"); let probes = 0;
    mocks.lock.mockImplementation(() => ++probes > 1 ? {} : null);
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_deferred" });
    expect(commands()).toContainEqual(["stop", "--time", "2", ID]); expect(exists).toBe(false); expect(mocks.rm).toHaveBeenCalledTimes(2);
  });
  it("an invalid final image receipt is unverified and its scratch is removed", async () => {
    const original = mocks.json.getMockImplementation()!;
    mocks.json.mockImplementation(async (file: string) => { const value = await original(file); return file.endsWith("receipt.json") ? { ...value, sourceSha256: "wrong" } : value; });
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" }); expect(exists).toBe(false); expect(mocks.rm).toHaveBeenCalledTimes(2);
  });
  it("rejects unsuccessful exits and every independently checked receipt field", async () => {
    current.exitCode = 1;
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" });
    current.exitCode = 0;
    const original = mocks.json.getMockImplementation()!;
    for (const patch of [{ center: { x: 1, z: 0 } }, { jobId: PROFILE }, { renderer: { name: "bluemap", version: "unknown" } }, { width: 2 }, { image: { file: "overview.png", bytes: png.length, sha256: "f".repeat(64) } }]) {
      mocks.json.mockImplementation(async (file: string) => { const value = await original(file); return file.endsWith("receipt.json") ? { ...value, ...patch } : value; });
      await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" }); expect(exists).toBe(false);
    }
  });
  it("enforces the ten-minute watchdog and verifies removal after interruption", async () => {
    vi.useFakeTimers(); current = view("running");
    try { let settled = false; const result = renderMinecraftProfileOverview(input, op()).finally(() => { settled = true; }); const assertion = expect(result).rejects.toMatchObject({ code: "overview_unverified" }); await vi.advanceTimersByTimeAsync(600001); expect(settled).toBe(true); await assertion; expect(exists).toBe(false); expect(commands()).toContainEqual(["stop", "--time", "2", ID]); } finally { vi.useRealTimers(); }
  });
  it("a failed cleanup cannot claim a deferred retry", async () => {
    current = view("running"); let probes = 0;
    mocks.lock.mockImplementation(() => ++probes > 1 ? {} : null);
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation((binary: string, args: string[]) => args[0] === "rm" ? Promise.resolve({ stdout: ID }) : original(binary, args));
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" }); expect(exists).toBe(true);
  });
  it("does not stop a foreign or expanded mount during cleanup", async () => {
    current = view("running"); current.hostMounts[0].VolumeOptions.Subpath = "minecraft-profile-overviews/foreign";
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" });
    expect(commands().some(args => ["stop", "rm"].includes(args[0]))).toBe(false); expect(exists).toBe(true);
  });
  it("ambiguous creation is unverified and never claims cleanup or automatic retry", async () => {
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation((binary: string, args: string[]) => args[0] === "compose" ? Promise.resolve({ stdout: "unknown" }) : original(binary, args));
    await expect(renderMinecraftProfileOverview(input, op())).rejects.toMatchObject({ code: "overview_unverified" }); expect(commands().some(args => ["stop", "rm"].includes(args[0]))).toBe(false);
  });
});
