import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INFRA_KEYS, bareModId, parseIni, setIniValues, splitList } from "@/lib/zomboid";

/**
 * The Project Zomboid `.ini` parser and writer.
 *
 * This file IS the live server configuration — every setting, the mod list, the map list
 * and the RCON credentials the app controls the server through. A writer that drops a
 * line, mangles a value or loses the comments does not fail loudly; it produces a server
 * that boots with different rules, or one the app can no longer reach.
 *
 * The fixture is a real copy of the production `Server/yoshling.ini` taken 2026-09-29
 * (144 keys, 134 comment lines, 89 Workshop items). `RCONPassword` is the only secret it
 * contained and it is replaced with `REDACTED_FOR_FIXTURE`; `DiscordToken`, `Password`
 * and `ServerPlayerID` were already empty on the box.
 */
const INI = readFileSync(path.join(__dirname, "fixtures/pz-server.ini"), "utf-8");

describe("parseIni", () => {
  it("reads every key out of the real production config", () => {
    const props = parseIni(INI);
    // 144 `Key=` lines are in the fixture; the parser must not skip any of them.
    expect(props).toHaveLength(144);
    expect(new Set(props.map((p) => p.name)).size).toBe(144);
  });

  it("attaches the preceding comment as the help text", () => {
    // Both PZ's .ini and 7DTD's XML document themselves with a comment per setting, and
    // `config-panel.tsx` renders that as the only explanation a user gets.
    const pvp = parseIni(INI).find((p) => p.name === "PVP");
    expect(pvp?.value).toBe("true");
    expect(pvp?.help).toBe("Players can hurt and kill other players");
  });

  it("does not carry a comment across a blank line to an undocumented key", () => {
    // `ChatStreams` sits after a blank line in the fixture, so it has no help of its own.
    // Inheriting the previous setting's comment would explain the wrong control.
    const streams = parseIni(INI).find((p) => p.name === "ChatStreams");
    expect(streams?.value).toBe("s,r,a,w,y,sh,f,all");
    expect(streams?.help).toBe("");
  });

  it("keeps a value that legitimately contains ';'", () => {
    // `Map=` and `WorkshopItems=` are semicolon-separated lists. Splitting the LINE on ';'
    // instead of splitting the VALUE would truncate the map list to its first entry, which
    // on this box means silently dropping 20-odd map mods.
    const map = parseIni(INI).find((p) => p.name === "Map");
    expect(map?.value).toContain(";");
    expect(splitList(map!.value).length).toBeGreaterThan(5);
    expect(splitList(map!.value)[0]).toBe("map_distanciado");

    // 75 Workshop items yielding 87 mod ids on the live box — one item can ship several
    // mods, which is why those two numbers differ and why neither can be inferred from
    // the other.
    const items = parseIni(INI).find((p) => p.name === "WorkshopItems");
    expect(splitList(items!.value)).toHaveLength(75);
    expect(splitList(parseIni(INI).find((p) => p.name === "Mods")!.value)).toHaveLength(87);
    expect(splitList(map!.value)).toHaveLength(22);
  });

  it("keeps a value that legitimately contains '='", () => {
    // Split on the FIRST '=' only. `indexOf` vs `split("=")` is the whole difference, and
    // a value like a welcome message or an RGB tag routinely carries more of them.
    const props = parseIni("# help\nServerWelcomeMessage=a=b <RGB:1,0,0> c=d\n");
    expect(props).toHaveLength(1);
    expect(props[0].name).toBe("ServerWelcomeMessage");
    expect(props[0].value).toBe("a=b <RGB:1,0,0> c=d");
  });

  it("keeps an empty value rather than dropping the key", () => {
    // `Password=` and `DiscordToken=` are empty on this box. Dropping them would make the
    // settings page offer to "add" a key that is already there, and `setIniValues` would
    // then append a duplicate.
    const names = parseIni(INI).map((p) => p.name);
    expect(names).toContain("Password");
    expect(names).toContain("DiscordToken");
    expect(parseIni(INI).find((p) => p.name === "Password")?.value).toBe("");
  });

  it("ignores a comment line that itself contains '='", () => {
    const props = parseIni("# set Foo=bar to enable\nFoo=bar\n");
    expect(props).toHaveLength(1);
    expect(props[0].help).toBe("set Foo=bar to enable");
  });

  it("skips a line with no key, rather than emitting an empty name", () => {
    const props = parseIni("=orphan\nFoo=1\n");
    expect(props.map((p) => p.name)).toEqual(["Foo"]);
  });

  it("folds PZ's literal \\n escapes in its own comments into spaces", () => {
    const props = parseIni("# first\\nsecond\nFoo=1\n");
    expect(props[0].help).toBe("first second");
  });
});

describe("setIniValues", () => {
  it("changes only the named key and leaves every other byte alone", () => {
    const { text, applied } = setIniValues(INI, { PVP: "false" });
    expect(applied).toEqual(["PVP"]);

    const before = INI.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    const differing = before
      .map((line, i) => (line === after[i] ? null : i))
      .filter((i): i is number => i !== null);
    expect(differing).toHaveLength(1);
    expect(after[differing[0]]).toBe("PVP=false");
  });

  it("preserves every comment and blank line", () => {
    const { text } = setIniValues(INI, { PVP: "false", MaxPlayers: "16" });
    const comments = (s: string) => s.split("\n").filter((l) => l.startsWith("#"));
    expect(comments(text)).toEqual(comments(INI));
    expect(text.split("\n").filter((l) => l.trim() === "")).toHaveLength(
      INI.split("\n").filter((l) => l.trim() === "").length
    );
  });

  it("does not disturb a value containing ';' while editing a neighbour", () => {
    // The 89-item `WorkshopItems=` line and the map list are the two most expensive
    // things in this file to lose.
    const { text } = setIniValues(INI, { PVP: "false" });
    const before = parseIni(INI);
    const after = parseIni(text);
    for (const key of ["Map", "WorkshopItems", "Mods", "ServerWelcomeMessage"]) {
      expect(after.find((p) => p.name === key)?.value).toBe(
        before.find((p) => p.name === key)?.value
      );
    }
  });

  it("writes a value containing '=' back unchanged", () => {
    const { text } = setIniValues("Foo=1\n", { Foo: "a=b;c=d" });
    expect(text).toBe("Foo=a=b;c=d\n");
    expect(parseIni(text)[0].value).toBe("a=b;c=d");
  });

  it("appends a key that is not in the file yet", () => {
    // Still appends, and that is still required — the config import has to be able to put
    // `RCONPassword` into an uploaded .ini that lacks one. What changed (2026-10-01) is
    // that an appended key is reported as `appended` rather than folded into `applied`:
    // the settings editor could not otherwise tell "rewrote the line you asked about"
    // from "invented a line the game will ignore", and it reported the second as the
    // first for every unmatched key. The behaviour this asserts is unchanged; only the
    // field it is read from is more specific.
    const { text, applied, appended } = setIniValues("Foo=1", { Bar: "2" });
    expect(applied).toEqual([]);
    expect(appended).toEqual(["Bar"]);
    expect(text).toBe("Foo=1\nBar=2");
  });

  it("rewrites a key once, never twice", () => {
    const { text } = setIniValues(INI, { PVP: "false" });
    expect(text.split("\n").filter((l) => l.startsWith("PVP="))).toHaveLength(1);
  });

  it("strips a newline out of a value instead of splitting the file", () => {
    // A newline in a value would put the rest of it on its own line, where PZ reads it as
    // a key — silently corrupting whatever it happens to look like.
    const { text } = setIniValues("Foo=1\nBar=2\n", { Foo: "a\nEvil=yes" });
    expect(text.split("\n").filter((l) => l.startsWith("Evil="))).toHaveLength(0);
    expect(parseIni(text).find((p) => p.name === "Foo")?.value).toBe("a Evil=yes");
  });

  it("keeps CRLF files on CRLF", () => {
    // Mixing the two would rewrite every line of a Windows-authored config and make the
    // next diff useless.
    const { text } = setIniValues("Foo=1\r\nBar=2\r\n", { Foo: "9" });
    expect(text).toBe("Foo=9\r\nBar=2\r\n");
  });

  it("does not match a key that is only a prefix of another", () => {
    // `PVPLogToolChat` must not be hit by an edit to `PVP` — the anchored `KEY=` regex is
    // what stops it, and both keys really are in this file.
    const { text, applied } = setIniValues(INI, { PVP: "false" });
    expect(applied).toEqual(["PVP"]);
    expect(parseIni(text).find((p) => p.name === "PVPLogToolChat")?.value).toBe("true");
  });

  it("round-trips the whole file when nothing is changed", () => {
    const { text, applied } = setIniValues(INI, {});
    expect(applied).toEqual([]);
    expect(text).toBe(INI);
  });
});

describe("the deployment's own settings are known", () => {
  it("names the keys that must never be taken from an imported config", () => {
    // Importing someone else's RCON password or port numbers cuts the server off from the
    // app, or makes it listen where nothing is forwarded.
    expect(INFRA_KEYS).toContain("RCONPassword");
    expect(INFRA_KEYS).toContain("RCONPort");
    expect(INFRA_KEYS).toContain("DefaultPort");
    // And the live file really does carry the key the lock-out is about.
    expect(parseIni(INI).map((p) => p.name)).toContain("RCONPassword");
  });
});

describe("mod ids", () => {
  it("strips the build-42 backslash without touching the id", () => {
    expect(bareModId("\\Secretz42")).toBe("Secretz42");
    expect(bareModId("Secretz42")).toBe("Secretz42");
  });

  it("reads the real Mods= line as backslash-prefixed build-42 tokens", () => {
    const mods = splitList(parseIni(INI).find((p) => p.name === "Mods")!.value);
    expect(mods.length).toBeGreaterThan(80);
    expect(mods.every((m) => m.startsWith("\\"))).toBe(true);
    expect(mods.map(bareModId)).toContain("Secretz42");
  });

  it("drops empty entries from a trailing or doubled separator", () => {
    expect(splitList("a;;b;")).toEqual(["a", "b"]);
    expect(splitList("")).toEqual([]);
  });
});
