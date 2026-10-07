import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import type { ModrinthVersion } from "@/lib/modrinth";
import type { OpHandle, OpSuccess } from "@/lib/operations";

const DIRS = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/yoshling-pack-lifecycle-${process.pid}-${Date.now()}`;
  process.env.MC_SERVER_DIR = `${root}/minecraft`;
  return { root, mc: `${root}/minecraft`, backups: `${root}/backups` };
});

let events: string[] = [];
let states: Record<string, string> = {};
let mods: string[] = [];
let installed = [{ id: "old", name: "Old", fileName: "old.jar" }];
let clientOnly = false;
let failInstall = false;
let failRemoval = false;
let failTar = false;
let ignoreStop = false;
let ignoreStart = false;
let unknownState = false;
let exitAtFinalRead = false;
let readsAfterStart = 0;
let installHook: (() => Promise<void>) | null = null;
let planningHook: (() => Promise<void>) | null = null;
let currentOp: OpHandle | null = null;
let directMode = false;
let directSlug = "technicthing";
let escapeDirectRoot = false;
let failDirectReadback = false;
let preemptDirectPath = false;
let directRows: Record<string, unknown>[] = [];

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args);
    if (failDirectReadback && String(args[0]).endsWith("/technicthing.jar")) return Buffer.from("different published bytes");
    return bytes;
  } };
});
vi.mock("@/lib/mod-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mod-path")>();
  return { ...actual, modFilePath: async (...args: Parameters<typeof actual.modFilePath>) => {
    const file = await actual.modFilePath(...args);
    if (directMode && preemptDirectPath && currentOp) {
      Object.defineProperty(currentOp, "preempted", { get: () => true });
    }
    return file;
  } };
});

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "tester", name: "Tester", role: "MOD", games: "minecraft" } })),
}));
vi.mock("@/lib/db", () => ({ db: {
  modpack: { findUnique: vi.fn(async () => ({
    id: "pack", name: "Pack", mods: directMode ? [{
      id: "direct", name: "TechnicThing", slug: directSlug, modrinthId: null, versionId: null,
      downloadUrl: "https://example.test/direct.jar",
    }] : mods.map((name) => ({
      id: name, name, slug: name.toLowerCase(), modrinthId: name, versionId: null, downloadUrl: null,
    })),
  })) },
  serverConfig: { findUnique: vi.fn(async () => ({ mcVersion: "26.1.2", modLoader: "fabric" })) },
  installedMod: {
    findMany: vi.fn(async () => installed),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { directRows.push(data); }),
  },
  activity: { create: vi.fn(async () => ({})) },
} }));

vi.mock("@/lib/modrinth", () => ({ getVersion: vi.fn(async () => { throw new Error("no pins in this fixture"); }), getProjectVersions: vi.fn(async (name: string) => {
  await planningHook?.();
  return [{
  id: `v-${name}`, project_id: name, name, version_number: "1", loaders: ["fabric"],
  game_versions: ["26.1.2"], environment: clientOnly ? "client_only" : "server_only",
  date_published: "2026-10-06T00:00:00Z", downloads: 1,
  files: [{
    primary: true, filename: `${name.toLowerCase()}.jar`, size: 7, url: "https://example.test/mod.jar",
    hashes: {
      sha1: createHash("sha1").update("new jar").digest("hex"),
      sha512: createHash("sha512").update("new jar").digest("hex"),
    },
  }],
  dependencies: [],
  } as ModrinthVersion];
}) }));
vi.mock("@/lib/mod-manager", async () => {
  const { checkIntegrity, digestsOf, serverSideVerdict } = await import("@/lib/mod-admission");
  return {
    serverSideFor: vi.fn(async (version: { environment?: string }) => serverSideVerdict(version)),
    removeMod: vi.fn(async (id: string) => {
      events.push("remove");
      if (failRemoval) throw new Error("old jar cannot be removed");
      const mod = installed.find((item) => item.id === id)!;
      await unlink(path.join(DIRS.mc, "mods", mod.fileName));
      installed = installed.filter((item) => item.id !== id);
    }),
    installMod: vi.fn(async ({ name, version }: { name: string; version: ModrinthVersion }) => {
      events.push("install");
      await installHook?.();
      if (failInstall) throw new Error("download failed");
      const bytes = Buffer.from("new jar");
      const check = checkIntegrity(version.files[0], digestsOf(bytes));
      if (!check.ok) throw new Error(check.reason);
      await writeFile(path.join(DIRS.mc, "mods", `${name.toLowerCase()}.jar`), bytes);
      return check;
    }),
  };
});

// Trace real tar, and use a failure only when the scenario requires one.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: { timeout?: number }, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      if (file === "tar" && args.includes("-czf")) {
        events.push("archive");
        if (failTar) { cb(new Error("tar failed"), "", ""); return; }
      }
      return actual.execFile(file, args, { ...options, encoding: "utf-8" }, cb);
    },
  };
});
vi.mock("@/lib/backup-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup-store")>();
  return { ...actual, BACKUP_DIRS: {
    minecraft: DIRS.backups, "7dtd": `${DIRS.root}/7dtd-backups`, zomboid: `${DIRS.root}/pz-backups`,
  } };
});
vi.mock("@/lib/backup-log", () => ({ recordBackupEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/rcon", () => ({ sendCommand: vi.fn(async (command: string) => {
  if (command === "save-all flush") {
    events.push("save");
    await writeFile(path.join(DIRS.mc, "world", "level.dat"), "saved before apply");
  }
  return "ok";
}) }));

// Capture the real registry's handle to exercise its preemption getter at a boundary.
vi.mock("@/lib/operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operations")>();
  return { ...actual, runOperation: <T>(spec: Parameters<typeof actual.runOperation>[0], fn: (op: OpHandle) => Promise<OpSuccess<T>>) =>
    actual.runOperation(spec, async (op) => {
      if (spec.kind === "mods.apply") currentOp = op;
      return fn(op);
    }),
  };
});

vi.mock("@/lib/game-manager", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/game-manager")>(),
  getMinecraftTarget: async () => ({ mcVersion: "26.1.2", loader: "fabric" }),
}));

const { POST } = await import("@/app/api/mods/install-modpack/route");
const { currentControlLock, powerOn } = await import("@/lib/game-manager");
const { resetCommandRunner, setCommandRunner } = await import("@/lib/docker-cli");
const { listFinished, OperationConflictError, runOperation } = await import("@/lib/operations");

beforeEach(async () => {
  vi.clearAllMocks();
  events = [];
  states = { "yoshling-mc": "running", "yoshling-7dtd": "exited", "yoshling-pz": "exited" };
  mods = ["Lithium"];
  installed = [{ id: "old", name: "Old", fileName: "old.jar" }];
  clientOnly = false;
  failInstall = false;
  failRemoval = false;
  failTar = false;
  ignoreStop = false;
  ignoreStart = false;
  unknownState = false;
  exitAtFinalRead = false;
  readsAfterStart = 0;
  installHook = null;
  planningHook = null;
  currentOp = null;
  directMode = false; directSlug = "technicthing"; escapeDirectRoot = false; failDirectReadback = false; preemptDirectPath = false; directRows = [];
  await rm(DIRS.root, { recursive: true, force: true });
  await mkdir(path.join(DIRS.mc, "mods"), { recursive: true });
  await mkdir(path.join(DIRS.mc, "world"));
  await writeFile(path.join(DIRS.mc, "mods", "old.jar"), "old jar");
  await writeFile(path.join(DIRS.mc, "world", "level.dat"), "previous save");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url !== "https://example.test/direct.jar") throw new Error("Unexpected direct download URL");
    return {
      ok: true, headers: new Headers({ "content-length": "7" }),
      arrayBuffer: async () => {
        if (escapeDirectRoot) {
          await mkdir(path.join(DIRS.root, "outside"));
          await writeFile(path.join(DIRS.root, "outside", "technicthing.jar"), "preserve outside fixture");
          await rm(path.join(DIRS.mc, "mods"), { recursive: true });
          await symlink(path.join(DIRS.root, "outside"), path.join(DIRS.mc, "mods"));
        }
        return Uint8Array.from(Buffer.from("new jar")).buffer;
      },
    };
  }));

  setCommandRunner(async (command) => {
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    if (command.startsWith("docker inspect")) {
      const container = Object.keys(states).find((name) => command.includes(name))!;
      if (unknownState && command.includes("HostConfig.Memory")) throw new Error("Docker unavailable");
      if (exitAtFinalRead && command.includes("HostConfig.Memory") && container === "yoshling-mc" && events.includes("start")) {
        readsAfterStart++;
        if (readsAfterStart === 3) states[container] = "exited";
      }
      if (command.includes("HostConfig.Memory")) return ok(`${states[container]}|${6 * 1024 ** 3}`);
      if (command.includes("ExitCode")) return ok(`'${states[container]}|0'`);
      return ok(`'${states[container]}'`);
    }
    if (command.startsWith("docker stop yoshling-mc")) {
      events.push("stop");
      if (!ignoreStop) states["yoshling-mc"] = "exited";
      return ok();
    }
    if (command.startsWith("docker start yoshling-mc")) {
      events.push("start");
      if (!ignoreStart) states["yoshling-mc"] = "running";
      return ok();
    }
    if (command.startsWith("docker start yoshling-7dtd")) {
      events.push("start-7dtd");
      states["yoshling-7dtd"] = "running";
      return ok();
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(async () => {
  resetCommandRunner();
  await rm(DIRS.root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("direct pack jars obey the same publication boundary", () => {
  it("writes and reads the contained direct jar before recording pack provenance", async () => {
    directMode = true;
    const result = await apply();
    expect(result.status).toBe(200);
    expect(await readFile(path.join(DIRS.mc, "mods", "technicthing.jar"), "utf8")).toBe("new jar");
    expect(directRows).toEqual([expect.objectContaining({ source: "pack", fileName: "technicthing.jar", version: "technic" })]);
  });

  it("refuses a mods-root alias introduced during direct download without changing its target", async () => {
    directMode = true;
    escapeDirectRoot = true;
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.errors.join(" ")).toContain("outside");
    expect(await readFile(path.join(DIRS.root, "outside", "technicthing.jar"), "utf8")).toBe("preserve outside fixture");
    expect(directRows).toEqual([]);
    expect(events).not.toContain("start");
  });

  it("refuses a nested direct slug even when its parent exists", async () => {
    directMode = true;
    directSlug = "nested/thing";
    await mkdir(path.join(DIRS.mc, "mods", "nested"));
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("filename");
    expect(directRows).toEqual([]);
  });

  it("does not count or record a jar whose disk readback disagrees", async () => {
    directMode = true;
    failDirectReadback = true;
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.errors.join(" ")).toContain("published mod jar");
    expect(result.body.installed).toBe(0);
    expect(directRows).toEqual([]);
    expect(events).not.toContain("start");
  });

  it("checks preemption after direct path admission before publication", async () => {
    directMode = true;
    preemptDirectPath = true;
    const result = await apply();
    expect(result.status).toBe(500);
    await expect(readFile(path.join(DIRS.mc, "mods", "technicthing.jar"))).rejects.toThrow();
    expect(directRows).toEqual([]);
    expect(events).not.toContain("start");
  });
});

async function apply() {
  const response = await POST(new Request("http://localhost/api/mods/install-modpack", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modpackId: "pack" }),
  }) as NextRequest);
  return { status: response.status, body: await response.json() };
}

async function archives() {
  return (await readdir(DIRS.backups).catch(() => [] as string[])).filter((name) => name.endsWith(".tar.gz"));
}

describe("a pack apply owns power and changes jars only while Minecraft is stopped", () => {
  it("saves and stops before archiving/removing/writing, and restarts only afterward", async () => {
    const result = await apply();
    expect(result.status).toBe(200);
    expect(events).toEqual(["save", "stop", "archive", "remove", "install", "start"]);
    expect(states["yoshling-mc"]).toBe("running");
    expect(await readFile(path.join(DIRS.mc, "mods", "lithium.jar"), "utf-8")).toBe("new jar");
    const [archive] = await archives();
    const { execFile: realExecFile } = await vi.importActual<typeof import("child_process")>("child_process");
    const savedWorld = await new Promise<string>((resolve, reject) => {
      realExecFile("tar", ["-xOf", path.join(DIRS.backups, archive), "world/level.dat"], (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
    });
    expect(savedWorld).toBe("saved before apply");
    const record = listFinished().find((entry) => entry.id === currentOp?.id)!;
    expect(record.facts.find((fact) => fact.label === "Server")?.value).toBe("starting again");
  });

  it("keeps an already stopped Minecraft stopped while another world is running", async () => {
    states["yoshling-mc"] = "exited";
    states["yoshling-pz"] = "running";
    expect((await apply()).status).toBe(200);
    expect(events).toEqual(["archive", "remove", "install"]);
    expect(states["yoshling-mc"]).toBe("exited");
    expect(states["yoshling-pz"]).toBe("running");
  });

  it("keeps a stopped world stopped when the host is otherwise empty", async () => {
    states["yoshling-mc"] = "exited";
    expect((await apply()).status).toBe(200);
    expect(events).toEqual(["archive", "remove", "install"]);
    expect(states["yoshling-mc"]).toBe("exited");
  });

  it("leaves a failed download stopped with the old jars still in the real rollback archive", async () => {
    failInstall = true;
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(states["yoshling-mc"]).toBe("exited");
    expect(events).not.toContain("start");
    const [archive] = await archives();
    const { execFile: realExecFile } = await vi.importActual<typeof import("child_process")>("child_process");
    const oldJar = await new Promise<string>((resolve, reject) => {
      realExecFile("tar", ["-xOf", path.join(DIRS.backups, archive), "mods/old.jar"], (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
    });
    expect(oldJar).toBe("old jar");
  });

  it("leaves failed-removal leftovers stopped even when every new jar downloaded", async () => {
    failRemoval = true;
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(result.body.errors[0]).toContain("could not be removed");
    expect(events).not.toContain("start");
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
  });

  it("does not remove any jar after backup failure, and leaves the stopped world recoverable", async () => {
    failTar = true;
    expect((await apply()).status).toBe(500);
    expect(events).toEqual(["save", "stop", "archive"]);
    expect(states["yoshling-mc"]).toBe("exited");
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
    expect(await archives()).toEqual([]);
  });

  it("refuses an unsuccessful stop before backing up or replacing jars", async () => {
    ignoreStop = true;
    expect((await apply()).status).toBe(500);
    expect(events).toEqual(["save", "stop"]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
    expect(await archives()).toEqual([]);
  });

  it("does not describe a failed restart as an applied and running pack", async () => {
    ignoreStart = true;
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("did not start");
    expect(states["yoshling-mc"]).toBe("exited");
  });

  it("fails when the final observation sees the restarted container already exited", async () => {
    exitAtFinalRead = true;
    const result = await apply();
    expect(readsAfterStart).toBe(3);
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("observed powered off");
    expect(states["yoshling-mc"]).toBe("exited");
    const record = listFinished().find((entry) => entry.id === currentOp?.id)!;
    expect(record.outcome).toBe("failed");
    expect(record.facts.some((fact) => fact.label === "Server" && fact.value === "starting again")).toBe(false);
    expect(record.summary).toContain("powered off");
    expect(record.summary).not.toContain("still running");
  });

  it("refuses co-residency before stopping or changing a running Minecraft", async () => {
    states["yoshling-pz"] = "running";
    const result = await apply();
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe("coresidency");
    expect(events).toEqual([]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
  });

  it("refuses to restart if another world starts outside the operation during replacement", async () => {
    installHook = async () => { states["yoshling-pz"] = "running"; };
    const result = await apply();
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe("coresidency");
    expect(states["yoshling-mc"]).toBe("exited");
    expect(events).not.toContain("start");
    expect(result.body.error).not.toContain("Nothing was changed");
  });

  it("treats unavailable Docker state as unknown rather than safely stopped", async () => {
    unknownState = true;
    expect((await apply()).status).toBe(500);
    expect(events).toEqual([]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
  });

  it("keeps empty and all-client refusals free of saves/stops/archives/replacements", async () => {
    mods = [];
    expect((await apply()).status).toBe(409);
    mods = ["Sodium"];
    clientOnly = true;
    expect((await apply()).status).toBe(409);
    expect(events).toEqual([]);
    expect(states["yoshling-mc"]).toBe("running");
    expect(await archives()).toEqual([]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
  });

  it("claims power throughout replacement and refuses a concurrent world start", async () => {
    let release!: () => void;
    let downloading!: () => void;
    const ready = new Promise<void>((resolve) => { downloading = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installHook = async () => { downloading(); await gate; };
    const active = apply();
    await ready;
    try {
      expect(currentControlLock()?.action).toBe("restart");
      await expect(powerOn("7dtd")).rejects.toBeInstanceOf(OperationConflictError);
    } finally {
      release();
      await active;
    }
  });

  it("refuses admission while another power operation holds the host", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => { admitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = runOperation({ kind: "power", game: "zomboid", action: "restart", title: "Busy" }, async () => {
      admitted(); await gate; return { value: null };
    });
    await ready;
    try {
      expect((await apply()).status).toBe(409);
      expect(events).toEqual([]);
      expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
    } finally { release(); await held; }
  });

  it("keeps client-only planning free of power while another world's backup remains intact", async () => {
    clientOnly = true;
    let backup!: OpHandle;
    let finishBackup!: () => void;
    let backupReady!: () => void;
    const readyBackup = new Promise<void>((resolve) => { backupReady = resolve; });
    const backupGate = new Promise<void>((resolve) => { finishBackup = resolve; });
    const held = runOperation({ kind: "backup.create", game: "zomboid", title: "Backing up" }, async (op) => {
      backup = op; backupReady(); await backupGate; return { value: null };
    });
    await readyBackup;
    let finishPlan!: () => void;
    let planReady!: () => void;
    const readyPlan = new Promise<void>((resolve) => { planReady = resolve; });
    const planGate = new Promise<void>((resolve) => { finishPlan = resolve; });
    planningHook = async () => { planReady(); await planGate; };
    const active = apply();
    await readyPlan;
    let result!: Awaited<ReturnType<typeof apply>>;
    try {
      expect(currentControlLock()).toBeNull();
      expect(backup.preempted).toBe(false);
    } finally {
      finishPlan();
      result = await active;
      finishBackup(); await held;
    }
    expect(result.status).toBe(409);
    expect(backup.preempted).toBe(false);
    expect(events).toEqual([]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
  });

  it("refuses while Minecraft's own backup holds its file lane instead of preempting it", async () => {
    mods = [];
    let backup!: OpHandle;
    let release!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => { admitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = runOperation({ kind: "backup.create", game: "minecraft", title: "Backing up" }, async (op) => {
      backup = op; admitted(); await gate; return { value: null };
    });
    await ready;
    try {
      expect((await apply()).status).toBe(409);
      expect(backup.preempted).toBe(false);
      expect(events).toEqual([]);
    } finally { release(); await held; }
  });

  it("lets a power handoff interrupt planning before any backup or jar replacement", async () => {
    let release!: () => void;
    let planning!: () => void;
    const ready = new Promise<void>((resolve) => { planning = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    planningHook = async () => { planning(); await gate; };
    const active = apply();
    await ready;
    let result!: Awaited<ReturnType<typeof apply>>;
    try {
      await powerOn("7dtd");
      expect(currentOp?.preempted).toBe(true);
      expect(states["yoshling-7dtd"]).toBe("running");
    } finally { release(); result = await active; }
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("interrupted");
    expect(await archives()).toEqual([]);
    expect(await readFile(path.join(DIRS.mc, "mods", "old.jar"), "utf-8")).toBe("old jar");
    expect(events).not.toContain("archive");
    expect(events).not.toContain("remove");
    expect(events).not.toContain("install");
  });

  it("checks preemption between removals before deleting the next old jar", async () => {
    installed.push({ id: "other", name: "Other", fileName: "other.jar" });
    await writeFile(path.join(DIRS.mc, "mods", "other.jar"), "other old jar");
    const { removeMod } = await import("@/lib/mod-manager");
    const normalRemoval = vi.mocked(removeMod).getMockImplementation()!;
    vi.mocked(removeMod).mockImplementationOnce(async (...args) => {
      await normalRemoval(...args);
      Object.defineProperty(currentOp!, "preempted", { get: () => true });
    });
    const result = await apply();
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("interrupted");
    expect(await readFile(path.join(DIRS.mc, "mods", "other.jar"), "utf-8")).toBe("other old jar");
    expect(events.filter((event) => event === "remove")).toHaveLength(1);
    expect(events).not.toContain("install");
    expect(events).not.toContain("start");
  });
});
