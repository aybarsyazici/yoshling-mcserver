import { describe, it, expect } from "vitest";
import { parsePlayers, sdtdSessionIsGameReady } from "@/lib/telnet";

/**
 * The strings here are the real ones, copied from live telnet sessions against
 * `yoshling-7dtd`. The middle case is the whole defect: for ~40 s of every boot the
 * listener answers and the game does not, and the dashboard called that "Running".
 */
const BOOTING = "*** ERROR: Command 'gettime' can only be executed when a game is started.";

const READY = [
  "0. id=171, YoshiTester, pos=(-402.6, 40.0, 1206.4), rot=(0.0, 88.2, 0.0), remote=True, health=100, deaths=0, zombies=3, players=0, score=7, level=8, pltfmid=Steam_7656119, crossid=EOS_00025, ip=203.0.113.9, ping=42",
  "Total of 1 in the game",
  "Day 7, 21:40",
  "Game version: V 3.3.0 (b14) Compatibility Version: V 3.3.0",
].join("\n");

describe("sdtdSessionIsGameReady", () => {
  it("is false for an empty session (telnet did not answer at all)", () => {
    expect(sdtdSessionIsGameReady("")).toBe(false);
  });

  it("is false while the world is still loading", () => {
    expect(sdtdSessionIsGameReady(BOOTING)).toBe(false);
  });

  it("is false when only one of the batched commands answered with the boot error", () => {
    // The probe runs listplayers + gettime + version in one session, so a partially
    // booted server returns three of these concatenated.
    const mixed = [
      "*** ERROR: Command 'listplayers' can only be executed when a game is started.",
      "*** ERROR: Command 'gettime' can only be executed when a game is started.",
      "Game version: V 3.3.0 (b14)",
    ].join("\n");
    expect(sdtdSessionIsGameReady(mixed)).toBe(false);
  });

  it("is true for a real transcript with a player count and an in-game clock", () => {
    expect(sdtdSessionIsGameReady(READY)).toBe(true);
  });

  it("is true for an empty-but-loaded server", () => {
    const empty = ["Total of 0 in the game", "Day 7, 21:40", "Game version: V 3.3.0 (b14)"].join(
      "\n"
    );
    expect(sdtdSessionIsGameReady(empty)).toBe(true);
  });
});

describe("parsePlayers", () => {
  it("reads the name and the authoritative total off a real listplayers reply", () => {
    const p = parsePlayers(READY, 8);
    expect(p.players).toEqual(["YoshiTester"]);
    expect(p.online).toBe(1);
    expect(p.max).toBe(8);
  });

  it("trusts 'Total of N' over the number of parsed lines", () => {
    expect(parsePlayers("Total of 0 in the game", 8).online).toBe(0);
  });
});
