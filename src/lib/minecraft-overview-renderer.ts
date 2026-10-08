import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COMPOSE_FILE } from "./compose";
import { getAllStatus } from "./game-manager";
import { currentControlLock, listOperations, type OpHandle } from "./operations";
import { minecraftProfileId } from "./minecraft-profile-path";
import type { MinecraftProfileTarget } from "./minecraft-profile-types";
import { overviewPath, overviewRoot, readOverviewJSON, readOverviewBytes, overviewHash } from "./minecraft-profile-overview-store";

export const MINECRAFT_OVERVIEW_IMAGE = "yoshling/minecraft-overview:5.28";
export const MINECRAFT_OVERVIEW_SERVICE = "minecraft-overview";
export const OVERVIEW_WORKER_MEMORY = 1536 * 1024 * 1024;
const HEADROOM_BYTES = 1024 * 1024 * 1024;
const DEADLINE_MS = 10 * 60_000;
const command = promisify(execFile);

export class MinecraftOverviewDeferredError extends Error {
  readonly code = "overview_deferred";
}
export class MinecraftOverviewRendererError extends Error {
  readonly code = "overview_unverified";
}
export interface MinecraftOverviewRenderInput {
  profileId: string; jobId: string; jobRelativePath: string;
  source: { kind: "saved-copy" | "checkpoint" | "backup"; id: string; sha256: string; snapshotAt: string; sourceSavedAt: string | null };
  target: MinecraftProfileTarget;
}
export interface MinecraftOverviewRenderReceipt {
  renderer: { name: "bluemap"; version: "5.28" }; width: number; height: number;
}
export function minecraftOverviewTargetSupport(target: MinecraftProfileTarget): { supported: boolean; reason?: string } {
  return ["26.1.2", "1.21.1"].includes(target.mcVersion)
    ? { supported: true }
    : { supported: false, reason: "Generated overviews currently support Minecraft 26.1.2 and 1.21.1 with pinned rendering assets." };
}
export function minecraftOverviewAvailableMemory(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  if (!match) return null;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
async function docker(args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await command("docker", args, { timeout, maxBuffer: 64 * 1024, encoding: "utf8" });
  return stdout.trim();
}
export function minecraftOverviewMemoryBudget(available: number | null, workerUsed = 0): boolean {
  return available !== null && Number.isFinite(workerUsed) && workerUsed >= 0 && workerUsed <= OVERVIEW_WORKER_MEMORY && available + workerUsed >= OVERVIEW_WORKER_MEMORY + HEADROOM_BYTES;
}
export function minecraftOverviewWorkerMemory(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)\s*\//.exec(text.trim());
  if (!match) return null;
  const multiplier = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]];
  const bytes = Number(match[1]) * multiplier!;
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= OVERVIEW_WORKER_MEMORY ? bytes : null;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Overview resource probe timed out")), 5000); })]); }
  finally { clearTimeout(timer!); }
}
async function budget(workerUsed = 0): Promise<string | null> {
  try {
    if (currentControlLock() || listOperations().some(item => item.holdsPower && !item.endedAt)) return "A game power operation is in progress.";
    const available = minecraftOverviewAvailableMemory(await bounded(readFile("/proc/meminfo", "utf8")));
    if (!minecraftOverviewMemoryBudget(available, workerUsed)) return "The host does not have enough available memory for a bounded overview job.";
    // Status drivers intentionally fall back to offline. Independently require actual
    // Docker state so a failed probe cannot admit a renderer beside an unknown game.
    const states = await docker(["inspect", "--format", "{{.State.Status}}", "yoshling-mc", "yoshling-7dtd", "yoshling-pz"], 5000);
    const observed = states.split("\n");
    if (observed.length !== 3 || observed.some(state => !["running", "exited", "created"].includes(state))) return "A game container state is unknown or transitioning.";
    const games = await bounded(getAllStatus());
    if ([games.minecraft, games["7dtd"], games.zomboid].some((game, index) => observed[index] === "running" && game.status === "offline")) return "A running game readiness probe is unknown.";
    if (Object.values(games).some(game => ["starting", "stopping", "installing"].includes(game.status))) return "A game is starting, stopping or installing.";
    return null;
  } catch { return "The host resource or game state could not be verified."; }
}
export interface MinecraftOverviewWorkerView { id: string; image: string; name: string; service: string; project: string; job: string; worker: string; state: string; exitCode: number; memory: number; swap: number; cpu: number; pids: number; network: string; readonly: boolean; privileged: boolean; capAdd: string[] | null; binds: string[] | null; devices: unknown[] | null; deviceRequests: unknown[] | null; user: string; pidMode: string; ipcMode: string; tmpfs: Record<string, string>; caps: string[]; security: string[]; mounts: { Type: string; Destination: string; RW: boolean; Name?: string }[]; hostMounts: { Type: string; Source: string; Target: string; ReadOnly?: boolean; VolumeOptions?: { Subpath?: string } }[] }
const workerFormat = '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"job":{{json (index .Config.Labels "yoshling.overview.job")}},"worker":{{json (index .Config.Labels "yoshling.overview.worker")}},"state":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"memory":{{.HostConfig.Memory}},"swap":{{.HostConfig.MemorySwap}},"cpu":{{.HostConfig.NanoCpus}},"pids":{{json .HostConfig.PidsLimit}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{.HostConfig.ReadonlyRootfs}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"binds":{{json .HostConfig.Binds}},"devices":{{json .HostConfig.Devices}},"deviceRequests":{{json .HostConfig.DeviceRequests}},"user":{{json .Config.User}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"tmpfs":{{json .HostConfig.Tmpfs}},"caps":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"mounts":{{json .Mounts}},"hostMounts":{{json .HostConfig.Mounts}}}';
async function worker(name: string): Promise<MinecraftOverviewWorkerView | null> {
  let raw: string;
  try { raw = await docker(["inspect", "--format", workerFormat, name]); }
  catch (error) {
    if (/No such (?:object|container)/i.test(String((error as { stderr?: string }).stderr))) return null;
    throw new MinecraftOverviewRendererError("The overview worker state could not be read.");
  }
  try { const value = JSON.parse(raw); if (!value || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)) throw new Error(); return value as MinecraftOverviewWorkerView; }
  catch { throw new MinecraftOverviewRendererError("The overview worker response is incomplete."); }
}
export function assertOwnedMinecraftOverviewWorker(value: MinecraftOverviewWorkerView, name: string, jobId: string, profileId?: string, imageId?: string): void {
  if (value.name !== `/${name}` || value.service !== MINECRAFT_OVERVIEW_SERVICE || value.project !== "yoshling" || value.job !== jobId || value.worker !== "1" || value.memory !== OVERVIEW_WORKER_MEMORY || value.swap !== OVERVIEW_WORKER_MEMORY || value.cpu !== 1_000_000_000 || value.pids !== 256 || value.network !== "none" || value.readonly !== true || !Array.isArray(value.mounts) || !Array.isArray(value.caps) || !value.caps.includes("ALL") || !Array.isArray(value.security) || !value.security.some(item => item === "no-new-privileges:true" || item === "no-new-privileges")) throw new MinecraftOverviewRendererError("Overview worker identity or resource isolation could not be verified.");
  if (value.privileged !== false || value.user !== "0:0" || value.pidMode !== "" || value.ipcMode !== "private" || [value.capAdd, value.binds, value.devices, value.deviceRequests].some(items => items !== null && (!Array.isArray(items) || items.length !== 0))) throw new MinecraftOverviewRendererError("The overview worker must not gain host privileges, devices or namespaces.");
  if (!value.tmpfs || Object.keys(value.tmpfs).length !== 1 || typeof value.tmpfs["/tmp"] !== "string") throw new MinecraftOverviewRendererError("The overview worker requires only a bounded private /tmp mount.");
  const options = value.tmpfs["/tmp"].split(",");
  if (options.length !== 5 || !["rw", "nosuid", "nodev", "mode=1777"].every(option => options.includes(option)) || !options.some(option => option === "size=256m" || option === "size=268435456")) throw new MinecraftOverviewRendererError("The overview worker scratch mount must be limited to 256 MiB.");
  if (value.mounts.some(item => item.Type === "tmpfs" && (item.Destination !== "/tmp" || item.RW !== true))) throw new MinecraftOverviewRendererError("The overview worker has an unexpected scratch mount.");
  if (imageId && value.image !== imageId) throw new MinecraftOverviewRendererError("The overview worker did not use the inspected renderer image.");
  const volumes = value.mounts.filter(item => item.Type !== "tmpfs");
  if (volumes.length !== 2 || !volumes.every(item => item.Type === "volume" && item.Name === "yoshling_web-data") || !volumes.some(item => item.Destination === "/input" && item.RW === false) || !volumes.some(item => item.Destination === "/output" && item.RW === true)) throw new MinecraftOverviewRendererError("Overview worker mounts must contain only its private input and output.");
  if (!Array.isArray(value.hostMounts) || value.hostMounts.length !== 2 || !value.hostMounts.every(item => item.Type === "volume" && item.Source === "yoshling_web-data")) throw new MinecraftOverviewRendererError("Overview worker volume declarations could not be verified.");
  if (profileId) {
    const base = `minecraft-profile-overviews/${profileId}/jobs/${jobId}`;
    if (!value.hostMounts.some(item => item.Target === "/input" && item.ReadOnly === true && item.VolumeOptions?.Subpath === `${base}/input`) || !value.hostMounts.some(item => item.Target === "/output" && item.ReadOnly !== true && item.VolumeOptions?.Subpath === `${base}/output`)) throw new MinecraftOverviewRendererError("The overview worker must mount only this job's contained volume subpaths.");
  }
}
async function disposeWorker(name: string, jobId: string, profileId: string, imageId: string, id: string): Promise<void> {
  const existing = await worker(id); if (!existing) { if (await worker(name)) throw new MinecraftOverviewRendererError("An unexpected overview worker replaced the admitted identity."); return; }
  if (existing.id !== id) throw new MinecraftOverviewRendererError("The admitted overview worker identity changed.");
  assertOwnedMinecraftOverviewWorker(existing, name, jobId, profileId, imageId);
  if (!["exited", "dead", "created"].includes(existing.state)) await docker(["stop", "--time", "2", existing.id]);
  const stopped = await worker(existing.id);
  if (stopped && !["exited", "dead", "created"].includes(stopped.state)) throw new MinecraftOverviewRendererError("The overview worker could not be verified stopped.");
  if (stopped) { assertOwnedMinecraftOverviewWorker(stopped, name, jobId, profileId, imageId); await docker(["rm", stopped.id]); }
  if (await worker(name)) throw new MinecraftOverviewRendererError("The overview worker removal could not be verified.");
}
async function resetOutput(relative: string): Promise<void> {
  const output = await overviewPath(`${relative}/output`, true);
  const info = await lstat(output).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())) throw new MinecraftOverviewRendererError("The overview output directory is not owned scratch storage.");
  if (info) await rm(output, { recursive: true });
  await mkdir(output, { mode: 0o700 });
  if ((await readdir(output)).length) throw new MinecraftOverviewRendererError("The overview scratch reset could not be verified.");
}
export async function renderMinecraftProfileOverview(input: MinecraftOverviewRenderInput, op: OpHandle): Promise<MinecraftOverviewRenderReceipt> {
  minecraftProfileId(input.profileId); minecraftProfileId(input.jobId);
  const relative = `${input.profileId}/jobs/${input.jobId}`;
  if (input.jobRelativePath !== relative || path.resolve(overviewRoot()) !== "/app/data/minecraft-profile-overviews" || !minecraftOverviewTargetSupport(input.target).supported) throw new MinecraftOverviewRendererError("The overview job target or mounted path is unsupported.");
  const manifest = await readOverviewJSON(`${relative}/input/manifest.json`) as { format?: number; profileId?: string; jobId?: string; source?: { sha256?: string }; center?: { x?: number; z?: number }; radius?: number; dimension?: string };
  if (manifest.format !== 1 || manifest.profileId !== input.profileId || manifest.jobId !== input.jobId || manifest.source?.sha256 !== input.source.sha256 || manifest.radius !== 64 || !Number.isSafeInteger(manifest.center?.x) || !Number.isSafeInteger(manifest.center?.z) || manifest.dimension !== "overworld") throw new MinecraftOverviewRendererError("The overview input manifest does not match its admitted job.");
  const before = await budget(); if (before || op.preempted) throw new MinecraftOverviewDeferredError(before || "The overview operation was interrupted.");
  let imageId: string;
  try { imageId = await docker(["image", "inspect", "--format", "{{.Id}}", MINECRAFT_OVERVIEW_IMAGE]); if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error(); }
  catch { throw new MinecraftOverviewDeferredError("The pinned overview renderer image is unavailable; deployment must build it first."); }
  // Persisted Docker ownership survives a web restart; the in-memory queue does not.
  if (await docker(["ps", "-aq", "--filter", "label=yoshling.overview.worker=1"])) throw new MinecraftOverviewRendererError("An existing overview worker needs review before another job can run.");
  const name = `yoshling-overview-${input.jobId}`;
  if (await worker(name)) throw new MinecraftOverviewRendererError("An existing overview worker needs review before this job can run.");
  await resetOutput(relative);
  let created = false, finished = false, createdId = "";
  try {
    // Compose owns this non-game job. Only these two private subpaths enter it.
    const { stdout } = await command("docker", ["compose", "-p", "yoshling", "-f", COMPOSE_FILE, "run", "--detach", "--no-deps", "--pull", "never", "--name", name, "--label", `yoshling.overview.job=${input.jobId}`, MINECRAFT_OVERVIEW_SERVICE], { cwd: path.dirname(COMPOSE_FILE), env: { ...process.env, MC_OVERVIEW_INPUT_SUBPATH: `minecraft-profile-overviews/${relative}/input`, MC_OVERVIEW_OUTPUT_SUBPATH: `minecraft-profile-overviews/${relative}/output` }, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    const id = stdout.trim(); if (!/^[a-f0-9]{64}$/.test(id)) throw new MinecraftOverviewRendererError("Overview creation returned no verified container identity.");
    created = true; createdId = id;
    const deadline = Date.now() + DEADLINE_MS;
    for (;;) {
      const current = await worker(id);
      if (!current) throw new MinecraftOverviewRendererError("The admitted overview worker disappeared before exit verification.");
      assertOwnedMinecraftOverviewWorker(current, name, input.jobId, input.profileId, imageId);
      if (current.state === "exited") { if (current.exitCode !== 0) throw new MinecraftOverviewRendererError("The overview renderer exited without a successful image receipt."); break; }
      const used = minecraftOverviewWorkerMemory(await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", id], 5000));
      const reason = used === null ? "The overview worker memory reading is unknown." : await budget(used);
      if (op.preempted || reason) throw new MinecraftOverviewDeferredError(reason || "The overview operation was interrupted.");
      if (Date.now() >= deadline) throw new MinecraftOverviewRendererError("The overview renderer exceeded its ten-minute deadline.");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const receipt = await readOverviewJSON(`${relative}/output/receipt.json`) as { format?: number; profileId?: string; jobId?: string; sourceSha256?: string; renderer?: { name?: string; version?: string }; width?: number; height?: number; image?: { file?: string; bytes?: number; sha256?: string }; center?: { x?: number; z?: number }; radius?: number; dimension?: string };
    const bytes = await readOverviewBytes(`${relative}/output/overview.png`, 5 * 1024 * 1024);
    if (receipt.format !== 1 || receipt.profileId !== input.profileId || receipt.jobId !== input.jobId || receipt.sourceSha256 !== input.source.sha256 || receipt.renderer?.name !== "bluemap" || receipt.renderer.version !== "5.28" || receipt.radius !== 64 || receipt.center?.x !== manifest.center?.x || receipt.center?.z !== manifest.center?.z || receipt.dimension !== "overworld" || !Number.isSafeInteger(receipt.width) || !Number.isSafeInteger(receipt.height) || receipt.width! < 1 || receipt.width! > 1600 || receipt.height! < 1 || receipt.height! > 1000 || receipt.image?.file !== "overview.png" || receipt.image.bytes !== bytes.length || receipt.image.sha256 !== overviewHash(bytes)) throw new MinecraftOverviewRendererError("The overview worker image receipt failed independent readback.");
    const metadata = await sharp(bytes, { limitInputPixels: 1_600_000, animated: false }).metadata();
    if (metadata.format !== "png" || metadata.width !== receipt.width || metadata.height !== receipt.height) throw new MinecraftOverviewRendererError("Overview pixel dimensions disagree with the renderer receipt.");
    finished = true;
    return { renderer: { name: "bluemap", version: "5.28" }, width: receipt.width!, height: receipt.height! };
  } catch (error) {
    if (!created && !(error instanceof MinecraftOverviewDeferredError)) throw new MinecraftOverviewRendererError("Overview creation is unverified; inspect the named worker before retrying.");
    throw error;
  } finally {
    if (created) { await disposeWorker(name, input.jobId, input.profileId, imageId, createdId); if (!finished) await resetOutput(relative); }
  }
}
