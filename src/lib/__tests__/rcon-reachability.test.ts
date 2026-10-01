import { describe, it, expect } from "vitest";
import { classifyRconFailure, rconFailureResponse } from "../rcon-reachability";

/**
 * The failure shapes the two RCON sources really produce.
 *
 * `node:net` errors carry a `code` and a message that is mostly the code again; `rcon.ts`'s
 * own `withTimeout` raises a bare `new Error("timeout")` with **no code at all**, which is
 * why the classifier has to read both.
 */
function coded(code: string, message = ""): Error & { code: string } {
  return Object.assign(new Error(message || code), { code });
}

describe("nothing is listening", () => {
  /**
   * The property: only an error that means "no TCP connection was accepted" is allowed to
   * produce the sentence that says the world may be powered off, because that sentence sends
   * the reader to press Power on.
   *
   * `ENOTFOUND` is the ordinary one on this deployment and it is a DNS failure rather than a
   * socket one: RCON is not published to the host, the web container reaches the game as the
   * compose service alias (`minecraft:25575`), and compose only publishes that alias while
   * the service has a container.
   */
  it("classifies the down codes as unreachable", () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(classifyRconFailure(coded(code)), code).toBe("unreachable");
    }
  });

  it("recognises a down code that only appears in the message", () => {
    // What `rcon-client` surfaces when it wraps the socket error rather than re-throwing it.
    expect(classifyRconFailure(new Error("getaddrinfo ENOTFOUND minecraft"))).toBe("unreachable");
    expect(classifyRconFailure(new Error("connect ECONNREFUSED 172.18.0.4:25575"))).toBe(
      "unreachable"
    );
  });

  it("is the only kind that may say 'powered off'", () => {
    const down = rconFailureResponse("unreachable", "Minecraft", "");
    expect(down.status).toBe(503);
    expect(down.error).toMatch(/powered off/);

    for (const kind of ["timeout", "error"] as const) {
      const other = rconFailureResponse(kind, "Minecraft", "boom");
      expect(other.error, kind).not.toMatch(/it may be powered off/);
    }
  });
});

describe("asked and got no answer", () => {
  /**
   * The bug this split exists for, and it has a measured victim in this repo rather than a
   * hypothetical one. The Operators card on `/minecraft/settings` records that `/op`
   * resolves the username against Mojang **on the server thread** even with
   * `online-mode=false` (the boot log reports `profilesHost=https://api.mojang.com`
   * regardless), that the lookup outlives `rcon.ts`'s 3 s window, and that the console route
   * then answered "The Minecraft server isn't reachable — it may be powered off" about a
   * server that was fine and was still working on the command.
   *
   * So a timeout is its own kind, and its sentence must not name powering on as the fix.
   */
  it("classifies rcon.ts's own bare timeout as a timeout, not as powered off", () => {
    // The exact error `withTimeout` throws: no code, message "timeout".
    expect(classifyRconFailure(new Error("timeout"))).toBe("timeout");
    expect(classifyRconFailure(coded("ETIMEDOUT"))).toBe("timeout");
    expect(classifyRconFailure(new Error("Request timed out"))).toBe("timeout");
  });

  it("answers 504 and refuses to name a cause it cannot support", () => {
    const { status, error } = rconFailureResponse("timeout", "Minecraft", "");
    // A distinct status so a client can tell "not there" from "not answering" without
    // parsing prose.
    expect(status).toBe(504);
    expect(error).toMatch(/didn't answer in time/);
    expect(error).toMatch(/not the same as powered off/);
    // `rcon.ts` wraps both `Rcon.connect` and `rcon.send` in the same `withTimeout` and both
    // raise the identical bare Error("timeout"), so this error cannot know whether the
    // connection was ever accepted. It must therefore not claim that it was.
    expect(error).not.toMatch(/is listening/);
    // Nor diagnose a hang: a slow command on a healthy server produces exactly this.
    expect(error).not.toMatch(/wedged|crashed|hung/i);
  });
});

describe("anything else keeps the game's own words", () => {
  it("classifies an unrecognised error as error", () => {
    // Including the ones that genuinely are ambiguous. `ECONNRESET` is deliberately not
    // folded into either of the two specific kinds: calling it "powered off" would be a
    // guess, and calling it a timeout would be a different guess.
    for (const e of [
      coded("ECONNRESET"),
      coded("EPIPE"),
      new Error("Authentication failed"),
      new Error(""),
      "a string",
      null,
      undefined,
      {},
    ]) {
      expect(classifyRconFailure(e), JSON.stringify(e) ?? String(e)).toBe("error");
    }
  });

  it("passes the raw message through rather than replacing it with a friendly sentence", () => {
    // The console route's rule, kept: "an RCON error the game itself produced is
    // information, and hiding it behind a friendly sentence is how a real fault becomes
    // invisible."
    const { status, error } = rconFailureResponse("error", "Minecraft", "Authentication failed");
    expect(status).toBe(500);
    expect(error).toContain("Authentication failed");
  });

  it("still says something when there is no message", () => {
    expect(rconFailureResponse("error", "Minecraft", "").error).toBe("RCON error: connection failed");
  });
});

describe("the sentences name the world they are about", () => {
  it("uses the server name it was given", () => {
    // Shared with Project Zomboid's RCON in principle — the transport is — so the name is a
    // parameter rather than the word "Minecraft" baked into three sentences.
    for (const kind of ["unreachable", "timeout"] as const) {
      expect(rconFailureResponse(kind, "Project Zomboid", "").error, kind).toContain(
        "Project Zomboid"
      );
    }
  });
});
