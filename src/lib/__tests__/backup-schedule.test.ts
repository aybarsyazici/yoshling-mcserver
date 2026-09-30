import { describe, expect, it } from "vitest";
import {
  FAILURE_COOLDOWN_MS,
  shouldRunScheduledBackup,
  type ScheduleInput,
} from "../backup-schedule";

/**
 * The scheduler's whole job is to decide *not* to run, so these are mostly assertions
 * about refusals. The one that matters most is the player check: an automatic backup that
 * fires while someone is playing copies files the game is midway through writing, and the
 * whole feature would then be producing torn archives on a timer.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

function input(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: NOW,
    enabled: true,
    intervalMs: 24 * HOUR,
    lastArchiveAtMs: NOW - 48 * HOUR,
    lastFailedAtMs: 0,
    failureCooldownMs: FAILURE_COOLDOWN_MS,
    world: { status: "offline", playersOnline: 0 },
    ...over,
  };
}

describe("shouldRunScheduledBackup — never while a world is being played", () => {
  /**
   * Player count, not container state. A running server with nobody on it is the *best*
   * moment to take one; a running server with somebody on it is the worst.
   */
  it("runs against a running server with nobody connected", () => {
    const d = shouldRunScheduledBackup(input({ world: { status: "online", playersOnline: 0 } }));
    expect(d.verdict).toBe("run");
  });

  it("refuses with one player connected, however overdue it is", () => {
    const d = shouldRunScheduledBackup(
      input({
        world: { status: "online", playersOnline: 1 },
        lastArchiveAtMs: NOW - 400 * HOUR,
      })
    );
    expect(d.verdict).toBe("skip");
    expect(d.reason).toContain("1 player is connected");
  });

  it("pluralises the refusal, because the reason is shown to a person", () => {
    const d = shouldRunScheduledBackup(input({ world: { status: "online", playersOnline: 3 } }));
    expect(d.reason).toContain("3 players are connected");
  });

  /**
   * `"starting"` is what the drivers report for a container that is up and not answering —
   * the documented wedged-game state (PZ's game loop, 2026-09-22). In that state the player
   * count is unknowable, so it must be a refusal and not a green light. This is the case a
   * "container is running, so nobody can be playing" shortcut would get wrong.
   */
  it("refuses while the server is starting or otherwise not settled", () => {
    for (const status of ["starting", "stopping", "installing"]) {
      const d = shouldRunScheduledBackup(input({ world: { status, playersOnline: 0 } }));
      expect(d.verdict).toBe("skip");
      expect(d.reason).toContain(status);
    }
  });

  it("runs against a stopped server, whose files are already at rest", () => {
    expect(shouldRunScheduledBackup(input()).verdict).toBe("run");
  });
});

describe("shouldRunScheduledBackup — the clock", () => {
  it("refuses while the newest archive is inside the interval", () => {
    const d = shouldRunScheduledBackup(input({ lastArchiveAtMs: NOW - 5 * HOUR }));
    expect(d.verdict).toBe("skip");
    expect(d.reason).toContain("5.0h old");
  });

  it("runs at exactly the interval", () => {
    expect(shouldRunScheduledBackup(input({ lastArchiveAtMs: NOW - 24 * HOUR })).verdict).toBe("run");
  });

  it("runs when the world has never been backed up", () => {
    const d = shouldRunScheduledBackup(input({ lastArchiveAtMs: null }));
    expect(d.verdict).toBe("run");
    expect(d.reason).toContain("no archive");
  });
});

describe("shouldRunScheduledBackup — the probe is the expensive half", () => {
  /**
   * The tri-state exists so the five-minute timer does not open a telnet and two RCON
   * connections every tick just to find out nothing is due. `world: null` means "not asked
   * yet", and the answer is `probe` only when the cheap half already said yes.
   */
  it("asks for a probe when due and the world has not been asked", () => {
    const d = shouldRunScheduledBackup(input({ world: null }));
    expect(d.verdict).toBe("probe");
  });

  it("skips without asking for a probe when nothing is due", () => {
    const d = shouldRunScheduledBackup(input({ world: null, lastArchiveAtMs: NOW - HOUR }));
    expect(d.verdict).toBe("skip");
  });

  it("skips without asking for a probe when it is switched off", () => {
    const d = shouldRunScheduledBackup(input({ world: null, enabled: false }));
    expect(d.verdict).toBe("skip");
  });
});

describe("shouldRunScheduledBackup — the failure cooldown", () => {
  /**
   * Same reasoning as `zomboid-updates.ts`'s seed cooldown, which was added after a
   * Workshop item that could never download launched a SteamCMD container every five
   * minutes forever. A full disk or a missing `Saves/` has no reason to go differently on
   * the next tick.
   */
  it("refuses inside the cooldown and says how long is left", () => {
    const d = shouldRunScheduledBackup(input({ lastFailedAtMs: NOW - 10 * 60_000 }));
    expect(d.verdict).toBe("skip");
    expect(d.reason).toMatch(/not retrying for ~\d+ min/);
  });

  it("runs again once the cooldown has passed", () => {
    const d = shouldRunScheduledBackup(
      input({ lastFailedAtMs: NOW - FAILURE_COOLDOWN_MS - 1000 })
    );
    expect(d.verdict).toBe("run");
  });

  /**
   * The cooldown is in memory precisely so it cannot be the `applyingSince` failure again
   * — a marker written to disk, never cleared, that left the UI permanently claiming an
   * apply was in flight with the only control that could clear it disabled by that state.
   * `0` is the never-failed value, and it must not be read as "failed at the epoch".
   */
  it("treats 0 as never failed rather than as a very old failure", () => {
    expect(shouldRunScheduledBackup(input({ lastFailedAtMs: 0 })).verdict).toBe("run");
  });
});

describe("shouldRunScheduledBackup — switched off", () => {
  it("refuses first, before anything else is considered", () => {
    const d = shouldRunScheduledBackup(
      input({ enabled: false, lastArchiveAtMs: null, world: { status: "offline", playersOnline: 0 } })
    );
    expect(d.verdict).toBe("skip");
    expect(d.reason).toContain("switched off");
  });
});
