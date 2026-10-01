import net from "node:net";
import {
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  decodePackets,
  encodePacket,
  joinReply,
  type RconPacket,
} from "@/lib/rcon-frame";
import { SERVERDATA_EXECCOMMAND } from "@/lib/rcon-frame";
import type { RconTarget } from "@/lib/rcon";

/**
 * One RCON command, read to the end even when the reply spans several packets.
 *
 * See `rcon-frame.ts` for why this exists: `rcon-client` keeps the first packet of a reply
 * and discards the rest, which silently truncated Project Zomboid's `showoptions` from 137
 * settings to 79 on production.
 *
 * **A separate, short-lived socket on purpose.** The cached connection in `rcon.ts` is the
 * right design for the ~100 ms status polls that run every few seconds, and this is not
 * that: it is a once-per-settings-page read of a 7 KB reply. Sharing the cached socket would
 * mean either reimplementing this drain inside `rcon-client`'s callback bookkeeping or
 * reading past a short command's reply into the next one — both of which risk the
 * off-by-one that `scripts/pz-rcon.sh` exists to prevent, in exchange for saving one TCP
 * handshake on a path that already costs 100 ms.
 *
 * `quietMs` is the grace period after the last packet. The server gives no total length and
 * no end marker, so "it stopped talking" is the only available end-of-reply signal — the
 * same approach `scripts/rcon.py` has used correctly against this server all along.
 */
export async function rconCommandLong(
  target: RconTarget,
  command: string,
  { timeoutMs = 9000, quietMs = 400 }: { timeoutMs?: number; quietMs?: number } = {}
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new net.Socket();
    let buf: Buffer = Buffer.alloc(0);
    const packets: RconPacket[] = [];
    let authed = false;
    let commandId = -1;
    let quietTimer: NodeJS.Timeout | null = null;
    let settled = false;

    // The overall deadline. Distinct from `quietMs`: this fires when the server never
    // answers at all, and `rcon.ts` raises the same bare `new Error("timeout")` for that,
    // which `classifyRconFailure` reads as "connected but did not reply" — the honest
    // reading, since the socket did open.
    const deadline = setTimeout(() => fail(new Error("timeout")), timeoutMs);

    function done(value: string) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (quietTimer) clearTimeout(quietTimer);
      socket.destroy();
      resolve(value);
    }

    function fail(e: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (quietTimer) clearTimeout(quietTimer);
      socket.destroy();
      reject(e);
    }

    /** Restart the quiet window: every packet that arrives means more may follow. */
    function bumpQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => done(joinReply(packets, commandId)), quietMs);
    }

    socket.setNoDelay(true);
    socket.on("error", fail);
    socket.on("end", () => {
      // The server hung up. Whatever arrived is the whole reply — returning it beats
      // throwing away a complete answer because the peer closed promptly.
      if (authed && commandId !== -1) done(joinReply(packets, commandId));
      else fail(new Error("connection closed during authentication"));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets: fresh, rest } = decodePackets(buf);
      // `subarray` hands back a view typed `Buffer<ArrayBufferLike>`; copy it so the
      // accumulator stays a plain `Buffer` and cannot alias a chunk we are done with.
      buf = Buffer.from(rest);
      for (const p of fresh) {
        if (!authed) {
          // Skip to the AUTH_RESPONSE. The empty RESPONSE_VALUE that precedes it is not an
          // answer, and treating it as one shifts every later reply by one command — the
          // bug that made `players` report 0 with somebody connected.
          if (p.type !== SERVERDATA_AUTH_RESPONSE) continue;
          if (p.id === -1) return fail(new Error("authentication failed — wrong password"));
          authed = true;
          commandId = 2;
          socket.write(encodePacket(commandId, SERVERDATA_EXECCOMMAND, command));
          continue;
        }
        packets.push(p);
      }
      if (authed) bumpQuiet();
    });

    socket.connect(target.port, target.host, () => {
      socket.write(encodePacket(1, SERVERDATA_AUTH, target.password));
    });
  });
}
