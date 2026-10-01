import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_RESPONSE_VALUE,
  decodePackets,
  encodePacket,
  joinReply,
  mayHaveMore,
} from "@/lib/rcon-frame";

/**
 * The property these tests exist for: a reply longer than one 4096-byte packet must come
 * back whole. Measured on production 2026-10-01, `rcon-client` returned 79 of Project
 * Zomboid's 137 settings — the first 4,102 bytes of a 6,789-byte reply — with no error and
 * `available: true`. The 58 it lost read "not reported", so a real disagreement in any of
 * them could never raise a chip.
 */
describe("decodePackets", () => {
  it("round-trips one packet", () => {
    const { packets, rest } = decodePackets(encodePacket(7, SERVERDATA_RESPONSE_VALUE, "hello"));
    expect(packets).toEqual([{ id: 7, type: SERVERDATA_RESPONSE_VALUE, body: "hello" }]);
    expect(rest.length).toBe(0);
  });

  it("decodes several packets out of one buffer", () => {
    const buf = Buffer.concat([
      encodePacket(2, SERVERDATA_RESPONSE_VALUE, "part one "),
      encodePacket(2, SERVERDATA_RESPONSE_VALUE, "part two"),
    ]);
    const { packets } = decodePackets(buf);
    expect(packets.map((p) => p.body)).toEqual(["part one ", "part two"]);
  });

  /**
   * TCP gives no packet boundaries. A reader that assumed one `data` event is one packet
   * would corrupt precisely the long replies this module exists to read, because those are
   * the ones that get split.
   */
  it("holds a partial packet back as rest and completes it on the next chunk", () => {
    const whole = encodePacket(2, SERVERDATA_RESPONSE_VALUE, "a reply that arrives in halves");
    const cut = Math.floor(whole.length / 2);

    const first = decodePackets(whole.subarray(0, cut));
    expect(first.packets).toHaveLength(0);
    expect(first.rest.length).toBe(cut);

    const second = decodePackets(Buffer.concat([first.rest, whole.subarray(cut)]));
    expect(second.packets.map((p) => p.body)).toEqual(["a reply that arrives in halves"]);
    expect(second.rest.length).toBe(0);
  });

  it("splits a buffer holding one and a half packets correctly", () => {
    const a = encodePacket(2, SERVERDATA_RESPONSE_VALUE, "first");
    const b = encodePacket(2, SERVERDATA_RESPONSE_VALUE, "second");
    const { packets, rest } = decodePackets(Buffer.concat([a, b.subarray(0, 6)]));
    expect(packets.map((p) => p.body)).toEqual(["first"]);
    expect(rest.length).toBe(6);
  });

  /**
   * A size field that cannot be a packet means the stream is out of sync. Reading on would
   * produce confident nonsense — misaligned int32s decoded as settings — which is worse than
   * timing out with what we have.
   */
  it("stops rather than inventing packets from a desynchronised stream", () => {
    const bad = Buffer.alloc(16);
    bad.writeInt32LE(3, 0); // impossibly small: size must be >= 10
    expect(decodePackets(bad).packets).toHaveLength(0);

    const huge = Buffer.alloc(16);
    huge.writeInt32LE(999_999, 0);
    expect(decodePackets(huge).packets).toHaveLength(0);
  });

  it("handles an empty body, which is a real packet and not an error", () => {
    const { packets } = decodePackets(encodePacket(2, SERVERDATA_RESPONSE_VALUE, ""));
    expect(packets).toEqual([{ id: 2, type: SERVERDATA_RESPONSE_VALUE, body: "" }]);
  });
});

describe("joinReply", () => {
  /** The whole point: 137 settings, not the first 79. */
  it("concatenates every packet of a multi-packet reply in order", () => {
    const packets = [
      { id: 2, type: SERVERDATA_RESPONSE_VALUE, body: "* A=1\n* B=2\n" },
      { id: 2, type: SERVERDATA_RESPONSE_VALUE, body: "* C=3\n* D=4\n" },
      { id: 2, type: SERVERDATA_RESPONSE_VALUE, body: "* E=5\n" },
    ];
    expect(joinReply(packets, 2)).toBe("* A=1\n* B=2\n* C=3\n* D=4\n* E=5\n");
  });

  /**
   * A naive client reads the auth reply as the first command's answer and every response
   * after it is shifted by one. That made `players` report 0 while somebody was connected
   * and the wrong reading got written down as fact — the reason `scripts/pz-rcon.sh` exists.
   */
  it("never lets another id's packet or an auth reply into the answer", () => {
    const packets = [
      { id: 1, type: SERVERDATA_AUTH_RESPONSE, body: "" }, // auth
      { id: 2, type: SERVERDATA_RESPONSE_VALUE, body: "ours" },
      { id: 3, type: SERVERDATA_RESPONSE_VALUE, body: "someone else's" },
    ];
    expect(joinReply(packets, 2)).toBe("ours");
  });

  it("returns empty rather than throwing when nothing matched", () => {
    expect(joinReply([], 2)).toBe("");
  });
});

describe("mayHaveMore", () => {
  it("flags a reply at the single-packet ceiling", () => {
    expect(mayHaveMore("x".repeat(MAX_PAYLOAD))).toBe(true);
    expect(mayHaveMore("x".repeat(100))).toBe(false);
  });

  /** Measured: the real reply is 6,789 bytes, so its first packet is at the ceiling. */
  it("flags the first packet of the measured PZ showoptions reply", () => {
    expect(mayHaveMore("x".repeat(4102))).toBe(true);
  });
});
