import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameId } from "@/lib/games";
import type { MinecraftProfileRecord, CreateProfileRecordInput, UpdateProfileRecordInput } from "@/lib/minecraft-profile-store";
import type { MinecraftProfileComposeSettings } from "@/lib/compose";
import type { MinecraftProfileContainerIdentity } from "@/lib/game-manager";
import { minecraftProfileComposeSettings } from "@/lib/compose";
import { activateMinecraftProfile, getMinecraftProfileRuntimeStatus } from "@/lib/minecraft-profile-activation";
import { adoptLegacyMinecraftProfile } from "@/lib/minecraft-profile-adoption";
import { listFinished } from "@/lib/operations";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", adopted = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let root: string;
let records: Map<string, MinecraftProfileRecord>;
let selected: string | null;
let revision: string;
let settings: MinecraftProfileComposeSettings;
let identity: MinecraftProfileContainerIdentity;
let states: Record<GameId, string>;
let events: string[];
let failSave: boolean, failPeerSave: boolean, failBoot: boolean, failCreate: boolean, prepareFailure: boolean;
let legacyAdopted: boolean;
let activityRows: Array<{ id: string; userId: string; action: string; details: string }>;
let activeGame: string | null;
let failHistory: boolean;
let failLastPlayed: boolean;

function record(id: string, name: string): MinecraftProfileRecord {
  return { id, name, description: "", status: "ready", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", javaVariant: "java21",
    sourceKind: "saved-set", sourceRef: null, sourceVersionId: null, sourceTitle: null, preparationError: null, coverKey: null, coverMime: null,
    revision: 1, createdBy: "user", createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"), lastPlayedAt: null };
}
function runtime() { return selected ? { id: "main", selectedProfileId: selected, revision, updatedAt: new Date() } : null; }
function identityFor(value: MinecraftProfileComposeSettings): MinecraftProfileContainerIdentity {
  return { state: states.minecraft, image: `itzg/minecraft-server:${value.javaVariant}`, subpath: value.subpath, volumeName: "yoshling_mc-data",
    project: "yoshling", service: "minecraft", type: value.type, version: value.version, fabricLoaderVersion: value.fabricLoaderVersion,
    forgeVersion: value.forgeVersion, neoForgeVersion: value.neoForgeVersion, quiltLoaderVersion: value.quiltLoaderVersion, propertiesOverride: value.propertiesOverride };
}

vi.mock("@/lib/db", () => ({ db: { installedMod: { findMany: vi.fn(async () => []) },
  activity: {
    create: vi.fn(async ({ data }: { data: { userId: string; action: string; details: string } }) => {
      if (failHistory) throw new Error("history unavailable");
      const row = { id: `activity-${activityRows.length}`, ...data }; activityRows.push(row); return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => activityRows.find(row => row.id === where.id) ?? null),
  },
  gameState: {
    upsert: vi.fn(async ({ update }: { update: { activeGame: string } }) => { if (failHistory) throw new Error("history unavailable"); activeGame = update.activeGame; return { activeGame }; }),
    findUnique: vi.fn(async () => ({ activeGame })),
  },
} }));
vi.mock("@/lib/minecraft-profile-store", async original => {
  const actual = await original<typeof import("@/lib/minecraft-profile-store")>();
  return { ...actual, readMinecraftRuntime: vi.fn(async () => ({ schemaReady: true, runtime: runtime() })), getMinecraftRuntime: vi.fn(async () => runtime()),
    getMinecraftProfile: vi.fn(async (id: string) => records.get(id) ?? null),
    assertMinecraftReservedProfileStorage: vi.fn(async () => {
      const entries = await readdir(path.join(root, "profiles"));
      if (entries.some(name => !records.has(name))) throw new actual.MinecraftProfileError("The legacy profiles folder contains unrecognized data; review it before adoption", 409, "profile_storage_collision");
    }),
    createProfileRecord: vi.fn(async (input: CreateProfileRecordInput) => {
      events.push("record:create"); const created = { ...record(adopted, input.name), ...input, id: adopted, description: input.description ?? "", loaderVersion: input.loaderVersion ?? null,
        status: input.status ?? "preparing" } as MinecraftProfileRecord; records.set(adopted, created); return created;
    }),
    updateProfileRecord: vi.fn(async (id: string, expected: number, patch: UpdateProfileRecordInput) => {
      if (patch.lastPlayedAt && failLastPlayed) throw new Error("play history unavailable");
      const current = records.get(id)!; if (current.revision !== expected) throw new Error("profile revision changed");
      const updated = { ...current, ...patch, revision: expected + 1 }; records.set(id, updated); return updated;
    }),
    commitProfileActivation: vi.fn(async (id: string, expected: string, options?: { adoptLegacyInventory?: boolean }) => {
      if (expected !== revision) throw new Error("selected revision changed"); events.push(`commit:${id}`); selected = id; revision = "r2";
      legacyAdopted = options?.adoptLegacyInventory === true; return runtime()!;
    }) };
});
vi.mock("@/lib/minecraft-profile-prepare", () => ({
  prepareMinecraftProfile: vi.fn(async (id: string) => { events.push(`prepare:${id}`); if (prepareFailure) throw new Error("missing required jar"); return records.get(id)!; }),
  prepareMinecraftProfileControlSettings: vi.fn(async (id: string) => { events.push(`control:${id}`); }),
}));
vi.mock("@/lib/minecraft-profile-target", () => ({ resolveProfileTarget: vi.fn(async (value: Record<string, unknown>) => value) }));
vi.mock("@/lib/compose", async original => {
  const actual = await original<typeof import("@/lib/compose")>();
  return { ...actual, readMinecraftProfileComposeSettings: vi.fn(async () => ({ ...settings })) };
});
vi.mock("@/lib/game-manager", () => ({
  RUNTIME: { minecraft: { get dir() { return root; } } },
  invalidateMinecraftRuntimeProbes: vi.fn(),
  gameContainerState: vi.fn(async (game: GameId) => states[game]),
  inspectMinecraftProfileContainer: vi.fn(async () => ({ ...identity, state: states.minecraft })),
  inspectMinecraftJavaVariant: vi.fn(async () => "java21"),
  tailContainerLog: vi.fn(async () => "Loading Minecraft 1.21.1 with Fabric Loader 0.16.10"),
  minecraftProfileIsReady: vi.fn(async () => states.minecraft === "running" && !failBoot),
  minecraftProfileContainerAgrees: vi.fn((read: MinecraftProfileContainerIdentity, wanted: MinecraftProfileComposeSettings) =>
    read.subpath === wanted.subpath && read.version === wanted.version && read.type === wanted.type &&
    read.image === `itzg/minecraft-server:${wanted.javaVariant}` && read.propertiesOverride === wanted.propertiesOverride),
  prepareMinecraftProfileImage: vi.fn(async () => { events.push("image:prepared"); }),
  stopGameForOperation: vi.fn(async (_op, game: GameId, options?: { requireSave?: boolean }) => {
    events.push(`stop:${game}`);
    if (options?.requireSave && failSave) throw new Error("did not confirm saving");
    if (options?.requireSave && game === "zomboid" && failPeerSave) throw new Error("Project Zomboid did not confirm saving. It is still running");
    states[game] = "exited"; return true;
  }),
  recreateMinecraftProfileForOperation: vi.fn(async (_op, wanted: MinecraftProfileComposeSettings) => {
    events.push(`create:${wanted.subpath}`); settings = { ...wanted }; identity = identityFor(settings); states.minecraft = "created";
    if (failCreate) { failCreate = false; throw new Error("created mount readback failed"); }
    return identity;
  }),
  startGameForOperation: vi.fn(async () => {
    if (states.zomboid === "running" || states["7dtd"] === "running") throw new Error("peer still running");
    events.push("start:minecraft"); states.minecraft = "running";
  }),
  waitForMinecraftProfileReady: vi.fn(async op => { events.push("boot:checked"); if (failBoot) throw new Error("loader exited before ready"); op.fact({ label: "Boot", value: "running and answering" }); }),
}));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "minecraft-profile-lifecycle-")); vi.stubEnv("MC_SERVER_DIR", root);
  vi.stubEnv("MC_PROFILE_OPERATIONS_DIR", `${root}-operations`);
  records = new Map([[a, record(a, "Friends A")], [b, record(b, "Friends B")]]); selected = a; revision = "r1";
  states = { minecraft: "exited", "7dtd": "exited", zomboid: "exited" }; events = [];
  failSave = false; failPeerSave = false; failBoot = false; failCreate = false; prepareFailure = false; legacyAdopted = false;
  activityRows = []; activeGame = "zomboid"; failHistory = false; failLastPlayed = false;
  settings = minecraftProfileComposeSettings(a, records.get(a)!); identity = identityFor(settings);
  for (const id of [a, b]) {
    const server = path.join(root, "profiles", id, "server"); await mkdir(path.join(server, "world"), { recursive: true });
    await writeFile(path.join(server, "world/progress"), id === a ? "friends A progress" : "friends B progress", { mode: 0o600 });
    await writeFile(path.join(server, "server.properties"), "level-name=world\ndifficulty=hard\n", { mode: 0o600 });
  }
  vi.clearAllMocks();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await rm(`${root}-operations`, { recursive: true, force: true }); });

describe("profile activation keeps separate worlds and commits only a verified selection", () => {
  it("preserves both worlds before a confirmed hand-off and starts the chosen profile", async () => {
    states.minecraft = "running";
    const result = await activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" });
    expect(result.changed).toBe(true); expect(selected).toBe(b); expect(states.minecraft).toBe("running");
    expect(events.indexOf(`prepare:${b}`)).toBeLessThan(events.indexOf("stop:minecraft"));
    expect(events.indexOf(`create:profiles/${b}/server`)).toBeLessThan(events.indexOf(`commit:${b}`));
    expect(events.indexOf(`commit:${b}`)).toBeLessThan(events.indexOf("start:minecraft"));
    for (const id of [a, b]) {
      expect(await readFile(path.join(root, "profiles", id, "server/world/progress"), "utf8")).toBe(id === a ? "friends A progress" : "friends B progress");
      const snapshots = await readdir(path.join(root, "profiles", id, "checkpoints")); expect(snapshots).toHaveLength(1);
      expect(await readFile(path.join(root, "profiles", id, "checkpoints", snapshots[0], "server/world/progress"), "utf8")).toBe(id === a ? "friends A progress" : "friends B progress");
    }
  });

  it("refuses incomplete preparation before stopping the played world", async () => {
    states.minecraft = "running"; prepareFailure = true;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/missing required jar/);
    expect(events.some(event => event.startsWith("stop:") || event.startsWith("create:"))).toBe(false);
    expect(selected).toBe(a); expect(states.minecraft).toBe("running");
  });

  it("refuses an incoming world downgrade before stopping the played profile", async () => {
    states.minecraft = "running";
    const nbt = Buffer.concat([Buffer.from([0x0a, 0, 7]), Buffer.from("Version"), Buffer.from([8, 0, 4]), Buffer.from("Name"), Buffer.from([0, 6]), Buffer.from("1.21.4")]);
    await writeFile(path.join(root, "profiles", b, "server/world/level.dat"), nbt);
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/would downgrade/);
    expect(states.minecraft).toBe("running"); expect(selected).toBe(a); expect(events.some(event => event.startsWith("stop:") || event.startsWith("create:"))).toBe(false);
  });

  it("refuses an unpreservable current tree before stopping the played world", async () => {
    states.minecraft = "running";
    await symlink(path.join(root, "profiles", b, "server/world/progress"), path.join(root, "profiles", a, "server/foreign-alias"));
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/source link escaped/);
    expect(states.minecraft).toBe("running"); expect(events.some(event => event.startsWith("stop:"))).toBe(false);
  });

  it("refuses insufficient recovery disk space before stopping the played world", async () => {
    states.minecraft = "running";
    vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: 1, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>);
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/free space/);
    expect(states.minecraft).toBe("running"); expect(events.some(event => event.startsWith("stop:"))).toBe(false);
  });

  it("remains switchable after vanilla created its contained jar alias", async () => {
    states.minecraft = "running";
    const server = path.join(root, "profiles", a, "server");
    await writeFile(path.join(server, "minecraft_server.1.21.1.jar"), "server jar");
    await symlink("minecraft_server.1.21.1.jar", path.join(server, "minecraft_server.jar"));
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).resolves.toMatchObject({ changed: true });
    expect(selected).toBe(b); expect(states.minecraft).toBe("running");
  });

  it("requires an explicit peer hand-off and leaves PZ running when refused", async () => {
    states.zomboid = "running";
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toMatchObject({ status: 409, running: ["zomboid"] });
    expect(states.zomboid).toBe("running"); expect(events.some(event => event.startsWith("stop:"))).toBe(false);
  });

  it("stops a confirmed peer only after checkpoint preparation and before Minecraft starts", async () => {
    states.zomboid = "running";
    await activateMinecraftProfile(b, { confirmStopPeers: true, confirmedPeers: ["zomboid"], expectedRevision: "r1" });
    expect(states.zomboid).toBe("exited"); expect(events.indexOf("stop:zomboid")).toBeLessThan(events.indexOf("start:minecraft"));
  });

  it("states Minecraft stayed off when a peer refused saving after Minecraft stopped", async () => {
    states.minecraft = "running"; states.zomboid = "running"; failPeerSave = true;
    let operationId: string | undefined;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: true, confirmedPeers: ["zomboid"], expectedRevision: "r1" }).catch((error: unknown) => {
      if (error && typeof error === "object" && "operationId" in error && typeof error.operationId === "string") operationId = error.operationId;
      throw error;
    })).rejects.toThrow(/Project Zomboid/);
    expect(states.minecraft).toBe("exited"); expect(states.zomboid).toBe("running"); expect(selected).toBe(a);
    expect(listFinished().find(entry => entry.id === operationId)?.summary).toContain("Minecraft is powered off");
  });

  it("refuses a newly running peer that was absent from the reviewed hand-off", async () => {
    states.zomboid = "running";
    await expect(activateMinecraftProfile(b, { confirmStopPeers: true, confirmedPeers: [], expectedRevision: "r1" })).rejects.toMatchObject({ status: 409, running: ["zomboid"] });
    expect(states.zomboid).toBe("running"); expect(events.some(event => event.startsWith("stop:"))).toBe(false);
  });

  it("refuses an unknown peer state without writing runtime selectors", async () => {
    states.zomboid = "paused";
    await expect(activateMinecraftProfile(b, { confirmStopPeers: true, expectedRevision: "r1" })).rejects.toMatchObject({ status: 409 });
    expect(events.some(event => event.startsWith("stop:") || event.startsWith("create:"))).toBe(false);
  });

  it("rejects a stale selector revision before preparation", async () => {
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "old" })).rejects.toMatchObject({ status: 409 });
    expect(events).toEqual([]);
  });

  it("refuses saving failures without changing the current runtime pointer or copied worlds", async () => {
    states.minecraft = "running"; failSave = true;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/did not confirm saving/);
    expect(selected).toBe(a); expect(states.minecraft).toBe("running"); expect(events.some(event => event.startsWith("create:"))).toBe(false);
  });

  it("restores the old stopped selection when target mount creation fails before commit", async () => {
    failCreate = true;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toThrow(/mount readback/);
    expect(selected).toBe(a); expect(settings.subpath).toBe(`profiles/${a}/server`); expect(states.minecraft).toBe("created");
    expect(events.some(event => event.startsWith("commit:") || event === "start:minecraft")).toBe(false);
  });

  it("leaves a failed boot selected and stopped with both checkpointed saves intact", async () => {
    failBoot = true;
    let operationId: string | undefined;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" }).catch((error: unknown) => {
      if (error && typeof error === "object" && "operationId" in error && typeof error.operationId === "string") operationId = error.operationId;
      throw error;
    })).rejects.toMatchObject({ operationId: expect.any(String) });
    expect(selected).toBe(b); expect(states.minecraft).toBe("exited");
    expect(listFinished().find(entry => entry.id === operationId)).toMatchObject({ kind: "profile.switch", outcome: "failed" });
    expect(await readFile(path.join(root, "profiles", a, "server/world/progress"), "utf8")).toBe("friends A progress");
    expect(await readFile(path.join(root, "profiles", b, "server/world/progress"), "utf8")).toBe("friends B progress");
  });

  it("records a verified PZ stop even when the following Minecraft boot fails", async () => {
    states.zomboid = "running"; failBoot = true;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: true, confirmedPeers: ["zomboid"], expectedRevision: "r1", userId: "user" })).rejects.toThrow(/loader exited/);
    const stop = activityRows.find(row => row.action === "server_stop" && JSON.parse(row.details).game === "zomboid");
    expect(stop).toBeDefined(); expect(stop!.details).not.toContain("minecraft");
    expect(JSON.parse(stop!.details)).toMatchObject({ game: "zomboid", reason: "profile_switch", profileId: b });
    expect(activityRows.some(row => row.action === "minecraft_profile_start")).toBe(false);
    expect(activeGame).toBe("zomboid"); expect(states.zomboid).toBe("exited"); expect(states.minecraft).toBe("exited");
  });

  it("updates the selected-world mirror only after a ready Minecraft boot", async () => {
    await activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1", userId: "user" });
    expect(activeGame).toBe("minecraft");
    expect(activityRows.some(row => row.action === "minecraft_profile_start")).toBe(true);
    expect(states.minecraft).toBe("running");
  });

  it("keeps the verified server running when cosmetic history writes fail", async () => {
    failHistory = true;
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1", userId: "user" })).resolves.toMatchObject({ changed: true });
    expect(states.minecraft).toBe("running"); expect(selected).toBe(b); expect(activityRows).toEqual([]);
  });

  it("keeps a ready world running when its play timestamp cannot be recorded", async () => {
    failLastPlayed = true;
    const result = await activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1", userId: "user" });
    expect(states.minecraft).toBe("running"); expect(selected).toBe(b); expect(result.changed).toBe(true);
    expect(result.profile.lastPlayedAt).toBeNull();
    expect(listFinished().find(entry => entry.id === result.operationId)).toMatchObject({ outcome: "partial" });
    expect(listFinished().find(entry => entry.id === result.operationId)?.facts).toContainEqual(expect.objectContaining({ label: "Play history", verdict: "warn" }));
  });

  it("refuses a drifted applied mount and reports unknown rather than the selected name as verified", async () => {
    identity.subpath = `profiles/${b}/server`;
    expect(await getMinecraftProfileRuntimeStatus()).toMatchObject({ selectedProfileId: a, appliedProfileId: b, verified: false, state: "unknown" });
    await expect(activateMinecraftProfile(b, { confirmStopPeers: false, expectedRevision: "r1" })).rejects.toMatchObject({ status: 409 });
    expect(events).toEqual([]);
  });

  it("retains the three newest complete private checkpoints", async () => {
    for (let pass = 0; pass < 4; pass++) {
      states.minecraft = "exited";
      await writeFile(path.join(root, "profiles", a, "server/world/progress"), `progress ${pass}`);
      await activateMinecraftProfile(a, { confirmStopPeers: false, expectedRevision: revision });
    }
    const snapshots = (await readdir(path.join(root, "profiles", a, "checkpoints"))).sort();
    expect(snapshots).toHaveLength(3);
    const contents = await Promise.all(snapshots.map(name => readFile(path.join(root, "profiles", a, "checkpoints", name, "server/world/progress"), "utf8")));
    expect(contents).toEqual(["progress 1", "progress 2", "progress 3"]);
  });
});

async function legacy() {
  selected = null; revision = "0"; settings = { ...settings, subpath: ".", javaVariant: "latest", propertiesOverride: "true" }; identity = identityFor(settings);
  await mkdir(path.join(root, "world")); await writeFile(path.join(root, "world/progress"), "legacy friends progress", { mode: 0o600 });
  await writeFile(path.join(root, "server.properties"), "level-name=world\ndifficulty=hard\n", { mode: 0o600 });
}
describe("legacy adoption preserves the whole server and never starts any world", () => {
  it("keeps an already stopped Minecraft stopped, preserves PZ and transfers legacy inventory only at commit", async () => {
    await legacy(); states.zomboid = "running";
    const result = await adoptLegacyMinecraftProfile({ name: "Our first world" }, { userId: "user" });
    expect(result.profile.id).toBe(adopted); expect(legacyAdopted).toBe(true); expect(selected).toBe(adopted);
    expect(states.minecraft).toBe("created"); expect(states.zomboid).toBe("running");
    expect(events.some(event => event.startsWith("stop:") || event === "start:minecraft")).toBe(false);
    expect(await readFile(path.join(root, "world/progress"), "utf8")).toBe("legacy friends progress");
    expect(await readFile(path.join(root, "profiles", adopted, "server/world/progress"), "utf8")).toBe("legacy friends progress");
    expect(events.indexOf(`create:profiles/${adopted}/server`)).toBeLessThan(events.indexOf(`commit:${adopted}`));
  });

  it("requires review before stopping a running legacy server", async () => {
    await legacy(); states.minecraft = "running";
    await expect(adoptLegacyMinecraftProfile({ name: "Our world" }, { userId: "user" })).rejects.toMatchObject({ status: 409 });
    expect(states.minecraft).toBe("running"); expect(events).toEqual([]);
  });

  it("saves and stops a reviewed running legacy server and leaves it stopped", async () => {
    await legacy(); states.minecraft = "running";
    await adoptLegacyMinecraftProfile({ name: "Our world", confirmStopCurrent: true }, { userId: "user" });
    expect(events).toContain("stop:minecraft"); expect(states.minecraft).toBe("created"); expect(events).not.toContain("start:minecraft");
  });

  it("refuses a custom legacy world directory before saving, stopping or copying", async () => {
    await legacy(); states.minecraft = "running"; await writeFile(path.join(root, "server.properties"), "level-name=custom-friends-world\n");
    await expect(adoptLegacyMinecraftProfile({ name: "Our world", confirmStopCurrent: true }, { userId: "user" })).rejects.toThrow(/custom world directory/);
    expect(states.minecraft).toBe("running"); expect(events).toEqual([]); expect(selected).toBeNull();
  });

  it("refuses adoption of a numerically downgraded legacy world before any stop or row creation", async () => {
    await legacy(); states.minecraft = "running";
    const nbt = Buffer.concat([Buffer.from([0x0a, 0, 7]), Buffer.from("Version"), Buffer.from([8, 0, 4]), Buffer.from("Name"), Buffer.from([0, 6]), Buffer.from("1.21.4")]);
    await writeFile(path.join(root, "world/level.dat"), nbt);
    await expect(adoptLegacyMinecraftProfile({ name: "Our world", confirmStopCurrent: true }, { userId: "user" })).rejects.toThrow(/newer than the configured/);
    expect(states.minecraft).toBe("running"); expect(events).toEqual([]); expect(selected).toBeNull(); expect(records.has(adopted)).toBe(false);
  });

  it("refuses a reserved legacy profiles folder without changing its content or permissions", async () => {
    await legacy(); states.minecraft = "running";
    const legacyFolder = path.join(root, "profiles", "custom-data"); await mkdir(legacyFolder); await writeFile(path.join(legacyFolder, "settings"), "existing mod profile data");
    await chmod(path.join(root, "profiles"), 0o755); const beforeMode = (await lstat(path.join(root, "profiles"))).mode;
    await expect(adoptLegacyMinecraftProfile({ name: "Our world", confirmStopCurrent: true }, { userId: "user" })).rejects.toMatchObject({ status: 409 });
    expect((await lstat(path.join(root, "profiles"))).mode).toBe(beforeMode);
    expect(await readFile(path.join(legacyFolder, "settings"), "utf8")).toBe("existing mod profile data");
    expect(states.minecraft).toBe("running"); expect(events).toEqual([]); expect(selected).toBeNull();
  });
});
