/**
 * Why an RCON call failed, in the only three shapes a route can say something true about.
 *
 * This existed as `isUnreachable()` private to `/api/server/console/route.ts`, where it
 * answered one boolean and folded **"nothing is listening"** together with **"it did not
 * answer in time"**. Those are different facts and the second one has a measured victim in
 * this repo: `/minecraft/settings`'s Operators card carries the note that `/op` in the
 * console resolves the name through a Mojang lookup *on the server thread* even with
 * `online-mode=false` (the boot log reports `profilesHost=https://api.mojang.com`
 * regardless), that the lookup outlives `src/lib/rcon.ts`'s 3 s window, and that the
 * console therefore answered
 *
 *   > The Minecraft server isn't reachable — it may be powered off.
 *
 * about a server that was fine and was still working on the command. That is this
 * project's defect class with the sign flipped: not "reports success after doing nothing"
 * but "reports a specific wrong cause with nothing behind it", and it sends the reader to
 * press Power on against a running world.
 *
 * So: shared, three-state, and used by both the console route and the game-rules route
 * rather than copied. One definition, because the console route's copy is exactly the sort
 * of per-route duplicate that drifted the power control into three versions.
 */
export type RconFailure = "unreachable" | "timeout" | "error";

/**
 * Codes that mean **nothing accepted a TCP connection**, which for this deployment means
 * the container is down or has not opened its listener yet.
 *
 * `ENOTFOUND` is the common one and it is a DNS failure, not a socket one: the web
 * container reaches the game as the compose service name (`minecraft:25575` — RCON is
 * deliberately not published to the host), and compose only publishes that alias while the
 * service has a container, so a stopped world fails to resolve rather than failing to
 * connect.
 */
const DOWN_CODES = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];

/**
 * Classify a thrown RCON error.
 *
 * The match is on the `code` **and** the message because the two failure sources carry
 * different things: a socket or DNS error from `node:net` has a `code` and no useful
 * message, while `src/lib/rcon.ts`'s own `withTimeout` raises a bare
 * `new Error("timeout")` with no code at all.
 *
 * `ETIMEDOUT` is grouped with the bare timeout rather than with the down codes on purpose.
 * A connection that was accepted and then went quiet is not a powered-off server, and
 * treating it as one is the bug above.
 *
 * Everything else — including `ECONNRESET` and an error the game itself produced — stays
 * `"error"` so the caller keeps the raw message. The console route's comment makes the
 * case and it holds here: "an RCON error the game itself produced is information, and
 * hiding it behind a friendly sentence is how a real fault becomes invisible."
 */
export function classifyRconFailure(e: unknown): RconFailure {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e ?? "");

  if (typeof code === "string" && DOWN_CODES.includes(code)) return "unreachable";
  if (code === "ETIMEDOUT") return "timeout";

  // No code: either rcon.ts's own timeout, or a message-only error. Checked in the same
  // order so a message that somehow names both is read as a timeout only when no
  // down-code appears in it.
  if (new RegExp(DOWN_CODES.join("|")).test(msg)) return "unreachable";
  if (/ETIMEDOUT|timed? ?out/i.test(msg)) return "timeout";
  return "error";
}

/**
 * The sentence to show, and the status to send with it.
 *
 * 504 for a timeout rather than 503: the dashboard really is a gateway in front of the
 * game here, the upstream was asked and did not answer, and a distinct status means a
 * client can tell "not there" from "not answering" without parsing prose.
 *
 * Neither sentence names a cause it cannot support. The timeout one deliberately does
 * **not** say "powered off", does not say "wedged", and does not say "it is listening"
 * either: `rcon.ts` wraps *both* `Rcon.connect` and `rcon.send` in the same `withTimeout`
 * and both raise the identical bare `Error("timeout")`, so this error cannot distinguish a
 * connect that never completed from a command that outlived the window. It says the one
 * thing that is true of every case — no answer arrived — and names the two live
 * explanations instead of picking one.
 */
export function rconFailureResponse(
  kind: RconFailure,
  serverName: string,
  rawMessage: string
): { status: number; error: string } {
  if (kind === "unreachable") {
    return {
      status: 503,
      error: `The ${serverName} server isn't reachable — it may be powered off. Start it, then try again.`,
    };
  }
  if (kind === "timeout") {
    return {
      status: 504,
      error:
        `The ${serverName} server didn't answer in time. That is not the same as powered off: ` +
        `it may still be starting up, or the command itself may take longer than the window. ` +
        `Try again in a moment.`,
    };
  }
  return { status: 500, error: `RCON error: ${rawMessage || "connection failed"}` };
}
