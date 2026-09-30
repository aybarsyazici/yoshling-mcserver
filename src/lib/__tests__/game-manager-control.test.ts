import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `game-manager` — the eviction logic, the `wasRunning` gating and the recreate path.
 *
 * ## Why this file exists
 *
 * This module decides which world is running on a box that fits exactly one, and until
 * now it had **no tests at all**, for one reason: every function forked `docker`. So its
 * load-bearing properties were asserted only by comments, and three rounds of audit
 * produced findings claiming the opposite of several of them (all refuted by hand, by
 * reading production logs — which is not a thing that scales).
 *
 * `src/lib/docker-cli.ts` is the seam that makes them testable. Nothing here touches
 * Docker, the network or a container; the fake below is a state machine over container
 * names, and what the tests assert is **which commands ran, in what order, under what
 * condition** — because that is exactly what every one of these properties is about.
 *
 * Each `describe` names the incident it pins. Where a test is a pure regression lock
 * with no prior failing state, it says so rather than implying it caught something.
 */

// ── the fake box ─────────────────────────────────────────────────────────────

type FakeContainer = {
  state: "running" | "exited" | "created";
  exitCode: number;
  startedAt: string;
  env: Record<string, string>;
  service: string;
  /** What `docker ps -a` reports for the compose labels, so the guard can be tested. */
  rows?: string[];
};

const REAL_COMPOSE = readFileSync(
  path.join(__dirname, "..", "..", "..", "docker-compose.yml"),
  "utf-8"
);

/** Every shell command the module issued, in order. The subject of most assertions. */
let commands: string[] = [];
let box: Record<string, FakeContainer> = {};
let composeText = REAL_COMPOSE;
let envText = "";
/** Inspect counter per container, so a test can flip state mid-operation. */
let inspects: Record<string, number> = {};
let onInspect: ((name: string, nth: number) => void) | null = null;

function container(name: string): FakeContainer {
  const c = box[name];
  if (!c) throw new Error(`Error: No such object: ${name}`);
  return c;
}

/**
 * Recompute a container's env from compose + `.env`, the way `compose create` does.
 *
 * Without this the configured-vs-live comparison — the one report in this codebase that
 * has never been wrong — would be asserted against a constant, and a test could pass
 * while the `.env` write never reached the container.
 */
async function recreate(service: string, name: string): Promise<void> {
  const { parseEnvFile, readServiceEnv } = await import("@/lib/compose");
  const env = parseEnvFile(envText);
  const c = container(name);
  c.env = {};
  for (const key of ["TYPE", "VERSION", "MEMORY", "MIN_MEMORY", "MAX_MEMORY"]) {
    const v = readServiceEnv(composeText, service, key, env);
    if (v !== null) c.env[key] = v;
  }
  // `create` never starts: a stopped world must stay stopped.
  c.state = c.state === "running" ? "running" : "created";
}

const fakeRunner = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  commands.push(cmd);
  const ok = (stdout = "") => ({ stdout, stderr: "" });

  let m: RegExpExecArray | null;

  if ((m = /^docker inspect --format='\{\{\.State\.Status\}\}' (\S+)/.exec(cmd))) {
    const name = m[1];
    inspects[name] = (inspects[name] ?? 0) + 1;
    onInspect?.(name, inspects[name]);
    return ok(`'${container(name).state}'\n`);
  }
  if ((m = /^docker inspect --format='\{\{\.State\.StartedAt\}\}' (\S+)/.exec(cmd))) {
    return ok(`'${container(m[1]).startedAt}'\n`);
  }
  if ((m = /^docker inspect --format='\{\{\.State\.Status\}\}\|\{\{\.State\.ExitCode\}\}' (\S+)/.exec(cmd))) {
    const c = container(m[1]);
    return ok(`'${c.state}|${c.exitCode}'\n`);
  }
  if ((m = /^docker inspect (\S+) --format '\{\{range \.Config\.Env\}\}/.exec(cmd))) {
    const c = container(m[1]);
    return ok(Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
  if ((m = /^docker inspect (\S+) --format '\{\{\.Config\.Image\}\}'/.exec(cmd))) {
    return ok(`image-for-${m[1]}\n`);
  }
  if ((m = /^docker start (\S+)/.exec(cmd))) {
    container(m[1]).state = "running";
    return ok();
  }
  if ((m = /^docker stop (?:-t \d+ )?(\S+)/.exec(cmd))) {
    const c = container(m[1]);
    c.state = "exited";
    return ok();
  }
  if ((m = /^docker ps -a --filter name=\^\/(\S+)\$/.exec(cmd))) {
    const c = container(m[1]);
    return ok((c.rows ?? [`abc123|yoshling|${c.service}`]).join("\n") + "\n");
  }
  if (/docker compose .* (create|up) /.test(cmd)) {
    const svc = /(?:create --force-recreate|up -d --no-deps --force-recreate) (\S+)/.exec(cmd)?.[1];
    const name = Object.keys(box).find((n) => box[n].service === svc);
    if (!name) throw new Error(`no container for service ${svc}`);
    await recreate(svc!, name);
    if (/ up -d /.test(cmd)) box[name].state = "running";
    return ok();
  }
  if (/^docker logs /.test(cmd)) return ok("");

  throw new Error(`fake docker got an unrecognised command: ${cmd}`);
};

// ── mocks for everything that is not the Docker CLI ──────────────────────────

vi.mock("@/lib/rcon", () => ({
  sendCommand: vi.fn(async () => "There are 0 of a max of 20 players online:"),
}));

vi.mock("@/lib/telnet", () => ({
  getSdtdStatus: vi.fn(async () => ({
    reachable: true,
    players: { online: 0, max: 8, players: [] as string[] },
    time: null,
    version: null,
  })),
  sdtdSaveWorld: vi.fn(async () => {}),
}));

vi.mock("@/lib/zomboid", () => ({
  getPzStatus: vi.fn(async () => ({
    reachable: true,
    players: { online: 0, max: 16, players: [] as string[] },
  })),
  // Asking the game to quit is what actually stops Project Zomboid — `docker stop`
  // cannot, because the kernel discards SIGTERM sent to an uncatching PID 1. The fake
  // therefore honours `quit` by exiting the container, and one test below removes that
  // to prove the `docker stop` fallback still runs.
  pzConsole: vi.fn(async (cmd: string) => {
    if (cmd === "quit" && pzHonoursQuit && box["yoshling-pz"]) {
      box["yoshling-pz"].state = "exited";
      box["yoshling-pz"].exitCode = 0;
    }
    return "ok";
  }),
  pzSave: vi.fn(async () => {}),
  readModState: vi.fn(async () => ({ modIds: [] as string[] })),
}));

let pzHonoursQuit = true;

vi.mock("@/lib/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compose")>();
  return {
    ...actual,
    readCompose: vi.fn(async () => composeText),
    writeCompose: vi.fn(async (t: string) => {
      composeText = t;
    }),
    readEnvFile: vi.fn(async () => envText),
    writeEnvFile: vi.fn(async (t: string) => {
      envText = t;
    }),
    // `readEnvMap` calls `readEnvFile` from the real module's own scope, so mocking
    // `readEnvFile` alone would leave it reading /opt/yoshling/.env off this laptop.
    readEnvMap: vi.fn(async () => actual.parseEnvFile(envText)),
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    // 16 GB, so `maxGameGb()` is the documented 13 and the cap assertions mean
    // something. On darwin there is no /proc/meminfo and the fallback is 8.
    readFile: vi.fn(async (p: unknown, enc: unknown) => {
      if (String(p) === "/proc/meminfo") return "MemTotal:       16384000 kB\n";
      return (actual.readFile as (a: unknown, b: unknown) => Promise<string>)(p, enc);
    }),
  };
});

import { setCommandRunner, resetCommandRunner } from "@/lib/docker-cli";
import {
  applyServiceEnv,
  getMemoryState,
  isMemoryRangeError,
  powerOff,
  powerOn,
  restartGame,
  setMemory,
  withGameStopped,
  ControlBusyError,
} from "@/lib/game-manager";
import { parseEnvFile } from "@/lib/compose";

// ── harness ──────────────────────────────────────────────────────────────────

function makeBox(states: {
  minecraft?: FakeContainer["state"];
  "7dtd"?: FakeContainer["state"];
  zomboid?: FakeContainer["state"];
}): void {
  box = {
    "yoshling-mc": {
      state: states.minecraft ?? "exited",
      exitCode: 0,
      startedAt: "2026-09-30T00:00:00Z",
      env: { TYPE: "FABRIC", VERSION: "26.1.2", MEMORY: "4G" },
      service: "minecraft",
    },
    "yoshling-7dtd": {
      state: states["7dtd"] ?? "exited",
      exitCode: 0,
      startedAt: "2026-09-30T00:00:00Z",
      env: { START_MODE: "1", VERSION: "latest_experimental" },
      service: "sevendtd",
    },
    "yoshling-pz": {
      state: states.zomboid ?? "exited",
      exitCode: 0,
      startedAt: "2026-09-30T00:00:00Z",
      env: { MIN_MEMORY: "2048m", MAX_MEMORY: "12288m" },
      service: "zomboid",
    },
  };
}

beforeEach(() => {
  commands = [];
  inspects = {};
  onInspect = null;
  composeText = REAL_COMPOSE;
  envText = "";
  pzHonoursQuit = true;
  makeBox({});
  setCommandRunner(fakeRunner);
  // Every driver sleeps after a save (1–1.5 s) and Project Zomboid polls for its own
  // exit every 500 ms. Real timers would make this suite seconds long; the whole point
  // of `vitest.config.mts` is a suite fast enough that it actually gets run.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetCommandRunner();
});

/** Drive fake time forward until `p` settles, then rethrow or return as it did. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const observed = p.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error) => {
      done = true;
      return { ok: false as const, error };
    }
  );
  for (let i = 0; i < 600 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  const r = await observed;
  if (!r.ok) throw r.error;
  return r.value;
}

/** The commands that changed something, i.e. everything that is not a read. */
function mutations(): string[] {
  return commands.filter(
    (c) => !/^docker (inspect|logs|ps )/.test(c)
  );
}

function indexOfCommand(re: RegExp): number {
  return commands.findIndex((c) => re.test(c));
}

// ── eviction ─────────────────────────────────────────────────────────────────

describe("powerOn is the only path that evicts, and it evicts every other world", () => {
  it("saves and stops the running world before starting the one asked for", async () => {
    // The incident: this box once ran two worlds at once and went 2 GB into swap. Only
    // `powerOn` prevents it, and only by doing these three things in this order.
    makeBox({ zomboid: "running" });
    const { pzSave } = await import("@/lib/zomboid");

    const steps = await settle(powerOn("minecraft"));

    expect(pzSave).toHaveBeenCalled();
    const stopped = indexOfCommand(/^docker stop .*yoshling-pz/);
    const started = indexOfCommand(/^docker start yoshling-mc/);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThanOrEqual(0);
    // Ordering is the property. A start before the stop is co-residency.
    expect(stopped).toBeLessThan(started);
    expect(steps).toEqual([
      { step: "save", game: "zomboid" },
      { step: "stop", game: "zomboid" },
      { step: "start", game: "minecraft" },
    ]);
    expect(box["yoshling-pz"].state).toBe("exited");
    expect(box["yoshling-mc"].state).toBe("running");
  });

  it("stops EVERY other running world, not just the first one it finds", async () => {
    // `otherGames(id)` returns every other world specifically so nothing assumes there
    // are two. With three games, a loop that stopped one and started the requested world
    // would leave two running — and the single-`otherGame` shape it replaced did exactly
    // that.
    makeBox({ minecraft: "running", "7dtd": "running" });

    const steps = await settle(powerOn("zomboid"));

    expect(steps.filter((s) => s.step === "stop").map((s) => s.game).sort()).toEqual([
      "7dtd",
      "minecraft",
    ]);
    const started = indexOfCommand(/^docker start yoshling-pz/);
    expect(indexOfCommand(/^docker stop .*yoshling-mc/)).toBeLessThan(started);
    expect(indexOfCommand(/^docker stop .*yoshling-7dtd/)).toBeLessThan(started);
    expect(box["yoshling-mc"].state).toBe("exited");
    expect(box["yoshling-7dtd"].state).toBe("exited");
    expect(box["yoshling-pz"].state).toBe("running");
  });

  it("stops nothing when no other world is running", async () => {
    makeBox({});
    const steps = await settle(powerOn("minecraft"));
    expect(steps).toEqual([{ step: "start", game: "minecraft" }]);
    expect(mutations()).toEqual(["docker start yoshling-mc"]);
  });

  it("refuses, and starts nothing, if a world comes up between the probe and admission", async () => {
    // Pins the first code path in this app that *detects* co-residency instead of
    // working around it. Only an out-of-band `docker start` can produce this state — and
    // that is what produced the 2026-09-26 two-worlds-at-once overlap, which six audit
    // findings misattributed to `restartGame` and `withGameStopped`.
    makeBox({});
    onInspect = (name, nth) => {
      // The probe loop reads each other world once before admission; the loop inside the
      // operation reads it again. Flip it up in between.
      if (name === "yoshling-7dtd" && nth >= 2) box["yoshling-7dtd"].state = "running";
    };

    await expect(settle(powerOn("minecraft"))).rejects.toThrow(
      /started while this operation was being admitted/
    );
    // The whole claim of that error message: nothing was started and nothing stopped.
    expect(mutations()).toEqual([]);
    expect(box["yoshling-mc"].state).toBe("exited");
    expect(box["yoshling-7dtd"].state).toBe("running");
  });

  it("a start of an already-running, answering world runs no docker command at all", async () => {
    // Not a failure — a no-op. It used to be admitted holding every file lane, which
    // marked a live 7 Days to Die backup `preempted`; 26 s later that backup deleted its
    // own finished 304 MB archive for having been "taken across a save-and-shutdown
    // boundary" that never existed.
    makeBox({ minecraft: "running" });
    const steps = await settle(powerOn("minecraft"));
    expect(steps).toEqual([]);
    expect(mutations()).toEqual([]);
  });

  it("a start of a running world that is NOT answering is refused, and stops nothing", async () => {
    makeBox({ minecraft: "running" });
    const { sendCommand } = await import("@/lib/rcon");
    vi.mocked(sendCommand).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(settle(powerOn("minecraft"))).rejects.toThrow(/already running/);
    expect(mutations()).toEqual([]);
  });
});

// ── the wasRunning gate ──────────────────────────────────────────────────────

describe("withGameStopped gates both halves on wasRunning", () => {
  it("never starts a world that was already stopped", async () => {
    // **Regression lock, honestly labelled**: this has always been correct. Multiple
    // audit findings claimed `withGameStopped` could start a stopped world, and every
    // one was refuted by hand against production logs. Until now the property existed
    // only as a comment, which is why it kept getting re-reported.
    makeBox({});
    const work = vi.fn(async () => {});

    const { restarted } = await settle(withGameStopped("zomboid", "restart", work));

    expect(restarted).toBe(false);
    expect(work).toHaveBeenCalledOnce();
    expect(mutations()).toEqual([]);
    expect(box["yoshling-pz"].state).toBe("exited");
  });

  it("stops before the work and starts after it, when the world was running", async () => {
    makeBox({ zomboid: "running" });
    let stateDuringWork = "";
    const work = vi.fn(async () => {
      stateDuringWork = box["yoshling-pz"].state;
    });

    const { restarted } = await settle(withGameStopped("zomboid", "restart", work));

    expect(restarted).toBe(true);
    // The reason this wrapper exists: replacing mod files under a running server
    // overwrites files the JVM has open and partly mmap'd.
    expect(stateDuringWork).toBe("exited");
    expect(box["yoshling-pz"].state).toBe("running");
  });

  it("restartOnFailure: true brings a running world back when the work throws", async () => {
    // What a Workshop mod update wants. `seedMods` throws on a partial download, and
    // `restart: "no"` means nothing else ever revives Project Zomboid — so leaving it
    // down for one unfetchable mod is worse than booting the previous version.
    makeBox({ zomboid: "running" });
    const work = vi.fn(async () => {
      throw new Error("updated 0 of 1 mods");
    });

    await expect(
      settle(withGameStopped("zomboid", "restart", work, { restartOnFailure: true }))
    ).rejects.toThrow("updated 0 of 1 mods");

    expect(box["yoshling-pz"].state).toBe("running");
    expect(indexOfCommand(/^docker start yoshling-pz/)).toBeGreaterThanOrEqual(0);
  });

  it("restartOnFailure: false leaves a running world down when the work throws", async () => {
    // What a backup restore wants, and the opposite of the above — getting this
    // backwards is silent. A half-replaced save booted is worse than a stopped one: the
    // game rewrites the mess on its first autosave and takes the archive with it.
    makeBox({ zomboid: "running" });
    const work = vi.fn(async () => {
      throw new Error("tar: unexpected EOF");
    });

    await expect(
      settle(withGameStopped("zomboid", "restart", work, { restartOnFailure: false }))
    ).rejects.toThrow("unexpected EOF");

    expect(box["yoshling-pz"].state).toBe("exited");
    expect(indexOfCommand(/^docker start yoshling-pz/)).toBe(-1);
  });

  it("restartOnFailure: true still does not start a world that was already stopped", async () => {
    // The cross case, and the one a naive `finally { start() }` gets wrong: the gate is
    // `wasRunning && (!failed || restartOnFailure)`, so `wasRunning` decides first.
    makeBox({});
    const work = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      settle(withGameStopped("zomboid", "restart", work, { restartOnFailure: true }))
    ).rejects.toThrow("boom");

    expect(mutations()).toEqual([]);
    expect(box["yoshling-pz"].state).toBe("exited");
  });
});

// ── restart is two phases ────────────────────────────────────────────────────

describe("restartGame is stop-then-start, never one opaque docker restart", () => {
  it("issues a stop and then a start, and no `docker restart`", async () => {
    // Each driver used to carry a `restart()` — for Project Zomboid a bare
    // `docker restart -t 300`. One combined call cannot say which half it is in, and the
    // PZ stop half dominates, so the UI showed a spinning "Restarting…" with no stage
    // for minutes and got reported as hung.
    makeBox({ zomboid: "running" });

    await settle(restartGame("zomboid"));

    expect(commands.some((c) => /^docker restart/.test(c))).toBe(false);
    const stopped = indexOfCommand(/^docker stop .*yoshling-pz/);
    const started = indexOfCommand(/^docker start yoshling-pz/);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(stopped);
    expect(box["yoshling-pz"].state).toBe("running");
  });

  it("restarting a stopped world only starts it", async () => {
    makeBox({});
    await settle(restartGame("minecraft"));
    expect(mutations()).toEqual(["docker start yoshling-mc"]);
  });
});

describe("the Project Zomboid stop asks the game first and falls back unconditionally", () => {
  it("exits on the RCON quit and still runs docker stop as a no-op", async () => {
    // `docker stop` alone can never work here: `entry.sh` is PID 1 with no SIGTERM
    // handler and the kernel *discards* uncaught signals for a namespace's PID 1, so
    // every PZ stop was a flat 300 s ending in SIGKILL (14 in three days). The fallback
    // stays UNCONDITIONAL: on an exited container it is instant, and making it
    // conditional would let a server that ignored `quit` keep running while this
    // reported success.
    makeBox({ zomboid: "running" });
    const { pzConsole, pzSave } = await import("@/lib/zomboid");

    const stopped = await settle(powerOff("zomboid"));

    expect(stopped).toBe(true);
    expect(pzSave).toHaveBeenCalled();
    expect(pzConsole).toHaveBeenCalledWith("quit");
    expect(indexOfCommand(/^docker stop -t 300 yoshling-pz/)).toBeGreaterThanOrEqual(0);
    expect(box["yoshling-pz"].state).toBe("exited");
  });

  it("falls back to docker stop when the game ignores the quit", async () => {
    makeBox({ zomboid: "running" });
    pzHonoursQuit = false;

    await settle(powerOff("zomboid"));

    expect(indexOfCommand(/^docker stop -t 300 yoshling-pz/)).toBeGreaterThanOrEqual(0);
    expect(box["yoshling-pz"].state).toBe("exited");
  });

  it("a stop of an already-stopped world runs nothing and reports it as a no-op", async () => {
    // Answered before admission, on purpose: admission is what marks in-flight file
    // operations `preempted`, and two 135 ms / 89 ms no-op stops once invalidated and
    // DELETED a 7 Days to Die backup that had already written a 290 MB archive, for
    // having been "taken across a save-and-shutdown boundary" that never happened.
    makeBox({});
    const stopped = await settle(powerOff("zomboid"));
    expect(stopped).toBe(false);
    expect(mutations()).toEqual([]);
  });
});

// ── the control lock ─────────────────────────────────────────────────────────

describe("the control lock expires on the heartbeat, never on total duration", () => {
  it("stays held past any fixed duration while the heartbeat runs", async () => {
    // The incident: expiry was judged 300 s after the operation *started*, which is
    // shorter than a single Project Zomboid graceful stop. A mod-update apply therefore
    // lost its own lock partway through, a second operation was admitted on top, and two
    // SteamCMD runs raced on the same workshop volume until one reported
    // "updated 0 of 1 mods".
    //
    // 20 minutes of held time is four times that old cap and thirteen times
    // OPERATION_STALE_MS, so this test fails under any total-duration cap.
    makeBox({ zomboid: "running" });
    let release: (() => void) | null = null;
    const held = withGameStopped(
      "zomboid",
      "restart",
      () => new Promise<void>((r) => (release = r))
    );
    // Let it reach the callback.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).not.toBeNull();

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    await expect(powerOn("minecraft")).rejects.toThrow(ControlBusyError);
    // And nothing was done on the way to refusing.
    expect(indexOfCommand(/^docker start yoshling-mc/)).toBe(-1);

    release!();
    await settle(held);
  });

  it("is released as soon as the operation ends, so the next one is admitted", async () => {
    makeBox({ zomboid: "running" });
    await settle(withGameStopped("zomboid", "restart", async () => {}));
    // Would throw ControlBusyError if release were not identity-checked and prompt.
    await settle(powerOn("minecraft"));
    expect(box["yoshling-mc"].state).toBe("running");
  });
});

// ── the recreate path ────────────────────────────────────────────────────────

describe("setMemory recreates without starting, and writes .env rather than compose", () => {
  it("leaves a stopped world stopped, and uses `create` not `up`", async () => {
    // `up` starts the container. Applying a setting to a stopped world would therefore
    // boot it — and since only one world fits on this box, that quietly produces two
    // running at once.
    makeBox({});

    const state = await settle(setMemory("zomboid", 8));

    expect(commands.some((c) => /docker compose .*create --force-recreate zomboid/.test(c))).toBe(true);
    expect(commands.some((c) => /docker compose .*\bup\b/.test(c))).toBe(false);
    expect(indexOfCommand(/^docker start yoshling-pz/)).toBe(-1);
    expect(box["yoshling-pz"].state).toBe("created");
    // Configured vs live, which is the only evidence the change took.
    expect(state.configuredGb).toBe(8);
    expect(state.liveGb).toBe(8);
    expect(state.applied).toBe(true);
  });

  it("writes PZ_MAX_MEMORY to .env and leaves docker-compose.yml byte-identical", () => {
    // The point of job 2. Compose is tracked in git and `deploy.sh` runs
    // `git checkout -f`, so anything written into compose was discarded by the next
    // deploy — undone by hand once, then made loud, but never closed until this.
    makeBox({});
    return settle(setMemory("zomboid", 8)).then(() => {
      expect(composeText).toBe(REAL_COMPOSE);
      expect(parseEnvFile(envText).PZ_MAX_MEMORY).toBe("8192m");
    });
  });

  it("saves, stops, recreates and starts again when the world was running", async () => {
    makeBox({ zomboid: "running" });
    const { pzSave } = await import("@/lib/zomboid");

    await settle(setMemory("zomboid", 10));

    expect(pzSave).toHaveBeenCalled();
    const stopped = indexOfCommand(/^docker stop .*yoshling-pz/);
    const created = indexOfCommand(/create --force-recreate zomboid/);
    const started = indexOfCommand(/^docker start yoshling-pz/);
    expect(stopped).toBeLessThan(created);
    expect(created).toBeLessThan(started);
    expect(box["yoshling-pz"].state).toBe("running");
  });

  it("refuses a heap below MIN_MEMORY, and changes nothing", async () => {
    // Measured on production 2026-09-30: Project Zomboid's JVM runs `-Xms2048m
    // -Xmx12288m`, straight from MIN_MEMORY/MAX_MEMORY in compose. Only MAX_MEMORY is
    // UI-owned, so picking 1 GB wrote `-Xmx1024m` under `-Xms2048m` — a JVM that refuses
    // to start — and the memory card then compared configured against live, found them
    // equal, and rendered the setting as applied. Green, self-consistent, unbootable.
    makeBox({});

    // `MemoryRangeError`, not a bare Error: `/api/games/memory` answers 400 for it rather
    // than 500. The user saw the same message either way — the card toasts `data.error` —
    // but a 500 tells every log and monitor the dashboard broke, when in fact it declined.
    await expect(settle(setMemory("zomboid", 1))).rejects.toSatisfy(isMemoryRangeError);
    await expect(settle(setMemory("zomboid", 1))).rejects.toThrow(/can't be set below 2 GB/);

    expect(envText).toBe("");
    expect(composeText).toBe(REAL_COMPOSE);
    expect(mutations()).toEqual([]);
  });

  it("has no floor for Minecraft, whose single MEMORY key sets both -Xms and -Xmx", async () => {
    // The guard must not become a blanket minimum: itzg/minecraft-server derives both
    // bounds from one value, so there is no way for them to disagree and 1 GB is legal.
    makeBox({});
    const state = await settle(setMemory("minecraft", 1));
    expect(state.configuredGb).toBe(1);
    expect(parseEnvFile(envText).MC_MEMORY).toBe("1G");
  });

  it("refuses above the host cap, and changes nothing", async () => {
    // 16 GB host − 2.5 GB reserve → 13.
    makeBox({});
    await expect(settle(setMemory("minecraft", 14))).rejects.toSatisfy(isMemoryRangeError);
    await expect(settle(setMemory("minecraft", 14))).rejects.toThrow(/between 1 and 13 GB/);
    expect(mutations()).toEqual([]);
    expect(envText).toBe("");
  });

  it("refuses, and recreates nothing, when compose does not read the key it wrote", async () => {
    // The new failure mode `.env` introduces, and the reason the write is followed by a
    // read-back. If the compose line is a literal — hand-edited, or reverted — writing
    // `.env` succeeds, the container is recreated, and the setting silently does not
    // change. That is this project's documented recurring defect wearing a new hat.
    makeBox({});
    composeText = REAL_COMPOSE.replace(
      'MAX_MEMORY: "${PZ_MAX_MEMORY:-12288m}"',
      'MAX_MEMORY: "12288m"'
    );
    expect(composeText).not.toBe(REAL_COMPOSE);

    await expect(settle(setMemory("zomboid", 8))).rejects.toThrow(
      // `[\s\S]*` rather than the `s` flag: tsconfig targets below es2018, where
      // `/…/s` is a compile error.
      /still resolves to "12288m"[\s\S]*nothing was recreated/
    );
    expect(commands.some((c) => /docker compose/.test(c))).toBe(false);
  });

  it("refuses a duplicate container after the recreate rather than leaving the mess", async () => {
    // `assertSingleContainer` is the guard that a hand-built `docker run` produces a
    // container compose cannot adopt, and the next `docker compose up` then either errors
    // on the name or orphans it.
    makeBox({});
    box["yoshling-pz"].rows = ["abc|yoshling|zomboid", "def|yoshling|zomboid"];

    await expect(settle(setMemory("zomboid", 8))).rejects.toThrow(/now has 2 containers/);
  });

  it("refuses when the surviving container lost its compose labels", async () => {
    makeBox({});
    box["yoshling-pz"].rows = ["abc||"];
    await expect(settle(setMemory("zomboid", 8))).rejects.toThrow(/isn't managed by compose/);
  });
});

describe("the memory card's configured-vs-live report survives the move to .env", () => {
  it("reads the compose default when .env has no key at all", async () => {
    // Every box is in this state today: `/opt/yoshling/.env` contains none of the new
    // keys (read off production 2026-09-30). If this answered null the card would show
    // "unknown" for a setting that is in fact applied — the failure this whole
    // interpolation path exists to avoid.
    makeBox({ zomboid: "running" });
    envText = "";
    const state = await settle(getMemoryState("zomboid"));
    expect(state.supported).toBe(true);
    expect(state.configuredGb).toBe(12);
    expect(state.liveGb).toBe(12);
    expect(state.applied).toBe(true);
  });

  it("reads the .env override in preference to the default", async () => {
    makeBox({ zomboid: "running" });
    envText = "PZ_MAX_MEMORY=8192m\n";
    box["yoshling-pz"].env.MAX_MEMORY = "8192m";
    const state = await settle(getMemoryState("zomboid"));
    expect(state.configuredGb).toBe(8);
    expect(state.applied).toBe(true);
  });

  it("reports NOT applied when the container predates the .env change", async () => {
    // The actual point of the card. A container's env is fixed when it is created, so
    // writing `.env` and running `docker restart` looks like it worked and silently does
    // not — the trap the Minecraft memory setting fell into before this existed.
    makeBox({ zomboid: "running" });
    envText = "PZ_MAX_MEMORY=8192m\n";
    // Container still carries the old value.
    const state = await settle(getMemoryState("zomboid"));
    expect(state.configuredGb).toBe(8);
    expect(state.liveGb).toBe(12);
    expect(state.applied).toBe(false);
  });

  it("says 7 Days to Die has no memory setting rather than offering a dead control", async () => {
    makeBox({});
    const state = await settle(getMemoryState("7dtd"));
    expect(state.supported).toBe(false);
    expect(state.reason).toMatch(/native server/);
  });

  /**
   * The card builds its buttons from `minGb`…`maxGb`, so reporting the floor is what stops
   * it offering a value `setMemory` will refuse. It used to start at 1 unconditionally, and
   * pressing 1G for Project Zomboid wrote `-Xmx1024m` under `-Xms2048m`.
   *
   * A refusal and an un-offered option are not alternatives: the refusal is the safety net
   * for an API caller, and this is the fix for the person looking at the page.
   */
  it("reports the MIN_MEMORY floor, so the card cannot offer a heap that will be refused", async () => {
    makeBox({ zomboid: "running" });
    const state = await settle(getMemoryState("zomboid"));
    expect(state.minGb).toBe(2);
  });

  it("reports no floor for Minecraft, whose single MEMORY key sets both bounds", async () => {
    makeBox({ minecraft: "running" });
    const state = await settle(getMemoryState("minecraft"));
    expect(state.minGb).toBe(1);
  });
});

describe("applyServiceEnv routes Minecraft's version and loader through .env", () => {
  it("writes MC_TYPE and MC_VERSION, recreates, and leaves a stopped world stopped", async () => {
    makeBox({});

    await settle(
      applyServiceEnv(
        "minecraft",
        { TYPE: "VANILLA", VERSION: "1.21.4" },
        { stage: "Changing the Minecraft version" }
      )
    );

    expect(parseEnvFile(envText)).toMatchObject({ MC_TYPE: "VANILLA", MC_VERSION: "1.21.4" });
    expect(composeText).toBe(REAL_COMPOSE);
    expect(commands.some((c) => /create --force-recreate minecraft/.test(c))).toBe(true);
    expect(commands.some((c) => /docker compose .*\bup\b/.test(c))).toBe(false);
    expect(indexOfCommand(/^docker start yoshling-mc/)).toBe(-1);
    // Read back off the NEW container: writing the file proves nothing on its own.
    expect(box["yoshling-mc"].env).toMatchObject({ TYPE: "VANILLA", VERSION: "1.21.4" });
  });

  it("does not touch 7 Days to Die's VERSION, which means a Steam branch", async () => {
    makeBox({});
    await settle(
      applyServiceEnv("minecraft", { VERSION: "1.21.4" }, { stage: "Changing the version" })
    );
    const { readServiceEnv } = await import("@/lib/compose");
    expect(readServiceEnv(composeText, "sevendtd", "VERSION", parseEnvFile(envText))).toBe(
      "latest_experimental"
    );
  });

  it("refuses a key with no .env mapping instead of falling back to compose", async () => {
    // Falling back is exactly how the deploy collision would come back without anyone
    // changing a line of policy. 7 Days to Die has no UI-owned keys at all.
    makeBox({});
    await expect(
      settle(applyServiceEnv("7dtd", { START_MODE: "3" }, { stage: "Updating" }))
    ).rejects.toThrow(/no .env key in RUNTIME\["7dtd"\].envKeys/);
    expect(envText).toBe("");
    expect(composeText).toBe(REAL_COMPOSE);
    expect(commands.some((c) => /docker compose/.test(c))).toBe(false);
  });
});
