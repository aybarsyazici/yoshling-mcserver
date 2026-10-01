import { readdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { rconCommand, type RconTarget } from "@/lib/rcon";
import {
  classifyLiveOptions,
  parseShowOptions,
  type PzLiveReload,
} from "@/lib/zomboid-ini-contract";

/**
 * Project Zomboid control + config.
 *
 * PZ keeps everything in one data directory (mounted here as PZ_SERVER_DIR):
 *   Server/<name>.ini                – every server setting, including the mods
 *   Server/<name>_SandboxVars.lua    – loot/zombie/XP preset
 *   Server/<name>_spawnregions.lua   – spawn regions (rewritten when maps change)
 *   Saves/Multiplayer/<name>/        – the world
 *   db/<name>.db                     – player accounts
 *
 * The .ini is the single source of truth: the container runs with
 * SELF_MANAGED_MODS=true so its entrypoint never rewrites Mods/WorkshopItems
 * behind our back. Control is over RCON (port 27015).
 */

export const PZ_DIR = process.env.PZ_SERVER_DIR || "/zomboid";
/** steamapps/workshop mount — where the server downloads Workshop items. */
export const PZ_WORKSHOP_DIR = process.env.PZ_WORKSHOP_DIR || "/zomboid-workshop";
/** Steam app id of Project Zomboid, i.e. the workshop content sub-folder. */
export const PZ_APP_ID = "108600";

const DEFAULT_SERVER_NAME = process.env.PZ_SERVER_NAME || "yoshling";

// ── paths ───────────────────────────────────────────────────────────────────

/**
 * The active server's name (its .ini/save/db basename). Prefers the configured
 * name, then a lone .ini in Server/, then PZ's own default. Discovering it from
 * disk keeps things working if the server was ever started under another name.
 */
export async function serverName(): Promise<string> {
  const dir = path.join(PZ_DIR, "Server");
  try {
    await stat(path.join(dir, `${DEFAULT_SERVER_NAME}.ini`));
    return DEFAULT_SERVER_NAME;
  } catch {}
  try {
    const inis = (await readdir(dir)).filter((f) => f.endsWith(".ini"));
    if (inis.length > 0) {
      const pick = inis.includes("servertest.ini") ? "servertest.ini" : inis[0];
      return pick.replace(/\.ini$/, "");
    }
  } catch {}
  return DEFAULT_SERVER_NAME;
}

export async function iniPath(): Promise<string> {
  return path.join(PZ_DIR, "Server", `${await serverName()}.ini`);
}

/** Absolute paths of everything a backup has to capture. */
export async function savePaths(): Promise<{
  name: string;
  world: string;
  db: string;
  serverDir: string;
}> {
  const name = await serverName();
  return {
    name,
    world: path.join(PZ_DIR, "Saves", "Multiplayer", name),
    db: path.join(PZ_DIR, "db", `${name}.db`),
    serverDir: path.join(PZ_DIR, "Server"),
  };
}

// ── .ini parsing / writing ──────────────────────────────────────────────────

export interface PzProperty {
  name: string;
  value: string;
  /** The `#` comment block above the key, which PZ ships as documentation. */
  help: string;
}

/**
 * Settings that describe *this deployment*, not the world: the app's control
 * channel and the ports docker-compose publishes. They're locked out of the
 * settings editor and preserved when a config is imported — taking someone
 * else's RCON password or port numbers would cut the server off from the app or
 * make it listen where nothing is forwarded.
 *
 * This list used to end with `SteamPort1` and `SteamPort2`, and **Build 42 has no
 * such server options** — the live .ini holds 144 keys and neither is among them
 * (checked on production 2026-10-01), nor does `showoptions` report them. So two of
 * the six entries locked and preserved nothing, which matters beyond the dead code: a
 * lock list that is a third fiction invites trusting the rest of it, and this one is
 * also what the import route promises to carry across. The Steam query ports are
 * published by docker-compose (`8766-8767/udp`) and are not in the .ini at all.
 */
export const INFRA_KEYS = ["RCONPassword", "RCONPort", "DefaultPort", "UDPPort"] as const;

/**
 * Parse `# help` + `Key=Value` blocks. PZ writes its own comments as literal
 * `\n` escapes, so those are folded into spaces for display.
 */
export function parseIni(text: string): PzProperty[] {
  const out: PzProperty[] = [];
  let help: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      help = [];
      continue;
    }
    if (line.startsWith("#")) {
      help.push(line.slice(1).trim());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      help = [];
      continue;
    }
    out.push({
      name: line.slice(0, eq).trim(),
      value: line.slice(eq + 1).trim(),
      help: help.join(" ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim(),
    });
    help = [];
  }
  return out;
}

const KEY_RE = /^([A-Za-z0-9_]+)=/;

export interface SetIniResult {
  text: string;
  /** Keys the file already had, rewritten in place. */
  applied: string[];
  /** Keys added to the end of the file (only when `append` is on). */
  appended: string[];
  /** Keys the file does not have, left alone because `append` is off. */
  ignored: string[];
}

/**
 * Rewrite the given keys in place. Line-based so every comment, blank line and
 * untouched key survives verbatim.
 *
 * `append` decides what happens to a key the file does not have, and the two callers
 * want opposite things — which is why it is a parameter rather than a policy baked in
 * here. **It defaults to the old behaviour on purpose**: the config *import* has to be
 * able to add `RCONPassword` to an uploaded .ini that lacks it (otherwise the import
 * hands the box a config with no control channel), and `writeMapOrder` /
 * `writeModState` must be able to create `Map=` / `Mods=` in a file the game has not
 * finished filling in. Both discard the result, so a default of `false` would have made
 * them silently no-op — the exact failure this change exists to remove.
 *
 * The generic settings editor is the caller that passes `append: false`, because there
 * every unmatched key is a typo or a stale field and appending it produced a line the
 * game ignores while the response claimed it was applied.
 */
export function setIniValues(
  text: string,
  updates: Record<string, string>,
  { append = true }: { append?: boolean } = {}
): SetIniResult {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const applied: string[] = [];
  const appended: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    if (!pending.has(m[1])) continue;
    lines[i] = `${m[1]}=${sanitizeValue(pending.get(m[1]) ?? "")}`;
    applied.push(m[1]);
    pending.delete(m[1]);
  }
  const ignored: string[] = [];
  for (const [key, value] of pending) {
    if (!append) {
      ignored.push(key);
      continue;
    }
    lines.push(`${key}=${sanitizeValue(value)}`);
    appended.push(key);
  }

  return { text: lines.join(eol), applied, appended, ignored };
}

/** A newline in a value would split the key across lines and corrupt the file. */
function sanitizeValue(v: string): string {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

/** Module-local on purpose: callers want `readIniProperties`, not raw text. */
async function readIni(): Promise<string> {
  return readFile(await iniPath(), "utf-8");
}

export async function readIniProperties(): Promise<PzProperty[]> {
  return parseIni(await readIni());
}

/**
 * Apply a subset of settings to the .ini on disk.
 *
 * Returns the full `setIniValues` verdict rather than one `applied` array, because the
 * caller is the only one who can say whether a key it did not match is fine (the mod
 * and map writers create theirs) or a mistake worth reporting (the settings editor).
 */
export async function updateIni(
  updates: Record<string, string>,
  opts?: { append?: boolean }
): Promise<Omit<SetIniResult, "text">> {
  const file = await iniPath();
  const current = await readFile(file, "utf-8");
  const { text, ...result } = setIniValues(current, updates, opts);
  await writeFile(file, text, "utf-8");
  return result;
}

function valueOf(props: PzProperty[], name: string): string {
  return props.find((p) => p.name === name)?.value ?? "";
}

// ── mods ────────────────────────────────────────────────────────────────────

/** Split a `a;b;c` .ini list. */
export function splitList(value: string): string[] {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build 42 wants every entry of `Mods=` prefixed with a backslash
 * (`Mods=\ModA;\ModB`); Build 41 wants the bare id. Mirror whatever the file
 * already uses, defaulting to B42 since that is the current stable build.
 */
function modIdPrefix(existingTokens: string[]): string {
  if (existingTokens.length === 0) return "\\";
  return existingTokens.some((t) => t.startsWith("\\")) ? "\\" : "";
}

/** A mod token as written in the file, minus the build-42 backslash. */
export function bareModId(token: string): string {
  return token.replace(/^\\+/, "");
}

export interface PzModState {
  /** Workshop item ids from `WorkshopItems=`, in file order. */
  workshopIds: string[];
  /** Mod ids from `Mods=`, backslashes stripped, in load order. */
  modIds: string[];
  /** The prefix style the file uses for mod ids. */
  prefix: string;
}

export async function readModState(): Promise<PzModState> {
  const props = await readIniProperties();
  const tokens = splitList(valueOf(props, "Mods"));
  return {
    workshopIds: splitList(valueOf(props, "WorkshopItems")),
    modIds: tokens.map(bareModId),
    prefix: modIdPrefix(tokens),
  };
}

export async function writeModState(state: { workshopIds: string[]; modIds: string[]; prefix: string }): Promise<void> {
  await updateIni({
    WorkshopItems: state.workshopIds.join(";"),
    Mods: state.modIds.map((id) => `${state.prefix}${id}`).join(";"),
  });
}

/**
 * Mod ids actually present on disk for a Workshop item.
 *
 * **The mod id is the `id=` field inside `mod.info` — NOT the folder name.** They
 * often differ, and assuming the folder name silently breaks the load list:
 * folder `CommunityTilePack` declares `id=UnofficialMappersCommunityTilePack`,
 * `Hot_Brass_Visible_Casing_Ejection_Framework` declares `id=HBVCEFb42`, and
 * `DragBodiesFaster 50%` declares `id=DBFaster50`. PZ resolves `Mods=` against
 * the declared id and logs `required mod "X" not found` for anything else.
 *
 * The server unpacks items to `content/<appid>/<workshopId>/mods/<folder>/…`,
 * with B42 adding a version folder (`common/`, `42/`) below that. Empty until the
 * server has downloaded the item at least once.
 */
export async function installedModIds(workshopId: string): Promise<string[]> {
  const root = path.join(PZ_WORKSHOP_DIR, "content", PZ_APP_ID, workshopId);
  const found = new Set<string>();

  /**
   * EVERY id a mod folder declares. A folder commonly ships several `mod.info`
   * files — one at the root for Build 41 and one per version folder for B42 —
   * with DIFFERENT ids, e.g. `Hot_Brass_…Framework` declares `zHBVCEF` at the
   * root and `HBVCEFb42` under `42.15/`. A server on B42 references the B42 id,
   * so returning only the first one found makes valid entries look invalid.
   */
  async function idsIn(modDir: string, folderName: string): Promise<string[]> {
    const ids = new Set<string>();

    async function scan(dir: string, depth: number): Promise<void> {
      if (depth > 2) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === "mod.info") {
          try {
            const declared = /^\s*id\s*=\s*(.+?)\s*$/im.exec(
              await readFile(path.join(dir, "mod.info"), "utf-8")
            )?.[1];
            if (declared) ids.add(declared);
          } catch {}
        } else if (entry.isDirectory()) {
          await scan(path.join(dir, entry.name), depth + 1);
        }
      }
    }

    await scan(modDir, 0);
    // No mod.info at all: the folder name is the best guess left.
    if (ids.size === 0) ids.add(folderName);
    return Array.from(ids);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "mods") {
        for (const mod of await readdir(path.join(dir, "mods"), { withFileTypes: true })) {
          if (!mod.isDirectory()) continue;
          for (const id of await idsIn(path.join(dir, "mods", mod.name), mod.name)) {
            found.add(id);
          }
        }
        continue;
      }
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return Array.from(found);
}

// ── RCON control ────────────────────────────────────────────────────────────

function pzTarget(): RconTarget {
  return {
    host: process.env.PZ_RCON_HOST || "zomboid",
    port: parseInt(process.env.PZ_RCON_PORT || "27015"),
    password: process.env.PZ_RCON_PASSWORD || "changeme",
  };
}

export async function pzConsole(command: string, timeoutMs = 8000): Promise<string> {
  return rconCommand(pzTarget(), command, timeoutMs);
}

/** Flush the world to disk. Used before stopping so nothing is lost. */
export async function pzSave(): Promise<void> {
  await pzConsole("save");
}

/**
 * Ask a running server to re-read its .ini, then ask it what it now believes.
 *
 * Both commands were run against the live server before this was written, because
 * shipping a call nobody has seen answer is how this codebase keeps acquiring success
 * messages for work that did not happen. Measured 2026-10-01:
 *
 *   $ help           → `* reloadoptions : Reload server options (ServerOptions.ini) and send to clients`
 *   $ reloadoptions  → `Options reloaded`
 *   $ showoptions    → `List of Server Options:` then `* Key=Value`, 137 lines
 *
 * `showoptions` is what turns "saved" into something checkable: all 137 values it
 * reported matched the .ini on disk byte for byte, so it is reading the same
 * `<servername>.ini` this app writes — which is the part a comment in the game's help
 * text could not have told us. The seven keys it withholds are the secrets and the
 * Discord channels, so an absent key means *unverifiable*, never *rejected*.
 *
 * `null` means RCON did not answer at all: the world is down or wedged, there is
 * nothing to reload, and the caller must say so rather than imply a live change.
 *
 * The timeout is short on purpose. This runs inside a sub-second config PUT, so a
 * wedged server must cost the request a few seconds, not the 8 s the status probe can
 * afford.
 */
export async function reloadLiveOptions(
  expect: Record<string, string>,
  timeoutMs = 4000
): Promise<PzLiveReload | null> {
  let reply: string;
  try {
    reply = await pzConsole("reloadoptions", timeoutMs);
  } catch {
    return null;
  }
  const reloaded = /options\s+reloaded/i.test(reply);

  let live: Map<string, string>;
  try {
    live = parseShowOptions(await pzConsole("showoptions", timeoutMs));
  } catch {
    // The reload was acknowledged but the read-back failed, so nothing is proven.
    return { reloaded, verified: [], unverified: Object.keys(expect), stale: [] };
  }
  return { reloaded, ...classifyLiveOptions(expect, live) };
}

export interface PzStatus {
  /** RCON answered — the world is loaded, not just the container running. */
  reachable: boolean;
  players: { online: number; max: number; players: string[] };
}

/** Max players from the .ini, so the UI shows the configured cap. */
async function maxPlayers(): Promise<number> {
  try {
    const v = parseInt(valueOf(await readIniProperties(), "MaxPlayers"), 10);
    return Number.isFinite(v) && v > 0 ? v : 16;
  } catch {
    return 16;
  }
}

export async function getPzStatus(timeoutMs = 8000): Promise<PzStatus> {
  const max = await maxPlayers();
  try {
    // `players` answers with:  Players connected (2):\n-Alice\n-Bob
    const out = await pzConsole("players", timeoutMs);
    const names = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    const counted = out.match(/\((\d+)\)/);
    return {
      reachable: true,
      players: { online: counted ? parseInt(counted[1], 10) : names.length, max, players: names },
    };
  } catch {
    return { reachable: false, players: { online: 0, max, players: [] } };
  }
}
