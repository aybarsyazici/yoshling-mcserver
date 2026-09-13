// Shared, client-safe identity + metadata for the worlds this box hosts.
// This is the single source of truth for accents, labels, routes and the
// per-game API endpoints the shared control components talk to.

export type GameId = "minecraft" | "7dtd" | "zomboid";

/** A named directory the file browser can start from (7DTD/PZ have several). */
export interface GameFileRoot {
  key: string;
  label: string;
}

export interface GameMeta {
  id: GameId;
  /** Display name */
  name: string;
  /** Short tag used in compact spots */
  short: string;
  /** One-line personality blurb */
  tagline: string;
  /** Base route for this game's dashboard */
  base: string;
  /** CSS custom-property names for the accent (already themed light/dark) */
  tint: string; // var(--mc) | var(--sd) | var(--pz)
  tintSoft: string;
  tintDeep: string;
  /** The connect address(es) players use. Multiple = show all (e.g. hostname + IP). */
  connect: string[];
  /** Approx RAM this world reserves, in GB, for the budget bar */
  ramGb: number;
  /** Label for the free-form `detail` metric (uptime, in-game day, …) */
  detailLabel: string;
  /** Routes the shared components (console/backups/files) call for this game. */
  api: { console: string; backups: string; files: string };
  /** File-browser roots. Omitted = the endpoint's single default directory. */
  fileRoots?: GameFileRoot[];
  /** Whether this world gets a Mods page in the sidebar */
  hasMods: boolean;
  /** Whether this world gets a Whitelist page in the sidebar */
  hasWhitelist: boolean;
}

export const GAMES: Record<GameId, GameMeta> = {
  minecraft: {
    id: "minecraft",
    name: "Minecraft",
    short: "MC",
    tagline: "Start and stop the Minecraft server.",
    base: "/minecraft",
    tint: "var(--mc)",
    tintSoft: "var(--mc-soft)",
    tintDeep: "var(--mc-deep)",
    connect: ["mc.yoshling.xyz"],
    ramGb: 4,
    detailLabel: "Uptime",
    api: {
      console: "/api/server/console",
      backups: "/api/server/backups",
      files: "/api/server/files",
    },
    hasMods: true,
    hasWhitelist: true,
  },
  "7dtd": {
    id: "7dtd",
    name: "7 Days to Die",
    short: "7DTD",
    tagline: "Start and stop the 7 Days to Die server.",
    base: "/7dtd",
    tint: "var(--sd)",
    tintSoft: "var(--sd-soft)",
    tintDeep: "var(--sd-deep)",
    // Show both: the hostname, and the raw IP (7DTD's direct-connect box only
    // reliably accepts a literal IP, so the IP is the sure thing).
    connect: ["7dtd.yoshling.xyz:26900", "178.105.163.254:26900"],
    ramGb: 5,
    detailLabel: "In-game day",
    api: {
      console: "/api/7dtd/console",
      backups: "/api/7dtd/backups",
      files: "/api/7dtd/files",
    },
    fileRoots: [
      { key: "config", label: "Config" },
      { key: "saves", label: "Saves" },
    ],
    hasMods: false,
    hasWhitelist: false,
  },
  zomboid: {
    id: "zomboid",
    name: "Project Zomboid",
    short: "PZ",
    tagline: "Start and stop the Project Zomboid server.",
    base: "/zomboid",
    tint: "var(--pz)",
    tintSoft: "var(--pz-soft)",
    tintDeep: "var(--pz-deep)",
    connect: ["pz.yoshling.xyz:16261", "178.105.163.254:16261"],
    ramGb: 4,
    detailLabel: "Uptime",
    api: {
      console: "/api/zomboid/console",
      backups: "/api/zomboid/backups",
      files: "/api/zomboid/files",
    },
    fileRoots: [
      { key: "config", label: "Config" },
      { key: "saves", label: "Saves" },
      { key: "all", label: "All data" },
    ],
    hasMods: true,
    hasWhitelist: false,
  },
};

export const GAME_LIST: GameMeta[] = [GAMES.minecraft, GAMES["7dtd"], GAMES.zomboid];

/** Total RAM budget of the host box, in GB. Drives the "one world at a time" bar. */
export const HOST_RAM_GB = 8;

/** The other worlds — the ones that must be stopped for `id` to get the box. */
export function otherGames(id: GameId): GameId[] {
  return GAME_LIST.filter((g) => g.id !== id).map((g) => g.id);
}

export function isGameId(v: string | null | undefined): v is GameId {
  return v === "minecraft" || v === "7dtd" || v === "zomboid";
}

export type ServerStatus = "online" | "offline" | "starting" | "stopping" | "installing";

export const STATUS_LABEL: Record<ServerStatus, string> = {
  online: "Online",
  offline: "Offline",
  starting: "Booting",
  stopping: "Saving",
  installing: "Installing",
};
