import { describe, it, expect } from "vitest";
import {
  ENVIRONMENT_INERT,
  PINNED_BY_DEPLOYMENT,
  annotateSdtdHelp,
  clampPlayerCount,
  normalizeSandboxCode,
  pinnedReason,
  readXmlProperty,
  sandboxCodeIssue,
} from "../sdtd-settings";

/**
 * Every code in this file was read off the production box on 2026-10-01, not invented:
 *
 * - `LIVE` — the `SandboxCode` property in `sdtdserver.xml` (94 characters), the preset
 *   this server is configured with.
 * - `FRESH_DEFAULT` — what a fresh SteamCMD install wrote, as printed by 22 boot logs.
 * - `OFFICIAL_EXAMPLE` — the example preset in the game's own
 *   `Data/Config/sandbox_overrides.xml`.
 * - `TRUNCATED_IN_ONE_LOG` — `LIVE` minus its last character, which exactly one of 23
 *   boot logs printed for both `GamePref.SandboxCode` and `Sandbox Code:`. Nothing
 *   explains it, which is why the length rule warns instead of refusing.
 */
const LIVE =
  "AAAGABGACGAPABACAWBAXBAZEAMIBUEBSEGCEGAEBFIBGIBHIBIBBKEBLEBNCCIDCJDCVDBZFDCDDDDDEDDFDDGDDJFEXF";
const FRESH_DEFAULT = "AAAJABJACJADJARFBNC";
const OFFICIAL_EXAMPLE = "ABEABTBBWADFP";
const TRUNCATED_IN_ONE_LOG = LIVE.slice(0, -1);

describe("sandbox code shape", () => {
  // The property: a code that exists on the box is accepted without complaint. If the
  // rule is ever tightened past what the game actually produces, these go red — which is
  // the only protection against a validator that refuses real input.
  for (const [label, code] of [
    ["the live preset (94 chars)", LIVE],
    ["the fresh-install default (19 chars)", FRESH_DEFAULT],
    ["the game's own example preset (13 chars)", OFFICIAL_EXAMPLE],
  ] as const) {
    it(`accepts ${label} with no error and no warning`, () => {
      expect(sandboxCodeIssue(code)).toEqual({});
      expect((code.length - 1) % 3).toBe(0);
    });
  }

  it("treats empty as unset rather than as a malformed code", () => {
    expect(sandboxCodeIssue("")).toEqual({});
  });

  it("warns about a length that cannot be a whole code, but does not refuse it", () => {
    const issue = sandboxCodeIssue(TRUNCATED_IN_ONE_LOG);
    expect(issue.error).toBeUndefined();
    expect(issue.warning).toBeTruthy();
    // The number in the message has to be the real length — a message that says "93" for
    // a 40-character code is the same species of lie as the toast this replaces.
    expect(issue.warning).toContain(String(TRUNCATED_IN_ONE_LOG.length));
  });

  it("refuses characters a sandbox code cannot contain, and names them", () => {
    // Digits were allowed through until now: the textarea stripped `[^A-Za-z0-9]`, so a
    // mis-paste containing a digit was stored and written to sdtdserver.xml as-is.
    const issue = sandboxCodeIssue("AAAGABG4CG");
    expect(issue.error).toBeTruthy();
    expect(issue.error).toContain("4");
    expect(issue.warning).toBeUndefined();
  });

  it("refuses rather than warns when a code is both malformed and the wrong length", () => {
    // Order matters: an error is actionable, a length warning on top of it is noise.
    const issue = sandboxCodeIssue("AB-");
    expect(issue.error).toBeTruthy();
    expect(issue.warning).toBeUndefined();
  });
});

describe("normalizeSandboxCode", () => {
  it("survives the way a code is actually pasted: wrapped across lines, with spaces", () => {
    const wrapped = `  ${LIVE.slice(0, 40)}\n${LIVE.slice(40)}\t`;
    expect(normalizeSandboxCode(wrapped)).toBe(LIVE);
    expect(sandboxCodeIssue(normalizeSandboxCode(wrapped))).toEqual({});
  });

  it("uppercases, because the alphabet is A-Z and case cannot carry meaning", () => {
    expect(normalizeSandboxCode(LIVE.toLowerCase())).toBe(LIVE);
  });

  it("keeps characters it cannot normalise instead of silently dropping them", () => {
    // Stripping them here would turn a mis-paste into a plausible-looking code and the
    // route would have nothing left to refuse.
    expect(normalizeSandboxCode("AB4C")).toBe("AB4C");
  });

  it("treats a missing value as empty rather than as the string 'undefined'", () => {
    expect(normalizeSandboxCode(undefined)).toBe("");
    expect(normalizeSandboxCode(null)).toBe("");
  });
});

describe("player count clamp", () => {
  it("reports the clamp instead of silently applying it", () => {
    // The measured defect: PUT maxPlayers=99 stored 16 and answered {success:true} with
    // nothing said, and the page kept showing 99.
    const r = clampPlayerCount(99, 8);
    expect(r.value).toBe(16);
    expect(r.note).toBeTruthy();
    expect(r.note).toContain("99");
    expect(r.note).toContain("16");
  });

  it("says nothing when the value was accepted as asked", () => {
    expect(clampPlayerCount(12, 8)).toEqual({ value: 12 });
    expect(clampPlayerCount(16, 8)).toEqual({ value: 16 });
  });

  it("clamps upward from below the floor, and says so", () => {
    const r = clampPlayerCount(0, 8);
    expect(r.value).toBe(1);
    expect(r.note).toBeTruthy();
  });

  it("falls back without a note when the key was not sent at all", () => {
    // A PUT that omits the field must keep the stored value and must not claim a clamp.
    expect(clampPlayerCount(undefined, 8)).toEqual({ value: 8 });
    expect(clampPlayerCount("", 8)).toEqual({ value: 8 });
  });
});

describe("properties the deployment owns", () => {
  it("pins both ports the compose port map fixes", () => {
    // 26900 and 8080 are published by docker-compose.yml; a container's port map is fixed
    // when it is created, so editing either number saves cleanly and makes the server
    // unreachable. TelnetPort was already hidden; these two were freely editable.
    expect(Object.keys(PINNED_BY_DEPLOYMENT).sort()).toEqual(["ServerPort", "WebDashboardPort"]);
    for (const why of Object.values(PINNED_BY_DEPLOYMENT)) expect(why.length).toBeGreaterThan(20);
  });

  it("labels every setting the host firewall makes inert", () => {
    // 8080 is DROPped at eth0 in DOCKER-USER by the yoshling-firewall unit, so the game's
    // web dashboard answers only on the box itself and map rendering feeds nothing.
    expect(Object.keys(ENVIRONMENT_INERT).sort()).toEqual([
      "EnableMapRendering",
      "WebDashboardEnabled",
      "WebDashboardPort",
      "WebDashboardUrl",
    ]);
  });

  it("puts the deployment's note in front of the game's own comment, keeping both", () => {
    const [annotated] = annotateSdtdHelp([
      { name: "EnableMapRendering", help: "Enable/disable rendering of how the map looks" },
    ]);
    expect(annotated.help).toContain("web dashboard");
    // The game documents itself with a comment per property — that is why one generic
    // panel serves 7DTD and PZ — so the note must add to it, not replace it.
    expect(annotated.help).toContain("Enable/disable rendering of how the map looks");
  });

  it("leaves every other property exactly as it came out of the file", () => {
    const input = [{ name: "ServerName", help: "Whatever you want the name to be" }];
    const [out] = annotateSdtdHelp(input);
    expect(out).toBe(input[0]);
  });

  it("does not double up when a property is both pinned and inert", () => {
    const [out] = annotateSdtdHelp([{ name: "WebDashboardPort", help: "Port of the web dashboard" }]);
    expect(out.help).toContain("8080");
    expect(out.help).toContain("Port of the web dashboard");
    // Idempotent: the GET annotates whatever it just parsed, and a value that has already
    // been through here must not grow a second copy of the note.
    const [again] = annotateSdtdHelp([out]);
    expect(again.help).toBe(out.help);
  });
});

describe("pinnedReason", () => {
  it("answers for the two ports the compose port map fixes", () => {
    expect(pinnedReason("ServerPort")).toContain("26900");
    expect(pinnedReason("WebDashboardPort")).toContain("8080");
  });

  it("answers undefined for a property that really is editable", () => {
    expect(pinnedReason("ServerName")).toBeUndefined();
  });

  it("does not treat an inherited Object key as pinned", () => {
    // The generic editor's keys come straight out of a request body, so a bare lookup made
    // `PUT {"toString":"x"}` refusable with a stringified function as the stated reason.
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(pinnedReason(name)).toBeUndefined();
    }
  });
});

describe("readXmlProperty", () => {
  // A slice of the real file's shape: property, self-closing tag, trailing comment.
  const xml = `<?xml version="1.0"?>
<ServerSettings>
  <property name="ServerName" value="Yoshling 7DTD"/> <!-- Whatever you want the name to be -->
  <property name="ServerPort" value="26900"/>
  <property name="ServerDescription" value="pass&amp;word &lt;here&gt;"/>
  <property name="SandboxCode" value="${LIVE}"/>
</ServerSettings>`;

  it("reads the value the quick settings page now shows instead of the DB copy", () => {
    expect(readXmlProperty(xml, "SandboxCode")).toBe(LIVE);
    expect(readXmlProperty(xml, "ServerPort")).toBe("26900");
  });

  it("unescapes, so the next save cannot escape the value a second time", () => {
    // The entity-doubling defect `sdtd-xml.ts` documents: the writer escapes, so a reader
    // that hands back raw attribute text makes every save add a level of entities.
    expect(readXmlProperty(xml, "ServerDescription")).toBe('pass&word <here>');
  });

  it("answers null for a property the file does not have, rather than guessing", () => {
    // `GameDifficulty` is the worked example: it is not in this server's 69 properties.
    expect(readXmlProperty(xml, "GameDifficulty")).toBeNull();
  });

  it("treats the name as a literal, not as a pattern", () => {
    // The generic editor passes names straight through from a request body, so `a.*b`
    // must not match a different property's line.
    expect(readXmlProperty(xml, "Server.*")).toBeNull();
  });
});
