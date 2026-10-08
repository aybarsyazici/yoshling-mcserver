import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { CoResidencyError } from "@/lib/coresidency";
import { GAMES, otherGames, type GameId } from "@/lib/games";
import {
  gameContainerState, inspectMinecraftProfileContainer, minecraftProfileContainerAgrees,
  minecraftProfileIsReady, prepareMinecraftProfileImage, recreateMinecraftProfileForOperation,
  invalidateMinecraftRuntimeProbes,
  RUNTIME, startGameForOperation, stopGameForOperation, waitForMinecraftProfileReady,
} from "@/lib/game-manager";
import {
  minecraftProfileComposeSettings, readMinecraftProfileComposeSettings,
  type MinecraftProfileComposeSettings,
} from "@/lib/compose";
import { claimOperationPower, runOperation, type OpHandle } from "@/lib/operations";
import { prepareMinecraftProfile, prepareMinecraftProfileControlSettings } from "@/lib/minecraft-profile-prepare";
import {
  commitProfileActivation, getMinecraftProfile, readMinecraftRuntime,
  toMinecraftProfileDTO, updateProfileRecord, type MinecraftProfileRecord,
} from "@/lib/minecraft-profile-store";
import { legacyMinecraftDataPresent, minecraftProfilePath, minecraftProfileServerPath } from "@/lib/minecraft-profile-path";
import { copyVerifiedMinecraftTree, inventoryMinecraftTree, requireMinecraftCopySpace } from "@/lib/minecraft-profile-copy";
import type { MinecraftProfileDTO, MinecraftProfileRuntimeDTO } from "@/lib/minecraft-profile-types";
import { readWorldVersion } from "@/lib/mc-world-version";
import { isDowngrade } from "@/lib/mc-version-guard";
import { withMinecraftProfileOperationMarker } from "@/lib/minecraft-profile-operation-marker";

const STOPPED = new Set(["created", "exited", "dead"]);

export class MinecraftProfileActionError extends Error {
  constructor(message: string, readonly status: number, readonly operationId?: string,
    readonly running?: GameId[]) {
    super(message);
    this.name = "MinecraftProfileActionError";
  }
}

export function profileActionError(error: unknown, operationId?: string): MinecraftProfileActionError {
  if (error instanceof MinecraftProfileActionError) {
    return new MinecraftProfileActionError(error.message, error.status, operationId ?? error.operationId, error.running);
  }
  if (error instanceof CoResidencyError) return new MinecraftProfileActionError(error.message, 409, operationId, error.running);
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status : 502;
  return new MinecraftProfileActionError(error instanceof Error ? error.message : "Minecraft profile action failed", status, operationId);
}

function targetSettings(profile: MinecraftProfileRecord): MinecraftProfileComposeSettings {
  return minecraftProfileComposeSettings(profile.id, {
    mcVersion: profile.mcVersion, loader: profile.loader,
    loaderVersion: profile.loaderVersion, javaVariant: profile.javaVariant,
  });
}

/** A DB selection is a record. Only mount/env/image agreement establishes applied identity. */
export async function getMinecraftProfileRuntimeStatus(): Promise<MinecraftProfileRuntimeDTO> {
  let selectedProfileId: string | null = null;
  let appliedProfileId: string | null = null;
  let revision = "0";
  let containerState: string | undefined;
  const unknown = (reason: string): MinecraftProfileRuntimeDTO => ({
    selectedProfileId, appliedProfileId, verified: false, state: "unknown", reason, revision,
    containerState, identityStatus: "unknown",
  });
  try {
    const { schemaReady, runtime } = await readMinecraftRuntime();
    selectedProfileId = runtime?.selectedProfileId ?? null;
    revision = runtime?.revision ?? "0";
    containerState = await gameContainerState("minecraft");
    if (!schemaReady) return unknown("Minecraft profiles need their reviewed database migration before use.");
    if (containerState === "missing") return unknown("Minecraft's container is missing; its profile mount cannot be verified.");
    if (containerState !== "running" && !STOPPED.has(containerState)) return unknown(`Minecraft's container is ${containerState}; its state is not safe to change.`);
    const [configured, identity] = await Promise.all([
      readMinecraftProfileComposeSettings(), inspectMinecraftProfileContainer(),
    ]);
    appliedProfileId = /^profiles\/([0-9a-f-]{36})\/server$/.exec(identity.subpath)?.[1] ?? null;
    if (!minecraftProfileContainerAgrees(identity, configured)) return unknown("Minecraft's configured and created-container mount, version, loader or Java image differ.");
    if (!selectedProfileId) {
      if (configured.subpath !== "." || appliedProfileId) return unknown("Minecraft has a profile mount but no selected profile record.");
      return { selectedProfileId: null, appliedProfileId: null, verified: true, state: "legacy", revision,
        containerState, identityStatus: "legacy" };
    }
    const profile = await getMinecraftProfile(selectedProfileId);
    if (!profile || profile.status !== "ready") return unknown("The selected Minecraft profile is missing or is not ready.");
    if (appliedProfileId !== selectedProfileId || !minecraftProfileContainerAgrees(identity, targetSettings(profile))) {
      return unknown("The selected Minecraft profile differs from the applied mount or target. Recovery is required before editing or starting it.");
    }
    return { selectedProfileId, appliedProfileId, verified: true,
      state: containerState === "running" ? await minecraftProfileIsReady() ? "running" : "starting" : "stopped",
      revision, containerState, identityStatus: "checked" };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : "Minecraft's profile identity could not be verified.");
  }
}

/** Complete world/mod/config recovery point, private to this profile and verified before rename. */
export async function checkpointMinecraftProfile(profile: MinecraftProfileRecord, op: OpHandle): Promise<string> {
  const checkpointRoot = path.join(await minecraftProfilePath(profile.id), "checkpoints");
  const rootInfo = await lstat(checkpointRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) throw new Error("Profile checkpoints must be a separate real directory");
  await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  const checkpointId = `${Date.now()}-${randomUUID()}`;
  const staging = await minecraftProfilePath(profile.id, `checkpoints/.staging-${checkpointId}`, { allowMissing: true });
  const destination = await minecraftProfilePath(profile.id, `checkpoints/${checkpointId}`, { allowMissing: true });
  op.step(`Preserving ${profile.name}`, { game: "minecraft" });
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const copy = await copyVerifiedMinecraftTree(await minecraftProfileServerPath(profile.id), path.join(staging, "server"), RUNTIME.minecraft.dir, { op });
    const inventory = await db.installedMod.findMany({ where: { profileId: profile.id } });
    const text = JSON.stringify({ formatVersion: 1, profileId: profile.id, target: targetSettings(profile),
      createdAt: new Date().toISOString(), installedMods: inventory, files: copy.entries });
    const metadata = path.join(staging, "checkpoint.json");
    await writeFile(metadata, text, { flag: "wx", mode: 0o600 });
    if (await readFile(metadata, "utf8") !== text) throw new Error("The Minecraft checkpoint metadata failed readback");
    if (op.preempted) throw new Error("The Minecraft checkpoint was interrupted before publication");
    await rename(staging, destination);
    op.settle(`Preserved and verified ${copy.files} files for ${profile.name}`, { count: { done: copy.files, total: copy.files, noun: "files" } });
    op.fact({ label: "Checkpoint", value: `${profile.name}: ${checkpointId}` });
    await pruneMinecraftProfileCheckpoints(profile.id);
    const { notifyMinecraftProfileOverviewReady } = await import("./minecraft-profile-overview-queue");
    await notifyMinecraftProfileOverviewReady(profile.id, op);
    return checkpointId;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function pruneMinecraftProfileCheckpoints(id: string): Promise<void> {
  const root = await minecraftProfilePath(id, "checkpoints");
  const candidates = (await readdir(root)).filter(name => /^\d{13}-[0-9a-f-]{36}$/.test(name)).sort().reverse();
  for (const name of candidates.slice(3)) {
    const checkpoint = await minecraftProfilePath(id, `checkpoints/${name}`);
    let metadata: unknown;
    try { metadata = JSON.parse(await readFile(await minecraftProfilePath(id, `checkpoints/${name}/checkpoint.json`), "utf8")); } catch { continue; }
    if (!metadata || typeof metadata !== "object" || (metadata as { profileId?: unknown }).profileId !== id ||
        (metadata as { formatVersion?: unknown }).formatVersion !== 1) continue;
    await rm(checkpoint, { recursive: true, force: true });
  }
}

export async function recordMinecraftProfilePower(op: OpHandle): Promise<void> {
  try {
    const state = await gameContainerState("minecraft");
    op.fact({ label: "Power", value: state === "running" ? "still running" : STOPPED.has(state) ? "powered off" : `in state ${state}`,
      verdict: state === "running" || STOPPED.has(state) ? undefined : "warn" });
  } catch { op.fact({ label: "Power", value: "in an unknown state", verdict: "warn" }); }
}

async function recordProfileActivity(op: OpHandle, userId: string | undefined, action: string, details: Record<string, unknown>): Promise<void> {
  if (!userId) return;
  try {
    const data = { userId, action, details: JSON.stringify(details) };
    const created = await db.activity.create({ data });
    const stored = await db.activity.findUnique({ where: { id: created.id }, select: { userId: true, action: true, details: true } });
    if (!stored || stored.userId !== data.userId || stored.action !== data.action || stored.details !== data.details) throw new Error("Activity readback failed");
  } catch {
    op.fact({ label: "Activity", value: "a verified server change could not be recorded in activity history", verdict: "warn" });
  }
}

async function recordSelectedWorld(op: OpHandle): Promise<void> {
  try {
    await db.gameState.upsert({ where: { id: "main" }, create: { id: "main", activeGame: "minecraft" }, update: { activeGame: "minecraft" } });
    const stored = await db.gameState.findUnique({ where: { id: "main" }, select: { activeGame: true } });
    if (stored?.activeGame !== "minecraft") throw new Error("Selected world readback failed");
  } catch {
    op.fact({ label: "Selection history", value: "Minecraft is ready, but the dashboard's last selected world could not be recorded", verdict: "warn" });
  }
}

export async function activateMinecraftProfile(id: string, options: {
  confirmStopPeers: boolean; confirmedPeers?: readonly GameId[]; expectedRevision?: string; startedBy?: string | null; userId?: string;
}): Promise<{ profile: MinecraftProfileDTO; operationId: string; changed: boolean }> {
  let operationId: string | undefined;
  try {
    return await runOperation<{ profile: MinecraftProfileDTO; operationId: string; changed: boolean }>({ kind: "profile.switch", game: "minecraft", title: "Starting a Minecraft profile",
      startedBy: options.startedBy ? { name: options.startedBy } : null }, async op => {
      operationId = op.id;
      return withMinecraftProfileOperationMarker(op, "switch", async () => {
      let committed = false;
      let activationAttempted = false;
      let previousSettings: MinecraftProfileComposeSettings | undefined;
      try {
        const before = await getMinecraftProfileRuntimeStatus();
        if (!before.verified || before.state === "unknown") throw new MinecraftProfileActionError(before.reason ?? "Minecraft profile identity is unknown", 409);
        if (options.expectedRevision !== undefined && options.expectedRevision !== before.revision) {
          throw new MinecraftProfileActionError("The selected Minecraft profile changed. Reload the profile selector before starting.", 409);
        }
        if (before.state === "legacy" && await legacyMinecraftDataPresent()) {
          throw new MinecraftProfileActionError("Save the existing Minecraft server as a profile before starting another setup.", 409);
        }
        if (before.selectedProfileId === id && before.state === "running") {
          const profile = await getMinecraftProfile(id);
          if (!profile) throw new MinecraftProfileActionError("The selected Minecraft profile is missing", 409);
          op.fact({ label: "Profile", value: profile.name });
          op.step("Checking the selected Minecraft profile", { game: "minecraft" });
          op.settle("This profile was already running and answering", { kind: "noop" });
          op.fact({ label: "Boot", value: "running and answering" });
          return { value: { profile: toMinecraftProfileDTO(profile), operationId: op.id, changed: false } };
        }
        if (before.selectedProfileId === id && before.state === "starting") {
          throw new MinecraftProfileActionError("This Minecraft profile is already starting. Wait for it, or use the explicit stop/recovery controls before trying again.", 409);
        }
        const profile = await prepareMinecraftProfile(id, op);
        const wanted = targetSettings(profile);
        const worldVersion = await readWorldVersion(await minecraftProfileServerPath(profile.id));
        if (worldVersion && isDowngrade(profile.mcVersion, worldVersion)) {
          throw new MinecraftProfileActionError(`${profile.name}'s world was last opened by Minecraft ${worldVersion}; its ${profile.mcVersion} target would downgrade it. Restore a compatible profile backup or repair the target before starting. Nothing was stopped.`, 409);
        }
        op.fact({ label: "Profile", value: profile.name });
        await prepareMinecraftProfileImage(op, profile.javaVariant);
        const peers: GameId[] = [];
        for (const game of otherGames("minecraft")) {
          const state = await gameContainerState(game);
          if (state === "running") peers.push(game);
          else if (!STOPPED.has(state) && state !== "missing") throw new MinecraftProfileActionError(`The ${game} power state is ${state}; nothing was stopped.`, 409);
        }
        if (peers.length && (!options.confirmStopPeers || peers.some(game => !(options.confirmedPeers ?? []).includes(game)))) {
          throw new CoResidencyError("The running worlds differ from the reviewed hand-off. Review which worlds will stop before starting this Minecraft profile.", peers);
        }
        // Links, special files, entry limits and disk capacity are admission failures,
        // so discover them while the currently played world is still running.
        const current = before.selectedProfileId ? await getMinecraftProfile(before.selectedProfileId) : null;
        op.step("Checking complete recovery copies and disk space", { game: "minecraft" });
        let checkpointBytes = 0;
        for (const candidate of current && current.id !== profile.id ? [current, profile] : [profile]) {
          const entries = await inventoryMinecraftTree(await minecraftProfileServerPath(candidate.id), RUNTIME.minecraft.dir, { op, hash: false });
          checkpointBytes += entries.reduce((sum, entry) => sum + entry.bytes, 0);
        }
        await requireMinecraftCopySpace(RUNTIME.minecraft.dir, checkpointBytes);
        op.settle("The complete recovery copies fit with 1 GiB of disk headroom");
        const rechecked = await getMinecraftProfileRuntimeStatus();
        if (!rechecked.verified || rechecked.revision !== before.revision || rechecked.selectedProfileId !== before.selectedProfileId) {
          throw new MinecraftProfileActionError("Minecraft's selected profile or runtime changed during preparation; nothing was stopped.", 409);
        }
        claimOperationPower(op, "start", peers);
        // A peer that appeared after admission was never confirmed or leased.
        for (const game of otherGames("minecraft")) {
          const state = await gameContainerState(game);
          if (state === "running" && !peers.includes(game)) throw new MinecraftProfileActionError("Another world started during profile admission; nothing was stopped.", 409);
          if (state !== "running" && !STOPPED.has(state) && state !== "missing") throw new MinecraftProfileActionError(`The ${game} power state became unknown; nothing was stopped.`, 409);
        }
        previousSettings = await readMinecraftProfileComposeSettings();
        if (await gameContainerState("minecraft") === "running" && await stopGameForOperation(op, "minecraft", { requireSave: true })) {
          await recordProfileActivity(op, options.userId, "server_stop", { game: "minecraft", gameName: GAMES.minecraft.name,
            reason: "profile_switch", profileId: before.selectedProfileId, nextProfileId: profile.id });
        }
        if (current) await checkpointMinecraftProfile(current, op);
        // Preserve the incoming world's latest progress before its entrypoint can write.
        if (!current || current.id !== profile.id) await checkpointMinecraftProfile(profile, op);
        for (const peer of peers) if (await gameContainerState(peer) === "running" && await stopGameForOperation(op, peer, { requireSave: true })) {
          // No target-world name in a peer's row: world-scoped activity filtering must
          // keep this real stop visible to an operator who can see only that peer.
          await recordProfileActivity(op, options.userId, "server_stop", { game: peer, gameName: GAMES[peer].name, reason: "profile_switch", profileId: profile.id });
        }
        await prepareMinecraftProfileControlSettings(profile.id, op);
        activationAttempted = true;
        await recreateMinecraftProfileForOperation(op, wanted);
        await commitProfileActivation(profile.id, before.revision);
        invalidateMinecraftRuntimeProbes();
        committed = true;
        await startGameForOperation(op, "minecraft");
        await waitForMinecraftProfileReady(op);
        const final = await getMinecraftProfileRuntimeStatus();
        if (!final.verified || final.selectedProfileId !== id || final.state !== "running") {
          throw new Error("The running Minecraft profile identity could not be verified after startup");
        }
        let played = profile;
        try { played = await updateProfileRecord(profile.id, profile.revision, { lastPlayedAt: new Date() }); }
        catch {
          op.fact({ label: "Play history", value: "Minecraft is ready, but its last started time could not be recorded", verdict: "warn" });
        }
        await recordSelectedWorld(op);
        await recordProfileActivity(op, options.userId, "minecraft_profile_start", { game: "minecraft", profileId: id, profileName: profile.name, stoppedGames: peers });
        return { value: { profile: toMinecraftProfileDTO(played), operationId: op.id, changed: true } };
      } catch (error) {
        if (committed) {
          // The target may have written while booting. Its complete checkpoint remains
          // available; never boot either profile automatically after a failed start.
          if (await gameContainerState("minecraft").catch(() => "unknown") === "running") {
            const stopped = await stopGameForOperation(op, "minecraft").catch(() => false);
            if (stopped) await recordProfileActivity(op, options.userId, "server_stop", { game: "minecraft", gameName: GAMES.minecraft.name,
              reason: "profile_start_failure", profileId: id });
          }
        } else if (activationAttempted && previousSettings) {
          try {
            await recreateMinecraftProfileForOperation(op, previousSettings);
            op.fact({ label: "Recovery", value: "the previous profile selection was restored and remains stopped" });
          } catch {
            op.fact({ label: "Recovery", value: "the previous profile selection could not be verified; inspect the stopped container before retrying", verdict: "warn" });
          }
        }
        await recordMinecraftProfilePower(op);
        throw error;
      }
      });
    });
  } catch (error) {
    // Admission conflicts retain their shared response type and never have an op ID.
    if (!operationId) throw error;
    throw profileActionError(error, operationId);
  }
}
