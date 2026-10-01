import { describe, it, expect } from "vitest";
import {
  BAN_FOREVER,
  DEFAULT_BAN_REASON,
  DEFAULT_BAN_SOURCE,
  addIpBan,
  addPlayerBan,
  banCommand,
  banDrift,
  banMessage,
  banlistContains,
  banlistProves,
  buildIpBan,
  buildPlayerBan,
  checkBanTarget,
  classifyBanReply,
  isValidIpv4,
  isValidIpv6,
  mcBanDate,
  normalizeIp,
  pardonCommand,
  parseBanlist,
  parseBannedIpsFile,
  parseBannedPlayersFile,
  parseMcBanDate,
  removeIpBan,
  removePlayerBan,
  routeBanChange,
  sanitizeBanReason,
  sanitizeBanSource,
  serializeIpBans,
  serializePlayerBans,
  withCreatedIso,
} from "../mc-bans";
import { offlineUuid } from "../mc-identity";

/**
 * The oracle for the formats here is vanilla's own output: the `banned-*.json` field
 * set, the `SimpleDateFormat` both files use, and the command-feedback translation
 * strings. **None of it was exercised against the live 26.1.2 server** — this was built
 * offline — which is why the module treats the reply strings as advisory and why the
 * tests below spend most of their effort on the *failure* directions: an unrecognised
 * reply, a run-together reply, a corrupt file, a blank UUID. Those are the paths that
 * decide whether a wrong guess about the format turns into "could not confirm" or into
 * a confident lie.
 */

describe("isValidIpv4", () => {
  it("accepts the dotted quads that belong in banned-ips.json", () => {
    for (const ip of ["0.0.0.0", "1.2.3.4", "127.0.0.1", "255.255.255.255", "89.58.50.155"]) {
      expect(isValidIpv4(ip)).toBe(true);
    }
  });

  it("rejects out-of-range octets", () => {
    // The pattern vanilla's older ban-ip command used (`([0-9]{1,3}\.){3}[0-9]{1,3}`)
    // accepts every one of these, which is the reason not to copy it.
    expect(isValidIpv4("256.0.0.1")).toBe(false);
    expect(isValidIpv4("999.999.999.999")).toBe(false);
    expect(isValidIpv4("1.2.3.400")).toBe(false);
  });

  it("rejects the wrong number of octets", () => {
    expect(isValidIpv4("1.2.3")).toBe(false);
    expect(isValidIpv4("1.2.3.4.5")).toBe(false);
    expect(isValidIpv4("1.2.3.")).toBe(false);
    expect(isValidIpv4(".1.2.3")).toBe(false);
    expect(isValidIpv4("")).toBe(false);
  });

  it("rejects leading zeros, because their meaning depends on the parser", () => {
    // `010` is octal to inet_aton and decimal to a naive reader, so an entry written
    // this way may or may not match the peer it was meant to block.
    expect(isValidIpv4("127.000.000.001")).toBe(false);
    expect(isValidIpv4("01.2.3.4")).toBe(false);
    // A bare zero octet is still fine.
    expect(isValidIpv4("10.0.0.1")).toBe(true);
  });

  it("rejects things that are not addresses at all", () => {
    expect(isValidIpv4("1.2.3.4/24")).toBe(false);
    expect(isValidIpv4("example.com")).toBe(false);
    expect(isValidIpv4("1.2.3.-4")).toBe(false);
    expect(isValidIpv4("1.2.3.4 ")).toBe(false);
    expect(isValidIpv4("1e1.2.3.4")).toBe(false);
  });
});

describe("isValidIpv6", () => {
  it("accepts compressed, full and v4-tailed forms", () => {
    for (const ip of [
      "::",
      "::1",
      "fe80::1",
      "2001:db8::8a2e:370:7334",
      "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:1.2.3.4",
    ]) {
      expect(isValidIpv6(ip)).toBe(true);
    }
  });

  it("rejects malformed forms", () => {
    expect(isValidIpv6("1::2::3")).toBe(false);
    expect(isValidIpv6("gggg::1")).toBe(false);
    expect(isValidIpv6("1:2:3:4:5:6:7")).toBe(false);
    expect(isValidIpv6("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isValidIpv6("1:2:3:4:5:6:7:8::")).toBe(false);
    expect(isValidIpv6("12345::1")).toBe(false);
    expect(isValidIpv6("::ffff:999.1.1.1")).toBe(false);
    expect(isValidIpv6("")).toBe(false);
  });

  it("rejects a zone id, which is scoped to one interface", () => {
    expect(isValidIpv6("fe80::1%eth0")).toBe(false);
  });

  it("does not report an IPv4 address as IPv6", () => {
    // The two validators have to disagree about `1.2.3.4`, or `checkBanTarget` would
    // reach the IPv6 refusal for an address it should have accepted.
    expect(isValidIpv6("1.2.3.4")).toBe(false);
    expect(isValidIpv4("1.2.3.4")).toBe(true);
  });
});

describe("checkBanTarget", () => {
  it("accepts and trims a username", () => {
    expect(checkBanTarget("player", "  Notch  ")).toEqual({
      ok: true,
      kind: "player",
      target: "Notch",
    });
  });

  it("accepts and normalises an IPv4 address", () => {
    expect(checkBanTarget("ip", " 89.58.50.155 ")).toEqual({
      ok: true,
      kind: "ip",
      target: "89.58.50.155",
    });
  });

  it("rejects a bad username with the name in the message", () => {
    const r = checkBanTarget("player", "not a name");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a name");
  });

  it("rejects an unknown kind rather than guessing one", () => {
    expect(checkBanTarget("ipv6", "::1").ok).toBe(false);
    expect(checkBanTarget(undefined, "Notch").ok).toBe(false);
  });

  it("rejects a non-string target", () => {
    expect(checkBanTarget("ip", 12345).ok).toBe(false);
    expect(checkBanTarget("player", null).ok).toBe(false);
  });

  /**
   * The two refusals have to be *different* sentences. A valid IPv6 address rejected
   * with "not an IPv4 address" reads as a typo and gets retyped; naming it as IPv6 and
   * pointing at banning the account is the only answer that lets the user act.
   */
  it("distinguishes a valid IPv6 address from something that is not an address", () => {
    const six = checkBanTarget("ip", "2001:db8::1");
    expect(six.ok).toBe(false);
    if (!six.ok) {
      expect(six.error).toContain("IPv6");
      expect(six.error).toContain("account by name");
    }

    const junk = checkBanTarget("ip", "999.1.1.1");
    expect(junk.ok).toBe(false);
    if (!junk.ok) {
      expect(junk.error).toContain("not an IPv4 address");
      expect(junk.error).not.toContain("IPv6");
    }
  });
});

describe("sanitizeBanReason", () => {
  it("falls back to vanilla's own default for anything empty or non-string", () => {
    expect(sanitizeBanReason(undefined)).toBe(DEFAULT_BAN_REASON);
    expect(sanitizeBanReason("")).toBe(DEFAULT_BAN_REASON);
    expect(sanitizeBanReason("   ")).toBe(DEFAULT_BAN_REASON);
    expect(sanitizeBanReason(42)).toBe(DEFAULT_BAN_REASON);
    expect(sanitizeBanReason({ reason: "x" })).toBe(DEFAULT_BAN_REASON);
  });

  /**
   * The load-bearing one. A newline in the reason becomes an extra line in the
   * `banlist` reply, which is indistinguishable from a second ban entry — so it
   * corrupts the read-back that decides whether success is reported.
   */
  it("flattens newlines and control characters to single spaces", () => {
    expect(sanitizeBanReason("grief\ning\r\nspawn")).toBe("grief ing spawn");
    expect(sanitizeBanReason("a\tb")).toBe("a b");
    expect(sanitizeBanReason("a\u0000b")).toBe("a b");
    expect(sanitizeBanReason("  lots   of   space  ")).toBe("lots of space");
    for (const out of [sanitizeBanReason("x\ny"), sanitizeBanReason("x\r\ny")]) {
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\r");
    }
  });

  it("caps the length", () => {
    expect(sanitizeBanReason("z".repeat(500))).toHaveLength(150);
  });

  it("keeps an ordinary reason intact", () => {
    expect(sanitizeBanReason("Griefing the spawn area")).toBe("Griefing the spawn area");
  });
});

describe("sanitizeBanSource", () => {
  it("keeps a display name and flattens it", () => {
    expect(sanitizeBanSource("Yoshiane")).toBe("Yoshiane");
    expect(sanitizeBanSource(" Linn\nMarie ")).toBe("Linn Marie");
    expect(sanitizeBanSource("z".repeat(80))).toHaveLength(40);
  });

  /**
   * A different fallback from a reason's, and that is the whole reason this is a second
   * function: a blank display name becoming "Banned by an operator." would put the reason
   * text in the column that is supposed to say *which* operator.
   */
  it("falls back to a name, not to the reason default", () => {
    for (const input of [undefined, null, "", "   ", 7]) {
      expect(sanitizeBanSource(input)).toBe(DEFAULT_BAN_SOURCE);
      expect(sanitizeBanSource(input)).not.toBe(DEFAULT_BAN_REASON);
    }
  });
});

describe("mcBanDate / parseMcBanDate", () => {
  it("writes the yyyy-MM-dd HH:mm:ss Z form the ban files use", () => {
    expect(mcBanDate(new Date(Date.UTC(2026, 9, 1, 14, 33, 7)))).toBe("2026-10-01 14:33:07 +0000");
  });

  it("zero-pads every field", () => {
    // An unpadded month or hour is a string Java's SimpleDateFormat will not parse, and
    // an unparseable `created` silently becomes "now" on the next load.
    expect(mcBanDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02 03:04:05 +0000");
  });

  it("is independent of the host timezone", () => {
    // Pinned in UTC on purpose: the web container's TZ is not the game container's, and
    // a date that shifts between a laptop and the box is one that cannot be asserted.
    const d = new Date(Date.UTC(2026, 5, 15, 0, 0, 0));
    expect(mcBanDate(d).endsWith("+0000")).toBe(true);
    expect(mcBanDate(d)).toBe("2026-06-15 00:00:00 +0000");
  });

  it("round-trips through the parser", () => {
    const d = new Date(Date.UTC(2026, 9, 1, 14, 33, 7));
    expect(parseMcBanDate(mcBanDate(d))?.getTime()).toBe(d.getTime());
  });

  it("reads the non-UTC offset the game itself writes", () => {
    // The game writes its container-local offset. Same instant, different text.
    expect(parseMcBanDate("2026-10-01 16:33:07 +0200")?.toISOString()).toBe(
      "2026-10-01T14:33:07.000Z"
    );
    expect(parseMcBanDate("2026-10-01 10:33:07 -0400")?.toISOString()).toBe(
      "2026-10-01T14:33:07.000Z"
    );
  });

  it('returns null for "forever" and other non-dates', () => {
    // A caller that read a failed parse as "expired" would un-ban everyone, so the
    // permanent-ban literal must not look like a date.
    expect(parseMcBanDate(BAN_FOREVER)).toBeNull();
    expect(parseMcBanDate("")).toBeNull();
    expect(parseMcBanDate("2026-10-01")).toBeNull();
    expect(parseMcBanDate("2026-10-01 14:33:07")).toBeNull();
  });
});

describe("buildPlayerBan / buildIpBan", () => {
  const now = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));

  it("writes every field Minecraft reads, with a permanent expiry", () => {
    expect(buildPlayerBan({ name: "Notch", source: "Yoshiane", reason: "Griefing", now })).toEqual({
      uuid: "",
      name: "Notch",
      created: "2026-10-01 12:00:00 +0000",
      source: "Yoshiane",
      expires: BAN_FOREVER,
      reason: "Griefing",
    });
  });

  it("leaves the uuid blank for resolveEntryUuids to fill, and lowercases an IP", () => {
    // Blank *here* is correct and is caught downstream: `serializePlayerBans` refuses
    // it. Building a real-looking id in this function is what would make the bug
    // unreachable by the guard.
    expect(buildPlayerBan({ name: "Notch", source: "Rcon", now }).uuid).toBe("");
    expect(buildIpBan({ ip: " 10.0.0.1 ", source: "Rcon", now }).ip).toBe("10.0.0.1");
  });

  it("sanitizes the reason on the way in", () => {
    expect(buildIpBan({ ip: "1.2.3.4", source: "s", reason: "a\nb", now }).reason).toBe("a b");
    expect(buildPlayerBan({ name: "Notch", source: "s", now }).reason).toBe(DEFAULT_BAN_REASON);
  });
});

describe("withCreatedIso", () => {
  it("adds an ISO date the browser can format", () => {
    const [e] = withCreatedIso([{ created: "2026-10-01 16:33:07 +0200", name: "Notch" }]);
    expect(e.createdIso).toBe("2026-10-01T14:33:07.000Z");
    // The original fields survive — the page still shows the file's own text elsewhere.
    expect(e.created).toBe("2026-10-01 16:33:07 +0200");
    expect(e.name).toBe("Notch");
  });

  it("gives null rather than a fabricated date for anything unparseable", () => {
    // These files were written by an unknown chain of versions. A made-up date in an
    // audit column is worse than a blank one.
    expect(withCreatedIso([{ created: "" }])[0].createdIso).toBeNull();
    expect(withCreatedIso([{ created: "forever" }])[0].createdIso).toBeNull();
    expect(withCreatedIso([{ created: "yesterday" }])[0].createdIso).toBeNull();
  });

  it("does not mutate the entries it was given", () => {
    const input = [{ created: "2026-10-01 00:00:00 +0000" }];
    withCreatedIso(input);
    expect(input[0]).not.toHaveProperty("createdIso");
  });
});

describe("parseBannedPlayersFile", () => {
  it("reads the shape the game writes", () => {
    const raw = JSON.stringify([
      {
        uuid: "cec627a9-5bfb-3db1-82de-b433dc37d3c3",
        name: "LinnMarie",
        created: "2026-09-28 14:33:07 +0200",
        source: "Server",
        expires: "forever",
        reason: "Testing",
      },
    ]);
    const r = parseBannedPlayersFile(raw);
    expect(r.malformed).toBe(false);
    expect(r.skipped).toBe(0);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].uuid).toBe("cec627a9-5bfb-3db1-82de-b433dc37d3c3");
    expect(r.entries[0].source).toBe("Server");
  });

  it("treats an empty file as zero bans, not as a fault", () => {
    // `JSON.parse("")` throws, and the game leaves an empty file in some versions.
    for (const raw of ["", "   ", "\n"]) {
      expect(parseBannedPlayersFile(raw)).toEqual({ entries: [], skipped: 0, malformed: false });
    }
    expect(parseBannedPlayersFile("[]")).toEqual({ entries: [], skipped: 0, malformed: false });
  });

  /**
   * `malformed` is not cosmetic. A writer that saw `entries: []` from a corrupt file and
   * proceeded would replace a file full of bans with a file holding one — and the page
   * would then truthfully show that one, which is the destructive version of this
   * project's defect class.
   */
  it("flags a file that is not a JSON array instead of reporting zero bans", () => {
    for (const raw of ["{}", "not json", '{"uuid":"x"}', "null", '"a"']) {
      const r = parseBannedPlayersFile(raw);
      expect(r.malformed).toBe(true);
      expect(r.entries).toEqual([]);
    }
  });

  it("counts unreadable entries rather than dropping them silently", () => {
    const raw = JSON.stringify([
      { name: "Good", uuid: "cec627a9-5bfb-3db1-82de-b433dc37d3c3" },
      { name: "" },
      { uuid: "no-name-here" },
      "a string",
      null,
      42,
    ]);
    const r = parseBannedPlayersFile(raw);
    expect(r.malformed).toBe(false);
    expect(r.entries.map((e) => e.name)).toEqual(["Good"]);
    expect(r.skipped).toBe(5);
  });

  it("defaults the fields the game may have omitted", () => {
    const r = parseBannedPlayersFile(JSON.stringify([{ name: "Notch" }]));
    expect(r.entries[0]).toEqual({
      uuid: "",
      name: "Notch",
      created: "",
      source: "",
      expires: BAN_FOREVER,
      reason: DEFAULT_BAN_REASON,
    });
  });
});

describe("parseBannedIpsFile", () => {
  it("reads and normalises the ip", () => {
    const r = parseBannedIpsFile(JSON.stringify([{ ip: " 89.58.50.155 ", reason: "spam" }]));
    expect(r.entries[0].ip).toBe("89.58.50.155");
    expect(r.entries[0].reason).toBe("spam");
    expect(r.skipped).toBe(0);
  });

  it("flags malformed and counts skipped, the same way as the player file", () => {
    expect(parseBannedIpsFile("{}").malformed).toBe(true);
    const r = parseBannedIpsFile(JSON.stringify([{ ip: "1.2.3.4" }, { ip: "" }, {}]));
    expect(r.entries).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });
});

describe("serializePlayerBans", () => {
  const good = {
    uuid: offlineUuid("Notch"),
    name: "Notch",
    created: "2026-10-01 12:00:00 +0000",
    source: "Rcon",
    expires: BAN_FOREVER,
    reason: "Griefing",
  };

  it("writes the entry when the uuid is real", () => {
    const r = serializePlayerBans([good]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual([good]);
  });

  /**
   * The one guarantee this function exists for. `whitelist.json` and `ops.json` were
   * written with `uuid: ""` for months and the game discards such entries — for a ban
   * that means the page shows the ban and the player keeps connecting. Here it is a
   * refusal, not a convention.
   */
  it('refuses uuid: "" — the value that caused the whitelist and ops bug', () => {
    const r = serializePlayerBans([{ ...good, uuid: "" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Notch");
      expect(r.error).toContain("UUID");
    }
  });

  it("refuses an undashed or otherwise unusable uuid", () => {
    // Minecraft writes the 8-4-4-4-12 form; a bare 32-hex id is not what it matches.
    expect(serializePlayerBans([{ ...good, uuid: offlineUuid("Notch").replace(/-/g, "") }]).ok).toBe(
      false
    );
    expect(serializePlayerBans([{ ...good, uuid: "not-a-uuid" }]).ok).toBe(false);
  });

  it("refuses a bad name even when the uuid is well-formed", () => {
    expect(serializePlayerBans([{ ...good, name: "not a name" }]).ok).toBe(false);
    expect(serializePlayerBans([{ ...good, name: "" }]).ok).toBe(false);
  });

  it("refuses the whole write when any one entry is bad", () => {
    // All-or-nothing, like `resolveEntryUuids`: a partial write is the same
    // silent-nothing failure, just harder to notice.
    expect(serializePlayerBans([good, { ...good, name: "Jeb", uuid: "" }]).ok).toBe(false);
  });

  it("accepts an empty list, so the last ban can be lifted", () => {
    const r = serializePlayerBans([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual([]);
  });
});

describe("serializeIpBans", () => {
  const good = {
    ip: "1.2.3.4",
    created: "2026-10-01 12:00:00 +0000",
    source: "Rcon",
    expires: BAN_FOREVER,
    reason: "spam",
  };

  it("writes a valid address", () => {
    expect(serializeIpBans([good]).ok).toBe(true);
  });

  it("refuses an address the game could never match", () => {
    for (const ip of ["", "999.1.1.1", "1.2.3", "example.com", "1.2.3.4/24", "::1"]) {
      expect(serializeIpBans([{ ...good, ip }]).ok).toBe(false);
    }
  });
});

describe("list edits", () => {
  const notch = buildPlayerBan({ name: "Notch", source: "s", now: new Date(0) });
  const jeb = buildPlayerBan({ name: "jeb_", source: "s", now: new Date(0) });

  it("adds a new name and reports it", () => {
    const r = addPlayerBan([notch], jeb);
    expect(r.added).toBe(true);
    expect(r.list.map((e) => e.name)).toEqual(["Notch", "jeb_"]);
  });

  /**
   * `added: false` is what lets the route say "already banned, nothing changed" instead
   * of reporting a success for a no-op write — and it stops the list growing a duplicate
   * entry the game would hold twice.
   */
  it("reports a duplicate instead of appending it, case-insensitively", () => {
    const lower = buildPlayerBan({ name: "notch", source: "s", now: new Date(0) });
    const r = addPlayerBan([notch], lower);
    expect(r.added).toBe(false);
    expect(r.list).toHaveLength(1);
    expect(r.list[0].name).toBe("Notch");
  });

  it("removes by name, case-insensitively, and counts what went", () => {
    const r = removePlayerBan([notch, jeb], "NOTCH");
    expect(r.removed).toBe(1);
    expect(r.list.map((e) => e.name)).toEqual(["jeb_"]);
  });

  it("reports removed: 0 for a name that was not banned", () => {
    // Without this the route would answer "Unbanned Steve" for a player who was never
    // banned — a success message for work that did not happen.
    const r = removePlayerBan([notch], "Steve");
    expect(r.removed).toBe(0);
    expect(r.list).toHaveLength(1);
  });

  it("removes every copy if a hand-edited file holds duplicates", () => {
    expect(removePlayerBan([notch, notch], "Notch").removed).toBe(2);
  });

  it("does the same for IPs, matching on the normalised form", () => {
    const a = buildIpBan({ ip: "1.2.3.4", source: "s", now: new Date(0) });
    expect(addIpBan([a], a).added).toBe(false);
    expect(addIpBan([], a).added).toBe(true);
    expect(removeIpBan([a], " 1.2.3.4 ").removed).toBe(1);
    expect(removeIpBan([a], "4.3.2.1").removed).toBe(0);
  });

  it("does not mutate the list it was given", () => {
    const list = [notch];
    addPlayerBan(list, jeb);
    removePlayerBan(list, "Notch");
    expect(list.map((e) => e.name)).toEqual(["Notch"]);
  });
});

describe("banCommand / pardonCommand", () => {
  it("builds the four vanilla commands", () => {
    expect(banCommand("player", "Notch", "Griefing")).toBe("ban Notch Griefing");
    expect(banCommand("ip", "1.2.3.4", "spam")).toBe("ban-ip 1.2.3.4 spam");
    expect(pardonCommand("player", "Notch")).toBe("pardon Notch");
    expect(pardonCommand("ip", "1.2.3.4")).toBe("pardon-ip 1.2.3.4");
  });

  it("supplies vanilla's default reason when none was given", () => {
    expect(banCommand("player", "Notch")).toBe(`ban Notch ${DEFAULT_BAN_REASON}`);
  });

  /**
   * Sanitizing inside the builder rather than at the call site means there is no
   * ordering a caller can get wrong that puts a newline into a command whose reply this
   * module then has to parse.
   */
  it("sanitizes the reason itself, so a newline cannot reach the command", () => {
    const cmd = banCommand("player", "Notch", "grief\ning\nspawn");
    expect(cmd).toBe("ban Notch grief ing spawn");
    expect(cmd).not.toContain("\n");
  });

  it("trims and normalises the target it was handed", () => {
    expect(banCommand("player", "  Notch  ", "x")).toBe("ban Notch x");
    expect(pardonCommand("ip", " 10.0.0.1 ")).toBe("pardon-ip 10.0.0.1");
  });

  it("throws rather than send a command for an invalid target", () => {
    // A backstop, not the gate — `checkBanTarget` is the gate and answers 400. Reaching
    // here means a caller skipped it, which is worth a stack trace.
    expect(() => banCommand("player", "not a name")).toThrow(/not a valid Minecraft username/);
    expect(() => banCommand("ip", "999.1.1.1")).toThrow(/not an IPv4/);
    expect(() => pardonCommand("ip", "2001:db8::1")).toThrow(/IPv6/);
  });
});

describe("classifyBanReply", () => {
  it("recognises the success replies", () => {
    expect(classifyBanReply("Banned Notch: Griefing")).toBe("applied");
    expect(classifyBanReply("Banned IP 1.2.3.4: spamThis ban affects 0 player(s): ")).toBe(
      "applied"
    );
    expect(classifyBanReply("Unbanned Notch")).toBe("applied");
    expect(classifyBanReply("Unbanned IP 1.2.3.4")).toBe("applied");
  });

  it("separates 'already in that state' from a failure", () => {
    expect(classifyBanReply("Nothing changed. The player is already banned")).toBe("already");
    expect(classifyBanReply("Nothing changed. That IP is already banned")).toBe("already");
    expect(classifyBanReply("Nothing changed. The player isn't banned")).toBe("notBanned");
    expect(classifyBanReply("Nothing changed. That IP isn't banned")).toBe("notBanned");
    // Some locales phrase the contraction out.
    expect(classifyBanReply("Nothing changed. That IP is not banned")).toBe("notBanned");
  });

  it("recognises the two argument failures", () => {
    expect(classifyBanReply("The IP address you entered is invalid or the player is not online")).toBe(
      "invalidAddress"
    );
    expect(classifyBanReply("No player was found")).toBe("noSuchPlayer");
  });

  /**
   * The important case. These are translation strings, so a version bump or a locale
   * change can make every pattern above stop matching at once — and that has to come
   * out as "I don't know", never as "applied".
   */
  it("answers unrecognised for anything it does not know, including empty", () => {
    expect(classifyBanReply("")).toBe("unrecognised");
    expect(classifyBanReply("   ")).toBe("unrecognised");
    expect(classifyBanReply("Gesperrt Notch: Griefing")).toBe("unrecognised");
    expect(classifyBanReply("Unknown or incomplete command")).toBe("unrecognised");
  });

  /**
   * Two separate guards, pinned separately because each one alone made the other's test
   * pass. The first version asserted only that "…is already banned" is not `"applied"`,
   * which the *ordering* satisfies on its own — so unanchoring the success pattern left it
   * green. Found by mutation-checking it.
   */
  it("checks the 'Nothing changed' variants before the generic success pattern", () => {
    // Both of these contain the word; neither is a success.
    expect(classifyBanReply("Nothing changed. The player is already banned")).toBe("already");
    expect(classifyBanReply("Nothing changed. That IP isn't banned")).toBe("notBanned");
  });

  it("only treats a reply that *starts* with the verb as a success", () => {
    // Anchored so a reply that merely mentions a ban cannot read as one having been
    // applied. The cost is a possible false *negative* — a version that printed vanilla's
    // "this ban affects N player(s)" line first would come out `unrecognised` — and that is
    // the safe direction, because the banlist read-back decides the outcome and is
    // unaffected by it.
    expect(classifyBanReply("This ban affects 1 player(s): NotchBanned IP 1.2.3.4: spam")).toBe(
      "unrecognised"
    );
    expect(classifyBanReply("Could not be Banned right now")).toBe("unrecognised");
  });
});

describe("parseBanlist", () => {
  it("reads an empty list", () => {
    const r = parseBanlist("There are no bans");
    expect(r).toMatchObject({ count: 0, entries: [], separated: true, recognised: true });
  });

  it("reads a newline-separated list", () => {
    const r = parseBanlist(
      "There are 2 ban(s):\nNotch was banned by Rcon: Griefing\njeb_ was banned by Server: Testing"
    );
    expect(r.count).toBe(2);
    expect(r.separated).toBe(true);
    expect(r.entries).toEqual([
      { target: "Notch", source: "Rcon", reason: "Griefing" },
      { target: "jeb_", source: "Server", reason: "Testing" },
    ]);
  });

  it("handles \\r\\n and an IP list", () => {
    const r = parseBanlist("There are 1 ban(s):\r\n1.2.3.4 was banned by Rcon: spam\r\n");
    expect(r.count).toBe(1);
    expect(r.entries).toEqual([{ target: "1.2.3.4", source: "Rcon", reason: "spam" }]);
  });

  it("takes the shortest source, so a colon in the reason is kept in the reason", () => {
    const r = parseBanlist("There are 1 ban(s):\nNotch was banned by Rcon: see ticket: 42");
    expect(r.entries[0]).toEqual({ target: "Notch", source: "Rcon", reason: "see ticket: 42" });
  });

  /**
   * The case that drove the design. Minecraft's RCON console source appends each
   * feedback message to one buffer, and multi-message replies are widely reported to
   * come back with no separator. Entry boundaries are then genuinely unrecoverable —
   * the end of one reason abuts the start of the next name — so the header count is
   * cross-checked against the parse, and a mismatch drops the entries rather than
   * publishing a greedy mis-read as fact.
   */
  it("refuses to publish entries from a run-together reply", () => {
    const r = parseBanlist(
      "There are 2 ban(s):Notch was banned by Rcon: Griefingjeb_ was banned by Server: Testing"
    );
    expect(r.count).toBe(2);
    expect(r.separated).toBe(false);
    expect(r.entries).toEqual([]);
    expect(r.recognised).toBe(true);
    // The count is still trustworthy, and the contains-check still works — which is
    // why those two are what the route relies on.
    expect(banlistContains(r, "Notch")).toBe(true);
    expect(banlistContains(r, "jeb_")).toBe(true);
  });

  it("accepts a single-entry run-together reply, where the parse is unambiguous", () => {
    const r = parseBanlist("There are 1 ban(s):Notch was banned by Rcon: Griefing");
    expect(r.separated).toBe(true);
    expect(r.entries).toEqual([{ target: "Notch", source: "Rcon", reason: "Griefing" }]);
  });

  it("drops entries when the count disagrees with what parsed", () => {
    // A header of 3 with 2 readable lines means something was lost. Reporting the two
    // as the whole list is how "the ban is missing from the page" gets blamed on the page.
    const r = parseBanlist(
      "There are 3 ban(s):\nNotch was banned by Rcon: a\njeb_ was banned by Rcon: b"
    );
    expect(r.count).toBe(3);
    expect(r.separated).toBe(false);
    expect(r.entries).toEqual([]);
  });

  it("marks an unrecognised reply rather than calling it empty", () => {
    // "Not a banlist answer" and "no bans" must not collapse: a 503 or a localised
    // reply would otherwise render as an empty, healthy ban list.
    for (const raw of ["", "Unknown or incomplete command", "Es gibt keine Sperren"]) {
      const r = parseBanlist(raw);
      expect(r.recognised).toBe(false);
      expect(r.count).toBeNull();
      expect(r.entries).toEqual([]);
    }
  });
});

describe("banlistContains", () => {
  const two = parseBanlist(
    "There are 2 ban(s):\nNotch was banned by Rcon: Griefing\n1.2.3.4 was banned by Rcon: spam"
  );

  it("finds a banned name and a banned ip", () => {
    expect(banlistContains(two, "Notch")).toBe(true);
    expect(banlistContains(two, "1.2.3.4")).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding space", () => {
    // The operator types `notch`; the server prints the profile's canonical `Notch`.
    expect(banlistContains(two, "notch")).toBe(true);
    expect(banlistContains(two, "  NOTCH  ")).toBe(true);
  });

  it("does not find something that is absent", () => {
    expect(banlistContains(two, "Steve")).toBe(false);
    expect(banlistContains(two, "1.2.3.5")).toBe(false);
  });

  it("requires the full phrase, not a bare mention of the name", () => {
    // A name inside someone else's ban *reason* must not read as that name being banned.
    const r = parseBanlist("There are 1 ban(s):\njeb_ was banned by Rcon: impersonating Notch");
    expect(banlistContains(r, "jeb_")).toBe(true);
    expect(banlistContains(r, "Notch")).toBe(false);
  });

  it("answers false for an unrecognised reply instead of guessing", () => {
    expect(banlistContains(parseBanlist("Unknown command"), "Notch")).toBe(false);
    expect(banlistContains(parseBanlist(""), "Notch")).toBe(false);
  });

  /**
   * The case that distinguishes the `recognised` guard from nothing at all. A reply with
   * no header but an entry-shaped line *does* contain the phrase, so without the guard
   * this would read a reply the parser could not vouch for as positive evidence. The
   * first version of these tests only used replies that lacked the phrase too, so
   * deleting the guard left every one of them green — found by mutation-checking it.
   */
  it("will not treat a header-less reply as evidence, even when it holds the phrase", () => {
    const headerless = parseBanlist("Notch was banned by Rcon: Griefing");
    expect(headerless.recognised).toBe(false);
    expect(headerless.raw).toContain("was banned by");
    expect(banlistContains(headerless, "Notch")).toBe(false);
  });
});

describe("banlistProves", () => {
  const two = parseBanlist(
    "There are 2 ban(s):\nNotch was banned by Rcon: a\n1.2.3.4 was banned by Rcon: b"
  );

  it("proves a ban by presence and a pardon by absence", () => {
    expect(banlistProves("ban", two, "Notch")).toBe(true);
    expect(banlistProves("pardon", two, "Steve")).toBe(true);
  });

  it("disproves a ban that is absent and a pardon that is still listed", () => {
    expect(banlistProves("ban", two, "Steve")).toBe(false);
    expect(banlistProves("pardon", two, "Notch")).toBe(false);
  });

  /**
   * The asymmetry this function exists for. Written inline as
   * `action === "ban" ? present : !present`, an unreadable reply makes `present` false
   * and so *confirms* a pardon — a green toast for a player who is still banned. Both
   * directions have to answer "I don't know".
   */
  it("proves nothing from a reply it could not read, in either direction", () => {
    for (const raw of ["", "Unknown or incomplete command", "Notch was banned by Rcon: a"]) {
      const reply = parseBanlist(raw);
      expect(banlistProves("ban", reply, "Notch")).toBeNull();
      expect(banlistProves("pardon", reply, "Notch")).toBeNull();
    }
  });

  it("proves a pardon against an empty list", () => {
    // "There are no bans" is readable and says the target is gone, which is a real proof
    // and must not be lumped in with the unreadable case above.
    expect(banlistProves("pardon", parseBanlist("There are no bans"), "Notch")).toBe(true);
    expect(banlistProves("ban", parseBanlist("There are no bans"), "Notch")).toBe(false);
  });
});

describe("routeBanChange", () => {
  /**
   * Running → RCON, stopped → file, never a fall-back. Getting this backwards is the
   * silent failure the whole module is shaped around: the game rewrites both files from
   * its in-memory list, so a file edit made while it is up is an edit with a delete
   * scheduled behind it.
   */
  it("sends a change to RCON when the server is up and answering", () => {
    const r = routeBanChange({ containerRunning: true, rconAnswering: true });
    expect(r.path).toBe("rcon");
    expect(r.why).toContain("in effect now");
    expect(r.error).toBe("");
  });

  it("writes the file only when the container is down and RCON is silent", () => {
    const r = routeBanChange({ containerRunning: false, rconAnswering: false });
    expect(r.path).toBe("file");
    expect(r.why).toContain("next start");
    expect(r.error).toBe("");
  });

  /**
   * The fail-direction that matters. `containerState` answers `"missing"` for any
   * `docker inspect` failure — a broken socket, a renamed container — so
   * `containerRunning === false` is a *report*, not evidence. A live RCON socket is
   * proof the game is up, and taking the file path against that proof is the write that
   * silently disappears when the game next saves its list.
   */
  it("trusts a live RCON socket over docker reporting the container stopped", () => {
    expect(routeBanChange({ containerRunning: false, rconAnswering: true }).path).toBe("rcon");
  });

  it("refuses 'container up, RCON silent' instead of falling back to the file", () => {
    // The third reachability state `a7d76b8` named for the power controls. A file write
    // here would be discarded, so the refusal has to say so.
    const r = routeBanChange({ containerRunning: true, rconAnswering: false });
    expect(r.path).toBe("refuse");
    expect(r.error).toContain("rewrites");
    expect(r.error).toContain("Nothing was written");
    expect(r.error).toContain("Restart");
  });

  it("never answers 'file' while anything says the server might be up", () => {
    // The whole table in one assertion, so a future edit cannot quietly widen the one
    // path whose failure is silent.
    for (const containerRunning of [true, false]) {
      for (const rconAnswering of [true, false]) {
        const r = routeBanChange({ containerRunning, rconAnswering });
        if (r.path === "file") {
          expect(containerRunning).toBe(false);
          expect(rconAnswering).toBe(false);
        }
      }
    }
  });
});

describe("banMessage", () => {
  const base = { action: "ban", kind: "player", target: "Notch", path: "rcon" } as const;

  it("says a confirmed RCON ban is in effect now", () => {
    const m = banMessage({ ...base, verified: true });
    expect(m).toContain("Banned Notch");
    expect(m).toContain("confirms it");
  });

  /**
   * The file path must never claim the ban is in effect — the server is stopped, so
   * there is nothing for it to be in effect on. "A ban that silently does not take
   * effect until the next restart" is the exact failure being avoided, and the fix is
   * to say which it is.
   */
  it("says a file write applies at the next start, never that it is applied now", () => {
    const m = banMessage({ ...base, path: "file", verified: true });
    expect(m).toContain("banned-players.json");
    expect(m).toContain("next time it starts");
    expect(m).not.toMatch(/applied|in effect|now\b/i);
  });

  it("names the right file for an IP ban", () => {
    const m = banMessage({ action: "ban", kind: "ip", target: "1.2.3.4", path: "file", verified: true });
    expect(m).toContain("IP 1.2.3.4");
    expect(m).toContain("banned-ips.json");
  });

  it("never claims success when the read-back did not confirm it", () => {
    for (const path of ["rcon", "file"] as const) {
      const m = banMessage({ ...base, path, verified: false });
      expect(m).toMatch(/not confirmed/);
      expect(m).not.toContain("Banned Notch.");
    }
  });

  it("distinguishes 'read it back and it is not there' from 'could not read it back'", () => {
    // Two different problems: the first means the command did nothing, the second means
    // we cannot tell. Collapsing them sends the operator to the wrong place.
    const contradicted = banMessage({ ...base, verified: false, contradicted: true });
    const unread = banMessage({ ...base, verified: false });
    expect(contradicted).toContain("did not take effect");
    expect(contradicted).toContain("check the console");
    expect(unread).toContain("couldn't be read back");
    expect(unread).not.toContain("did not take effect");
  });

  it("reports a no-op as a no-op, in both directions", () => {
    expect(banMessage({ ...base, verified: true, noop: true })).toBe(
      "Notch was already banned. Nothing changed."
    );
    expect(banMessage({ ...base, action: "pardon", verified: true, noop: true })).toBe(
      "Notch wasn't banned. Nothing changed."
    );
  });

  it("uses the pardon verb when unbanning", () => {
    expect(banMessage({ ...base, action: "pardon", verified: true })).toContain("Unbanned Notch");
  });
});

describe("banDrift", () => {
  const live = parseBanlist(
    "There are 2 ban(s):\nNotch was banned by Rcon: a\njeb_ was banned by Rcon: b"
  );

  it("reports no drift when the file and the server agree", () => {
    expect(banDrift(["Notch", "jeb_"], live)).toEqual({ notEnforced: [], extraLive: 0 });
  });

  /**
   * The whole point, and the same shape as the memory card's configured-vs-live
   * comparison: a ban that is on disk but not in the running server's list is one the
   * page shows and the server is not enforcing — exactly what a file edit made while it
   * was up leaves behind.
   */
  it("names file entries the running server is not enforcing", () => {
    expect(banDrift(["Notch", "Steve"], live)).toEqual({
      notEnforced: ["Steve"],
      extraLive: 1,
    });
  });

  it("counts live bans the file does not account for", () => {
    expect(banDrift(["Notch"], live)).toEqual({ notEnforced: [], extraLive: 1 });
    expect(banDrift([], live)).toEqual({ notEnforced: [], extraLive: 2 });
  });

  /**
   * The clamp, reached by a reply whose header disagrees with its body — header says one
   * ban, two entry phrases are present. `1 - 2` is −1, and "−1 extra bans" is not a
   * sentence. The first version of this test used a *consistent* one-ban reply, where
   * `count` and `enforced` are both 1 and the subtraction is 0 either way, so removing the
   * clamp left it green. Found by mutation-checking it.
   */
  it("never reports a negative surplus when the reply's header undercounts its body", () => {
    const inconsistent = parseBanlist(
      "There are 1 ban(s):\nNotch was banned by Rcon: a\njeb_ was banned by Rcon: b"
    );
    expect(inconsistent.count).toBe(1);
    expect(banDrift(["Notch", "jeb_"], inconsistent)).toEqual({ notEnforced: [], extraLive: 0 });
  });

  it("claims no surplus when the reply could not be read", () => {
    // An unreadable reply is not evidence about the server's list. It makes every file
    // entry look unenforced, which is honest, but it must not also invent a surplus.
    const bad = parseBanlist("Unknown command");
    expect(banDrift(["Notch"], bad)).toEqual({ notEnforced: ["Notch"], extraLive: 0 });
    expect(banDrift([], bad)).toEqual({ notEnforced: [], extraLive: 0 });
  });

  it("matches case-insensitively, so canonical casing is not read as drift", () => {
    expect(banDrift(["notch", "JEB_"], live).notEnforced).toEqual([]);
  });
});

describe("normalizeIp", () => {
  it("trims and case-folds so file comparisons are string equality", () => {
    expect(normalizeIp("  1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("FE80::1")).toBe("fe80::1");
  });
});
