/**
 * What `server.properties` holds, and what the running Minecraft build actually reads.
 *
 * **Why this file exists at all, given that a declarative per-game settings schema was
 * explicitly rejected.** 7 Days to Die's XML and Project Zomboid's `.ini` each carry a
 * comment per setting, so one generic `ConfigPanel` can render help straight out of the
 * file and a schema would only be a second source of truth to rot. `server.properties`
 * has **no comments at all** — the live file is 71 bare `key=value` lines under two
 * header lines the server writes — so there is no in-file text to render, and the
 * Minecraft settings page was the one settings surface in the app with no help and no
 * grouping.
 *
 * This is therefore deliberately *not* a schema: it does not declare the editable
 * surface (the file still does — the editor renders whatever keys it parses, and an
 * unknown key is simply shown), it declares nothing about types it does not have to,
 * and every claim in it is a **fact measured against one named build** and stamped with
 * that build in `MC_PROPERTIES_VERIFIED_FOR`. When the version bumps, the stamp is the
 * thing that tells the next reader to re-measure instead of to trust.
 *
 * How to re-measure (all of it is read-only, and it is how the tables below were
 * produced on 2026-10-01 against 26.1.2):
 *
 *   # does the server still read a property? the literal lives in DedicatedServerProperties.
 *   # python3 is present in the itzg image; zipfile over /data/versions/<v>/server-<v>.jar,
 *   # recursing into nested jars, and search every *.class entry for the key's bytes.
 *   # what game rules exist?
 *   docker exec yoshling-mc rcon-cli "help gamerule"
 *   docker exec yoshling-mc rcon-cli "gamerule pvp"        # query form only, no write
 */

/**
 * The build every claim below was measured against — read off the server itself with
 * `docker exec yoshling-mc rcon-cli version`:
 * `id = 26.1.2  name = 26.1.2  data = 4790  series = main  protocol = 775`.
 */
export const MC_PROPERTIES_VERIFIED_FOR = "26.1.2";

/**
 * Keys this editor must neither show nor write. 7DTD has the same set as `LOCKED`
 * and Project Zomboid as `INFRA_KEYS`; this is Minecraft's, and it exists for the
 * same two reasons.
 *
 * **Read:** the properties GET is deliberately open to anyone with Minecraft access
 * (a MEMBER may browse settings), so every key it returns is a key every viewer
 * can read — and the page renders each one in a plain `<Input>`. Until this set
 * existed, `/minecraft/settings` printed the live RCON password
 * (`rcon.password`, verified present in the file on the box) into the browser of
 * anyone who could see the world.
 *
 * **Write:** `enable-rcon` / `rcon.password` / `rcon.port` are the dashboard's own
 * control channel, and it authenticates with `RCON_PASSWORD` from the container
 * env, so a value typed here can only ever *disagree* with the one in use — the
 * same trap already paid for with 7DTD's `TelnetPassword`. `server-port` is fixed
 * by the compose port mapping; moving it makes the server listen where nothing is
 * forwarded, which reads as "connect hangs, nothing in the logs".
 *
 * `level-name` is locked for a different reason: the backup route hardcodes the
 * `world/` directory (`tar -C /minecraft world`, `rm -rf /minecraft/world`).
 * Rename the level and backups quietly archive a directory the server no longer
 * writes, while a restore deletes nothing and unpacks over nothing — a backup
 * page that still looks like it works while protecting an empty folder.
 *
 * `server-ip` is the newest member and the most dangerous one that was missing. It is
 * the *bind address*, so it is `server-port`'s trap with a wider blast radius, and the
 * 2026-09-28/10-01 settings audit demonstrated it destructively: set to `127.0.0.1` the
 * server binds inside the container's loopback, which takes down **both** the published
 * game port and the dashboard's own RCON. That second half is what makes it worse than
 * `server-port`: RCON on 25575 is not published to the host (verified — a connection to
 * `127.0.0.1:25575` from the box is refused; the web container reaches the game as
 * `minecraft:25575` over the compose network), so the probe goes dark, the status flips
 * to "Not responding", and the one control that could put the value back is this editor
 * — which can no longer be trusted to be reading a live file. One text field, no route
 * to recovery from the UI. It stays empty (= all interfaces), which is what the live
 * file holds.
 */
export const MC_LOCKED_KEYS = [
  "enable-rcon",
  "rcon.password",
  "rcon.port",
  "server-port",
  "server-ip",
  "level-name",
] as const;

const LOCKED = new Set<string>(MC_LOCKED_KEYS);

/**
 * Locked **by shape as well as by name**, so a version bump that adds a new
 * credential key is hidden by default rather than after somebody notices.
 *
 * The named set above predates Minecraft 26's Management Server API, and the gap
 * was real, not theoretical. Read live from the box: `server.properties` contains
 * `management-server-secret=…` (a 40-character bearer token) and
 * `management-server-tls-keystore-password`, and this editor printed both into the
 * browser of anyone with Minecraft access — the GET is deliberately open to a
 * MEMBER. `management-server-enabled` was writable too, so a read-only viewer could
 * be shown a switch that turns on a remote-admin HTTP API.
 *
 * The whole `management-server-` block is locked for the same reason `enable-rcon`
 * is: it is a second control channel, and none of it is the dashboard's to hand out.
 *
 * Checked against the live file, 2026-10-01: 71 `key=value` lines, of which the
 * deployed GET returned 58 — and `server-ip` was one of them, with
 * `level-type=minecraft\:normal` as proof of the escaping bug below. Locking
 * `server-ip` takes that to 57. This shape rule hides the eight `management-server-*`
 * keys and nothing else, leaving no key matching /password|secret|token/ visible;
 * `enforce-secure-profile` is the only near-miss and does not match ("secure", not
 * "secret").
 */
export function isLockedMcProperty(key: string): boolean {
  return (
    LOCKED.has(key) ||
    key.startsWith("management-server-") ||
    /password|secret|token/.test(key)
  );
}

/**
 * A newline in a value would end the line early and turn the rest into further
 * `key=value` pairs — which is how a locked key gets set through an unlocked one
 * (`motd=hi\nlevel-name=other`). Same guard as PZ's `sanitizeValue`.
 */
export function sanitizeMcValue(v: unknown): string {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

/**
 * `server.properties` is a **java.util.Properties** file, and `Properties.store`
 * backslash-escapes `:` in values. That is not a hypothetical: the live file holds
 * `level-type=minecraft\:normal`, written by the server itself.
 *
 * The page's `level-type` dropdown offered `minecraft:normal` and the file said
 * `minecraft\:normal`, so the two never compared equal and the select rendered as
 * **empty on every load** — pick anything and you have silently changed the world
 * type, leave it alone and the control still looks unset. Nothing warned, because
 * nothing was wrong with the file.
 *
 * So values are unescaped on the way out to the browser and re-escaped on the way back
 * to disk. Only `:` is handled, on purpose: those are the only escapes present in the
 * live file, and the round trip has to be **idempotent** — the page re-sends values it
 * received — so a broader unescape (`\\`, `\uXXXX`) would need an exactly symmetric
 * re-escape to avoid mangling a value nobody has ever set here. Leaving unknown
 * sequences byte-identical keeps today's behaviour for every other key.
 */
export function unescapeMcValue(v: string): string {
  return v.replace(/\\:/g, ":");
}

export function escapeMcValue(v: string): string {
  // Only an unescaped colon, so applying this twice is the same as applying it once.
  return v.replace(/(?<!\\):/g, "\\:");
}

/**
 * Properties the dashboard writes that **26.1.2 does not read**, and the game rule that
 * replaced each one.
 *
 * This is the project's documented defect class — "reports success after doing nothing"
 * — in its purest form: flip PVP off, get a green "server.properties saved", and PVP
 * stays on forever. Three facts, each measured on 2026-10-01 against the 26.1.2 server
 * jar and the running world:
 *
 *  1. The property-name literals are **gone from the jar**. A recursive scan of every
 *     class entry in `/data/versions/26.1.2/server-26.1.2.jar` finds `spawn-monsters`,
 *     `allow-nether` and `enable-command-block` in **zero** classes, while the same scan
 *     of `/data/versions/1.21.4/server-1.21.4.jar` (still on the volume) finds all three
 *     in `apv.class` — the obfuscated `DedicatedServerProperties`, identified by the
 *     `online-mode` / `server-ip` / `enable-query` literals it also holds. `pvp` survives
 *     in 26.1.2 only in `GameRules.class` and `GameRuleRegistryFix.class` (a datafixer —
 *     i.e. the thing that migrates the old value into the world), and in 1.21.4 only in
 *     `apv.class`. The property moved; it did not merely get renamed.
 *  2. The replacement game rules answer: `rcon-cli "gamerule pvp"` →
 *     `Gamerule pvp is currently set to: true`, and likewise `spawn_monsters`,
 *     `command_blocks_work`, `allow_entering_nether_using_portals`. (26.1 renamed every
 *     game rule to snake_case as well — `keepInventory` and `doDaylightCycle` are both
 *     `Incorrect argument` now, which is why these ids look unfamiliar.)
 *  3. The two already **disagree in production**, which is the proof that does not
 *     depend on reading bytecode: `server.properties` says `enable-command-block=false`
 *     while the world says `command_blocks_work = true`. The file lost that argument
 *     silently, months ago.
 *
 * The keys are deliberately still *shown* (the file holds them, and hiding them would
 * make the editor lie by omission) but rendered read-only with this rule named, and the
 * PUT refuses them rather than writing a value it knows is inert.
 */
export const MC_GAME_RULE_REPLACEMENTS: Record<string, string> = {
  pvp: "pvp",
  "spawn-monsters": "spawn_monsters",
  "enable-command-block": "command_blocks_work",
  "allow-nether": "allow_entering_nether_using_portals",
};

/**
 * Did this Minecraft version move those four properties into game rules?
 *
 * Three-state on purpose. Minecraft switched from `1.x` to a calendar-ish `26.x` scheme,
 * so "major ≥ 26" is the whole test — but an unparseable version must answer **`null`
 * ("unknown")** rather than `false`, and the callers treat the two differently: `null`
 * annotates nothing and writes the key anyway (today's behaviour, no new failure mode),
 * `true` refuses the write and names the game rule. Answering `false` for a version
 * string nobody recognises would re-open exactly the silent-success hole this closes, and
 * answering `true` would refuse a write that works on 1.21.4 — which is still installed
 * on the volume and still selectable in the dropdown.
 */
export function movedToGameRules(version: string | null | undefined): boolean | null {
  if (!version) return null;
  const major = /^(\d+)\./.exec(version.trim())?.[1];
  if (major === undefined) return null;
  return Number(major) >= 26;
}

/** The game rule that replaced `key`, or null when this version still reads the file. */
export function gameRuleReplacing(key: string, version: string | null | undefined): string | null {
  if (movedToGameRules(version) !== true) return null;
  return MC_GAME_RULE_REPLACEMENTS[key] ?? null;
}

/**
 * Settings that write correctly and **can have no effect in this deployment**.
 *
 * Labelled, not hidden: every one of them is a real property that 26.1.2 still reads
 * (each literal is in `DedicatedServerProperties`), and each would start mattering the
 * day the deployment changes — publish a UDP port, turn `online-mode` on, add a second
 * server. Hiding them would be a different lie, and one that hides the reason.
 *
 * Measured 2026-10-01: `docker inspect yoshling-mc` reports exactly one port mapping,
 * `25565/tcp` → nothing UDP is published at all; `server.properties` holds
 * `online-mode=false` and an empty `text-filtering-config`.
 */
export const MC_INERT_HERE: Record<string, string> = {
  "enable-query": // GameSpy4 query listener
    "The query listener is UDP, and this container publishes only 25565/tcp " +
    "(docker inspect shows one mapping), so nothing off the box can reach it.",
  "query.port":
    "Same as enable-query: no UDP port is published, so this picks a port nothing " +
    "outside the container can talk to.",
  "enable-jmx-monitoring":
    "JMX needs the JVM's remote-management flags and a published port; neither is " +
    "set here, so this registers an MBean nothing can connect to.",
  "prevent-proxy-connections":
    "This asks Mojang whether the client's address matches its session. online-mode " +
    "is false on this server, so there is no session to check.",
  "text-filtering-config":
    "Chat filtering needs a filtering service to point at. This is empty, so there " +
    "is nothing to filter through.",
  "text-filtering-version":
    "Only read when text-filtering-config names a service, which it does not here.",
  "accepts-transfers":
    "Accepts players redirected from another Minecraft server by a transfer packet. " +
    "There is no second Minecraft server in this deployment.",
};

/**
 * Settings whose effect depends on a **sibling value in the same file**, evaluated
 * against the values actually loaded rather than stated as a fixed fact.
 *
 * Both of these render as independent switches, and both are dead while their partner is
 * off — "Require Resource Pack" with no resource pack, "Enforce Whitelist" with the
 * whitelist disabled. A function, not a table: the note disappears by itself the moment
 * someone sets the sibling, so it cannot go stale the way a hardcoded sentence would.
 */
export function mcCouplingNote(key: string, props: Record<string, string>): string | null {
  if (key === "require-resource-pack" && !(props["resource-pack"] ?? "").trim()) {
    return "No resource pack is set, so there is nothing to require. Fill in Resource Pack first.";
  }
  if (key === "enforce-whitelist" && props["white-list"] !== "true") {
    return "The whitelist is off (White List is disabled), so this enforces nothing.";
  }
  if (key === "query.port" && props["enable-query"] === "false") {
    return "Enable Query is off, so no port is opened.";
  }
  return null;
}

/**
 * Keys rendered as a dropdown, with the values the server accepts.
 *
 * `level-type` holds the **unescaped** form here; the GET unescapes what it reads, so
 * the two now compare equal (see `unescapeMcValue` for the bug this fixes).
 *
 * `region-file-compression` was a free-text box, and the accepted values are not
 * guessable. They are read out of 26.1.2's `RegionFileVersion.class`, which carries the
 * three option names `deflate`, `none`, `lz4` next to the message it logs for anything
 * else: "Invalid `region-file-compression` value `{}` in server.properties. Please use
 * one of: {}". So a typo is *rejected and logged* rather than silently corrupting a
 * world — but the real hazard the dropdown removes is subtler and permanent: chunks are
 * written in whichever scheme is selected, so switching to `lz4` and later going back to
 * a build that does not offer it leaves region files that build cannot read.
 */
export const MC_SELECTS: Record<string, string[]> = {
  difficulty: ["peaceful", "easy", "normal", "hard"],
  gamemode: ["survival", "creative", "adventure", "spectator"],
  "level-type": [
    "minecraft:normal",
    "minecraft:flat",
    "minecraft:large_biomes",
    "minecraft:amplified",
    "minecraft:single_biome_surface",
  ],
  "region-file-compression": ["deflate", "lz4", "none"],
};

/**
 * The options to render for a dropdown, with the **current value included even when it is
 * not one of them**.
 *
 * This is the same bug as the escaped colon, one level up: a value the list does not
 * contain renders as an empty select, which looks like "unset" and is one click away from
 * silently replacing a setting the operator never chose. It is not hypothetical for
 * `level-type` — a datapack or mod can register its own generator — and `difficulty` /
 * `gamemode` accept their numeric legacy forms in older files.
 *
 * The unknown value goes first and the known ones follow, so what is in the file is what
 * the trigger shows.
 */
export function mcSelectOptions(key: string, value: string): string[] {
  const known = MC_SELECTS[key] ?? [];
  if (value === "" || known.includes(value)) return known;
  return [value, ...known];
}

/**
 * Keys that must render as free text even when the current value is all digits.
 *
 * `level-seed` is an opaque 64-bit token: it may be negative, it may be a word
 * (the server hashes anything that is not a number), and `type="number"` on a 19-digit
 * seed gives a spinner that can nudge it by one and a field that silently refuses a
 * leading `-`. The type inference is value-shaped, so an empty seed looked like text and
 * the moment someone set a numeric one it became a number input.
 */
export const MC_TEXT_KEYS = new Set<string>(["level-seed"]);

/**
 * Grouping for the editor, which was a flat alphabetical grid of ~58 bare labels.
 *
 * Unknown keys fall through to "Other" rather than disappearing, so this table cannot
 * hide a key the next version adds — it can only fail to file it nicely. That is the
 * one property the test pins; the exact grouping is taste.
 */
export const MC_PROPERTY_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "Gameplay",
    keys: [
      "difficulty",
      "gamemode",
      "force-gamemode",
      "hardcore",
      "pvp",
      "spawn-monsters",
      "spawn-protection",
      "allow-flight",
      "allow-nether",
      "enable-command-block",
      "enable-code-of-conduct",
      "player-idle-timeout",
      "pause-when-empty-seconds",
    ],
  },
  {
    title: "World & generation",
    keys: [
      "level-type",
      "level-seed",
      "generator-settings",
      "generate-structures",
      "max-world-size",
      "region-file-compression",
      "sync-chunk-writes",
      "initial-enabled-packs",
      "initial-disabled-packs",
    ],
  },
  {
    title: "Players & access",
    keys: [
      "max-players",
      "white-list",
      "enforce-whitelist",
      "online-mode",
      "enforce-secure-profile",
      "prevent-proxy-connections",
      "accepts-transfers",
      "op-permission-level",
      "function-permission-level",
      "hide-online-players",
      "log-ips",
    ],
  },
  {
    title: "Performance & network",
    keys: [
      "view-distance",
      "simulation-distance",
      "entity-broadcast-range-percentage",
      "max-tick-time",
      "max-chained-neighbor-updates",
      "network-compression-threshold",
      "rate-limit",
      "use-native-transport",
    ],
  },
  {
    title: "Presentation",
    keys: [
      "motd",
      "resource-pack",
      "resource-pack-id",
      "resource-pack-prompt",
      "resource-pack-sha1",
      "require-resource-pack",
      "bug-report-link",
      "text-filtering-config",
      "text-filtering-version",
    ],
  },
  {
    title: "Status & monitoring",
    keys: [
      "enable-status",
      "status-heartbeat-interval",
      "enable-query",
      "query.port",
      "enable-jmx-monitoring",
      "broadcast-console-to-ops",
      "broadcast-rcon-to-ops",
    ],
  },
];

export const MC_OTHER_GROUP = "Other";

const GROUP_BY_KEY = new Map<string, string>(
  MC_PROPERTY_GROUPS.flatMap((g) => g.keys.map((k) => [k, g.title] as const))
);

export function mcPropertyGroup(key: string): string {
  return GROUP_BY_KEY.get(key) ?? MC_OTHER_GROUP;
}

/**
 * The editor's rows, grouped, in the declared order, with the "Other" bucket last.
 *
 * Returns only groups that have keys present, so a version that drops a whole group does
 * not leave an empty heading behind.
 */
export function groupMcProperties(
  props: Record<string, string>
): { title: string; keys: string[] }[] {
  const keys = Object.keys(props);
  const out: { title: string; keys: string[] }[] = [];
  for (const group of MC_PROPERTY_GROUPS) {
    const present = group.keys.filter((k) => k in props);
    if (present.length > 0) out.push({ title: group.title, keys: present });
  }
  const other = keys.filter((k) => !GROUP_BY_KEY.has(k)).sort();
  if (other.length > 0) out.push({ title: MC_OTHER_GROUP, keys: other });
  return out;
}
