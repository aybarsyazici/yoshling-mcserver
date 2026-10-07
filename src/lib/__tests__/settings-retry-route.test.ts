import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

let role = "MOD";
let games = "minecraft";
let signedIn = true;
let row = { id: "main", mcVersion: "26.1.2", modLoader: "fabric", maxMemory: "4G" };
let rowPresent = true;
let worldVersion: string | null = "26.1.2";
let composeReadable = true;
let envText = "";
let containerEnv = { TYPE: "FABRIC", VERSION: "26.1.2" };
let commands: string[] = [];
let failRecreate = false;
let ignoreRecreate = false;
let failDbWrite = false;
let ignoreDbWrite = false;
let peerRunning = false;

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => signedIn ? { user: { id: "tester", name: "Tester", role, games } } : null),
}));
const upsert = vi.fn(async ({ update, create }: { update: Partial<typeof row>; create: typeof row }) => {
  if (failDbWrite) throw new Error("database unavailable");
  if (!ignoreDbWrite) {
    row = rowPresent ? { ...row, ...update } : {
      id: create.id, mcVersion: create.mcVersion, modLoader: create.modLoader, maxMemory: create.maxMemory,
    };
    rowPresent = true;
  }
  return row;
});
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: vi.fn(async () => rowPresent ? ({ ...row }) : null), upsert },
  installedMod: { findMany: vi.fn(async () => []) },
} }));
vi.mock("@/lib/mc-world-version", () => ({ readWorldVersion: vi.fn(async () => worldVersion) }));

const COMPOSE = 'services:\n  minecraft:\n    environment:\n      TYPE: "${MC_TYPE:-FABRIC}"\n      VERSION: "${MC_VERSION:-26.1.2}"\n      MEMORY: "${MC_MEMORY:-4G}"\n';
vi.mock("@/lib/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compose")>();
  return {
    ...actual,
    readCompose: vi.fn(async () => {
      if (!composeReadable) throw new Error("compose unavailable");
      return COMPOSE;
    }),
    readEnvFile: vi.fn(async () => envText),
    readEnvMap: vi.fn(async () => actual.parseEnvFile(envText)),
    writeEnvFile: vi.fn(async (text: string) => { envText = text; }),
  };
});

import { resetCommandRunner, setCommandRunner } from "@/lib/docker-cli";
import { parseEnvFile, readServiceEnv } from "@/lib/compose";
import { runOperation } from "@/lib/operations";
const { GET, PUT } = await import("@/app/api/settings/route");
const { POST: control } = await import("@/app/api/games/control/route");

beforeEach(() => {
  vi.clearAllMocks();
  role = "MOD";
  games = "minecraft";
  signedIn = true;
  row = { id: "main", mcVersion: "26.1.2", modLoader: "fabric", maxMemory: "4G" };
  rowPresent = true;
  worldVersion = "26.1.2";
  composeReadable = true;
  vi.stubEnv("RCON_PASSWORD", "fabricated-test-control-password");
  envText = "";
  containerEnv = { TYPE: "FABRIC", VERSION: "26.1.2" };
  commands = [];
  failRecreate = false;
  ignoreRecreate = false;
  failDbWrite = false;
  ignoreDbWrite = false;
  peerRunning = false;
  setCommandRunner(async (cmd) => {
    commands.push(cmd);
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    if (cmd.includes("HostConfig.Memory")) return ok(`${peerRunning && cmd.includes("yoshling-pz") ? "running" : "exited"}|${6 * 1024 ** 3}`);
    if (cmd.includes("range .Config.Env")) {
      return ok(Object.entries(containerEnv).map(([key, value]) => `${key}=${value}`).join("\n"));
    }
    if (cmd.includes(".State.Status")) return ok("'exited'");
    if (cmd.includes("create --force-recreate minecraft")) {
      if (failRecreate) throw new Error("recreate failed");
      if (!ignoreRecreate) {
        const env = parseEnvFile(envText);
        containerEnv = {
          TYPE: readServiceEnv(COMPOSE, "minecraft", "TYPE", env)!,
          VERSION: readServiceEnv(COMPOSE, "minecraft", "VERSION", env)!,
        };
      }
      return ok();
    }
    if (cmd.startsWith("docker ps -a")) return ok("abc123|yoshling|minecraft\n");
    throw new Error(`Unexpected command: ${cmd}`);
  });
});

afterEach(() => { resetCommandRunner(); vi.unstubAllEnvs(); });

async function save(body: unknown = { mcVersion: "1.21.4", modLoader: "fabric", confirm: true }) {
  const response = await PUT(new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest);
  return { status: response.status, body: await response.json() };
}

describe("settings applies are retryable and persist after verification", () => {
  it("returns a business409 when Restart would start alongside another world", async () => {
    peerRunning = true;
    const response = await control(new Request("http://localhost/api/games/control", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "minecraft", action: "restart" }),
    }) as NextRequest);
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.conflict).toBe("coresidency");
    expect(body.running).toEqual(["zomboid"]);
    expect(body.error).toContain("Minecraft was not started");
    expect(body.error).not.toContain("nothing");
    expect(commands.some((command) => command.startsWith("docker start"))).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("initializes an absent row only after GET reads a verified configuration and PUT applies it", async () => {
    rowPresent = false;
    worldVersion = null;
    envText = "MC_VERSION=1.21.11\nMC_TYPE=NEOFORGE\nMC_MEMORY=3G\n";
    containerEnv = { TYPE: "NEOFORGE", VERSION: "1.21.11" };
    const response = await GET();
    const initial = await response.json();
    expect(response.status).toBe(200);
    expect(initial).toMatchObject({ initialized: false, mcVersion: "1.21.11", modLoader: "neoforge", maxMemory: "3G" });
    expect(Object.keys(initial)).not.toContain("rconPassword");
    expect(upsert).not.toHaveBeenCalled();
    expect(rowPresent).toBe(false);
    expect((await save({ mcVersion: initial.mcVersion, modLoader: initial.modLoader })).status).toBe(200);
    expect(rowPresent).toBe(true);
    expect(row).toMatchObject({ mcVersion: "1.21.11", modLoader: "neoforge", maxMemory: "3G" });
    expect((await (await GET()).json()).initialized).toBe(true);
    expect(commands.some((command) => command.includes("docker compose"))).toBe(false);
  });

  it("refuses missing-row setup when configured values cannot be read", async () => {
    rowPresent = false;
    composeReadable = false;
    expect((await GET()).status).toBe(503);
    expect((await save()).status).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
    expect(rowPresent).toBe(false);
    expect(commands).toEqual([]);
  });

  it("does not substitute defaults for an invalid configured initializer", async () => {
    rowPresent = false;
    envText = "MC_VERSION=valid\nMC_TYPE=not a loader\n";
    expect((await GET()).status).toBe(503);
    expect((await save()).status).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("leaves the database unchanged when operation admission is busy", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => { admitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = runOperation({ kind: "power", game: "zomboid", action: "start", title: "Busy" }, async () => {
      admitted();
      await gate;
      return { value: null };
    });
    await ready;
    try {
      expect((await save()).status).toBe(409);
      expect(row.mcVersion).toBe("26.1.2");
      expect(upsert).not.toHaveBeenCalled();
      expect(envText).toBe("");
      expect(commands).toEqual([]);
    } finally {
      release();
      await held;
    }
    expect((await save()).status).toBe(200);
    expect(row.mcVersion).toBe("1.21.4");
    expect(containerEnv.VERSION).toBe("1.21.4");
  });

  it("does not persist a failed recreate and applies an identical retry", async () => {
    failRecreate = true;
    expect((await save()).status).toBe(500);
    expect(upsert).not.toHaveBeenCalled();
    expect(row.mcVersion).toBe("26.1.2");
    expect(containerEnv.VERSION).toBe("26.1.2");
    expect(parseEnvFile(envText).MC_VERSION).toBe("1.21.4");
    failRecreate = false;
    expect((await save()).status).toBe(200);
    expect(row.mcVersion).toBe("1.21.4");
    expect(containerEnv.VERSION).toBe("1.21.4");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("repairs drift even when a historic failed apply already changed the DB row", async () => {
    row.mcVersion = "1.21.4";
    expect((await save()).status).toBe(200);
    expect(commands.some((cmd) => cmd.includes("create --force-recreate minecraft"))).toBe(true);
    expect(containerEnv.VERSION).toBe("1.21.4");
  });

  it("does not claim success when recreation reports success but keeps stale env", async () => {
    ignoreRecreate = true;
    const result = await save();
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("could not be verified");
    expect(upsert).not.toHaveBeenCalled();
    expect(row.mcVersion).toBe("26.1.2");
  });

  it("retries a database failure without recreating an already verified container", async () => {
    failDbWrite = true;
    expect((await save()).status).toBe(500);
    expect(containerEnv.VERSION).toBe("1.21.4");
    expect(row.mcVersion).toBe("26.1.2");
    commands = [];
    failDbWrite = false;
    expect((await save()).status).toBe(200);
    expect(row.mcVersion).toBe("1.21.4");
    expect(commands.some((cmd) => cmd.includes("docker compose"))).toBe(false);
  });

  it("reads the database back before reporting success", async () => {
    ignoreDbWrite = true;
    expect((await save()).status).toBe(500);
    expect(row.mcVersion).toBe("26.1.2");
    expect(containerEnv.VERSION).toBe("1.21.4");
  });

  it("preserves the world mismatch confirmation before admitting any change", async () => {
    const result = await save({ mcVersion: "1.21.4" });
    expect(result.status).toBe(400);
    expect(result.body.needsConfirm).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("retains world and role authorization before touching settings", async () => {
    games = "zomboid";
    expect((await save()).status).toBe(403);
    games = "minecraft";
    role = "MEMBER";
    expect((await save()).status).toBe(403);
    signedIn = false;
    expect((await save()).status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });
});
