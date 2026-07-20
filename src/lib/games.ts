// Shared, client-safe identity + metadata for the two worlds.
// This is the single source of truth for accents, labels, routes and icons.

export type GameId = "minecraft" | "7dtd";

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
  tint: string; // var(--mc) | var(--sd)
  tintSoft: string;
  tintDeep: string;
  /** The connect address players use */
  connect: string;
  /** Approx RAM this world reserves, in GB, for the budget bar */
  ramGb: number;
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
    connect: "mc.yoshling.xyz",
    ramGb: 4,
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
    connect: "7dtd.yoshling.xyz:26900",
    ramGb: 5,
  },
};

export const GAME_LIST: GameMeta[] = [GAMES.minecraft, GAMES["7dtd"]];

/** Total RAM budget of the host box, in GB. Drives the "one world at a time" bar. */
export const HOST_RAM_GB = 8;

export function otherGame(id: GameId): GameId {
  return id === "minecraft" ? "7dtd" : "minecraft";
}

export function isGameId(v: string | null | undefined): v is GameId {
  return v === "minecraft" || v === "7dtd";
}

export type ServerStatus = "online" | "offline" | "starting" | "stopping" | "installing";

export const STATUS_LABEL: Record<ServerStatus, string> = {
  online: "Online",
  offline: "Offline",
  starting: "Booting",
  stopping: "Saving",
  installing: "Installing",
};
