import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `/api/server/gamerules` — the GET's floor and the PUT's write verification.
 *
 * ## Why this file exists
 *
 * The route shipped with **no tests at all**, and an adversarial review found out what that
 * cost by mutating it: changing `if (after.value !== checked.value)` to `if (false)` — the
 * single comparison that makes a write verified rather than assumed — left the whole suite
 * green. With that line disabled the route answers `200 {success: true, value: <what you
 * asked for>}` for a write the server declined, which is this project's named defect class
 * ("reports success after doing nothing or the wrong thing") on the one path built to prevent
 * it. Every test here is written so that removing the thing it names turns it red.
 *
 * ## What is faked, and what is not
 *
 * Only the edges: the session, the RCON transport, the activity table and the file lane. The
 * route's own logic — which transport it picks for which command, the order of the four RCON
 * round trips, the floor, the status codes and the message text — is the subject, so none of
 * it is stubbed. `commands` records every command in order, tagged with the transport that
 * carried it, because "the discovery read went through the long transport" is itself one of
 * the two bugs fixed here and it is invisible to any assertion about the response body.
 */

// ── the fake server ──────────────────────────────────────────────────────────

/** Every RCON command the route issued, in order, tagged with the transport. */
let commands: { via: "short" | "long"; command: string }[] = [];
/** The live rule values, as the fake game holds them. */
let world: Record<string, string> = {};
/** Rules the fake build lists in `help gamerule`. Defaults to whatever `world` holds. */
let listed: string[] | null = null;
/** Set to override the `help gamerule` reply entirely (to fake a truncated or odd one). */
let listReplyOverride: string | null = null;
/** Rules the fake game refuses to change, to drive the read-back disagreement. */
let readOnlyRules = new Set<string>();
/** Queued failures, keyed by command prefix. */
let failures: { match: RegExp; error: Error }[] = [];
let activityRows: { action: string; details: string }[] = [];
let laneBusy = false;
let role = "ADMIN";
// Varied like `role`, because the two gates are independent and only one was asserted.
// A route can hold a correct `gameGate` call and nothing notices when it is removed.
let games = "minecraft,7dtd,zomboid";
// The frozen clock, but movable. It was `mockReturnValue`, which pinned `Date.now()` for
// the whole file — correct for keeping the 58-rule test off wall time, but it also made
// `Date.now() >= deadline` false in every test, so the entire READ_BUDGET_MS path was
// unexecuted and could be deleted with the suite green. `msPerQuery` lets one test buy
// simulated time per rule query without reintroducing a wall-clock dependency anywhere else.
let now = 1_760_000_000_000;
let msPerQuery = 0;

function helpReply(): string {
  if (listReplyOverride !== null) return listReplyOverride;
  const ids = listed ?? Object.keys(world);
  // Both spellings and no separator, exactly as the real server answers — see
  // `fixtures/mc-help-gamerule.txt` and the parser's header.
  return ids.map((id) => `/gamerule ${id} [<value>]/gamerule minecraft:${id} [<value>]`).join("");
}

function answer(command: string): string {
  for (const f of failures) if (f.match.test(command)) throw f.error;
  if (command === "help gamerule") return helpReply();
  const m = /^gamerule (\S+)(?: (\S+))?$/.exec(command);
  if (!m) return "Unknown or incomplete command, see below for error";
  const [, id, value] = m;
  // Simulated per-query latency, so one test can exhaust the route's read budget
  // deterministically. It lives HERE and not in the `vi.mock` factory above: vitest hoists
  // those factories, and the reference to `msPerQuery` inside one does not share this
  // module's binding — the increment ran against a different variable and the clock never
  // moved, while the test still read all 12 rules and looked like the budget branch was
  // simply unreachable. `answer` is an ordinary hoisted function declaration the factory
  // calls at runtime, so it sees the real bindings.
  now += msPerQuery;
  if (!(id in world)) return "Incorrect argument for command";
  if (value === undefined) return `Gamerule ${id} is currently set to: ${world[id]}`;
  // A rule the fake server declines: it accepts the command and does not change the value,
  // which is precisely the state the write verification exists to catch.
  if (!readOnlyRules.has(id)) world[id] = value;
  return `Gamerule ${id} is now set to: ${world[id]}`;
}

vi.mock("@/lib/rcon", () => ({
  sendCommand: vi.fn(async (command: string) => {
    commands.push({ via: "short", command });
    return answer(command);
  }),
  sendCommandLong: vi.fn(async (command: string) => {
    commands.push({ via: "long", command });
    return answer(command);
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "u1", name: "Tester", role, games },
  })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    activity: {
      create: vi.fn(async ({ data }: { data: { action: string; details: string } }) => {
        activityRows.push({ action: data.action, details: data.details });
        return data;
      }),
    },
  },
}));

vi.mock("@/lib/operation-response", async () => {
  const { NextResponse } = await import("next/server");
  return {
    fileLaneBusy: vi.fn(() =>
      laneBusy ? NextResponse.json({ error: "Busy" }, { status: 409 }) : null
    ),
  };
});

vi.mock("@/lib/game-manager", () => ({
  containerIsRunning: vi.fn(async () => true),
}));

const { GET, PUT } = await import("@/app/api/server/gamerules/route");

/** A build with enough rules to clear the plausibility floor, plus the ones tests name. */
function vanillaish(extra: Record<string, string> = {}) {
  const w: Record<string, string> = {
    pvp: "true",
    mob_griefing: "true",
    keep_inventory: "false",
    fall_damage: "true",
    fire_damage: "true",
    drowning_damage: "true",
    freeze_damage: "true",
    random_tick_speed: "3",
    max_entity_cramming: "24",
    spawn_monsters: "true",
    command_blocks_work: "true",
    universal_anger: "false",
  };
  return { ...w, ...extra };
}

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/server/gamerules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

beforeEach(() => {
  // A frozen clock, so nothing here depends on wall time. The GET gives itself
  // `READ_BUDGET_MS` (6 s) to query every rule and reports whatever it did not reach in
  // `unread` with a warning — correct behaviour, and a wall-clock dependency that makes the
  // 58-rule test flaky on a starved machine: 58 awaits that normally take microseconds can
  // outlive the budget under load, and the test then fails on a `warning` that is true.
  // Frozen rather than faked wholesale (`vi.useFakeTimers()` would also stall the awaits).
  now = 1_760_000_000_000;
  msPerQuery = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  commands = [];
  world = vanillaish();
  listed = null;
  listReplyOverride = null;
  readOnlyRules = new Set();
  failures = [];
  activityRows = [];
  laneBusy = false;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
});

afterEach(() => {
  // Only the clock. `vi.restoreAllMocks()` would also reset the `vi.fn()`s the module factories
  // above created, leaving `sendCommand` with no implementation for every later test.
  vi.mocked(Date.now).mockRestore?.();
});

// ── the write verification ───────────────────────────────────────────────────

/**
 * The property: this route never reports a value it was not told by a **fresh read after the
 * write**.
 *
 * The mutation that found this gap was `if (after.value !== checked.value)` → `if (false)`.
 * Each test below fails under exactly that mutation.
 */
describe("a write is verified by re-reading, not by the write's own reply", () => {
  it("reports the read-back and the previous value on a write that stuck", async () => {
    const res = await put({ rule: "mob_griefing", value: "false" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      rule: "mob_griefing",
      requested: "false",
      value: "false",
      previous: "true",
      changed: true,
    });
    // Query, write, query — the second query is the whole point, and a route that trusted the
    // write's echo would be one command shorter.
    expect(commands.map((c) => c.command)).toEqual([
      "help gamerule",
      "gamerule mob_griefing",
      "gamerule mob_griefing false",
      "gamerule mob_griefing",
    ]);
  });

  it("refuses with 502 when the server kept the old value, and never says success", async () => {
    // The mutation target. `readOnlyRules` is a server that accepts `gamerule pvp false`,
    // answers "is now set to: true", and leaves the rule alone — which is what a declined
    // write looks like from outside.
    readOnlyRules.add("pvp");
    const res = await put({ rule: "pvp", value: "false" });
    expect(res.status).toBe(502);
    const body = await res.json();
    // Not a 200 carrying `applied: false`: a caller that only checks `res.ok` must not be
    // able to read this as success.
    expect(body.success).toBeUndefined();
    expect(body.error).toContain("pvp is still true");
    expect(body.error).toContain("did not take false");
    // Both values, so the UI can snap the control back to the truth.
    expect(body.value).toBe("true");
    expect(body.requested).toBe("false");
  });

  it("writes no activity row for a write the server declined", async () => {
    // Otherwise the log says somebody set a rule that is still at its old value — the one
    // record of what was done to this box, asserting something that did not happen.
    readOnlyRules.add("pvp");
    await put({ rule: "pvp", value: "false" });
    expect(activityRows).toEqual([]);
  });

  it("502s rather than guessing when the follow-up query cannot be read", async () => {
    // A build whose reply wording changed. "Sent it, could not confirm" is a state
    // `docs/OPERATIONS.md` has a name for, and rounding it to success is what this avoids.
    world.mob_griefing = "true";
    let queries = 0;
    failures = [];
    const { sendCommand } = await import("@/lib/rcon");
    vi.mocked(sendCommand).mockImplementation(async (command: string) => {
      commands.push({ via: "short", command });
      if (command === "gamerule mob_griefing" && ++queries === 2) return "Some other reply";
      return answer(command);
    });
    const res = await put({ rule: "mob_griefing", value: "false" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toMatch(/unconfirmed/);
    vi.mocked(sendCommand).mockImplementation(async (command: string) => {
      commands.push({ via: "short", command });
      return answer(command);
    });
  });
});

// ── the activity row ─────────────────────────────────────────────────────────

describe("the activity log records changes, not presses", () => {
  it("logs a write that changed the value", async () => {
    await put({ rule: "mob_griefing", value: "false" });
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0].action).toBe("set_gamerule");
    expect(JSON.parse(activityRows[0].details)).toMatchObject({
      game: "minecraft",
      rule: "mob_griefing",
      value: "false",
      from: "true",
    });
  });

  it("logs nothing when the rule was already in that position", async () => {
    // The toggles are idempotent, so re-pressing one was writing history: a row reading
    // "set the game rule pvp to true" when pvp was already true. The response still reports
    // the write with `changed: false`; the log records changes.
    const res = await put({ rule: "pvp", value: "true" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, changed: false, value: "true" });
    expect(activityRows).toEqual([]);
  });

  it("still succeeds when the activity write throws", async () => {
    const { db } = await import("@/lib/db");
    vi.mocked(db.activity.create).mockRejectedValueOnce(new Error("db gone"));
    // The route logs the failure; silenced so the deliberate stack trace does not look like a
    // broken suite in `npm test`'s output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await put({ rule: "mob_griefing", value: "false" });
    // The rule is set; failing the response would invite a retry that changes nothing.
    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

// ── the list read: transport, and the floor ──────────────────────────────────

/**
 * The 4096-byte cliff, from the route's side.
 *
 * `help gamerule` is 5,082 bytes on 26.1.2 and `rcon-client` resolves on the first packet, so
 * a discovery read on the cached socket silently loses a third of the reply. The assertion is
 * on the transport rather than on the response, because a truncated list still produces a
 * plausible-looking 200.
 */
describe("which transport carries which command", () => {
  it("reads the rule list through the long transport, and queries through the short one", async () => {
    await GET();
    const list = commands.filter((c) => c.command === "help gamerule");
    expect(list).toHaveLength(1);
    expect(list[0].via).toBe("long");
    // Every per-rule query stays on the cached socket: ~58 round trips on one connection.
    for (const c of commands.filter((c) => c.command !== "help gamerule")) {
      expect(c.via, c.command).toBe("short");
    }
  });

  it("reads the list through the long transport on the write path too", async () => {
    await put({ rule: "pvp", value: "false" });
    expect(commands.find((c) => c.command === "help gamerule")?.via).toBe("long");
  });
});

describe("a list the route could not read is reported, not rendered", () => {
  const FIXTURE = readFileSync(
    path.join(__dirname, "fixtures", "mc-help-gamerule.txt"),
    "utf-8"
  );

  it("renders the real 58-rule reply", async () => {
    // The whole fixture, parsed and queried end to end. `world` has to hold all 58 or they
    // land in `unread`.
    const ids = FIXTURE.split("/gamerule ")
      .slice(1)
      .map((p) => p.split(" ")[0].replace("minecraft:", ""));
    world = Object.fromEntries([...new Set(ids)].map((id) => [id, "true"]));
    listReplyOverride = FIXTURE;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toHaveLength(58);
    expect(body.discovered).toBe(58);
    expect(body.unread).toEqual([]);
    expect(body.warning).toBeUndefined();
  });

  it("502s on a one-rule read instead of answering 200 with one rule", async () => {
    // Exactly what shipped: the parser read one id out of the 58-rule reply and the route
    // presented it as the build's rule list, 200, no warning. The floor is what makes that
    // impossible, and the message names what was read rather than a cause.
    listReplyOverride = "/gamerule immediate_respawn [<value>]";
    world = { immediate_respawn: "false" };
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.rules).toBeUndefined();
    expect(body.error).toContain("Read 1 game rule");
    expect(body.error).toMatch(/mentions "gamerule" 1 time/);
    expect(body.error).not.toMatch(/renamed|has no game rules/i);
  });

  it("warns when the reply arrived exactly one packet long", async () => {
    // Still ~46 rules, so the floor passes — the warning is the only thing standing between
    // a truncated list and a panel that looks complete.
    const cut = FIXTURE.slice(0, 4096);
    const ids = cut
      .split("/gamerule ")
      .slice(1)
      .map((p) => p.split(" ")[0].replace("minecraft:", ""))
      .filter((id) => /^[A-Za-z][A-Za-z0-9_]*$/.test(id));
    world = Object.fromEntries([...new Set(ids)].map((id) => [id, "true"]));
    listReplyOverride = cut;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toContain("4096");
    expect(body.warning).toMatch(/cut off/);
  });
});

// ── the PUT's refusal message ────────────────────────────────────────────────

describe("the PUT refuses without naming a cause it has not established", () => {
  it("will not call a rule unknown on the strength of a list it could not read", async () => {
    // The reviewer's finding: a one-rule list read made the route answer 400 "This Minecraft
    // build has no game rule called fall_damage. Reload the page — 26.1 renamed the rules",
    // for a rule the server had just listed 116 times. The list is the only evidence for
    // "no such rule", so an unreadable list cannot support that conclusion.
    listReplyOverride = "/gamerule immediate_respawn [<value>]";
    const res = await put({ rule: "fall_damage", value: "false" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Nothing was written");
    expect(body.error).toContain("Read 1 game rule");
    expect(body.error).not.toMatch(/renamed/i);
    // And nothing was sent: the list read is the only command that ran.
    expect(commands.map((c) => c.command)).toEqual(["help gamerule"]);
  });

  it("400s for a rule a readable list really does not contain, stating only that", async () => {
    const res = await put({ rule: "keepInventory", value: "true" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("keepInventory is not one of the 12 game rules");
    // No invented cause. 26.1's rename, a typo and an unloaded datapack all produce this.
    expect(body.error).not.toMatch(/renamed|26\.1|Reload the page/i);
    expect(commands.map((c) => c.command)).toEqual(["help gamerule"]);
  });

  it("never interpolates an id the server did not list", async () => {
    // The injection guard, from the route's side: the shape that would turn one command into
    // two has to be refused before `gameRuleCommand` sees it.
    const res = await put({ rule: "pvp false\nop mallory", value: "true" });
    expect(res.status).toBe(400);
    expect(commands.map((c) => c.command)).toEqual(["help gamerule"]);
  });

  it("refuses a value of the wrong kind before sending anything", async () => {
    const res = await put({ rule: "random_tick_speed", value: "3.5" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ value: "3" });
    expect(commands.map((c) => c.command)).toEqual([
      "help gamerule",
      "gamerule random_tick_speed",
    ]);
  });
});

/**
 * The shortfall paths. Both of these drop a rule out of the list, and the only thing
 * separating "a short list that says it is short" from the defect this feature was rebuilt
 * to fix is that they push onto `unread` and set a `warning`. Deleting either `unread.push`
 * left the whole suite green, because the frozen clock meant the budget branch never ran and
 * no fixture had more than 200 rules — so the panel could silently render a complete-looking
 * list that was missing rows, which is exactly the shape of the original blocker.
 */
describe("a short read says it is short", () => {
  it("names the rules it ran out of time for, and warns", async () => {
    // The default fake build lists 12 rules. At 400 simulated ms each against a 4 s budget
    // it gets through ten and names the last two, rather than quietly returning ten.
    msPerQuery = 400;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.unread.length).toBeGreaterThan(0);
    expect(body.rules.length).toBeGreaterThan(0);
    // Nothing is lost: every discovered rule is either read or named as unread.
    expect(body.rules.length + body.unread.length).toBe(body.discovered);
    expect(body.warning).toMatch(/ran out of time/i);
    // The warning states the real figures rather than a round number.
    expect(body.warning).toContain(String(body.rules.length));
  });

  it("reads everything and warns about nothing when the server is prompt", async () => {
    msPerQuery = 0;
    const body = await (await GET()).json();
    expect(body.unread).toEqual([]);
    // Omitted, not null: the route spreads `...(warning ? { warning } : {})`, so "nothing to
    // say" is the absence of the key. Asserting `toBeNull()` here passed for the wrong
    // reason on a body that had no `warning` at all.
    expect(body.warning).toBeUndefined();
    expect(body.rules.length).toBe(body.discovered);
  });
});

// ── the gates ────────────────────────────────────────────────────────────────

describe("who may read and who may write", () => {
  it("lets a MEMBER read, like the properties editor directly above it", async () => {
    // This GET used to require `settings.read`, so on `/minecraft/settings` a MEMBER saw
    // every panel render and this one alone show a red error box. The neighbouring
    // properties GET is gated on world access only; this follows it.
    role = "MEMBER";
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ discovered: 12 });
  });

  it("still refuses a MEMBER's write", async () => {
    role = "MEMBER";
    const res = await put({ rule: "pvp", value: "false" });
    expect(res.status).toBe(403);
    expect(commands).toEqual([]);
  });

  /**
   * World access, which is a different axis from role and was the untested one. The route
   * calls `gameGate("minecraft")` on both verbs, correctly — but every test above ran with
   * `games: "minecraft,7dtd,zomboid"` and varied only `role`, so the gate could have been
   * deleted outright with the suite green. A MOD with only Project Zomboid has full
   * capability *on Zomboid*; the whole point of `User.games` is that it must not reach
   * Minecraft's running world.
   */
  it("refuses a MOD who has not been granted Minecraft, on both verbs", async () => {
    role = "MOD";
    games = "zomboid";

    const read = await GET();
    expect(read.status).toBe(403);

    const write = await put({ rule: "pvp", value: "false" });
    expect(write.status).toBe(403);

    // And nothing reached the game. A 403 that still sent the command would be the gate
    // failing after the fact.
    expect(commands).toEqual([]);
  });

  it("lets a MOD who HAS Minecraft through, so the refusal above is about access", async () => {
    role = "MOD";
    games = "minecraft";
    expect((await GET()).status).toBe(200);
    expect((await put({ rule: "pvp", value: "false" })).status).toBe(200);
  });

  it("refuses a write while an operation holds the file lane", async () => {
    laneBusy = true;
    const res = await put({ rule: "pvp", value: "false" });
    expect(res.status).toBe(409);
    expect(commands).toEqual([]);
  });
});

// ── the failure sentences ────────────────────────────────────────────────────

describe("an RCON failure is classified, not guessed at", () => {
  it("does not tell someone to press Power on while the container is running", async () => {
    // `rcon-failure.ts`'s whole reason to exist: `docker start` on a running container is a
    // no-op that toasts success, so "Start it, then try again" is a dead end. The fake
    // `containerIsRunning` answers true.
    failures = [{ match: /^help gamerule$/, error: new Error("timeout") }];
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/did not answer in time/);
    expect(body.error).not.toMatch(/Start it/);
  });

  it("reads a socket-level ETIMEDOUT as nothing answering, not as a quiet game", async () => {
    // The subtlety `rcon-failure.ts` pins and the deleted `rcon-reachability.ts` had
    // backwards: as a socket `code`, ETIMEDOUT is the kernel giving up on the handshake.
    const { containerIsRunning } = await import("@/lib/game-manager");
    vi.mocked(containerIsRunning).mockResolvedValueOnce(false);
    const e = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    failures = [{ match: /^help gamerule$/, error: e }];
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("isn't running"),
    });
  });

  it("passes a game error through with its own message", async () => {
    failures = [{ match: /^help gamerule$/, error: new Error("Unknown command") }];
    const res = await GET();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unknown command"),
    });
  });
});

// ── the per-rule read ────────────────────────────────────────────────────────

describe("a rule the server lists but will not answer about", () => {
  it("is named in unread rather than given a value", async () => {
    // `Incorrect argument for command` is what a listed-but-absent rule answers. A fabricated
    // value here would render a switch in a position the world is not in.
    listed = [...Object.keys(world), "ghost_rule"];
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unread).toEqual(["ghost_rule"]);
    expect(body.rules.map((r: { id: string }) => r.id)).not.toContain("ghost_rule");
    expect(body.discovered).toBe(13);
  });

  it("502s when every single rule is unreadable, rather than 200 with an empty list", async () => {
    listed = Array.from({ length: 15 }, (_, i) => `ghost_${i}`);
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.rules).toBeUndefined();
    expect(body.error).toContain("wouldn't report a value");
  });
});
