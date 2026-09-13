import { readdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { rconCommand, type RconTarget } from "@/lib/rcon";

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
 */
export const INFRA_KEYS = [
  "RCONPassword",
  "RCONPort",
  "DefaultPort",
  "UDPPort",
  "SteamPort1",
  "SteamPort2",
] as const;

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

/**
 * Rewrite the given keys in place, appending any that aren't in the file yet.
 * Line-based so every comment, blank line and untouched key survives verbatim.
 */
export function setIniValues(
  text: string,
  updates: Record<string, string>
): { text: string; applied: string[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const applied: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    if (!pending.has(m[1])) continue;
    lines[i] = `${m[1]}=${sanitizeValue(pending.get(m[1]) ?? "")}`;
    applied.push(m[1]);
    pending.delete(m[1]);
  }
  for (const [key, value] of pending) {
    lines.push(`${key}=${sanitizeValue(value)}`);
    applied.push(key);
  }

  return { text: lines.join(eol), applied };
}

/** A newline in a value would split the key across lines and corrupt the file. */
function sanitizeValue(v: string): string {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

export async function readIni(): Promise<string> {
  return readFile(await iniPath(), "utf-8");
}

export async function readIniProperties(): Promise<PzProperty[]> {
  return parseIni(await readIni());
}

/** Apply a subset of settings to the .ini on disk. */
export async function updateIni(updates: Record<string, string>): Promise<string[]> {
  const file = await iniPath();
  const current = await readFile(file, "utf-8");
  const { text, applied } = setIniValues(current, updates);
  await writeFile(file, text, "utf-8");
  return applied;
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
export function modIdPrefix(existingTokens: string[]): string {
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
