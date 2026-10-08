import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, readdir } from "node:fs/promises";
import { db } from "./db";
import { canAccessGame, hasPermission, isRole } from "./permissions";
import { discordUserId } from "./discord-identity";
import { isWhitelisted } from "./whitelist";
import { getMinecraftProfile, listMinecraftProfiles, type MinecraftProfileRecord } from "./minecraft-profile-store";
import { runOperation, runFileWrite, listOperations, assertFileWriteActive, type OpHandle } from "./operations";
import { normalizeMinecraftProfileCover } from "./minecraft-profile-cover";
import { renderMinecraftProfileOverview, minecraftOverviewTargetSupport } from "./minecraft-overview-renderer";
import { copyMinecraftOverviewSource, hashOverviewSourceFile, verifyMinecraftOverviewInput } from "./minecraft-profile-overview-source";
import { overviewPath, overviewHash, readOverviewBytes, readOverviewRecord, readOverviewJob, writeOverviewJob, writeOverviewJSON, writeOverviewRecord, writeOverviewBytes, listOverviewProfiles, sameOverviewTarget, minecraftOverviewInputManifest, verifyMinecraftOverviewManifest, MinecraftOverviewError, OVERVIEW_MAX_IMAGE, type OverviewRecord, type OverviewJob, type OverviewArtifact } from "./minecraft-profile-overview-store";
import type { MinecraftProfileOverviewDTO, MinecraftProfileOverviewRequestReceipt } from "./minecraft-profile-overview-types";
import type { MinecraftProfileTarget } from "./minecraft-profile-types";
import type { MinecraftOverviewArchive } from "./minecraft-profile-overview-archive";

const global = globalThis as typeof globalThis & { __yoshlingOverviewQueue?: { ticking: boolean; working: boolean; live: Map<string, string> } };
const queue = global.__yoshlingOverviewQueue ??= { ticking: false, working: false, live: new Map() };
const RETRY_MS = 15 * 60_000, MAX_QUEUED = 16;
export function minecraftOverviewProfileTarget(profile: MinecraftProfileRecord): MinecraftProfileTarget { return { mcVersion: profile.mcVersion, loader: profile.loader, loaderVersion: profile.loaderVersion, javaVariant: profile.javaVariant }; }
export async function overviewManager(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { discordId: true, role: true, games: true } });
  if (!user || !discordUserId(user.discordId) || !isRole(user.role) || !canAccessGame(user.role, user.games, "minecraft") || !hasPermission(user.role, "settings.edit") || !await isWhitelisted(user.discordId)) throw new MinecraftOverviewError("The managing account is no longer authorized for Minecraft overviews", 403, "overview_revoked");
}
function empty(state: MinecraftProfileOverviewDTO["state"] = "waiting", reason: string | null = "Waiting for overview generation"): MinecraftProfileOverviewDTO {
  return { state, reason, imageUrl: null, revision: null, generatedAt: null, snapshotAt: null, sourceSavedAt: null, renderer: null, source: null, operationId: null, dimension: "overworld" };
}
function live(row: OverviewRecord) { return !!row.jobId && !!row.operationId && queue.live.get(row.jobId) === row.operationId && listOperations(["minecraft"]).some(op => op.id === row.operationId && op.kind === "profile.overview" && !op.endedAt); }
async function verifyArtifact(profileId: string, artifact: OverviewArtifact): Promise<void> {
  const file = await overviewPath(`${profileId}/images/${artifact.revision}.png`), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.gid !== process.getgid?.() || (info.mode & 0o777) !== 0o600 || info.size !== artifact.bytes || info.size > OVERVIEW_MAX_IMAGE) throw new MinecraftOverviewError("The generated image is not an owned verified artifact", 503, "overview_unverified");
  const receipt = await hashOverviewSourceFile(file, OVERVIEW_MAX_IMAGE);
  if (receipt.sha256 !== artifact.revision || receipt.bytes !== artifact.bytes) throw new MinecraftOverviewError("The generated image no longer matches its receipt", 503, "overview_unverified");
}
/** Failed optional image metadata never changes gameplay authorization/readiness. */
export async function readMinecraftProfileOverview(profile: MinecraftProfileRecord): Promise<MinecraftProfileOverviewDTO> {
  try {
    const support = minecraftOverviewTargetSupport(minecraftOverviewProfileTarget(profile));
    if (!support.supported) return empty("unsupported", support.reason ?? "The saved world target is not supported by the renderer");
    const row = await readOverviewRecord(profile.id);
    if (!row) return empty();
    if (!sameOverviewTarget(row.target, minecraftOverviewProfileTarget(profile))) return empty("stale", "This overview belongs to a different recorded world target");
    const result = empty(row.state, row.reason); result.operationId = row.operationId;
    if (row.state === "queued") {
      if (!row.jobId) throw new MinecraftOverviewError("The queued overview identity is missing", 503, "overview_unverified");
      const job = await readOverviewJob(profile.id, row.jobId);
      if (job.phase !== "queued" || !sameOverviewTarget(job.target, row.target)) throw new MinecraftOverviewError("The queued overview target is unverified", 503, "overview_unverified");
      await verifyMinecraftOverviewManifest(profile.id, job.id, job.target, job.source);
    }
    if (row.state === "rendering" && !live(row)) { result.state = "unverified"; result.reason = "The renderer's completion is unverified after interruption. Owner review is required before retrying."; }
    if (row.artifact) {
      await verifyArtifact(profile.id, row.artifact);
      const latest = await readOverviewRecord(profile.id), current = await getMinecraftProfile(profile.id);
      if (!current || !sameOverviewTarget(minecraftOverviewProfileTarget(current), row.target) || latest?.artifact?.revision !== row.artifact.revision) return empty("unverified", "The overview changed during image readback");
      Object.assign(result, { imageUrl: `/api/minecraft/profiles/${profile.id}/overview/image?revision=${row.artifact.revision}`, revision: row.artifact.revision, generatedAt: row.artifact.generatedAt,
        snapshotAt: row.artifact.source.snapshotAt, sourceSavedAt: row.artifact.source.sourceSavedAt, renderer: row.artifact.renderer,
        source: { kind: row.artifact.source.kind, id: row.artifact.source.id, sha256: row.artifact.source.sha256 } });
    } else if (row.state === "ready" || row.state === "stale") return empty("unverified", "The generated image receipt is missing");
    return result;
  } catch { return empty("unverified", "Generated overview metadata or image bytes could not be verified"); }
}
export async function readMinecraftProfileOverviewImage(profile: MinecraftProfileRecord, revision: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new MinecraftOverviewError("Invalid overview image revision", 400);
  const row = await readOverviewRecord(profile.id);
  if (!row?.artifact || row.artifact.revision !== revision || !sameOverviewTarget(row.target, minecraftOverviewProfileTarget(profile))) throw new MinecraftOverviewError("Generated overview image not found", 404, "overview_not_found");
  const bytes = await readOverviewBytes(`${profile.id}/images/${revision}.png`, OVERVIEW_MAX_IMAGE);
  if (bytes.length !== row.artifact.bytes || overviewHash(bytes) !== revision) throw new MinecraftOverviewError("The generated image failed byte readback", 503, "overview_unverified");
  const current = await getMinecraftProfile(profile.id), latest = await readOverviewRecord(profile.id);
  if (!current || latest?.artifact?.revision !== revision || !sameOverviewTarget(row.target, minecraftOverviewProfileTarget(current))) throw new MinecraftOverviewError("The generated image changed during readback", 409, "overview_stale");
  return bytes;
}
async function capacity(): Promise<void> {
  let count = 0;
  for (const id of await listOverviewProfiles()) { const row = await readOverviewRecord(id); if (row && (row.state === "queued" || row.state === "rendering")) count++; }
  if (count >= MAX_QUEUED) throw new MinecraftOverviewError("The overview queue is full; existing work must settle first", 429, "overview_capacity");
}
async function prepareJob(profile: MinecraftProfileRecord, actor: OverviewJob["actor"], op: OpHandle): Promise<{ jobId: string | null; row: OverviewRecord }> {
  const prior = await readOverviewRecord(profile.id), target = minecraftOverviewProfileTarget(profile), support = minecraftOverviewTargetSupport(target);
  if (!support.supported) throw new MinecraftOverviewError(support.reason ?? "This Minecraft target is unsupported by the overview renderer", 422, "overview_unsupported");
  if (prior?.state === "rendering") throw new MinecraftOverviewError(live(prior) ? "This overview is already rendering" : "The previous renderer completion is unverified; owner review is required", 409, live(prior) ? "overview_busy" : "overview_unverified");
  if (prior?.state === "unverified") throw new MinecraftOverviewError("The previous overview job needs owner review before another renderer can overwrite it", 409, "overview_unverified");
  if (prior?.state === "queued") throw new MinecraftOverviewError("This overview is already queued", 409, "overview_busy");
  if (prior?.artifact) await verifyArtifact(profile.id, prior.artifact);
  await capacity();
  const jobId = randomUUID(); let admitted = false;
  const row: OverviewRecord = { format: 1, profileId: profile.id, target, state: "waiting", reason: null, updatedAt: new Date().toISOString(), operationId: op.id, jobId: null, retryAt: Date.now() + RETRY_MS, artifact: prior?.artifact ?? null };
  try {
    op.step("Copying verified saved Overworld terrain");
    const source = await copyMinecraftOverviewSource(profile.id, jobId);
    assertFileWriteActive();
    const current = await getMinecraftProfile(profile.id);
    if (!current || current.status !== "ready" || current.revision !== profile.revision || !sameOverviewTarget(minecraftOverviewProfileTarget(current), target)) throw new MinecraftOverviewError("The profile changed while its saved overview source was copied", 409, "overview_stale");
    if (actor) await overviewManager(actor.userId);
    if (!source) {
      row.state = prior?.artifact ? "stale" : "waiting"; row.reason = "Waiting for the first saved Overworld terrain near its spawn. No game was started or saved.";
      await writeOverviewRecord(row); op.settle("No saved spawn terrain is available yet", { kind: "noop" }); op.fact({ label: "Overview", value: "Waiting for saved Overworld terrain" });
      return { row, jobId: null };
    }
    const job: OverviewJob = { format: 1, id: jobId, profileId: profile.id, target, source, actor, phase: "queued", createdAt: new Date().toISOString(), operationId: null };
    await writeOverviewJSON(`${profile.id}/jobs/${jobId}/input/manifest.json`, minecraftOverviewInputManifest(profile.id, jobId, target, source));
    await writeOverviewJob(job);
    row.state = "queued"; row.jobId = jobId; row.retryAt = 0; row.reason = "A verified saved-world copy is queued for rendering";
    await writeOverviewRecord(row); admitted = true;
    op.settle(`Copied and verified ${source.files.length} saved-world files`, { count: { done: source.files.length, total: source.files.length, noun: "files" } });
    op.fact({ label: "Overview", value: "A verified saved-world overview was queued" });
    return { row, jobId };
  } finally { if (!admitted) { const stage = await overviewPath(`${profile.id}/jobs/${jobId}`, true); await rm(stage, { recursive: true, force: true }); } }
}
export async function requestMinecraftProfileOverview(id: string, input: { expectedRevision: number; expectedOverviewRevision: string | null; actor: NonNullable<OverviewJob["actor"]> }): Promise<MinecraftProfileOverviewRequestReceipt> {
  let operationId: string | undefined;
  try {
    return await runOperation({ kind: "profile.overview", game: "minecraft", resources: ["files:minecraft"], title: "Preparing Minecraft world overview", startedBy: input.actor.name ? { name: input.actor.name } : null }, async op => {
      operationId = op.id; await overviewManager(input.actor.userId);
      const profile = await getMinecraftProfile(id);
      if (!profile || profile.status !== "ready") throw new MinecraftOverviewError("A ready Minecraft profile is required", 409, "overview_not_ready");
      if (profile.revision !== input.expectedRevision) throw new MinecraftOverviewError("The profile changed; reload before regenerating", 409, "overview_stale");
      const prior = await readOverviewRecord(id);
      if ((prior?.artifact?.revision ?? null) !== input.expectedOverviewRevision) throw new MinecraftOverviewError("The generated overview changed; reload before regenerating", 409, "overview_stale");
      const result = await prepareJob(profile, input.actor, op);
      return { value: { profileId: id, jobId: result.jobId, operationId: op.id, overview: await readMinecraftProfileOverview(profile) } };
    });
  } catch (error) { if (operationId && error instanceof Error) Object.assign(error, { operationId, profileId: id }); throw error; }
}
async function renderJob(profileId: string, jobId: string): Promise<void> {
  await runOperation({ kind: "profile.overview", game: "minecraft", title: "Rendering Minecraft world overview" }, async op => {
    const row = await readOverviewRecord(profileId), job = await readOverviewJob(profileId, jobId);
    if (!row || row.jobId !== jobId || row.state !== "queued" || job.phase !== "queued") throw new MinecraftOverviewError("The queued overview no longer matches its admission", 409, "overview_stale");
    const profile = await getMinecraftProfile(profileId);
    if (!profile || profile.status !== "ready" || !sameOverviewTarget(job.target, minecraftOverviewProfileTarget(profile))) throw new MinecraftOverviewError("The queued profile changed or was deleted", 409, "overview_stale");
    if (job.actor) await overviewManager(job.actor.userId);
    try {
      await runFileWrite("minecraft", async () => {
        const current = await getMinecraftProfile(profileId), latest = await readOverviewRecord(profileId);
        if (!current || current.status !== "ready" || !sameOverviewTarget(job.target, minecraftOverviewProfileTarget(current)) || latest?.jobId !== jobId || latest.state !== "queued") throw new MinecraftOverviewError("The queued profile changed before renderer admission", 409, "overview_stale");
        queue.live.set(jobId, op.id);
        row.state = "rendering"; row.operationId = op.id; row.reason = "Rendering the pinned saved Overworld copy"; job.phase = "rendering"; job.operationId = op.id;
        await writeOverviewJob(job); await writeOverviewRecord(row);
      });
      await verifyMinecraftOverviewInput(profileId, jobId, job.source, job.target);
      const output = await overviewPath(`${profileId}/jobs/${jobId}/output`, true); await mkdir(output, { mode: 0o700, recursive: true });
      await overviewPath(`${profileId}/jobs/${jobId}/output/overview.png`, true);
      op.step("Rendering saved terrain in the isolated worker");
      const receipt = await renderMinecraftProfileOverview({ profileId, jobId, jobRelativePath: `${profileId}/jobs/${jobId}`, source: job.source, target: job.target }, op);
      await verifyMinecraftOverviewInput(profileId, jobId, job.source, job.target);
      const raw = await readOverviewBytes(`${profileId}/jobs/${jobId}/output/overview.png`, OVERVIEW_MAX_IMAGE), normalized = await normalizeMinecraftProfileCover(raw, true);
      if (normalized.length > OVERVIEW_MAX_IMAGE || !Number.isSafeInteger(receipt.width) || !Number.isSafeInteger(receipt.height) || receipt.width < 1 || receipt.height < 1) throw new MinecraftOverviewError("The renderer output is unverified", 503, "overview_unverified");
      op.settle("Rendered and independently decoded the saved-world overview");
      await runFileWrite("minecraft", async () => {
        const current = await getMinecraftProfile(profileId), latest = await readOverviewRecord(profileId), persisted = await readOverviewJob(profileId, jobId);
        if (!current || current.status !== "ready" || !sameOverviewTarget(job.target, minecraftOverviewProfileTarget(current)) || latest?.jobId !== jobId || latest.state !== "rendering" || persisted.phase !== "rendering" || persisted.source.sha256 !== job.source.sha256) throw new MinecraftOverviewError("The profile or admitted job changed before overview publication", 409, "overview_stale");
        if (job.actor) await overviewManager(job.actor.userId);
        const revision = overviewHash(normalized), artifact: OverviewArtifact = { revision, bytes: normalized.length, generatedAt: new Date().toISOString(), jobId, renderer: receipt.renderer, source: job.source };
        op.step("Publishing and reading back the generated default cover");
        await writeOverviewBytes(`${profileId}/images/${revision}.png`, normalized);
        await verifyArtifact(profileId, artifact);
        assertFileWriteActive();
        if (!await getMinecraftProfile(profileId)) throw new MinecraftOverviewError("The profile was deleted before publication", 409, "overview_stale");
        row.state = "ready"; row.reason = job.target.loader === "vanilla" ? "Generated from a verified saved Overworld copy" : "Generated using vanilla assets; modded blocks may be simplified"; row.artifact = artifact; row.updatedAt = new Date().toISOString(); row.retryAt = 0;
        await writeOverviewRecord(row);
        const verified = await readMinecraftProfileOverview(current);
        if (verified.state !== "ready" || verified.revision !== revision || verified.imageUrl === null) throw new MinecraftOverviewError("Generated cover publication could not be confirmed", 503, "overview_unverified");
        job.phase = "complete"; await writeOverviewJob(job);
        try { await pruneOverviewScratch(profileId, jobId); } catch { row.reason += "; private snapshot cleanup needs owner review"; await writeOverviewRecord(row); op.fact({ label: "Snapshot cleanup", value: "private renderer scratch could not be completely removed", verdict: "warn" }); }
        op.settle("The generated default image and source receipt were read back");
        op.fact({ label: "Overview", value: "Generated world overview published and read back" });
      });
      return { value: undefined };
    } catch (error) {
      const deferred = error && typeof error === "object" && "code" in error && error.code === "overview_deferred";
      // Preserve any verified earlier image; a crash leaves rendering unverified instead of guessing completion.
      const current = await getMinecraftProfile(profileId).catch(() => null), latest = await readOverviewRecord(profileId).catch(() => null);
      if (current && latest?.jobId === jobId) {
        latest.state = deferred ? "queued" : error && typeof error === "object" && "code" in error && error.code === "overview_unverified" ? "unverified" : "failed";
        latest.reason = error instanceof Error ? error.message.slice(0, 1000) : "Overview rendering failed"; latest.retryAt = Date.now() + RETRY_MS;
        job.phase = deferred ? "queued" : "failed";
        await writeOverviewJob(job); await writeOverviewRecord(latest);
      }
      if (deferred) { op.step("Deferring overview rendering"); op.settle("Rendering will wait for safe host resources", { kind: "noop" }); op.fact({ label: "Overview", value: "Rendering deferred until safe host resources are available" }); return { value: undefined }; }
      throw error;
    } finally { queue.live.delete(jobId); }
  });
}
async function pruneOverviewScratch(profileId: string, jobId: string): Promise<void> {
  for (const name of ["input", "output"]) {
    const file = await overviewPath(`${profileId}/jobs/${jobId}/${name}`);
    const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.gid !== process.getgid?.()) throw new MinecraftOverviewError("Renderer scratch cleanup is unverified", 503, "overview_unverified");
    assertFileWriteActive(); await rm(file, { recursive: true });
    if (await lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new MinecraftOverviewError("Renderer scratch remains present", 503, "overview_unverified");
  }
  const root = await overviewPath(`${profileId}/jobs`), names = (await readdir(root)).sort();
  const completed: OverviewJob[] = [];
  for (const id of names) { const job = await readOverviewJob(profileId, id); if (job.phase === "complete") completed.push(job); }
  completed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of completed.slice(3)) { if (old.id === jobId) continue; assertFileWriteActive(); await rm(await overviewPath(`${profileId}/jobs/${old.id}`), { recursive: true }); }
  const row = await readOverviewRecord(profileId), images = await overviewPath(`${profileId}/images`);
  for (const name of await readdir(images)) if (/^[a-f0-9]{64}\.png$/.test(name) && name !== `${row?.artifact?.revision}.png`) { const file = await overviewPath(`${profileId}/images/${name}`); const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.gid !== process.getgid?.()) throw new MinecraftOverviewError("Old overview image cleanup is unverified", 503); assertFileWriteActive(); await rm(file); }
}
export async function runMinecraftProfileOverviewQueue(): Promise<void> {
  if (queue.working) return; queue.working = true;
  try {
    for (const profileId of await listOverviewProfiles()) {
      const row = await readOverviewRecord(profileId);
      if (row?.state === "queued" && row.jobId && Date.now() >= row.retryAt) {
        try { await renderJob(profileId, row.jobId); }
        catch (error) {
          await runFileWrite("minecraft", async () => {
            const latest = await readOverviewRecord(profileId);
            if (latest?.jobId === row.jobId && latest.state === "queued") { latest.state = "unverified"; latest.reason = "The queued overview source or admission could not be verified; owner review is required"; await writeOverviewRecord(latest); }
          });
          throw error;
        }
        break;
      }
    }
  } finally { queue.working = false; }
}
/** Timer owner is instrumentation. Read-only HTTP endpoints never enqueue or seed data. */
export async function tickMinecraftProfileOverviews(): Promise<void> {
  if (queue.ticking) return; queue.ticking = true;
  try {
    for (const profile of await listMinecraftProfiles()) {
      if (profile.status !== "ready" || !minecraftOverviewTargetSupport(minecraftOverviewProfileTarget(profile)).supported) continue;
      const row = await readOverviewRecord(profile.id);
      if (row?.artifact || row && (row.state === "queued" || row.state === "rendering" || row.state === "unverified" || Date.now() < row.retryAt)) continue;
      try { await runOperation({ kind: "profile.overview", game: "minecraft", resources: ["files:minecraft"], title: "Preparing Minecraft world overview" }, async op => { await prepareJob(profile, null, op); return { value: undefined }; }); }
      catch (error) {
        if (!(error instanceof MinecraftOverviewError)) throw error;
        await runFileWrite("minecraft", async () => {
          if (!await getMinecraftProfile(profile.id)) return;
          const deferred = ["overview_deferred", "overview_no_space", "overview_source_changed"].includes(error.code);
          await writeOverviewRecord({ format: 1, profileId: profile.id, target: minecraftOverviewProfileTarget(profile), state: deferred ? "waiting" : error.code === "overview_unverified" ? "unverified" : "failed", reason: error.message, updatedAt: new Date().toISOString(), jobId: null, operationId: null, retryAt: Date.now() + RETRY_MS, artifact: null });
        });
      }
    }
    await runMinecraftProfileOverviewQueue();
  } finally { queue.ticking = false; }
}
/** Piggyback only on an already sanctioned file/lifecycle operation; optional covers cannot fail a game change. */
export async function notifyMinecraftProfileOverviewReady(id: string, op: OpHandle): Promise<void> {
  try {
    const profile = await getMinecraftProfile(id), prior = await readOverviewRecord(id);
    if (!profile || profile.status !== "ready" || prior?.artifact || prior && ["queued", "rendering", "unverified"].includes(prior.state) || !minecraftOverviewTargetSupport(minecraftOverviewProfileTarget(profile)).supported) return;
    await prepareJob(profile, null, op);
  } catch (error) {
    // No power action or game data modification is needed to recover an optional cover.
    op.settle("The optional overview source was refused or deferred", { kind: "noop" });
    op.fact({ label: "Default cover", value: error instanceof Error ? `overview generation is pending: ${error.message.slice(0, 300)}` : "overview generation is pending", verdict: "warn" });
  }
}
export async function notifyMinecraftProfileOverviewBackup(archive: MinecraftOverviewArchive, op: OpHandle): Promise<void> {
  try {
    const profile = await getMinecraftProfile(archive.profileId), prior = await readOverviewRecord(archive.profileId);
    if (!profile || profile.status !== "ready" || prior?.artifact || prior && ["queued", "rendering", "unverified"].includes(prior.state) || !minecraftOverviewTargetSupport(minecraftOverviewProfileTarget(profile)).supported) return;
    await writeOverviewRecord({ format: 1, profileId: profile.id, target: minecraftOverviewProfileTarget(profile), state: "waiting", reason: "A saved backup is available; waiting for verified overview snapshot admission", updatedAt: new Date().toISOString(), jobId: null, operationId: null, retryAt: 0, artifact: null });
  } catch (error) { op.fact({ label: "Default cover", value: error instanceof Error ? `overview notification is pending: ${error.message.slice(0, 300)}` : "overview notification is pending", verdict: "warn" }); }
}
/** Inactive deletion owns the file lane; final renderer publication cannot resurrect it. */
export async function assertMinecraftProfileOverviewDeletable(id: string): Promise<void> {
  const row = await readOverviewRecord(id);
  if (row?.state === "rendering") throw new MinecraftOverviewError(live(row) ? "Wait for the overview renderer before deleting this profile" : "The interrupted overview renderer needs owner review before deletion", 409, live(row) ? "overview_busy" : "overview_unverified");
}
export async function deleteMinecraftProfileOverview(id: string): Promise<void> {
  const root = await overviewPath(id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!root) return;
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.gid !== process.getgid?.()) throw new MinecraftOverviewError("Overview cleanup path is unverified", 503, "overview_unverified");
  await assertMinecraftProfileOverviewDeletable(id);
  assertFileWriteActive(); await rm(root, { recursive: true, force: true });
  if (await lstat(root).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new MinecraftOverviewError("Overview removal could not be verified", 503, "overview_unverified");
}
