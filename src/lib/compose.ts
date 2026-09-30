import { readFile, writeFile } from "fs/promises";
import path from "path";

/**
 * Surgical reads/writes of `docker-compose.yml` and its `.env` on the host.
 *
 * Everything here is scoped to ONE service block on purpose. A previous version
 * of the settings route regenerated the whole file from a template, which
 * silently deleted every service the template didn't know about. Scoping also
 * matters because keys repeat: `VERSION` is the Minecraft version in one block
 * and the Steam branch in another, and `MEMORY` means different things again.
 *
 * ## Which of the two files the app writes, and why it changed
 *
 * It used to write `docker-compose.yml`: the memory card patched `MEMORY` /
 * `MAX_MEMORY` and the Minecraft settings page patched `TYPE` / `VERSION`. But
 * compose is tracked in git and the deploy is `git checkout -f -B main FETCH_HEAD`,
 * so every deploy reverted whatever the UI had applied. One commit (`f0cf692`) undid
 * that by hand; `deploy.sh` was then taught to refuse and print the diff, which made
 * the collision visible without ending it.
 *
 * So the app now writes the **`.env`** beside compose, and compose interpolates from
 * it (`${MC_MEMORY:-4G}`) the way it already did for `RCON_PASSWORD` and
 * `SDTD_TELNET_PASSWORD`. `.env` is gitignored, so it survives `git checkout -f`, and
 * compose becomes purely git-owned.
 *
 * `patchServiceEnv` stays, and stays tested: `/api/7dtd/update` still uses it to flip
 * `START_MODE` to 3 and straight back to 1 inside one operation. That value is
 * deliberately NOT moved to `.env` — patching it would rewrite the `${...}` reference
 * into a literal and permanently detach the line from its `.env` key, which is worse
 * than the transient dirt it causes today.
 */
export const COMPOSE_FILE = process.env.COMPOSE_FILE || "/opt/yoshling/docker-compose.yml";

/**
 * The `.env` compose interpolates from.
 *
 * Derived from `COMPOSE_FILE`'s directory rather than configured separately, because
 * that is the file `docker compose` itself loads: it reads `.env` from the project
 * directory, which defaults to the directory holding the compose file — and
 * `composeCmd` in `game-manager` `cd`s there before every invocation. Two independent
 * settings could disagree, and then the app would patch a file compose never reads.
 */
export const ENV_FILE =
  process.env.COMPOSE_ENV_FILE || path.join(path.dirname(COMPOSE_FILE), ".env");

/** Line range of a service's block: [firstLineAfterHeader, endExclusive]. */
function serviceBlock(lines: string[], service: string): { start: number; end: number; indent: string } | null {
  const startRe = new RegExp(`^(\\s*)${service}:\\s*$`);
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (m) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start < 0) return null;

  // The block ends at the next non-blank line indented no deeper than the key.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if ((lines[i].match(/^\s*/)?.[0].length ?? 0) <= indent.length) {
      end = i;
      break;
    }
  }
  return { start, end, indent };
}

/**
 * Resolve compose's `${VAR}` / `${VAR:-default}` / `${VAR-default}` against an env map.
 *
 * Needed because the values the app owns now live in `.env` and compose only holds a
 * reference to them. Without this, `readServiceEnv(compose, "minecraft", "MEMORY")`
 * would answer the literal string `${MC_MEMORY:-4G}`, `parseGb` would return `null`,
 * and the memory card's configured-vs-live comparison — the one report in this
 * codebase that has never been wrong — would quietly start answering "unknown".
 *
 * `:-` (unset **or empty**) and `-` (unset only) are distinguished because compose
 * does. That difference is the whole reason the defaults are written with `:-`: a
 * `.env` line left as `MC_MEMORY=` must fall back to `4G` rather than hand the JVM an
 * empty `-Xmx`.
 */
export function resolveEnvRefs(raw: string, env: Record<string, string>): string {
  return raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_all, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare!;
      const present = Object.prototype.hasOwnProperty.call(env, name);
      const value = present ? env[name] : undefined;
      if (fallback === undefined) return value ?? "";
      // `${VAR:-d}` falls back on empty too; `${VAR-d}` only when unset. The regex
      // captured the same group for both, so the distinction is read back off the text.
      const emptyCountsAsUnset = /\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(_all);
      if (value === undefined) return fallback;
      if (value === "" && emptyCountsAsUnset) return fallback;
      return value;
    }
  );
}

/**
 * The value of `KEY: value` inside one service block, unquoted and with `${...}`
 * resolved against `env`.
 *
 * `env` defaults to `{}` rather than to the real `.env`, and that is deliberate: this
 * function is pure and synchronous, so a caller that cares about the live values has
 * to go and read them (`readEnvFile` + `parseEnvFile`). With no env it answers the
 * compose *default*, which is the right answer for "what would a fresh box run".
 */
export function readServiceEnv(
  compose: string,
  service: string,
  key: string,
  env: Record<string, string> = {}
): string | null {
  const lines = compose.split("\n");
  const block = serviceBlock(lines, service);
  if (!block) return null;
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  for (let i = block.start + 1; i < block.end; i++) {
    const m = re.exec(lines[i]);
    if (m) return resolveEnvRefs(m[1].trim().replace(/^["']|["']$/g, ""), env);
  }
  return null;
}

/** Rewrite `KEY: value` lines inside one service block, leaving the rest byte-identical. */
export function patchServiceEnv(
  compose: string,
  service: string,
  updates: Record<string, string>
): { text: string; applied: string[] } {
  const lines = compose.split("\n");
  const applied: string[] = [];
  const block = serviceBlock(lines, service);
  if (!block) return { text: compose, applied };

  for (let i = block.start + 1; i < block.end; i++) {
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^(\\s*${key}:\\s*)(.*)$`);
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `$1"${value}"`);
      applied.push(key);
    }
  }

  return { text: lines.join("\n"), applied };
}

// ── the `.env` beside compose ────────────────────────────────────────────────

/** `KEY=value` lines, last definition winning, quotes stripped. Comments ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) value = value.slice(1, -1);
    // LAST wins, matching compose's own dotenv reader. Which end wins is not a
    // detail: `patchEnvFile` has to rewrite every occurrence for that reason.
    out[m[1]] = value;
  }
  return out;
}

/**
 * Values this refuses to write, because `.env` has no escaping worth relying on.
 *
 * A `#` starts a comment, a `$` interpolates, quotes and newlines change where the
 * value ends. Writing any of them would produce a file that parses as something other
 * than what was asked for — and the caller would be told it succeeded. Refusing is the
 * only honest option, and nothing this patcher is used for (a heap size, a Minecraft
 * version, a loader name) can legitimately contain one.
 */
const UNSAFE_ENV_VALUE = /[\n\r"'$#]/;

/**
 * Set keys in a `.env`, in place, preserving everything else byte-for-byte.
 *
 * Two properties are load-bearing:
 *
 *  1. **Every occurrence of a key is rewritten, not just the first.** Compose's
 *     dotenv reader takes the LAST definition, so patching only the first would leave
 *     a later duplicate winning — a write that reports success and changes nothing,
 *     which is this project's documented recurring defect.
 *  2. **A key that isn't there is appended, and reported in `added`.** The compose
 *     defaults (`${MC_MEMORY:-4G}`) mean a fresh box has none of these keys, so the
 *     first edit of each one is an append. Refusing instead would make the feature
 *     work only on a box someone had hand-seeded.
 */
export function patchEnvFile(
  text: string,
  updates: Record<string, string>
): { text: string; applied: string[]; added: string[] } {
  for (const [key, value] of Object.entries(updates)) {
    if (UNSAFE_ENV_VALUE.test(value)) {
      throw new Error(`Refusing to write ${key}: the value contains a character .env cannot carry`);
    }
  }

  const lines = text.split("\n");
  const applied: string[] = [];
  const added: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`);
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `$1${value}`);
      hit = true;
    }
    if (hit) {
      applied.push(key);
    } else {
      added.push(key);
    }
  }

  if (added.length > 0) {
    // Appended with a header so the next person reading `.env` by hand knows these
    // are UI-owned and that compose carries the same values as defaults.
    const block = [
      "",
      "# Written by the dashboard (server memory, Minecraft version/loader).",
      "# docker-compose.yml holds the same values as ${VAR:-default} fallbacks, so",
      "# deleting a line here reverts that setting rather than emptying it.",
      ...added.map((k) => `${k}=${updates[k]}`),
    ];
    // Keep exactly one trailing newline: a file that already ended in one gets the
    // block appended after it rather than growing a blank line each time.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(...block, "");
  }

  return { text: lines.join("\n"), applied: [...applied, ...added], added };
}

export async function readCompose(): Promise<string> {
  return readFile(COMPOSE_FILE, "utf-8");
}

export async function writeCompose(text: string): Promise<void> {
  await writeFile(COMPOSE_FILE, text, "utf-8");
}

/**
 * The `.env` text, or `""` when there is none.
 *
 * A missing `.env` is a legitimate state — compose carries every app-owned value as a
 * `${VAR:-default}` fallback precisely so it is — so this must not throw. Throwing
 * would make the memory card unreadable on a fresh box instead of showing the default
 * it would actually boot with.
 */
export async function readEnvFile(): Promise<string> {
  try {
    return await readFile(ENV_FILE, "utf-8");
  } catch {
    return "";
  }
}

export async function writeEnvFile(text: string): Promise<void> {
  await writeFile(ENV_FILE, text, "utf-8");
}

/** The live `.env` as a map, for resolving compose's `${...}` references. */
export async function readEnvMap(): Promise<Record<string, string>> {
  return parseEnvFile(await readEnvFile());
}
