/**
 * Source RCON wire framing, as pure functions.
 *
 * This exists because of a measured, live, silent defect. `rcon-client` resolves a command
 * on the **first** packet carrying its request id and then deletes its own callback
 * (`node_modules/rcon-client/lib/rcon.js`), so every later packet of a multi-packet reply
 * is dropped on the floor. Source RCON caps one packet's payload at 4096 bytes and splits
 * anything longer across several packets with the same id.
 *
 * What that cost, measured on production 2026-10-01: Project Zomboid's `showoptions` reply
 * is 6,789 bytes / 137 settings. Through the app it arrived as **79** settings, cut off at
 * byte 4102, losing everything from `* PerkLogs=true` onward — 58 settings. Nothing failed.
 * `available` was `true`, the chips rendered, and those 58 keys read "not reported", so a
 * configured-vs-live *disagreement* in any of them could never show. The feature looked
 * like it worked and saw 58% of the file. This project's signature defect, arrived at
 * through a library rather than our own code.
 *
 * It is not Project Zomboid's problem either. Minecraft's `banlist` and a `list` on a busy
 * server pass 4096 bytes just as easily.
 *
 * `scripts/rcon.py` has drained multi-packet replies correctly all along, which is why
 * `scripts/pz-rcon.sh showoptions` reported 137 while the dashboard reported 79 — and why
 * the "137 settings" figure in the docs was right about the server and wrong about the app.
 * **Measure through the path the user actually uses.** The reader in `rcon-long.ts` is
 * modelled on that script; the framing is here so it can be asserted without a socket.
 */

export const SERVERDATA_RESPONSE_VALUE = 0;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_AUTH = 3;

/** The payload limit that makes this module necessary. A reply longer than this is split. */
export const MAX_PAYLOAD = 4096;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/**
 * `<int32 size><int32 id><int32 type><body NUL><NUL>`, all little-endian. `size` counts
 * everything after itself, so a packet occupies `size + 4` bytes on the wire.
 */
export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf-8");
  const buf = Buffer.alloc(payload.length + 14);
  buf.writeInt32LE(payload.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  // Two trailing NULs: one terminating the body, one terminating the packet.
  return buf;
}

export interface DecodeResult {
  packets: RconPacket[];
  /** Bytes not yet forming a whole packet. Feed them back in with the next chunk. */
  rest: Buffer;
}

/**
 * Decode as many whole packets as the buffer holds and hand back the remainder.
 *
 * TCP gives no packet boundaries: one `data` event can carry half a packet, or three and a
 * half. A reader that assumed one event equals one packet would corrupt exactly the long
 * replies this module exists to read, since those are the ones that get split.
 */
export function decodePackets(buf: Buffer): DecodeResult {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    // A size that cannot be a packet means the stream is out of sync; reading on would
    // produce confident nonsense. Stop and keep the bytes, so a caller times out with the
    // data it has rather than inventing settings out of misaligned ints.
    if (size < 10 || size > MAX_PAYLOAD + 32) break;
    if (buf.length - off < size + 4) break;
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    // `size - 10` is the body: size covers id (4) + type (4) + body + two NULs.
    const body = buf.subarray(off + 12, off + 4 + size - 2).toString("utf-8");
    packets.push({ id, type, body });
    off += size + 4;
  }
  return { packets, rest: buf.subarray(off) };
}

/**
 * Join the packets belonging to one command.
 *
 * Two rules, both learned the expensive way in this repo:
 *
 * - **Only packets with our own id.** A naive client reads the *auth* reply as the first
 *   command's answer and every response after that is shifted by one. That is what made
 *   `players` report 0 while somebody was connected, and the wrong reading got written down
 *   as fact — the whole reason `scripts/pz-rcon.sh` exists.
 * - **Only `SERVERDATA_RESPONSE_VALUE`.** Some servers emit an empty mid-stream packet;
 *   it is not an answer and must not terminate one.
 */
export function joinReply(packets: RconPacket[], id: number): string {
  return packets
    .filter((p) => p.id === id && p.type === SERVERDATA_RESPONSE_VALUE)
    .map((p) => p.body)
    .join("");
}

/**
 * Whether a reply is at the single-packet ceiling and therefore probably continues.
 *
 * Used only to decide whether waiting a little longer is worthwhile; the reader also just
 * waits out a short quiet period, so a false negative here costs correctness nothing. A
 * reply that happens to land exactly on 4096 with nothing following simply waits out the
 * grace period, which is the same thing it would do anyway.
 */
export function mayHaveMore(body: string): boolean {
  return Buffer.byteLength(body, "utf-8") >= MAX_PAYLOAD - 16;
}
