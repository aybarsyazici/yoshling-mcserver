/**
 * 7 Days to Die settings logic that is worth asserting, kept out of the two config
 * routes so a test can import it — a route module pulls in `next/server`, Prisma and
 * the Docker CLI. Same reason `sdtd-xml.ts` exists.
 *
 * Everything here is a fact about the *deployment* or about the game's own file
 * formats, measured on the box rather than inferred from a comment.
 */

import { unescapeXml } from "./sdtd-xml";

/* ------------------------------------------------------------------------------------
 * Reading one property back out of sdtdserver.xml
 * ---------------------------------------------------------------------------------- */

/**
 * Read a single `<property name=".." value=".."/>` out of the file, unescaped.
 *
 * `name` is escaped for the pattern because callers pass it through from a request in the
 * generic editor; `a.*b` would otherwise be a live pattern that matches a *different*
 * property's line. `unescapeXml` is not optional: the writer escapes, so a reader that
 * does not unescape hands back `&amp;` and the next save escapes it again — the entity
 * doubling `sdtd-xml.ts` documents, which is what happens to a `ServerPassword`
 * containing `&`.
 */
export function readXmlProperty(xml: string, name: string): string | null {
  const re = new RegExp(`<property\\s+name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s+value="([^"]*)"`);
  const m = xml.match(re);
  return m ? unescapeXml(m[1]) : null;
}

/* ------------------------------------------------------------------------------------
 * Sandbox code
 * ---------------------------------------------------------------------------------- */

/**
 * The sandbox code is the game's encoded Sandbox Options preset (New Game → Sandbox
 * Options → Copy Code). Its encoding is undocumented and we deliberately do not decode
 * it — but its *shape* is checkable, and a mistyped or half-selected paste is the
 * realistic failure.
 *
 * ## What was measured, 2026-10-01, before trusting this rule
 *
 * Every sandbox code that exists anywhere on the production box:
 *
 * | Where                                                           | Length | `(len-1) % 3` |
 * |-----------------------------------------------------------------|--------|---------------|
 * | the live `SandboxCode` in `sdtdserver.xml` (our pasted preset)   | 94     | 0             |
 * | the fresh-install default, from 22 boot logs                     | 19     | 0             |
 * | the official example preset in the game's `sandbox_overrides.xml` (`ABEABTBBWADFP`) | 13 | 0 |
 *
 * All three are uppercase A-Z with no digits. So: one leading character, then groups of
 * three.
 *
 * ## The counter-example, and why this warns instead of refusing
 *
 * One of 23 boot logs (`sdtdserver-console-2026-10-01-10:53:20.log`) printed both
 * `GamePref.SandboxCode` and `Sandbox Code:` as a **93**-character string — our 94 with
 * the last character missing, so `(93-1) % 3 = 2`. The boots immediately before and after
 * it printed 94, and `sdtdserver.xml` was not written between them, so nothing explains
 * it and the rule cannot be called exhaustively verified. A hard refusal on the length
 * would therefore be able to reject something the game itself emitted, which is a worse
 * failure than accepting a typo: the shape is reported, the save still happens.
 *
 * The character class *is* refused, because no observed code contains anything but A-Z
 * and a code with digits or punctuation in it cannot have come from Copy Code.
 */
export const SANDBOX_CODE_MAX = 4000;

/**
 * Whitespace out, case up — nothing else. Characters that cannot be in a code are
 * deliberately **kept** so the caller can name them; stripping them silently is how a
 * value nobody typed gets stored behind a green toast.
 */
export function normalizeSandboxCode(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  return String(raw).replace(/\s+/g, "").toUpperCase().slice(0, SANDBOX_CODE_MAX);
}

/**
 * The shape report for an already-normalised code. Empty means "unset, use the game's
 * defaults" and is legal.
 *
 * - `error` → refuse the write (characters that cannot be in a code).
 * - `warning` → write it, but say it does not look like a whole code.
 */
export function sandboxCodeIssue(code: string): { error?: string; warning?: string } {
  if (code === "") return {};
  const bad = Array.from(new Set(code.replace(/[A-Z]/g, "").split(""))).join("");
  if (bad) {
    return {
      error:
        `That sandbox code contains ${JSON.stringify(bad)}, which a sandbox code cannot contain — ` +
        `the game's codes are uppercase letters only. Re-copy it from New Game → Sandbox Options → Copy Code.`,
    };
  }
  if ((code.length - 1) % 3 !== 0) {
    // A clause, not a sentence of its own: the routes join these after whatever they have
    // to say about the write itself, and two independent "Saved." leads in one toast read
    // like two separate results.
    return {
      warning:
        `That sandbox code looks incomplete: every code on this server is one letter followed by ` +
        `groups of three, and this one is ${code.length} letters. If the game ignores it, re-copy ` +
        `the whole code from Sandbox Options.`,
    };
  }
  return {};
}

/**
 * Why a new sandbox code does not change the world that is already running.
 *
 * **Measured live on 2026-10-01**, with Reveo Valley / Fresh2 up, by reading all 153
 * values `getgamepref` returns over telnet. `SandboxCode` read back as exactly the
 * 94-character string in `sdtdserver.xml` — so the file *does* reach the game — and yet:
 *
 * | Option              | the code decodes to (server's own boot dump) | live `GamePref` |
 * |---------------------|---------------------------------------------|-----------------|
 * | BloodMoonEnemyCount | `5/16 Enemies` (default `2/8 Enemies`)      | `8`             |
 * | ZombieMove          | `1/Jog` (default `0/Walk`)                  | `0`             |
 * | ZombieFeralMove     | `4/Nightmare` (default `3/Sprint`)          | `3`             |
 *
 * The same boot dump prints `GamePref.SandboxCode = <the code>` next to
 * `GameStat.SandboxCode = ` (empty) and `GamePref.GameDifficulty = 1` next to
 * `GameStat.GameDifficulty = 2`: the save carries its own values and they win.
 *
 * This is the most important thing on the page, and until now the page did not say it —
 * it said the code was "the only place difficulty and day length can be set", which is
 * true and reads as "so set it here and the server changes", which is false.
 */
export const SANDBOX_SCOPE_WARNING =
  "A sandbox code only applies to a new world — the save that is running keeps the settings " +
  "it was created with, so nothing about the current game changes. Start a fresh save " +
  "(Server maintenance → Reset world) for it to take effect.";

/* ------------------------------------------------------------------------------------
 * Properties the deployment owns, and properties this deployment makes inert
 * ---------------------------------------------------------------------------------- */

/**
 * Editable in the file, but **pinned by `docker-compose.yml`'s port map**, so a save
 * that "worked" is a server nobody can reach.
 *
 * Read off the box 2026-10-01: compose publishes `26900:26900/tcp`, `26900:26900/udp`,
 * `26901:26901/udp`, `26902:26902/udp` and `8080:8080/tcp`, and the live XML has
 * `ServerPort=26900` / `WebDashboardPort=8080`. A container's port map is fixed when the
 * container is created, so changing either number here moves the listener off the one
 * published port and the dashboard's own telnet probe is the only thing still working.
 * `TelnetPort` has been in `LOCKED` for exactly this reason; these two were not.
 *
 * Unlike `LOCKED` these stay **visible** — the value is a fact worth reading, it is just
 * not ours to change. The write is refused before anything is written, so the editor
 * cannot report a save it did not make.
 */
export const PINNED_BY_DEPLOYMENT: Readonly<Record<string, string>> = {
  ServerPort:
    "ServerPort is fixed by the container's published port map (26900) and cannot be changed here — " +
    "changing it would stop every client reaching the server.",
  WebDashboardPort:
    "WebDashboardPort is fixed by the container's published port map (8080) and cannot be changed here.",
};

/**
 * Settings that this deployment makes inert, with the reason. They are **not** hidden:
 * hiding a setting that exists invites the next person to go looking for it in the file.
 *
 * Measured on the box 2026-10-01: `iptables -S DOCKER-USER` is
 * `-A DOCKER-USER -i eth0 -p tcp -m tcp --dport 8080 -j DROP` (plus 8081 and 3000),
 * installed by the `yoshling-firewall` systemd unit. 8080 *is* published by compose, so
 * the game's web dashboard binds and answers inside the compose network and is dropped at
 * the host's external interface — there is no URL anyone outside the box can open. The
 * live XML has `WebDashboardEnabled=false` and `EnableMapRendering=false`, which is the
 * right setting; the note exists so turning them on is a decision rather than a surprise.
 */
export const ENVIRONMENT_INERT: Readonly<Record<string, string>> = {
  WebDashboardEnabled:
    "No effect from outside the box: port 8080 is DROPped at the host's external interface by the yoshling-firewall unit, so the game's web dashboard is only reachable from the box itself.",
  WebDashboardPort:
    "Also unreachable from outside: 8080 is DROPped at the host's external interface.",
  WebDashboardUrl:
    "Only used by the game's own web dashboard, which is not reachable from outside the box.",
  EnableMapRendering:
    "Only feeds the game's web dashboard, which is not reachable from outside the box — leaving this on spends CPU drawing map tiles nobody can load.",
};

/**
 * Why this property may not be written here, or `undefined` if it may.
 *
 * `Object.hasOwn`, not a bare lookup: the generic editor's keys come straight out of a
 * request body, and `PINNED_BY_DEPLOYMENT["toString"]` is an inherited *function* — truthy,
 * so a `PUT {"toString": "x"}` would have been refused with a stringified function as the
 * reason. Harmless but incoherent, and the same shape of mistake is a real hole in code
 * that uses the looked-up value for anything but a message.
 */
export function pinnedReason(name: string): string | undefined {
  return Object.hasOwn(PINNED_BY_DEPLOYMENT, name) ? PINNED_BY_DEPLOYMENT[name] : undefined;
}

/**
 * Fold the deployment's notes into each property's help text.
 *
 * Deliberately done in the API rather than in a component: `config-panel.tsx` is shared
 * with Project Zomboid and already renders `help`, and both config formats document
 * themselves with a comment per setting. A second, UI-side table of per-key copy would be
 * the "declarative schema" this project decided against.
 */
export function annotateSdtdHelp<T extends { name: string; help: string }>(props: T[]): T[] {
  return props.map((p) => {
    const notes = [
      pinnedReason(p.name),
      Object.hasOwn(ENVIRONMENT_INERT, p.name) ? ENVIRONMENT_INERT[p.name] : undefined,
    ].filter(Boolean) as string[];
    if (notes.length === 0) return p;
    // Prepended, because the game's own comment can be several lines long and the note
    // is the part that decides whether editing the field is worth anything at all.
    const prefix = notes.join(" ");
    if (p.help.startsWith(prefix)) return p;
    return { ...p, help: p.help ? `${prefix} — ${p.help}` : prefix };
  });
}

/* ------------------------------------------------------------------------------------
 * Clamps that used to be silent
 * ---------------------------------------------------------------------------------- */

/** The quick settings' player-count bound, matching the `1–16` the page shows. */
export const MAX_PLAYER_COUNT = 16;

/**
 * `clampInt(body.maxPlayers, 1, 16, prev)` answered `{success:true}` for a request that
 * asked for 99, stored 16, and said nothing — the same shape as the two settings that
 * wrote XML properties that do not exist. The clamp is right; the silence was not.
 */
export function clampPlayerCount(raw: unknown, fallback: number): { value: number; note?: string } {
  const n = parseInt(String(raw), 10);
  if (isNaN(n)) return { value: fallback };
  const value = Math.min(MAX_PLAYER_COUNT, Math.max(1, n));
  if (value === n) return { value };
  return {
    value,
    note: `Max players was set to ${value}, not ${n} — this server allows 1 to ${MAX_PLAYER_COUNT}.`,
  };
}
