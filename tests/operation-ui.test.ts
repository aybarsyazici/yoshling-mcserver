import { describe, expect, it } from "vitest";
import { GAMES, type GameId } from "@/lib/games";
import type { OperationView } from "@/lib/operations-types";
import type { GameSnapshot } from "@/lib/use-games";
import {
  blockedReason,
  fileOperationLabel,
  liveFileOperations,
  namedFileOperations,
  powerBlocker,
  powerState,
  slowestStopSeconds,
  spellMinutes,
  spellSeconds,
} from "@/lib/operation-ui";

// ── builders ────────────────────────────────────────────────────────────────

function op(over: Partial<OperationView> = {}): OperationView {
  return {
    id: "x",
    kind: "backup.create",
    game: "zomboid",
    title: "Creating a backup",
    startedAt: 0,
    heartbeatAt: 0,
    facts: [],
    steps: [],
    progress: { kind: "indeterminate" },
    resources: ["files:zomboid"],
    holdsPower: false,
    startedBy: null,
    ...over,
  };
}

function snap(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    game: "zomboid",
    status: "offline",
    players: { online: 0, max: 0, players: [] },
    ...over,
  };
}

function worlds(over: Partial<Record<GameId, Partial<GameSnapshot>>>): Record<GameId, GameSnapshot> {
  const base: Record<GameId, GameSnapshot> = {
    minecraft: snap({ game: "minecraft" }),
    "7dtd": snap({ game: "7dtd" }),
    zomboid: snap({ game: "zomboid" }),
  };
  for (const [g, v] of Object.entries(over)) {
    base[g as GameId] = { ...base[g as GameId], ...v } as GameSnapshot;
  }
  return base;
}

const ALL = { start: true, stop: true, restart: true };

function surface(over: Partial<Parameters<typeof powerState>[0]> = {}) {
  return powerState({
    game: "zomboid",
    games: worlds({}),
    can: ALL,
    localBusy: false,
    serverBusy: null,
    elapsedMs: () => 0,
    clockSkewMs: 0,
    ...over,
  });
}

// ── powerBlocker ────────────────────────────────────────────────────────────

describe("powerBlocker", () => {
  it("is blocked by anything holding the box's power slot, whichever world", () => {
    const held = op({ game: "minecraft", holdsPower: true, resources: ["power"] });
    expect(powerBlocker([held], "zomboid")).toBe(held);
  });

  it("is blocked by a file operation on this world", () => {
    const backup = op({ game: "zomboid", resources: ["files:zomboid"] });
    expect(powerBlocker([backup], "zomboid")).toBe(backup);
  });

  it("is NOT blocked by a file operation on a different world", () => {
    // `powerBlocker` stays per-world: that is the *disable* decision and it is correct.
    // Only the confirm-dialog warning has to be as wide as the consequence.
    const other = op({ game: "minecraft", resources: ["files:minecraft"] });
    expect(powerBlocker([other], "zomboid")).toBeUndefined();
  });

  it("ignores a finished operation", () => {
    // The second, subtly different copy of this that used to live in `operations.ts`
    // omitted the `!o.endedAt` guard, so it matched finished records too.
    expect(powerBlocker([op({ holdsPower: true, endedAt: 1 })], "zomboid")).toBeUndefined();
  });

  it("ignores a synthetic boot", () => {
    // A booting container blocks nothing, and Restart is precisely the action you need
    // while one is wedged.
    const boot = op({ kind: "boot", synthetic: true, holdsPower: true });
    expect(powerBlocker([boot], "zomboid")).toBeUndefined();
  });
});

// ── liveFileOperations ──────────────────────────────────────────────────────

describe("liveFileOperations", () => {
  it("returns every world's file operation, not just one world's", () => {
    // Pre-emption is global: a power operation declares every `files:` lane, so `admit()`
    // marks EVERY held file operation preempted. The dialogs were built per-world, so
    // pressing Power on for 7 Days to Die warned about the 7DTD backup alone and destroyed
    // the Project Zomboid and Minecraft ones unmentioned — one had already written 290 MB.
    const ops = [
      op({ id: "a", game: "zomboid" }),
      op({ id: "b", game: "minecraft", resources: ["files:minecraft"] }),
      op({ id: "c", game: "7dtd", resources: ["files:7dtd"] }),
    ];
    expect(liveFileOperations(ops).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes power holders, finished records and synthetic boots", () => {
    const ops = [
      op({ id: "power", holdsPower: true }),
      op({ id: "done", endedAt: 1 }),
      op({ id: "boot", synthetic: true }),
      op({ id: "live" }),
    ];
    expect(liveFileOperations(ops).map((o) => o.id)).toEqual(["live"]);
  });

  it("names each world in the consequence clause", () => {
    const ops = [
      op({ id: "a", game: "zomboid", title: "Creating a backup" }),
      op({ id: "b", game: "minecraft", title: "Creating a backup" }),
    ];
    const text = namedFileOperations(ops, (o) => (o.id === "a" ? 248_000 : 72_000));
    expect(text).toBe(
      "Project Zomboid — creating a backup (4m 08s) and Minecraft — creating a backup (1m 12s)"
    );
  });

  it("lowercases only the first letter, so a proper noun survives", () => {
    // `toLowerCase()` produced "updating 7 days to die" and "changing project zomboid's
    // memory setting".
    expect(fileOperationLabel(op({ title: "Updating 7 Days to Die" }), 0)).toBe(
      "updating 7 Days to Die (0s)"
    );
    expect(fileOperationLabel(op({ title: "Changing Project Zomboid's memory setting" }), 0)).toBe(
      "changing Project Zomboid's memory setting (0s)"
    );
  });
});

// ── blockedReason ───────────────────────────────────────────────────────────

describe("blockedReason", () => {
  it("names the world, the verb and the elapsed time", () => {
    const held = op({ game: "zomboid", holdsPower: true, action: "stop" });
    expect(blockedReason(held, 12_000)).toBe(
      "Project Zomboid is shutting down (12s). Controls unlock when it finishes."
    );
  });

  it("puts the stage in its own sentence rather than splicing it in lowercased", () => {
    // Spliced after an em dash and lowercased, a step label that names a world read
    // "Project Zomboid is starting up — saving project zomboid (12s)".
    const held = op({
      game: "zomboid",
      holdsPower: true,
      action: "start",
      steps: [
        { id: "s", label: "Saving Project Zomboid", kind: "running", at: 0 },
      ],
    });
    const text = blockedReason(held, 12_000);
    expect(text).toContain("Project Zomboid is starting up (12s).");
    expect(text).toContain("Saving Project Zomboid.");
    expect(text).not.toContain("saving project zomboid");
  });
});

// ── powerState: the recovery path ───────────────────────────────────────────

describe("powerState: running but unreachable is its own state", () => {
  /**
   * The defect this pins, in full: `game-controls` was fixed in `a7d76b8` to tell
   * "stopped" apart from "up but not answering"; `game-overview` — the page every world
   * OPENS on — never was, and `mission-control`'s cards had the same inversion plus no
   * permission check at all. So on a wedged server the first page you meet offered
   * **Power on**, which runs `docker start` on an already-running container: a silent
   * no-op that toasts success and changes nothing, with Restart hidden behind `isOnline`,
   * the one state a wedged server is not in. Both the useful action and the honest label
   * were missing at once.
   */
  it("a wedged container offers Restart, not Power on", () => {
    const s = surface({
      games: worlds({
        zomboid: { status: "offline", containerRunning: true, startedAtMs: Date.now() - 20 * 60_000 },
      }),
    });
    expect(s.containerUp).toBe(true);
    expect(s.unreachable).toBe(true);
    expect(s.looksStuck).toBe(true);
    expect(s.heading).toBe("Not responding");
    // Restart is gated on `containerUp`, NOT on `isOnline`. That inversion is the fix.
    expect(s.canRestart).toBe(true);
    // And the button offers the useful sense.
    expect(s.label).toBe("Power off");
    expect(s.reason).toContain("Restart is the way out");
  });

  it("a young unreachable container reads as Starting…, not Stopped", () => {
    const s = surface({
      games: worlds({
        zomboid: { status: "offline", containerRunning: true, startedAtMs: Date.now() - 30_000 },
      }),
    });
    expect(s.unreachable).toBe(true);
    expect(s.looksStuck).toBe(false);
    expect(s.heading).toBe("Starting…");
    expect(s.canRestart).toBe(true);
    expect(s.reason).toContain("still loading");
  });

  it("a genuinely stopped container reads as Stopped and offers Power on", () => {
    const s = surface({ games: worlds({ zomboid: { status: "offline" } }) });
    expect(s.containerUp).toBe(false);
    expect(s.unreachable).toBe(false);
    expect(s.heading).toBe("Stopped");
    expect(s.label).toBe("Power on");
    // Restart cannot help a container that is not there.
    expect(s.canRestart).toBe(false);
  });

  it("corrects for clock skew before calling a boot wedged", () => {
    // `startedAtMs` is docker's `StartedAt` on the box. Compared against a browser clock a
    // few minutes fast, a healthy 30-second boot was declared "Not responding".
    const fastBrowserBy = 15 * 60_000;
    const s = surface({
      games: worlds({
        zomboid: {
          status: "offline",
          containerRunning: true,
          startedAtMs: Date.now() + fastBrowserBy - 30_000,
        },
      }),
      clockSkewMs: -fastBrowserBy,
    });
    expect(s.looksStuck).toBe(false);
    expect(s.heading).toBe("Starting…");
  });
});

describe("powerState: permissions are projected, not discovered by 403", () => {
  it("a read-only viewer cannot power, and is told why", () => {
    // `mission-control`'s cards had no `can` check at all, so a MEMBER pressed Power on and
    // got an unexplained "Forbidden" — which is exactly how this was reported.
    const s = surface({
      can: { start: false, stop: false, restart: false },
      games: worlds({ zomboid: { status: "offline" } }),
    });
    expect(s.canPower).toBe(false);
    expect(s.canRestart).toBe(false);
    expect(s.reason).toContain("Ask an admin for Mod access");
  });

  it("the button's sense decides which permission it needs", () => {
    // Power on cannot help when the container is already up, so the sense flips — and with
    // it the permission. A viewer who may stop but not start still gets a live button on a
    // running world.
    const up = worlds({ zomboid: { status: "online", containerRunning: true } });
    expect(powerState({
      game: "zomboid",
      games: up,
      can: { start: false, stop: true, restart: false },
      localBusy: false,
      serverBusy: null,
      elapsedMs: () => 0,
      clockSkewMs: 0,
    }).canPower).toBe(true);
    const down = worlds({ zomboid: { status: "offline" } });
    expect(powerState({
      game: "zomboid",
      games: down,
      can: { start: false, stop: true, restart: false },
      localBusy: false,
      serverBusy: null,
      elapsedMs: () => 0,
      clockSkewMs: 0,
    }).canPower).toBe(false);
  });
});

describe("powerState: busy locks the buttons, ownBusy describes the world", () => {
  it("another world's power operation locks us without claiming we are working", () => {
    // Conflating the two made the Project Zomboid page report "Working…", wear the
    // "Booting" pill and animate a blue Power Core while MINECRAFT was starting and PZ was
    // stopped.
    const held = op({ game: "minecraft", holdsPower: true, action: "start", resources: ["power"] });
    const s = surface({ powerHeld: held, games: worlds({ zomboid: { status: "offline" } }) });
    expect(s.busy).toBe(true);
    expect(s.ownBusy).toBe(false);
    expect(s.heading).toBe("Stopped");
    expect(s.label).toBe("Power on");
    expect(s.reason).toContain("Minecraft is starting up");
  });

  it("a hand-off away from us is a stop here, not a start", () => {
    // The operation's action is `start` (of the other world) while what is happening to
    // THIS container is a save and a shutdown. Keying on `op.game` alone left the outgoing
    // world's page reading "Running" with its uptime still counting up, 2m 35s into its own
    // shutdown.
    const held = op({
      game: "minecraft",
      holdsPower: true,
      action: "start",
      resources: ["power"],
      steps: [{ id: "s", label: "Saving Project Zomboid", kind: "running", at: 0, game: "zomboid" }],
    });
    const s = surface({
      powerHeld: held,
      games: worlds({ zomboid: { status: "online", containerRunning: true } }),
    });
    expect(s.ownBusy).toBe(true);
    expect(s.ownAction).toBe("stop");
    expect(s.ownStopping).toBe(true);
    expect(s.label).toBe("Stopping…");
  });
});

describe("powerState: the hand-off warning names the worlds it will stop", () => {
  it("names one running world", () => {
    const s = surface({
      game: "zomboid",
      games: worlds({ zomboid: { status: "offline" }, minecraft: { status: "online" } }),
    });
    expect(s.blocking).toEqual(["minecraft"]);
    expect(s.reason).toBe("Minecraft is running. Starting this one stops it first.");
  });

  it("names several, and pluralises", () => {
    // Nothing may assume there are exactly two worlds.
    const s = surface({
      game: "zomboid",
      games: worlds({
        zomboid: { status: "offline" },
        minecraft: { status: "online" },
        "7dtd": { status: "starting" },
      }),
    });
    expect(s.blocking.sort()).toEqual(["7dtd", "minecraft"]);
    expect(s.reason).toContain("are running");
    expect(s.reason).toContain("stops them first");
  });

  it("counts a world that is merely starting as occupying the box", () => {
    const s = surface({
      game: "zomboid",
      games: worlds({ zomboid: { status: "offline" }, "7dtd": { status: "starting" } }),
    });
    expect(s.blocking).toEqual(["7dtd"]);
  });
});

// ── the duration spellers ───────────────────────────────────────────────────

describe("how long a stop takes, in words", () => {
  it("does not call a fast stop 'about a minute'", () => {
    // The string "about a minute" was hardcoded in the hand-off confirm and on the memory
    // card while Project Zomboid's stop measured 5m 03s. Now that the stop is ~12s
    // (the RCON `quit` fix), `spellMinutes(12)` would overstate it 5x in the other
    // direction — which is the same untrustworthiness, just flipped.
    expect(spellSeconds(9)).toBe("a few seconds");
    expect(spellSeconds(12)).toBe("a few seconds");
    expect(spellSeconds(15)).toBe("a few seconds");
    expect(spellMinutes(12)).toBe("about a minute"); // why `spellSeconds` has to exist
  });

  it("spells the middle of the range without over- or under-claiming", () => {
    expect(spellSeconds(16)).toBe("half a minute");
    expect(spellSeconds(30)).toBe("half a minute");
    expect(spellSeconds(44)).toBe("half a minute");
    expect(spellSeconds(45)).toBe("about a minute");
    expect(spellSeconds(60)).toBe("about a minute");
  });

  it("spells minutes as words", () => {
    expect(spellMinutes(89)).toBe("about a minute");
    expect(spellMinutes(90)).toBe("two minutes");
    expect(spellMinutes(300)).toBe("five minutes");
  });

  it("takes the worst case across the worlds it is given", () => {
    // Reads `GameMeta.stopSeconds`, the measured TYPICAL stop and not the timeout.
    expect(slowestStopSeconds(["zomboid"])).toBeGreaterThan(0);
    expect(slowestStopSeconds(["minecraft", "7dtd", "zomboid"])).toBe(
      Math.max(
        slowestStopSeconds(["minecraft"]),
        slowestStopSeconds(["7dtd"]),
        slowestStopSeconds(["zomboid"])
      )
    );
    expect(slowestStopSeconds([])).toBe(0);
  });

  it("the real stop estimates are all sub-minute, and are spelled that way", () => {
    // If a `stopSeconds` is ever raised past 45 this starts saying "about a minute", which
    // is the honest answer — the test is here so that change is deliberate.
    for (const g of ["minecraft", "7dtd", "zomboid"] as GameId[]) {
      expect(slowestStopSeconds([g])).toBeLessThan(60);
    }
    expect(spellSeconds(slowestStopSeconds(["zomboid"]))).not.toBe("about a minute");
  });

  it("pins the MEASURED stop estimates, not just a bound", () => {
    // A bound cannot catch staleness, and staleness is what actually goes wrong here.
    // `zomboid` sat at 300 (the timeout, not the stop) and rendered "five minutes"; then
    // at 30 after the RCON `quit` fix made it 11.4s, rendering "half a minute". Both were
    // inside `< 60` for Minecraft and both were wrong by 3-25x.
    //
    // These two are measurements. Change one ONLY with a fresh timing in the same commit:
    //   zomboid   11.4s  — dashboard restart, 0 players, RCON quit then exit 0
    //   minecraft 0.719s — `time docker stop yoshling-mc`, exit 0
    expect(GAMES.zomboid.stopSeconds).toBe(12);
    expect(GAMES.minecraft.stopSeconds).toBe(5);

    // 7dtd is deliberately NOT pinned: it has never been timed in isolation and its
    // comment says so. Pinning an estimate would dress a guess as a measurement, which is
    // this field's recurring failure. Replace this with an equality once one is timed.
    expect(GAMES["7dtd"].stopSeconds).toBeGreaterThan(0);
  });
});
