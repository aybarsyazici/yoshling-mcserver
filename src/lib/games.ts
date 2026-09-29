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
  // There was a third, `tintDeep` (`var(--mc-deep)` &c). Zero consumers in any
  // component — the accent is always `tint`, and the chart's second series is
  // `tintSoft`. Deleted; the `--*-deep` CSS values still exist in `globals.css`.
  /** The connect address(es) players use. Multiple = show all (e.g. hostname + IP). */
  connect: string[];
  /**
   * How long a graceful stop of this world takes, in seconds.
   *
   * Here because the UI was stating one number for all three: the hand-off confirm and
   * the memory card both promised "about a minute" for every world, and Project
   * Zomboid's stop is a measured 5m 03s — so the single most-pressed control on the box
   * understated its own duration by 5×, which is how "I clicked Restart and it sat
   * there" became a bug report about something working as designed.
   *
   * **This is the TYPICAL duration, not the timeout.** The distinction was got wrong
   * once in this very file: Project Zomboid was set to 300 with a comment saying it
   * "never exits on SIGTERM", which was true of the old stop path and stopped being true
   * in the same change that wrote it down. The driver now asks the game to quit over
   * RCON and it exits in ~9s; 300 survives only as `PZ_STOP_TIMEOUT`, the fallback for
   * when RCON cannot land (a wedged server). Quoting the fallback as the expected wait
   * overstated the most-pressed control on the box by ~30x — the same class of error,
   * in the opposite direction, as the "about a minute" it replaced.
   *
   * So: put the measured normal case here, and let the UI say "up to" for the worst
   * case if it needs to. Re-measure when a stop path changes.
   */
  stopSeconds: number;
  /** Label for the free-form `detail` metric (uptime, in-game day, …) */
  detailLabel: string;
  /** Routes the shared components (console/backups/files) call for this game. */
  api: { console: string; backups: string; files: string };
  /** File-browser roots. Omitted = the endpoint's single default directory. */
  fileRoots?: GameFileRoot[];
  /** Whether this world gets a Mods page in the sidebar */
  hasMods: boolean;
}

/**
 * The box players connect to, in one place.
 *
 * It was written out per game before, and when the server moved to netcup two of
 * the three were left pointing at the decommissioned Hetzner box — so the landing
 * cards and both overview heroes spent two weeks telling people to connect to an
 * address that answers ICMP and refuses every game port.
 */
const HOST_IP = "89.58.50.155";

export const GAMES: Record<GameId, GameMeta> = {
  minecraft: {
    id: "minecraft",
    name: "Minecraft",
    short: "MC",
    tagline: "Start and stop the Minecraft server.",
    base: "/minecraft",
    tint: "var(--mc)",
    tintSoft: "var(--mc-soft)",
    connect: ["mc.yoshling.xyz"],
    // Measured 0.719s on production, exit code 0 (`time docker stop yoshling-mc`,
    // 2026-09-29). 5 allows for a populated world flushing chunks; 30 was a guess that
    // made the hand-off copy promise half a minute for something that takes under one.
    stopSeconds: 5,
    detailLabel: "Uptime",
    api: {
      console: "/api/server/console",
      backups: "/api/server/backups",
      files: "/api/server/files",
    },
    hasMods: true,
  },
  "7dtd": {
    id: "7dtd",
    name: "7 Days to Die",
    short: "7DTD",
    tagline: "Start and stop the 7 Days to Die server.",
    base: "/7dtd",
    tint: "var(--sd)",
    tintSoft: "var(--sd-soft)",
    // Show both: the hostname, and the raw IP (7DTD's direct-connect box only
    // reliably accepts a literal IP, so the IP is the sure thing).
    connect: ["7dtd.yoshling.xyz:26900", `${HOST_IP}:26900`],
    // Its entrypoint really does `trap exit_handler SIGINT SIGTERM` (unlike Project
    // Zomboid's, which the docs claimed for months and does not), so it exits on its own:
    // `docker inspect` reports `Exit=0`, not the 137 a SIGKILL leaves.
    //
    // **45 is an estimate, not a measurement** — the only 7DTD stop timed so far was
    // inside a 33s hand-off that also started another world, which does not isolate it.
    // Left deliberately generous and labelled rather than quietly changed to a
    // better-looking number: writing an unmeasured figure as though it were measured is
    // the habit this field has already been fixed for twice. Time one and replace this.
    stopSeconds: 45,
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
  },
  zomboid: {
    id: "zomboid",
    name: "Project Zomboid",
    short: "PZ",
    tagline: "Start and stop the Project Zomboid server.",
    base: "/zomboid",
    tint: "var(--pz)",
    tintSoft: "var(--pz-soft)",
    connect: ["pz.yoshling.xyz:16261", `${HOST_IP}:16261`],
    // Measured 11.4s through the dashboard on production, 0 players: RCON `quit`, then
    // `exited` with code 0. NOT 300 — that is `PZ_STOP_TIMEOUT`, the fallback for a
    // server too wedged to answer RCON.
    //
    // Was 30 ("that with headroom"), which rendered as "the stop takes about half a
    // minute" for an 11-second operation. Padding a measurement is how this field went
    // wrong the first two times, in both directions; put the number the box produced and
    // let the copy say "about" if it wants to hedge.
    stopSeconds: 12,
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
  },
};

export const GAME_LIST: GameMeta[] = [GAMES.minecraft, GAMES["7dtd"], GAMES.zomboid];

// `HOST_RAM_GB = 8` and `GameMeta.ramGb` used to live here as "display fallbacks".
// Both had zero readers — `useGames` carries `hostGb` and `memoryGb` from
// `/api/games/status`, which derives them from `/proc/meminfo` and the compose file.
// They are deleted rather than kept, because the one thing a stale fallback reliably
// does is outlive the hardware: `8` was the Hetzner box, and this one has 16 GB.

/** The other worlds — the ones that must be stopped for `id` to get the box. */
export function otherGames(id: GameId): GameId[] {
  return GAME_LIST.filter((g) => g.id !== id).map((g) => g.id);
}

export function isGameId(v: string | null | undefined): v is GameId {
  return v === "minecraft" || v === "7dtd" || v === "zomboid";
}

export type ServerStatus = "online" | "offline" | "starting" | "stopping" | "installing";

/**
 * One vocabulary for one container.
 *
 * These are the `StatusPill` labels, and they used to be a second, different set of
 * words for the same five states the headings already named: the pill said
 * "Online / Offline / Booting" two inches from a heading saying
 * "Running / Stopped / Starting…", so a single container described itself twice and
 * disagreed with itself both times.
 *
 * `stopping` was the worse one. It read **"Saving"**, which is true for the first
 * ~1 second of a Project Zomboid stop and false for the remaining ~300: the save
 * completes in ~100–150 ms and the rest is `docker stop` waiting out the grace period.
 * So the pill spent five minutes claiming a save that had already finished — the
 * house defect ("reports something it did not observe") at the label layer. It now
 * says what is actually true for the whole window.
 */
export const STATUS_LABEL: Record<ServerStatus, string> = {
  online: "Running",
  offline: "Stopped",
  starting: "Starting",
  stopping: "Stopping",
  installing: "Installing",
};
