import { describe, it, expect } from "vitest";
import { isPathInside, looksBinary, unsafeZipPaths, zipMemberNames } from "../file-guard";

/**
 * Both of these predicates existed, three times each, and were wrong in all three copies.
 * The inputs below are the ones measured against production on 2026-09-29, so if a future
 * refactor reintroduces `startsWith` or a `"utf-8"` read, one of them fails immediately.
 */
describe("isPathInside", () => {
  it("rejects a sibling that merely shares the prefix", () => {
    // The live escape: `/api/7dtd/files?root=saves&path=/sevendtd-config` returned a 200
    // listing of the whole config tree, because `startsWith("/sevendtd")` is true here.
    expect(isPathInside("/sevendtd", "/sevendtd-config")).toBe(false);
    // Same shape in the web container's other pair of mounts.
    expect(isPathInside("/zomboid", "/zomboid-workshop")).toBe(false);
    expect(isPathInside("/minecraft", "/minecraft-old/x")).toBe(false);
  });

  it("accepts the root itself and anything beneath it", () => {
    expect(isPathInside("/sevendtd", "/sevendtd")).toBe(true);
    expect(isPathInside("/sevendtd", "/sevendtd/Saves/x")).toBe(true);
    // A trailing separator on the base must not change the answer.
    expect(isPathInside("/sevendtd/", "/sevendtd/Saves")).toBe(true);
  });

  it("normalises before comparing, so `..` cannot walk out", () => {
    expect(isPathInside("/sevendtd", "/sevendtd/Saves/../..")).toBe(false);
    expect(isPathInside("/sevendtd", "/sevendtd/Saves/../GeneratedWorlds")).toBe(true);
  });
});

describe("looksBinary", () => {
  it("is true for a gzip header", () => {
    // The first 8 bytes of the `world/level.dat` that the old code turned from 411 bytes
    // into 752 and reported `{"success":true}` for.
    expect(looksBinary(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]))).toBe(true);
  });

  it("is true for a lone continuation byte (invalid UTF-8, no NUL)", () => {
    // 0x80 alone is not valid UTF-8. Without the strict decoder this reads as U+FFFD and
    // the byte is gone for good on the next Save.
    expect(looksBinary(Buffer.from([0x80]))).toBe(true);
  });

  it("is true for a truncated multi-byte sequence", () => {
    expect(looksBinary(Buffer.from([0xe6, 0x97]))).toBe(true);
  });

  it("is false for plain text", () => {
    expect(looksBinary(Buffer.from("key=value\nother=1\n"))).toBe(false);
  });

  it("is false for valid multi-byte UTF-8", () => {
    expect(looksBinary(Buffer.from("séï — 日本語", "utf-8"))).toBe(false);
  });

  it("is false for an empty file", () => {
    // A zero-byte file is editable text; refusing it would break creating one.
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});

/**
 * Both listings below are **copied verbatim** from the web container's own `unzip -l`
 * (BusyBox v1.37.0), run on 2026-09-29 against zips built for the purpose. That matters:
 * the guard this replaces was written against an Info-ZIP listing format that this
 * container does not produce, and it never fired.
 */
const EVIL_LISTING = `Archive:  evil.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        1  00-00-1980 00:00   etc/agent7dtd-pwned
        1  00-00-1980 00:00   AgentWorldX/AgentSaveX/main.ttw
        4  00-00-1980 00:00   AgentWorldX/AgentSaveX/players.xml
 --------                     -------
        6                     3 files
`;
// The exact stderr BusyBox emitted, on the `-l` pass as well as the `-o` pass.
const EVIL_STDERR = "unzip: removing leading '../../../../' from member names\n";

const GOOD_LISTING = `Archive:  good.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        1  00-00-1980 00:00   AgentWorldX/AgentSaveX/main.ttw
        4  00-00-1980 00:00   AgentWorldX/AgentSaveX/players.xml
 --------                     -------
        5                     2 files
`;

describe("zipMemberNames", () => {
  it("excludes the header, the rules and the trailing total", () => {
    // The total row (`        6                     3 files`) is what `/^\\s*\\d+\\s/`
    // counted as a fourth file.
    expect(zipMemberNames(GOOD_LISTING)).toEqual([
      "AgentWorldX/AgentSaveX/main.ttw",
      "AgentWorldX/AgentSaveX/players.xml",
    ]);
    expect(zipMemberNames(EVIL_LISTING)).toHaveLength(3);
  });

  it("keeps names containing spaces intact", () => {
    const listing = `  Length      Date    Time    Name
---------  ---------- -----   ----
        1  00-00-1980 00:00   Reveo Valley/Fresh2/main.ttw
`;
    expect(zipMemberNames(listing)).toEqual(["Reveo Valley/Fresh2/main.ttw"]);
  });
});

describe("unsafeZipPaths", () => {
  it("rejects the traversal zip on the stderr notice, which is the only place it appears", () => {
    // The whole point: the *listing* is already sanitised, so stdout alone says "safe".
    expect(unsafeZipPaths(EVIL_LISTING, "")).toBe(false);
    expect(unsafeZipPaths(EVIL_LISTING, EVIL_STDERR)).toBe(true);
    // Fired from the listing pass, so nothing is extracted before the refusal.
    expect(unsafeZipPaths("", EVIL_STDERR)).toBe(true);
  });

  it("accepts an ordinary save zip", () => {
    expect(unsafeZipPaths(GOOD_LISTING, "")).toBe(false);
  });

  it("still rejects a non-leading `..`, an absolute member and backslashes", () => {
    const row = (name: string) =>
      `  Length      Date    Time    Name\n---------  ---------- -----   ----\n        1  00-00-1980 00:00   ${name}\n`;
    expect(unsafeZipPaths(row("world/../../etc/x"), "")).toBe(true);
    expect(unsafeZipPaths(row("/etc/x"), "")).toBe(true);
    expect(unsafeZipPaths(row("C:\\windows\\x"), "")).toBe(true);
    expect(unsafeZipPaths(row("..\\..\\etc\\x"), "")).toBe(true);
    // A file merely *named* with two dots is fine; only `..` as a whole segment is not.
    expect(unsafeZipPaths(row("world/main..ttw"), "")).toBe(false);
  });
});
