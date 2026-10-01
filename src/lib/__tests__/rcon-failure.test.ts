import { describe, expect, it } from "vitest";
import { classifyRconFailure, rconFailureMessage } from "@/lib/rcon-failure";

/**
 * The property under test is the distinction the old one-regex classifier could not make:
 * a socket that never opened versus a socket that opened and went quiet. Both used to
 * produce "it may be powered off", and for the second that sentence sends the operator to
 * a Power on button that does nothing on a running container.
 */
describe("classifyRconFailure", () => {
  it("reads a socket that never opened as no-socket", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
      const e = Object.assign(new Error(`getaddrinfo ${code} minecraft`), { code });
      expect(classifyRconFailure(e)).toBe("no-socket");
    }
  });

  /**
   * The pair that makes this worth a module. `ETIMEDOUT` **as a socket code** is the kernel
   * giving up on the handshake — nothing answered. The bare message `"timeout"` is
   * `rcon.ts` giving up *after* the handshake succeeded. Almost the same word, opposite
   * meanings, which is why one regex over the message got it wrong.
   */
  it("separates a handshake ETIMEDOUT from rcon.ts's own post-connect timeout", () => {
    expect(classifyRconFailure(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(
      "no-socket"
    );
    // This is verbatim what src/lib/rcon.ts raises.
    expect(classifyRconFailure(new Error("timeout"))).toBe("no-reply");
  });

  it("passes an error the game itself produced through as game-error", () => {
    expect(classifyRconFailure(new Error("Unknown or incomplete command"))).toBe("game-error");
    expect(classifyRconFailure(new Error("Authentication failed"))).toBe("game-error");
  });

  it("does not crash on a thrown non-Error", () => {
    expect(classifyRconFailure(undefined)).toBe("game-error");
    expect(classifyRconFailure("ECONNREFUSED")).toBe("no-socket");
  });
});

describe("rconFailureMessage", () => {
  /**
   * The property is about the **advice**, not the vocabulary. A first draft asserted the
   * string must not contain "powered off" and failed against copy reading "not powered
   * off" — which is the clearest possible way to say it. What must never happen is sending
   * someone to Power on, because `docker start` on a running container is a no-op that
   * toasts success and leaves them exactly where they were.
   */
  const sendsThemToPowerOn = (msg: string) => /\bstart it\b|press power on|powering on/i.test(msg);

  it("never points a connected-but-slow server at Power on", () => {
    const msg = rconFailureMessage("no-reply", true, "Minecraft");
    expect(msg).toMatch(/running/i);
    expect(sendsThemToPowerOn(msg)).toBe(false);
    expect(msg).toMatch(/restart/i); // names the action that actually recovers it
  });

  it("names a just-started server's closed RCON port rather than calling it off", () => {
    const msg = rconFailureMessage("no-socket", true, "Minecraft");
    expect(msg).toMatch(/running/i);
    expect(sendsThemToPowerOn(msg)).toBe(false);
  });

  it("does say the plain thing when the container really is down", () => {
    expect(rconFailureMessage("no-socket", false, "Minecraft")).toMatch(/isn't running/i);
  });

  /**
   * An unknown container state must not be rendered as the likelier guess. A sentence that
   * said "powered off" because `docker inspect` failed would be the same false certainty
   * this module replaced, just arrived at differently.
   */
  it("states only what is known when the container state could not be read", () => {
    const msg = rconFailureMessage("no-socket", null, "Minecraft");
    expect(msg).toMatch(/could not be read/i);
    expect(msg).not.toMatch(/isn't running|is running/i);
  });

  it("explains the shutdown race: connected, then the container went away", () => {
    expect(rconFailureMessage("no-reply", false, "Minecraft")).toMatch(/shutting down/i);
  });

  it("returns nothing for game-error, so the caller passes the game's own words through", () => {
    expect(rconFailureMessage("game-error", true, "Minecraft")).toBe("");
  });
});
