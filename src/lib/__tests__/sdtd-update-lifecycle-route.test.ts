import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { readServiceEnv } from "@/lib/compose";

const BASE = 'services:\n  sevendtd:\n    environment:\n      START_MODE: "1"\n      VERSION: "latest_experimental"\n';
let compose = BASE;
let states: Record<string, string> = {};
let events: string[] = [];
let unknown: string | null = null;
let ignoredStop = false;
let staleMode = false;
let mode = "1";
let writeHook: (() => Promise<void>) | null = null;

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({
  user: { id: "tester", name: "Tester", role: "MOD", games: "7dtd" },
})) }));
vi.mock("@/lib/db", () => ({ db: { activity: { create: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/telnet", () => ({ sdtdSaveWorld: vi.fn(async () => { events.push("save"); }) }));
vi.mock("@/lib/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compose")>();
  return { ...actual,
    readCompose: vi.fn(async () => compose),
    writeCompose: vi.fn(async (text: string) => {
      events.push(`mode${actual.readServiceEnv(text, "sevendtd", "START_MODE")}`);
      compose = text;
      if (actual.readServiceEnv(text, "sevendtd", "START_MODE") === "3") await writeHook?.();
    }),
  };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, readFile: vi.fn(async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]).includes("appmanifest_294420.acf")) return '"buildid" "1"';
    return actual.readFile(...args);
  }) };
});
vi.mock("child_process", () => ({
  exec: (command: string, callback: (error: Error | null, output?: { stdout: string; stderr: string }) => void) => {
    if (!command.includes("json .Config.Env")) return callback(new Error("Unexpected exec"));
    callback(null, { stdout: JSON.stringify([`START_MODE=${mode}`, "VERSION=latest_experimental"]), stderr: "" });
  },
}));

const { POST } = await import("@/app/api/7dtd/update/route");
const { resetCommandRunner, setCommandRunner } = await import("@/lib/docker-cli");
const { currentControlLock } = await import("@/lib/game-manager");
const { runOperation, listFinished } = await import("@/lib/operations");

beforeEach(() => {
  vi.clearAllMocks();
  compose = BASE;
  events = [];
  states = { "yoshling-7dtd": "running", "yoshling-mc": "exited", "yoshling-pz": "exited" };
  unknown = null;
  ignoredStop = false;
  staleMode = false;
  mode = "1";
  writeHook = null;
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ data: {
    "294420": { depots: { branches: { latest_experimental: { buildid: "2" } } } },
  } }) })));
  setCommandRunner(async (command) => {
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    const container = Object.keys(states).find((name) => command.includes(name));
    if (command.includes("HostConfig.Memory")) {
      if (container === unknown) throw new Error("State unavailable");
      return ok(`${states[container!]}|${10 * 1024 ** 3}`);
    }
    if (command.includes("State.ExitCode")) return ok(`'${states[container!]}|0'`);
    if (command.includes("State.Status")) return ok(`'${states[container!]}'`);
    if (command.startsWith("docker stop yoshling-7dtd")) {
      events.push("stop");
      if (!ignoredStop) states["yoshling-7dtd"] = "exited";
      return ok();
    }
    if (command.includes("create --force-recreate sevendtd")) {
      events.push("create");
      states["yoshling-7dtd"] = "created";
      if (!staleMode) mode = readServiceEnv(compose, "sevendtd", "START_MODE")!;
      return ok();
    }
    if (command.startsWith("docker ps -a")) return ok("id|yoshling|sevendtd");
    if (command.startsWith("docker start yoshling-7dtd")) {
      events.push("start"); states["yoshling-7dtd"] = "running"; return ok();
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => { resetCommandRunner(); vi.unstubAllGlobals(); });

async function update() {
  const response = await POST();
  return { status: response.status, body: await response.json() };
}

describe("7DTD update uses the same protected lifecycle as ordinary controls", () => {
  it("saves/stops before mode3, creates stopped, verifies mode, then starts and restores mode1", async () => {
    const result = await update();
    expect(result.status).toBe(200);
    expect(events).toEqual(["save", "stop", "mode3", "create", "start", "mode1"]);
    expect(mode).toBe("3");
    expect(readServiceEnv(compose, "sevendtd", "START_MODE")).toBe("1");
    expect(states["yoshling-7dtd"]).toBe("running");
    const record = listFinished().find((entry) => entry.kind === "game.update")!;
    expect(record.facts.find((fact) => fact.label === "Build")?.value).toContain("downloading");
  });

  it("does not claim to save a world that was already stopped", async () => {
    states["yoshling-7dtd"] = "exited";
    expect((await update()).status).toBe(200);
    expect(events).toEqual(["mode3", "create", "start", "mode1"]);
  });

  it("refuses an unavailable peer instead of treating it as stopped", async () => {
    unknown = "yoshling-pz";
    expect((await update()).status).toBe(500);
    expect(events).toEqual([]);
    expect(compose).toBe(BASE);
  });

  it("refuses an unavailable target before modifying compose", async () => {
    unknown = "yoshling-7dtd";
    expect((await update()).status).toBe(500);
    expect(events).toEqual([]);
    expect(compose).toBe(BASE);
  });

  it.each(["running", "paused", "restarting"])("refuses a peer in %s state", async (state) => {
    states["yoshling-pz"] = state;
    const result = await update();
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe("coresidency");
    expect(events).toEqual([]);
  });

  it("never changes compose or recreates after a stop that leaves the game running", async () => {
    ignoredStop = true;
    expect((await update()).status).toBe(500);
    expect(events).toEqual(["save", "stop"]);
    expect(compose).toBe(BASE);
  });

  it("refuses an unverified mode3 container and still restores mode1", async () => {
    staleMode = true;
    expect((await update()).status).toBe(500);
    expect(events).toEqual(["save", "stop", "mode3", "create", "mode1"]);
    expect(readServiceEnv(compose, "sevendtd", "START_MODE")).toBe("1");
    expect(states["yoshling-7dtd"]).toBe("created");
  });

  it("refused peer preflight leaves unrelated backups unpreempted", async () => {
    states["yoshling-pz"] = "running";
    let handle!: import("@/lib/operations").OpHandle;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = runOperation({ kind: "backup.create", game: "zomboid", title: "Backing up" }, async (op) => {
      handle = op; entered(); await gate; return { value: null };
    });
    await ready;
    try { expect((await update()).status).toBe(409); expect(handle.preempted).toBe(false); }
    finally { release(); await held; }
    expect(events).toEqual([]);
  });

  it("holds power during stopped recreation so another world cannot start", async () => {
    states["yoshling-7dtd"] = "exited";
    let release!: () => void;
    let writing!: () => void;
    const ready = new Promise<void>((resolve) => { writing = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    writeHook = async () => { writing(); await gate; };
    const active = update();
    await ready;
    try {
      expect(currentControlLock()?.action).toBe("restart");
      await expect(runOperation({ kind: "power", game: "minecraft", action: "start", title: "Starting" }, async () => ({ value: null })))
        .rejects.toHaveProperty("resource", "power");
    } finally { release(); await active; }
  });
});
