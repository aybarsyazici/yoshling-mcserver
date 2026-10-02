import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `rcon.ts` — **that a declared `timeoutMs` is the deadline that actually fires.**
 *
 * ## The defect
 *
 * `rcon-client` keeps its own per-packet deadline in `config.timeout`, default **2000 ms**,
 * read from an object that is fixed when the socket is opened. It rejects the `send` itself
 * when that fires. `rcon.ts` also wraps every send in `withTimeout(…, timeoutMs)` — so
 * whichever is shorter wins, and since nothing was passing the caller's budget down to
 * `Rcon.connect`, the answer was always 2000 ms. Two callers declared a generosity they were
 * never getting:
 *
 *   - `FLUSH_RCON_TIMEOUT_MS = 120_000` in `backup-create.ts`, for `save-all flush` on a
 *     217 MB world. Its own comment explains that a 3 s budget "would put the everyday path
 *     down the failure branch and stamp a warn fact on every backup" — which is what 2 s was
 *     doing.
 *   - `BAN_RCON_TIMEOUT_MS = 5000` in the bans route, for a `ban` that may do a Mojang
 *     profile lookup on the server thread.
 *
 * A parameter accepted and ignored is the defect class `CLAUDE.md` names: it reports a thing
 * it is not doing, and the only visible symptom is an occasional unexplained failure.
 *
 * ## Why this file mocks `rcon-client`
 *
 * The property is "which of two competing deadlines fires first", so the test needs a server
 * that answers *slowly* — something no real socket in a unit suite may provide
 * (`vitest.config.mts`: nothing here may touch the network). The fake below is `rcon-client`'s
 * own timeout contract and nothing else: a default of 2000 ms, overridable per connect,
 * enforced on each `send`. If that contract ever changes in the real package these tests stop
 * meaning anything, which is why the number is quoted from `lib/rcon.js` in a comment at the
 * fake rather than left as a bare literal.
 *
 * Delays are real and tiny (tens of ms) rather than faked, because `withTimeout` and the
 * fake's own timer have to race for the test to be about anything.
 */

interface FakeConfig {
  host: string;
  port: number;
  password: string;
  timeout?: number;
}

/** How long the fake server takes to answer each command, by command string. */
let replyDelay = new Map<string, number>();
/** Every `Rcon.connect` config, in order — the subject of most assertions here. */
let connects: FakeConfig[] = [];
let ended: number[] = [];

class FakeRcon {
  /** `defaultOptions.timeout` in `rcon-client/lib/rcon.js` is 2000. */
  static DEFAULT_TIMEOUT = 2000;

  config: Required<Pick<FakeConfig, "timeout">> & FakeConfig;
  authenticated = true;
  private handlers = new Map<string, (() => void)[]>();
  private readonly index: number;

  constructor(config: FakeConfig) {
    this.config = { timeout: FakeRcon.DEFAULT_TIMEOUT, ...config };
    this.index = connects.length;
    connects.push(this.config);
  }

  static async connect(config: FakeConfig): Promise<FakeRcon> {
    return new FakeRcon(config);
  }

  on(event: string, fn: () => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }

  /**
   * The real `sendPacket`: start a timer for `config.timeout`, resolve if the reply lands
   * first, reject with `Timeout for packet id N` if it does not.
   */
  send(command: string): Promise<string> {
    const delay = replyDelay.get(command) ?? 0;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout for packet id 0`)), this.config.timeout);
      setTimeout(() => {
        clearTimeout(timer);
        resolve(`reply to ${command}`);
      }, delay);
    });
  }

  async end(): Promise<void> {
    ended.push(this.index);
    this.authenticated = false;
  }
}

vi.mock("rcon-client", () => ({ Rcon: FakeRcon }));

// `rcon.ts` imports `rcon-long` for `sendCommandLong`, which opens a real socket. Nothing
// here calls it, but the import must not drag `node:net` into a test that has no server.
vi.mock("@/lib/rcon-long", () => ({
  rconCommandLong: async () => {
    throw new Error("rconCommandLong is not under test here");
  },
}));

const TARGET = { host: "minecraft", port: 25575, password: "pw" };

let rconCommand: typeof import("../rcon").rconCommand;

beforeEach(async () => {
  replyDelay = new Map();
  connects = [];
  ended = [];
  // Fresh module per test: the socket cache is module-level state and these tests are
  // entirely about what it decides to reuse.
  vi.resetModules();
  ({ rconCommand } = await import("../rcon"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the caller's timeout is the one that governs", () => {
  /**
   * The regression. A reply that takes 60 ms must survive a 400 ms budget — and before the
   * fix it did not, because the socket was opened with `rcon-client`'s 2000 ms default and
   * nothing told it otherwise. With the fake's default lowered to a value *below* the
   * caller's budget, "the connect was not told the budget" and "the budget was ignored"
   * become the same observable failure.
   */
  it("passes the budget to the connect, so rcon-client cannot cut the reply short", async () => {
    FakeRcon.DEFAULT_TIMEOUT = 30;
    try {
      replyDelay.set("banlist players", 60);
      await expect(rconCommand(TARGET, "banlist players", 400)).resolves.toBe(
        "reply to banlist players"
      );
      expect(connects).toHaveLength(1);
      expect(connects[0].timeout).toBe(400);
    } finally {
      FakeRcon.DEFAULT_TIMEOUT = 2000;
    }
  });

  /** The budget is still an upper bound: a reply slower than it must fail, not hang. */
  it("still fails a reply slower than the budget", async () => {
    replyDelay.set("slow", 200);
    await expect(rconCommand(TARGET, "slow", 40)).rejects.toThrow();
  });

  it("uses its own 3 s default when the caller names no budget", async () => {
    await rconCommand(TARGET, "list");
    expect(connects[0].timeout).toBe(3000);
  });
});

describe("the cached socket carries the budget it was opened with", () => {
  /**
   * The half of the fix that is easy to leave out, and it is load-bearing: `config.timeout`
   * is fixed at connect, so a socket opened for a 3 s status poll **cannot** be stretched to
   * serve a 120 s world flush. Reusing it would silently cap the flush at 3 s — the original
   * bug, one layer in, and reachable in production because the status probe polls every few
   * seconds and is therefore almost always the connection a backup inherits.
   */
  it("reconnects rather than serve a longer budget from a shorter-fused socket", async () => {
    await rconCommand(TARGET, "list", 100);
    expect(connects).toHaveLength(1);

    replyDelay.set("save-all flush", 250);
    await expect(rconCommand(TARGET, "save-all flush", 600)).resolves.toBeTruthy();

    expect(connects).toHaveLength(2);
    expect(connects[1].timeout).toBe(600);
    // The short-fused one was closed, not leaked.
    expect(ended).toEqual([0]);
  });

  /** The other direction reuses, because `withTimeout` can always enforce a shorter budget. */
  it("reuses a longer-fused socket for a shorter budget", async () => {
    await rconCommand(TARGET, "save-all flush", 600);
    await rconCommand(TARGET, "list", 100);
    expect(connects).toHaveLength(1);
  });

  it("reuses the socket for an identical budget", async () => {
    await rconCommand(TARGET, "list", 100);
    await rconCommand(TARGET, "list", 100);
    expect(connects).toHaveLength(1);
  });

  /**
   * Pre-existing behaviour worth keeping pinned: a failed command drops the cached socket, so
   * one that died without emitting "end" — what a `docker stop` on the game container looks
   * like — cannot make every later call time out.
   */
  it("drops the cached socket after a failure", async () => {
    replyDelay.set("slow", 200);
    await expect(rconCommand(TARGET, "slow", 40)).rejects.toThrow();
    await rconCommand(TARGET, "list", 40);
    expect(connects).toHaveLength(2);
  });
});
