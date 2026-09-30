import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEnvFile,
  patchEnvFile,
  patchServiceEnv,
  readServiceEnv,
  resolveEnvRefs,
} from "@/lib/compose";

/**
 * The `.env` patcher and compose's `${VAR:-default}` resolution — the pair that ends
 * the `docker-compose.yml` ownership fight.
 *
 * ## What it replaces, and what went wrong before
 *
 * The dashboard used to patch compose directly: the memory card wrote `MEMORY` /
 * `MAX_MEMORY`, the Minecraft settings page wrote `TYPE` / `VERSION`. Compose is tracked
 * in git and the deploy runs `git checkout -f -B main FETCH_HEAD`, so every deploy
 * reverted all of it — undone by hand once (`f0cf692`), then made loud (`deploy.sh`
 * refuses and prints the diff) but never closed.
 *
 * So the values moved to `.env`, which is gitignored, and compose interpolates them.
 * That trades one failure mode for a different one, and these tests are about the new
 * one: a write into `.env` proves nothing unless the compose line really reads that key.
 *
 * Tested against the repository's own `docker-compose.yml` rather than a copy, so the
 * suite cannot drift away from the file it protects. That is the same choice
 * `tests/compose.test.ts` makes, for the same reason.
 */
const COMPOSE = readFileSync(
  path.join(__dirname, "..", "..", "..", "docker-compose.yml"),
  "utf-8"
);

/**
 * The values production is running right now, read off the box 2026-09-30:
 * `yoshling-mc` has TYPE=FABRIC VERSION=26.1.2 MEMORY=4G, `yoshling-pz` has
 * MAX_MEMORY=12288m MIN_MEMORY=2048m, and `/opt/yoshling/.env` contains **none** of the
 * new keys.
 *
 * Which makes this the load-bearing assertion of the whole change: if the compose
 * defaults do not equal these, the next deploy silently resizes a heap or changes a
 * Minecraft version. A test is the only place that claim can keep being checked.
 */
const PRODUCTION_DEFAULTS: Array<[service: string, key: string, value: string]> = [
  ["minecraft", "TYPE", "FABRIC"],
  ["minecraft", "VERSION", "26.1.2"],
  ["minecraft", "MEMORY", "4G"],
  ["zomboid", "MAX_MEMORY", "12288m"],
  ["zomboid", "MIN_MEMORY", "2048m"],
  ["sevendtd", "START_MODE", "1"],
  ["sevendtd", "VERSION", "latest_experimental"],
];

describe("compose defaults equal what production is running", () => {
  it.each(PRODUCTION_DEFAULTS)(
    "%s.%s falls back to %s with no .env at all",
    (service, key, value) => {
      expect(readServiceEnv(COMPOSE, service, key, {})).toBe(value);
    }
  );

  it("every UI-owned key is a ${VAR:-default} reference, not a literal", () => {
    // The point of the change. A literal here is a value the app cannot set without
    // writing compose, and writing compose is what the deploy throws away.
    for (const [service, key] of [
      ["minecraft", "TYPE"],
      ["minecraft", "VERSION"],
      ["minecraft", "MEMORY"],
      ["zomboid", "MAX_MEMORY"],
    ] as const) {
      const block = COMPOSE.slice(COMPOSE.indexOf(`\n  ${service}:`));
      const line = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(block)?.[1];
      expect(line, `${service}.${key}`).toMatch(/^"\$\{[A-Z_]+:-.*\}"$/);
    }
  });

  it("uses `:-` and never bare `-`, so an emptied key still boots", () => {
    // `${MC_MEMORY-4G}` falls back only when the key is absent. A truncated write
    // leaving `MC_MEMORY=` would then hand the JVM a blank -Xmx; `:-` treats empty as
    // unset and boots on 4G instead.
    expect(COMPOSE).not.toMatch(/\$\{(MC_|PZ_)[A-Z_]+-[^}]/);
  });
});

describe("resolveEnvRefs follows compose's own rules", () => {
  it("prefers the env value over the default", () => {
    expect(resolveEnvRefs("${MC_MEMORY:-4G}", { MC_MEMORY: "6G" })).toBe("6G");
  });

  it("falls back when the key is missing", () => {
    expect(resolveEnvRefs("${MC_MEMORY:-4G}", {})).toBe("4G");
  });

  it("`:-` falls back on an EMPTY value, `-` does not", () => {
    // The distinction is the reason compose is written with `:-`. Getting it backwards
    // turns a half-written `.env` line into an unbootable JVM flag.
    expect(resolveEnvRefs("${MC_MEMORY:-4G}", { MC_MEMORY: "" })).toBe("4G");
    expect(resolveEnvRefs("${MC_MEMORY-4G}", { MC_MEMORY: "" })).toBe("");
    expect(resolveEnvRefs("${MC_MEMORY-4G}", {})).toBe("4G");
  });

  it("resolves a reference with no default to the empty string", () => {
    expect(resolveEnvRefs("${RCON_PASSWORD}", {})).toBe("");
    expect(resolveEnvRefs("${RCON_PASSWORD}", { RCON_PASSWORD: "s3cret" })).toBe("s3cret");
  });

  it("leaves text with no reference alone", () => {
    expect(resolveEnvRefs("latest_experimental", { VERSION: "nope" })).toBe(
      "latest_experimental"
    );
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=value, ignoring comments and blanks", () => {
    expect(parseEnvFile("# a comment\n\nMC_MEMORY=4G\nMC_TYPE=FABRIC\n")).toEqual({
      MC_MEMORY: "4G",
      MC_TYPE: "FABRIC",
    });
  });

  it("strips surrounding quotes and accepts `export`", () => {
    expect(parseEnvFile('A="x"\nB=\'y\'\nexport C=z\n')).toEqual({ A: "x", B: "y", C: "z" });
  });

  it("the LAST definition wins, as compose's dotenv reader does", () => {
    // This is not trivia — it is why `patchEnvFile` has to rewrite every occurrence.
    expect(parseEnvFile("MC_MEMORY=4G\nMC_MEMORY=8G\n").MC_MEMORY).toBe("8G");
  });

  it("keeps an empty value as empty rather than dropping the key", () => {
    // `${MC_MEMORY:-4G}` distinguishes absent from empty, so the parser must too.
    const env = parseEnvFile("MC_MEMORY=\n");
    expect(Object.prototype.hasOwnProperty.call(env, "MC_MEMORY")).toBe(true);
    expect(env.MC_MEMORY).toBe("");
  });
});

describe("patchEnvFile", () => {
  const EXISTING = [
    "# Yoshling",
    "DATABASE_URL=file:/app/data/yoshling.db",
    "RCON_PASSWORD=hunter2",
    "",
    "MC_MEMORY=4G",
    "",
  ].join("\n");

  it("rewrites an existing key and touches nothing else", () => {
    const { text, applied, added } = patchEnvFile(EXISTING, { MC_MEMORY: "6G" });
    expect(applied).toEqual(["MC_MEMORY"]);
    expect(added).toEqual([]);
    expect(parseEnvFile(text).MC_MEMORY).toBe("6G");
    // Byte-level: exactly one line differs, and the unrelated secrets are untouched.
    const before = EXISTING.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((l, i) => l !== before[i])).toEqual(["MC_MEMORY=6G"]);
  });

  it("appends a key the file does not have, and says so", () => {
    // Every box today is in this state: compose carries the defaults and `.env` has none
    // of these keys, so the first edit of each is an append. Refusing would make the
    // feature work only on a hand-seeded box.
    const { text, applied, added } = patchEnvFile(EXISTING, { PZ_MAX_MEMORY: "8192m" });
    expect(added).toEqual(["PZ_MAX_MEMORY"]);
    expect(applied).toEqual(["PZ_MAX_MEMORY"]);
    expect(parseEnvFile(text).PZ_MAX_MEMORY).toBe("8192m");
    // Nothing that was already there moved.
    expect(parseEnvFile(text).RCON_PASSWORD).toBe("hunter2");
    expect(parseEnvFile(text).MC_MEMORY).toBe("4G");
  });

  it("rewrites EVERY occurrence of a key, not just the first", () => {
    // The defect this guards: compose's dotenv reader takes the LAST definition, so
    // patching only the first leaves a later duplicate winning — a write that reports
    // success and changes nothing, which is this project's documented recurring defect.
    // A duplicate is easy to acquire by hand-editing, and nothing warns about it.
    const dup = "MC_MEMORY=4G\nOTHER=1\nMC_MEMORY=4G\n";
    const { text } = patchEnvFile(dup, { MC_MEMORY: "10G" });
    expect(parseEnvFile(text).MC_MEMORY).toBe("10G");
    expect(text.match(/^MC_MEMORY=10G$/gm)).toHaveLength(2);
    expect(text).not.toContain("MC_MEMORY=4G");
  });

  it("matches an `export`-prefixed definition in place", () => {
    const { text, added } = patchEnvFile("export MC_MEMORY=4G\n", { MC_MEMORY: "5G" });
    expect(added).toEqual([]);
    expect(text).toContain("export MC_MEMORY=5G");
  });

  it("does not match a key by suffix", () => {
    // `MEMORY` vs `MAX_MEMORY` / `MIN_MEMORY` is the same collision `patchServiceEnv`
    // anchors against one layer up. Unanchored, setting one world's heap moves another's.
    const { text, added } = patchEnvFile("PZ_MAX_MEMORY=12288m\n", { MAX_MEMORY: "1024m" });
    expect(added).toEqual(["MAX_MEMORY"]);
    expect(parseEnvFile(text).PZ_MAX_MEMORY).toBe("12288m");
    expect(parseEnvFile(text).MAX_MEMORY).toBe("1024m");
  });

  it("does not rewrite a commented-out definition", () => {
    const { text, added } = patchEnvFile("# MC_MEMORY=4G\n", { MC_MEMORY: "6G" });
    expect(added).toEqual(["MC_MEMORY"]);
    expect(text).toContain("# MC_MEMORY=4G");
    expect(parseEnvFile(text).MC_MEMORY).toBe("6G");
  });

  it("works on an empty file, and does not grow blank lines on repeat appends", () => {
    // `readEnvFile` answers "" for a missing `.env` rather than throwing, so this is a
    // real input. Repeated appends growing the file is how a config file becomes
    // unreadable by hand.
    const first = patchEnvFile("", { MC_MEMORY: "4G" });
    expect(parseEnvFile(first.text).MC_MEMORY).toBe("4G");
    const second = patchEnvFile(first.text, { MC_TYPE: "FABRIC" });
    const third = patchEnvFile(second.text, { MC_VERSION: "26.1.2" });
    expect(parseEnvFile(third.text)).toMatchObject({
      MC_MEMORY: "4G",
      MC_TYPE: "FABRIC",
      MC_VERSION: "26.1.2",
    });
    expect(third.text).not.toMatch(/\n\n\n/);
    expect(third.text.endsWith("\n")).toBe(true);
  });

  it("refuses a value `.env` cannot carry, rather than mangling it", () => {
    // `.env` has no escaping worth relying on: `#` starts a comment, `$` interpolates,
    // a newline ends the value. Writing any of them would produce a file that parses as
    // something other than what was asked for — and report success.
    for (const bad of ["4G # nope", "a\nB=c", '4G"', "$MC_MEMORY", "it's"]) {
      expect(() => patchEnvFile("", { MC_MEMORY: bad })).toThrow(/Refusing to write MC_MEMORY/);
    }
  });

  it("applies several keys in one pass", () => {
    const { text, applied } = patchEnvFile(EXISTING, {
      MC_MEMORY: "6G",
      MC_TYPE: "VANILLA",
      MC_VERSION: "1.21.4",
    });
    expect(applied.sort()).toEqual(["MC_MEMORY", "MC_TYPE", "MC_VERSION"]);
    expect(parseEnvFile(text)).toMatchObject({
      MC_MEMORY: "6G",
      MC_TYPE: "VANILLA",
      MC_VERSION: "1.21.4",
    });
  });
});

describe("the .env write reaches the right compose line", () => {
  it("MC_VERSION moves Minecraft's version and not 7 Days to Die's branch", () => {
    // The per-service naming rule, asserted end to end. One shared `VERSION` key would
    // make editing Minecraft change which build 7DTD downloads — exactly the trap
    // `patchServiceEnv`'s scoping exists for, one layer down.
    const env = parseEnvFile(patchEnvFile("", { MC_VERSION: "1.21.4" }).text);
    expect(readServiceEnv(COMPOSE, "minecraft", "VERSION", env)).toBe("1.21.4");
    expect(readServiceEnv(COMPOSE, "sevendtd", "VERSION", env)).toBe("latest_experimental");
  });

  it("PZ_MAX_MEMORY moves MAX_MEMORY and leaves MIN_MEMORY alone", () => {
    // MIN_MEMORY is not UI-owned. It stays a literal precisely so a heap change cannot
    // move the floor underneath it; `setMemory` refuses a value below it instead.
    const env = parseEnvFile(patchEnvFile("", { PZ_MAX_MEMORY: "8192m" }).text);
    expect(readServiceEnv(COMPOSE, "zomboid", "MAX_MEMORY", env)).toBe("8192m");
    expect(readServiceEnv(COMPOSE, "zomboid", "MIN_MEMORY", env)).toBe("2048m");
  });

  it("a Minecraft heap key cannot reach Project Zomboid's block", () => {
    const env = parseEnvFile(patchEnvFile("", { MC_MEMORY: "1G" }).text);
    expect(readServiceEnv(COMPOSE, "minecraft", "MEMORY", env)).toBe("1G");
    expect(readServiceEnv(COMPOSE, "zomboid", "MAX_MEMORY", env)).toBe("12288m");
  });

  it("patchServiceEnv still works, because /api/7dtd/update depends on it", () => {
    // START_MODE is flipped to 3 and back to 1 in compose itself, inside one operation.
    // It is deliberately NOT moved to `.env`: the patch rewrites whatever is on the line,
    // so the first update would replace `${...}` with a literal and detach it for good.
    const { text, applied } = patchServiceEnv(COMPOSE, "sevendtd", { START_MODE: "3" });
    expect(applied).toEqual(["START_MODE"]);
    expect(readServiceEnv(text, "sevendtd", "START_MODE", {})).toBe("3");
    expect(readServiceEnv(patchServiceEnv(text, "sevendtd", { START_MODE: "1" }).text, "sevendtd", "START_MODE", {})).toBe("1");
  });
});
