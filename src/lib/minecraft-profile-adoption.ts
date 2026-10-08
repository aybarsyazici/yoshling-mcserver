import { readFile, readdir } from "node:fs/promises";
import { gameDataPath } from "@/lib/game-data-path";
import {
  gameContainerState, inspectMinecraftJavaVariant, inspectMinecraftProfileContainer,
  invalidateMinecraftRuntimeProbes,
  prepareMinecraftProfileImage, recreateMinecraftProfileForOperation, RUNTIME,
  stopGameForOperation, tailContainerLog,
} from "@/lib/game-manager";
import { minecraftProfileComposeSettings, readMinecraftProfileComposeSettings } from "@/lib/compose";
import { claimOperationPower, runOperation } from "@/lib/operations";
import {
  commitProfileActivation, createProfileRecord, getMinecraftRuntime, toMinecraftProfileDTO, updateProfileRecord,
  assertMinecraftReservedProfileStorage,
} from "@/lib/minecraft-profile-store";
import { minecraftProfileServerPath } from "@/lib/minecraft-profile-path";
import { copyVerifiedMinecraftTree, inventoryMinecraftTree, requireMinecraftCopySpace } from "@/lib/minecraft-profile-copy";
import { resolveProfileTarget } from "@/lib/minecraft-profile-target";
import { prepareMinecraftProfileControlSettings } from "@/lib/minecraft-profile-prepare";
import { readWorldVersion } from "@/lib/mc-world-version";
import { isDowngrade } from "@/lib/mc-version-guard";
import { withMinecraftProfileOperationMarker } from "@/lib/minecraft-profile-operation-marker";
import {
  getMinecraftProfileRuntimeStatus, MinecraftProfileActionError, profileActionError, recordMinecraftProfilePower,
} from "@/lib/minecraft-profile-activation";
import { MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS,
  type MinecraftJavaVariant, type MinecraftProfileDTO, type MinecraftProfileLoader } from "@/lib/minecraft-profile-types";

function exactPin(value: string | undefined): string | null {
  return value && !/^(latest|recommended|release|snapshot)$/i.test(value) && /^[a-z\d][a-z\d._+-]{0,119}$/i.test(value) ? value : null;
}

/** Resolve the installed legacy build rather than treating a floating default as a pin. */
async function legacyLoaderVersion(loader: MinecraftProfileLoader, version: string, declared: string): Promise<string | null> {
  if (loader === "vanilla") return null;
  const explicit = exactPin(declared);
  if (explicit) return explicit;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (loader === "fabric" || loader === "quilt") {
    const logs = await tailContainerLog("minecraft", 1000).catch(() => "");
    const expression = new RegExp(`Loading Minecraft ${escaped} with ${loader === "fabric" ? "Fabric" : "Quilt"} Loader ([a-z\\d._+-]+)`, "gi");
    const observed = [...logs.matchAll(expression)].map(match => exactPin(match[1])).filter((pin): pin is string => !!pin);
    if (observed.length) return observed.at(-1)!;
  }
  let candidates: string[] = [];
  if (loader === "fabric") {
    const files = await readdir(RUNTIME.minecraft.dir);
    const expression = new RegExp(`^fabric-server-mc\\.${escaped}-loader\\.([a-z\\d._+]+)(?:-launcher\\.[a-z\\d._+-]+)?\\.jar$`, "i");
    candidates = files.map(file => expression.exec(file)?.[1]).filter((pin): pin is string => !!pin);
  } else {
    const relative = loader === "forge" ? "libraries/net/minecraftforge/forge"
      : loader === "neoforge" ? "libraries/net/neoforged/neoforge" : "libraries/org/quiltmc/quilt-loader";
    const directory = await gameDataPath(RUNTIME.minecraft.dir, relative);
    const folders = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    candidates = loader === "forge" ? folders.filter(folder => folder.startsWith(`${version}-`)).map(folder => folder.slice(version.length + 1)) : folders;
  }
  const pins = [...new Set(candidates.map(pin => exactPin(pin)).filter((pin): pin is string => !!pin))];
  if (pins.length !== 1) throw new MinecraftProfileActionError(`The existing ${loader} loader build could not be identified uniquely. Supply its reviewed exact loader build before adopting this server.`, 409);
  return pins[0];
}

export async function adoptLegacyMinecraftProfile(input: {
  name: string; description?: string; confirmStopCurrent?: boolean; loaderVersion?: string; javaVariant?: MinecraftJavaVariant;
}, actor: { userId: string; name?: string | null }): Promise<{ profile: MinecraftProfileDTO; operationId: string; changed: boolean }> {
  let operationId: string | undefined;
  try {
    return await runOperation({ kind: "profile.adopt", game: "minecraft", title: "Saving the existing Minecraft server as a profile",
      startedBy: actor.name ? { name: actor.name } : null }, async op => {
      operationId = op.id;
      return withMinecraftProfileOperationMarker(op, "adopt", async () => {
      let profile: Awaited<ReturnType<typeof createProfileRecord>> | undefined;
      let activated = false;
      let previousSettings: Awaited<ReturnType<typeof readMinecraftProfileComposeSettings>> | undefined;
      try {
        if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name) ||
            (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000))) {
          throw new MinecraftProfileActionError("A valid profile name and description are required before adoption.", 400);
        }
        await assertMinecraftReservedProfileStorage();
        const before = await getMinecraftProfileRuntimeStatus();
        if (!before.verified || before.state !== "legacy" || before.selectedProfileId || (await getMinecraftRuntime())?.selectedProfileId) {
          throw new MinecraftProfileActionError(before.reason ?? "The existing Minecraft server was already adopted or its identity is unknown.", 409);
        }
        if (before.containerState === "running" && !input.confirmStopCurrent) {
          throw new MinecraftProfileActionError("Adopting this server will save and stop Minecraft. Confirm that it should remain stopped after adoption.", 409);
        }
        previousSettings = await readMinecraftProfileComposeSettings();
        const properties = await readFile(await gameDataPath(RUNTIME.minecraft.dir, "server.properties"), "utf8");
        const levelNames = properties.split("\n").map(line => /^\s*level-name\s*=(.*)$/.exec(line)?.[1]?.trim()).filter((value): value is string => value !== undefined);
        if (levelNames.some(value => value !== "world")) throw new MinecraftProfileActionError("The existing server uses a custom world directory. Preserve and convert that world explicitly before adoption; no files or power state were changed.", 409);
        const worldVersion = await readWorldVersion(RUNTIME.minecraft.dir);
        if (worldVersion && isDowngrade(previousSettings.version, worldVersion)) {
          throw new MinecraftProfileActionError(`The existing world was last opened by Minecraft ${worldVersion}, newer than the configured ${previousSettings.version} target. Repair the legacy target in Settings before adopting it. Nothing was stopped or copied.`, 409);
        }
        const identity = await inspectMinecraftProfileContainer();
        const loader = identity.type?.toLowerCase();
        if (!(MINECRAFT_PROFILE_LOADERS as readonly string[]).includes(loader ?? "")) throw new MinecraftProfileActionError("The existing Minecraft loader is not supported by profiles.", 409);
        const loaderName = loader as MinecraftProfileLoader;
        const declaredPin = loaderName === "fabric" ? identity.fabricLoaderVersion : loaderName === "forge" ? identity.forgeVersion
          : loaderName === "neoforge" ? identity.neoForgeVersion : identity.quiltLoaderVersion;
        const loaderVersion = input.loaderVersion ? exactPin(input.loaderVersion) : await legacyLoaderVersion(loaderName, previousSettings.version, declaredPin);
        if (input.loaderVersion && !loaderVersion) throw new MinecraftProfileActionError("An exact loader build is required for adoption.", 400);
        const observedJava = await inspectMinecraftJavaVariant();
        const javaVariant = input.javaVariant ?? observedJava;
        if (!javaVariant || !(MINECRAFT_JAVA_VARIANTS as readonly string[]).includes(javaVariant)) {
          throw new MinecraftProfileActionError("The existing Java variant could not be identified. Choose its reviewed Java image before adopting this server.", 409);
        }
        if (input.javaVariant && observedJava && input.javaVariant !== observedJava) {
          throw new MinecraftProfileActionError(`The selected Java image differs from the existing ${observedJava} runtime. Adoption preserves the current target.`, 409);
        }
        const target = await resolveProfileTarget({ mcVersion: previousSettings.version, loader: loaderName, loaderVersion,
          javaVariant: javaVariant as MinecraftJavaVariant });
        op.step("Checking the complete existing Minecraft server", { game: "minecraft" });
        const entries = await inventoryMinecraftTree(RUNTIME.minecraft.dir, RUNTIME.minecraft.dir, { excludeTopLevel: ["profiles"], op, hash: false });
        await requireMinecraftCopySpace(RUNTIME.minecraft.dir, entries.reduce((sum, entry) => sum + entry.bytes, 0));
        op.settle("The existing server tree can be preserved completely");
        await prepareMinecraftProfileImage(op, target.javaVariant);
        const rechecked = await getMinecraftProfileRuntimeStatus();
        if (!rechecked.verified || rechecked.state !== "legacy" || rechecked.revision !== before.revision) {
          throw new MinecraftProfileActionError("Minecraft's runtime changed while adoption was being prepared; nothing was stopped.", 409);
        }
        if (rechecked.containerState === "running" && !input.confirmStopCurrent) throw new MinecraftProfileActionError("Minecraft started while adoption was being prepared. Confirm its shutdown before retrying.", 409);
        claimOperationPower(op, "stop");
        if (await gameContainerState("minecraft") === "running") await stopGameForOperation(op, "minecraft", { requireSave: true });
        profile = await createProfileRecord({ name: input.name, description: input.description, status: "preparing",
          ...target, sourceKind: "legacy", createdBy: actor.userId });
        op.fact({ label: "Profile", value: profile.name });
        op.step("Copying the world, mods, configuration and player progress", { game: "minecraft" });
        const copy = await copyVerifiedMinecraftTree(RUNTIME.minecraft.dir, await minecraftProfileServerPath(profile.id), RUNTIME.minecraft.dir,
          { excludeTopLevel: ["profiles"], op });
        op.settle(`Copied and verified ${copy.files} files`, { count: { done: copy.files, total: copy.files, noun: "files" } });
        op.fact({ label: "Preserved", value: "the complete legacy server remains intact at the volume root" });
        await prepareMinecraftProfileControlSettings(profile.id, op);
        profile = await updateProfileRecord(profile.id, profile.revision, { status: "ready", preparationError: null });
        const { notifyMinecraftProfileOverviewReady } = await import("./minecraft-profile-overview-queue");
        await notifyMinecraftProfileOverviewReady(profile.id, op);
        activated = true;
        await recreateMinecraftProfileForOperation(op, minecraftProfileComposeSettings(profile.id, target));
        await commitProfileActivation(profile.id, before.revision, { adoptLegacyInventory: true });
        invalidateMinecraftRuntimeProbes();
        const final = await getMinecraftProfileRuntimeStatus();
        if (!final.verified || final.selectedProfileId !== profile.id || final.state !== "stopped") throw new Error("The adopted profile's stopped runtime could not be verified");
        op.fact({ label: "Power", value: "powered off" });
        return { value: { profile: toMinecraftProfileDTO(profile), operationId: op.id, changed: true } };
      } catch (error) {
        const runtime = await getMinecraftRuntime().catch(() => null);
        if (activated && previousSettings && runtime?.selectedProfileId !== profile?.id) {
          await recreateMinecraftProfileForOperation(op, previousSettings).then(() => {
            op.fact({ label: "Recovery", value: "the original legacy mount was restored and remains stopped" });
          }).catch(() => op.fact({ label: "Recovery", value: "the original legacy mount could not be verified; inspect the stopped container", verdict: "warn" }));
        }
        if (profile && runtime?.selectedProfileId !== profile.id) {
          await updateProfileRecord(profile.id, profile.revision, { status: "failed", preparationError: error instanceof Error ? error.message : "Adoption failed" }).catch(() => {});
        }
        await recordMinecraftProfilePower(op);
        throw error;
      }
      });
    });
  } catch (error) {
    if (!operationId) throw error;
    throw profileActionError(error, operationId);
  }
}
