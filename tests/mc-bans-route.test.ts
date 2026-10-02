import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/server/bans` — the route, with the server and the two json files faked.
 *
 * ## Why the route and not just the module
 *
 * `src/lib/__tests__/mc-bans.test.ts` pins the parsing, the routing decision and the
 * wording. None of that proves the route *uses* any of it, and `docs/OPERATIONS.md` records
 * the measured version of this lesson: a shared helper existing is not evidence that a
 * caller calls it, and three copies of the power control that did not call one are what
 * shipped a "Power on" button for an already-running container. The four properties below
 * are route-level by nature:
 *
 *  1. **`banlist` goes over `sendCommandLong`.** One RCON packet carries 4096 bytes; the
 *     cached-socket client resolves on the first and discards the rest. A `banlist` line is
 *     a name, a source and a free-text reason, so a few dozen bans clears that cliff — and
 *     the truncation lands on the read-back that decides whether a ban is reported as
 *     applied, so a real ban reads as absent and the UI says it did not take.
 *  2. **A ban is not confirmed by the command's own reply.** The reply picks the wording;
 *     the read-back decides the outcome, and anything unconfirmed answers non-2xx.
 *  3. **A pre-existing malformed entry does not block an edit**, and the error a bad entry
 *     does produce names the right player.
 *  4. **The 503 for "answered, then went quiet" claims only what is established.**
 *
 * ## The fakes
 *
 * Everything that reaches outside the process is mocked at the module boundary: the session,
 * the world gate, the operation lane, docker, RCON, Mojang, and `fs/promises`. The two ban
 * files live in a plain object so a test can start from a hand-edited one.
 */

// ── the fake box ─────────────────────────────────────────────────────────────

/** Path → contents. A missing key is ENOENT, which the route reads as "nothing banned yet". */
let files: Record<string, string> = {};
/** Every RCON command, with the transport it went over — the subject of the first property. */
let sent: { command: string; via: "short" | "long"; timeoutMs?: number }[] = [];
/** What the fake server answers, by command prefix. */
let replies: { match: RegExp; reply: string | (() => string | never) }[] = [];
let containerRunning = true;
let activityRows: { action: string; details: string }[] = [];

function answer(command: string): string {
  for (const r of replies) {
    if (r.match.test(command)) return typeof r.reply === "function" ? r.reply() : r.reply;
  }
  throw new Error(`no scripted reply for ${command}`);
}

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "u1", name: "Ayb", role: "ADMIN" } }),
}));
vi.mock("@/lib/game-gate", () => ({ denyGame: () => null }));
vi.mock("@/lib/operation-response", () => ({ fileLaneBusy: () => null }));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/game-manager", () => ({ containerIsRunning: async () => containerRunning }));
vi.mock("@/lib/db", () => ({
  db: {
    activity: {
      create: async ({ data }: { data: { action: string; details: string } }) => {
        activityRows.push({ action: data.action, details: data.details });
      },
    },
  },
}));
vi.mock("@/lib/rcon", () => ({
  sendCommand: async (command: string, timeoutMs?: number) => {
    sent.push({ command, via: "short", timeoutMs });
    return answer(command);
  },
  sendCommandLong: async (command: string, timeoutMs?: number) => {
    sent.push({ command, via: "long", timeoutMs });
    return answer(command);
  },
}));
/**
 * Offline UUID derivation is the real thing — `offlineUuid` is pure — but `resolveEntryUuids`
 * reads `server.properties` and can reach Mojang, so it is faked to the offline-mode branch,
 * which is what this server runs.
 */
vi.mock("@/lib/mc-identity", async () => {
  const real = await vi.importActual<typeof import("@/lib/mc-identity")>("@/lib/mc-identity");
  return {
    ...real,
    resolveEntryUuids: async (entries: { uuid: string; name: string }[]) => ({
      ok: true as const,
      entries: entries.map((e) => ({ ...e, uuid: real.offlineUuid(e.name) })),
    }),
  };
});
vi.mock("fs/promises", () => ({
  readFile: async (file: string) => {
    const got = files[file];
    if (got === undefined) {
      const e = new Error(`ENOENT: ${file}`) as Error & { code: string };
      e.code = "ENOENT";
      throw e;
    }
    return got;
  },
  writeFile: async (file: string, data: string) => {
    files[file] = data;
  },
}));

const PLAYERS_FILE = "/minecraft/banned-players.json";
const IPS_FILE = "/minecraft/banned-ips.json";

type Route = typeof import("@/app/api/server/bans/route");
let route: Route;

beforeEach(async () => {
  files = {};
  sent = [];
  replies = [];
  containerRunning = true;
  activityRows = [];
  vi.resetModules();
  route = await import("@/app/api/server/bans/route");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: unknown): Promise<Response> {
  return route.POST({ json: async () => body } as never) as unknown as Promise<Response>;
}

function del(kind: string, target: string): Promise<Response> {
  return route.DELETE({
    url: `http://x/api/server/bans?kind=${kind}&target=${encodeURIComponent(target)}`,
  } as never) as unknown as Promise<Response>;
}

/** A `banlist players` reply listing exactly these names. */
function banlistOf(names: string[]): string {
  if (names.length === 0) return "There are no bans";
  return (
    `There are ${names.length} ban(s):\n` +
    names.map((n) => `${n} was banned by Rcon: Griefing`).join("\n")
  );
}

// ── 1. the 4096-byte cliff ───────────────────────────────────────────────────

describe("banlist goes over the multi-packet transport", () => {
  /**
   * The direction that matters. `rcon-client` resolves on the first 4096-byte packet, so a
   * long `banlist` comes back cut mid-entry: the header still says "There are 40 ban(s):"
   * while only some of the lines arrived. Both possible readings of that are wrong in the
   * worst available way — if the entries were published, the ban just applied looks absent
   * and the route reports a success as a failure; and a *pardon* read back against a
   * truncated list looks confirmed when the target is still banned.
   *
   * Asserting the transport rather than simulating the truncation is deliberate: the
   * truncation lives inside `rcon-client`, and `src/lib/__tests__/rcon-frame.test.ts` already
   * pins the framing. What was missing is that this route reaches for the right one.
   */
  it("reads the ban list with sendCommandLong, never the cached short socket", async () => {
    replies = [{ match: /^banlist/, reply: banlistOf(["Notch"]) }];
    await route.GET();

    const banlists = sent.filter((s) => s.command.startsWith("banlist"));
    expect(banlists).toHaveLength(2);
    for (const b of banlists) expect(b.via).toBe("long");
    // And with a stated budget, not the 9 s default of a page-load-time read.
    for (const b of banlists) expect(b.timeoutMs).toBeGreaterThan(0);
  });

  it("also uses it for the read-back after a ban, which is what decides the outcome", async () => {
    replies = [
      { match: /^ban Notch/, reply: "Banned Notch: Griefing" },
      { match: /^banlist players/, reply: banlistOf(["Notch"]) },
      { match: /^banlist ips/, reply: "There are no bans" },
    ];
    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(200);

    // The probe, then the command, then the read-back.
    expect(sent.map((s) => `${s.via}:${s.command.split(" ")[0]}`)).toEqual([
      "long:banlist",
      "short:ban",
      "long:banlist",
    ]);
  });

  /** A long reply has to survive whole, which is the same statement from the other side. */
  it("confirms a ban that sits beyond the first 4096 bytes of the reply", async () => {
    const many = [...Array(120).keys()].map((i) => `Player${i}`);
    const reply = banlistOf([...many, "Notch"]);
    expect(reply.length).toBeGreaterThan(4096);
    replies = [
      { match: /^ban Notch/, reply: "Banned Notch: Griefing" },
      { match: /^banlist/, reply },
    ];
    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true, success: true });
  });
});

// ── 2. the reply does not decide the outcome ──────────────────────────────────

describe("the read-back outranks the reply", () => {
  it("answers 500 when the server says Banned and its list disagrees", async () => {
    replies = [
      { match: /^ban Notch/, reply: "Banned Notch: Griefing" },
      { match: /^banlist/, reply: "There are no bans" },
    ];
    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.verified).toBe(false);
    expect(body.contradicted).toBe(true);
    expect(body.error).toMatch(/did not take effect/);
    // Nothing that did not happen gets logged.
    expect(activityRows).toEqual([]);
  });

  /**
   * An unreadable read-back is "not confirmed", in **both** directions. The pardon direction
   * is the dangerous one: absence is only evidence if the reply could be read, and an
   * unrecognised reply contains no names at all.
   */
  it("answers 500 for a pardon whose read-back could not be parsed", async () => {
    files[PLAYERS_FILE] = "[]";
    replies = [
      { match: /^pardon/, reply: "Unbanned Notch" },
      { match: /^banlist/, reply: "Es gibt keine Sperren" },
    ];
    const res = await post({ kind: "player", target: "Notch" }).then(() => del("player", "Notch"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/couldn't be read back|not confirmed/);
  });

  /**
   * And the poisoning, end to end through the route: a ban that the server refused, with a
   * read-back whose only entry carries a reason naming the target. The raw-substring version
   * of the read-back answered "banned", so this answered 200, logged the ban and toasted
   * green for a player who could still connect.
   */
  it("is not talked into confirming a ban by a reason naming the target", async () => {
    replies = [
      { match: /^ban Bob/, reply: "Banned Bob: evading" },
      {
        match: /^banlist players/,
        reply: "There are 1 ban(s):\nAlice was banned by Rcon: Bob was banned by me: spam",
      },
      { match: /^banlist ips/, reply: "There are no bans" },
    ];
    const res = await post({ kind: "player", target: "Bob" });
    expect(res.status).toBe(500);
    expect((await res.json()).verified).toBe(false);
    expect(activityRows).toEqual([]);
  });
});

// ── 3. a pre-existing bad entry must not lock the list ────────────────────────

describe("the file path and an entry the dashboard dislikes", () => {
  /** Server down and silent, so `routeBanChange` takes the file path. */
  function serverDown() {
    containerRunning = false;
    replies = [
      {
        match: /^banlist/,
        reply: () => {
          const e = new Error("ENOTFOUND minecraft") as Error & { code: string };
          e.code = "ENOTFOUND";
          throw e;
        },
      },
    ];
  }

  /**
   * The state is the expected one for an older install, not a contrived one: this repo's own
   * whitelist and ops writers shipped `uuid: ""` for months, so a `banned-players.json`
   * carrying a blank-uuid entry is what history leaves behind. Validating every entry on
   * write turned that into a refusal of every file-path edit — including the pardon that
   * would have removed it.
   */
  const legacy = {
    uuid: "",
    name: "Herobrine",
    created: "2020-01-01 00:00:00 +0000",
    source: "console",
    expires: "forever",
    reason: "old",
  };

  it("bans somebody while a blank-uuid entry sits in the file, and keeps that entry", async () => {
    serverDown();
    files[PLAYERS_FILE] = JSON.stringify([legacy]);

    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true, path: "file" });

    const written = JSON.parse(files[PLAYERS_FILE]);
    expect(written).toHaveLength(2);
    // Carried through unchanged — it is already on disk, and dropping it silently would be
    // this route deleting a ban record it merely disapproves of.
    expect(written[0]).toEqual(legacy);
    expect(written[1].name).toBe("Notch");
    expect(written[1].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  /**
   * Two bad entries, one pardoned. The surviving one is what makes this bite: with the whole
   * list validated, the write that removes the first is refused by the second, so the list is
   * un-editable until somebody opens a shell on the box. (A single-entry version of this test
   * proves nothing — removing the only bad entry leaves `[]`, which validates either way.)
   */
  it("lets a pardon through while another bad entry remains in the list", async () => {
    serverDown();
    const other = { ...legacy, name: "Steve", uuid: "nope" };
    files[PLAYERS_FILE] = JSON.stringify([legacy, other]);

    const res = await del("player", "Herobrine");
    expect(res.status).toBe(200);
    expect(JSON.parse(files[PLAYERS_FILE])).toEqual([other]);
  });

  /**
   * The backstop is still there — and the sentence names the player the request was about.
   * Before the fix the 500 named whichever entry the loop reached first, so a request about
   * "Notch" came back talking about "Herobrine": an error that points at the wrong player
   * and at a write nobody asked for.
   */
  it("still refuses, naming the right player, when the added entry has no uuid", async () => {
    serverDown();
    files[PLAYERS_FILE] = JSON.stringify([legacy]);
    const identity = await import("@/lib/mc-identity");
    vi.spyOn(identity, "resolveEntryUuids").mockResolvedValue({
      ok: true,
      entries: [{ uuid: "", name: "Notch" } as never],
    });

    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Notch");
    expect(body.error).not.toContain("Herobrine");
    // And nothing was written.
    expect(JSON.parse(files[PLAYERS_FILE])).toEqual([legacy]);
  });

  /** An unparseable file is still refused rather than rebuilt — that one blocks for real. */
  it("refuses with 409 when the file it must edit is not JSON", async () => {
    serverDown();
    files[PLAYERS_FILE] = "{ this is not a list";
    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(409);
    expect(files[PLAYERS_FILE]).toBe("{ this is not a list");
  });

  /**
   * ...and only for the kind that has to go through it. A broken `banned-players.json` says
   * nothing about whether an address can be banned, and the two files fail independently.
   */
  it("still bans an address while banned-players.json is unparseable", async () => {
    serverDown();
    files[PLAYERS_FILE] = "{ this is not a list";
    const res = await post({ kind: "ip", target: "203.0.113.4" });
    expect(res.status).toBe(200);
    expect(JSON.parse(files[IPS_FILE])[0].ip).toBe("203.0.113.4");
  });
});

// ── 4. what the 503 may claim ────────────────────────────────────────────────

describe("the server answered, then went quiet", () => {
  beforeEach(() => {
    replies = [
      { match: /^banlist/, reply: banlistOf([]) },
      {
        match: /^ban /,
        reply: () => {
          throw new Error("timeout");
        },
      },
    ];
  });

  /**
   * The false claim this test exists to keep out. The first version of this body asserted
   * both "the ban was not applied" and "Nothing was written to the ban files", and **neither
   * is established**: the command was written to a socket the probe had just proved live, so
   * the server may well have executed it — and on this path a server that executed it has
   * already rewritten `banned-players.json` itself. So the one sentence that was meant to be
   * reassuring was false in precisely the case that matters.
   */
  it("does not claim the ban was not applied, or that nothing was written", async () => {
    const res = await post({ kind: "player", target: "Notch" });
    expect(res.status).toBe(503);
    const { error } = await res.json();

    expect(error).not.toMatch(/was not applied/i);
    expect(error).not.toMatch(/[Nn]othing was written/);
    // What it says instead: the outcome is unknown, and here is how to find out.
    expect(error).toMatch(/unknown/i);
    expect(error).toMatch(/reload/i);
  });

  /**
   * And it reads the failure with `classifyRconFailure` rather than one regex, so a timeout
   * *after* a successful handshake is not described as a server that is powered off. A bare
   * `"timeout"` is what `rcon.ts` raises for exactly that, and the container is up here.
   */
  it("describes a wedged server as busy rather than telling anyone to start it", async () => {
    const { error } = await post({ kind: "player", target: "Notch" }).then((r) => r.json());
    // The dead end this project already fixed once for the power controls: `docker start` on
    // an already-running container is a no-op that toasts success, so "Start it, then try
    // again" is advice that leads nowhere. `rconFailureMessage` takes `containerRunning` for
    // exactly this, and the container is up here.
    expect(error).not.toMatch(/Start it, then try again/i);
    expect(error).not.toMatch(/isn't running/i);
    expect(error).toMatch(/busy or wedged/i);
  });

  it("writes no file on that path, whatever it says about the server's own", async () => {
    await post({ kind: "player", target: "Notch" });
    expect(files[PLAYERS_FILE]).toBeUndefined();
    expect(activityRows).toEqual([]);
  });
});

// ── 5. what the GET reports ──────────────────────────────────────────────────

describe("GET reports what was compared, not what it assumed", () => {
  it("sends a per-list read state and a drift pair", async () => {
    files[PLAYERS_FILE] = JSON.stringify([
      { uuid: "u", name: "Notch", created: "", source: "", expires: "forever", reason: "" },
    ]);
    replies = [
      { match: /^banlist players/, reply: banlistOf(["Notch"]) },
      { match: /^banlist ips/, reply: "There are no bans" },
    ];
    const body = await route.GET().then((r) => r.json());

    expect(body.live).toEqual({ players: "read", ips: "read" });
    expect(body.drift.players).toEqual({ notEnforced: [], extraLive: 0 });
    expect(body.path).toBe("rcon");
  });

  /**
   * The inversion that the `recognised` flag was declared for and never used to prevent: an
   * unreadable reply arrived here as "the server is enforcing nothing", so every ban on disk
   * was reported as not enforced. A wall of warnings generated by the page's own inability to
   * read a reply is worse than no comparison, because the reader goes looking for a fault in
   * the server.
   */
  it("reports an unreadable reply as unreadable, not as an empty ban list", async () => {
    files[PLAYERS_FILE] = JSON.stringify([
      { uuid: "u", name: "Notch", created: "", source: "", expires: "forever", reason: "" },
    ]);
    replies = [{ match: /^banlist/, reply: "Es gibt keine Sperren" }];
    const body = await route.GET().then((r) => r.json());

    expect(body.live.players).toBe("unreadable");
    expect(body.drift.players).toBe(null);
    // And it is still the RCON path: the server answered, so a change goes over RCON.
    expect(body.path).toBe("rcon");
  });

  /**
   * The predicted path has to be the path the button will take. Derived from the `players`
   * read alone, an IP ban attempted in the moment that one read failed would be promised the
   * file path and get the RCON one.
   */
  it("predicts the rcon path when either list answered", async () => {
    replies = [
      {
        match: /^banlist players/,
        reply: () => {
          throw new Error("timeout");
        },
      },
      { match: /^banlist ips/, reply: "There are no bans" },
    ];
    const body = await route.GET().then((r) => r.json());
    expect(body.live).toEqual({ players: "unreachable", ips: "read" });
    expect(body.path).toBe("rcon");
  });

  /**
   * The two `banlist` reads are sequential. `getRcon` has no in-flight dedupe, so two
   * concurrent calls that find no cached socket both connect and one is leaked; and
   * `rcon-client` is `maxPending: 1`, so the second queues behind the first while its own
   * deadline is already running. Pinned by order rather than by timing, which is what a unit
   * suite can actually assert.
   */
  it("asks for the two lists one at a time", async () => {
    const order: string[] = [];
    replies = [
      {
        match: /^banlist/,
        reply: () => {
          order.push("start");
          return "There are no bans";
        },
      },
    ];
    await route.GET();
    expect(order).toEqual(["start", "start"]);
    expect(sent.map((s) => s.command)).toEqual(["banlist players", "banlist ips"]);
  });
});
