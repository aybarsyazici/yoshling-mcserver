/**
 * Why an RCON command failed, as far as the error itself can say.
 *
 * The console route used to answer **one** sentence for every failure — "The Minecraft
 * server isn't reachable — it may be powered off. Start it, then try again." — matched on a
 * pattern that included `/timeout/i`. Two different failures reached it:
 *
 * - **the socket never opened** (`ENOTFOUND minecraft` when the container is down,
 *   `ECONNREFUSED` when it is up but RCON is not listening yet). "Powered off" is a fair
 *   reading.
 * - **the socket opened and the game did not answer in time.** `src/lib/rcon.ts` raises its
 *   own `new Error("timeout")` with no `code` for this, so it fell into the same branch —
 *   and the server is demonstrably *there*, because something accepted the connection. A
 *   slow `op` write or a long chunk save lands here.
 *
 * Telling someone to press **Power on** in the second case is the exact dead end this
 * project already fixed once in `game-controls.tsx`: `docker start` on an already-running
 * container is a no-op that toasts success and changes nothing, so the advice leads
 * nowhere. "Container running but unreachable" is its own state everywhere else in this
 * app (`GameStatus.containerRunning`), and the console was the one surface that still
 * collapsed it back into "stopped".
 *
 * Pure on purpose: the route turns a classification into a sentence, and the only way to
 * assert the classification is to keep it away from `NextResponse`.
 */
export type RconFailure =
  /** Nothing was listening — the name did not resolve, or the port refused. */
  | "no-socket"
  /** Connected, then no reply inside the deadline. The server exists. */
  | "no-reply"
  /** The game itself answered with an error. That answer is information; pass it through. */
  | "game-error";

/**
 * Codes that mean the connection was never established.
 *
 * `ETIMEDOUT` is deliberately here and **not** in `no-reply`: as a socket `code` it is the
 * kernel giving up on the TCP handshake, i.e. nothing answered at all. The string
 * `"timeout"` with no code is the opposite — that is `rcon.ts` giving up after the
 * handshake succeeded. Two things named almost the same, meaning opposite things, which is
 * why one regex over the message could not tell them apart.
 */
const NO_SOCKET_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT", "ENETUNREACH"]);

export function classifyRconFailure(e: unknown): RconFailure {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && NO_SOCKET_CODES.has(code)) return "no-socket";

  const msg = e instanceof Error ? e.message : String(e ?? "");
  // Message matching is the fallback for errors that carry no code. Node's own socket
  // errors always carry one, so anything reaching here with a code-shaped message is
  // something that re-wrapped an error and lost the code — still worth reading.
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "no-socket";
  // `rcon.ts` raises exactly `new Error("timeout")`. Matched loosely because a future
  // caller may add context around it, but checked AFTER the no-socket patterns so a
  // message that happens to contain both words is read as the more specific one.
  if (/timed?\s?out|timeout/i.test(msg)) return "no-reply";

  return "game-error";
}

/**
 * The sentence to show, given the classification and whether the container is actually up.
 *
 * `containerRunning` is what makes this honest: a `no-socket` failure while the container
 * *is* running is not "powered off" either — it is a server that has not finished opening
 * its RCON port, which is the ordinary state for the first ~30 seconds after a start and
 * reads as a fault if the copy says "powered off".
 *
 * `null` means the container state could not be determined (the docker call itself failed).
 * The message then states what is known and nothing more, rather than picking the likelier
 * of two guesses and sounding certain.
 */
export function rconFailureMessage(
  failure: RconFailure,
  containerRunning: boolean | null,
  gameName = "The server"
): string {
  if (failure === "no-reply") {
    return containerRunning === false
      ? `${gameName} accepted the connection but then stopped answering, and its container is no longer running. It was shutting down.`
      : `${gameName} is running but did not answer in time. It is busy or wedged, not powered off — give it a moment, and use Restart if it stays this way.`;
  }
  if (failure === "no-socket") {
    if (containerRunning === true) {
      return `${gameName}'s container is running but nothing is listening on RCON yet. If it has just started this is normal for the first half-minute; if it persists, Restart is the way out.`;
    }
    if (containerRunning === false) {
      return `${gameName} isn't running. Start it, then try again.`;
    }
    return `${gameName} isn't reachable over RCON, and its container state could not be read. Check the server page.`;
  }
  return "";
}
