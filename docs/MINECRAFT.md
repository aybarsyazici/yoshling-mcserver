# Minecraft

Depth that was accumulating in `CLAUDE.md` with nowhere to go. The shared architecture —
memory, versions, `applyServiceEnv`, the operation registry — stays there; this is the
Minecraft-specific part.

Status: boots and has been exercised end to end. Compose, `ServerConfig.mcVersion` and the
jars on disk all say **26.1.2**; it starts in `Done (1.661s)!`. **No in-game join has ever
been observed on netcup** — only a person with the game can prove a client connects.

## Identity: the offline UUID

`src/lib/mc-identity.ts` derives a player's UUID the way the server does for an offline-mode
world: **`md5("OfflinePlayer:" + name)`, version 3**.

This exists because the in-game whitelist and ops **never worked until 2026-09-30**. Both
files were written with `uuid: ""`, which matches nobody, so enabling the whitelist and
adding yourself locked *everyone* out — with a green success toast. Anything that writes a
name into a file the server parses (`whitelist.json`, `ops.json`, `banned-players.json`)
needs a real UUID from this module. Do not reimplement it, and do not write an empty one
"because the server will fill it in": it does not.

## Settings surfaces

Minecraft is the one game whose config file has **no comments**, so it is also the one that
needs a hand-written help table (`src/lib/mc-properties.ts`). 7DTD's XML and PZ's `.ini`
document themselves, which is why one generic `ConfigPanel` serves both and not this.

See [`SETTINGS.md`](SETTINGS.md) for the shared layer. Minecraft-specific:

- **RCON answers almost nothing about `server.properties`.** The configured-vs-live probe
  gets exactly two values: `difficulty` (from `difficulty`, which replies `The difficulty is
  Hard` while the file says `difficulty=hard` — the lowercasing happens in the parser, where
  the value is known to be an enum) and `max-players` (from `list`). Everything else is
  configured-only.
- **Game rules override `server.properties` and the properties route knows it.** It refuses
  a write to a key a game rule has taken over, rather than writing a value that will have no
  effect. There is a control for them now — see [Game rules](#game-rules) below.
- `gamerule <name>` is the **query** form and `gamerule <name> <value>` is the write.
  **Rule names on the deployed 26.1.2 build are `snake_case`** (`mob_griefing`,
  `keep_inventory`, `fall_damage`), measured 2026-10-01; `server.properties` keys are
  kebab-case. This doc said camelCase (`mobGriefing`, `keepInventory`, `doFireTick`) — that
  is the **1.21.x** spelling, which is still right for the 1.21.4 jars on the volume and
  wrong for what is running. Nothing in the app hardcodes either, and that is on purpose.

## Game rules

`/api/server/gamerules` + the Game rules panel on `/minecraft/settings`
(`src/components/mc-game-rules.tsx`, logic in `src/lib/mc-gamerules.ts`). The only config
surface in the app that reads and writes the **running game** rather than a file.

Before it existed the dashboard could *detect* that a `server.properties` key had moved to a
game rule, refuse the write, and then only tell you to type the command yourself — for 58
rules none of which it listed. Someone was doing exactly that: production has
`enable-command-block=false` in the file against `command_blocks_work = true` in the world,
and `mob_griefing` is false with nothing in this app having set it.

**The rule ids are discovered with `help gamerule`, never hardcoded.** 26.1 renamed every
rule and not mechanically (`enable-command-block` → `command_blocks_work`), while 1.21.4 is
still on the volume and still selectable, so a fixed list would be wrong for one of the two
builds and would fail by rendering an empty panel — which reads as "this server has no game
rules". It is also the write path's injection guard: the only ids ever interpolated into a
console command are ids the game itself printed.

**A write is followed by a fresh query**, so what the UI shows is what the game read back,
not what was typed. A disagreement is a 502 carrying both values, never a 200 with
`applied: false`. The switches have no optimistic local state for the same reason.

### `help gamerule` is 5 KB with no newlines, and both halves of that bit

Measured against the live server on 2026-10-01, and committed as
`src/lib/__tests__/fixtures/mc-help-gamerule.txt`:

- the full reply is **5,099 bytes** (5,082 as captured) and contains **zero newlines**.
  `RconConsoleSource.sendSystemMessage` appends each feedback message to one buffer with no
  separator, so brigadier's usage lines arrive as one run-together string.
- it lists **58 rules, each twice** — bare and `minecraft:`-namespaced — so 116 occurrences
  of the literal `/gamerule `.

Two bugs followed, and each was sufficient on its own to make the panel lie:

1. the parser split on `\n`, found one "line", and returned **one** rule id. The route
   answered 200 with it.
2. read through `sendCommand` the reply arrives **truncated at exactly 4096 bytes**, because
   `rcon-client` resolves on the first packet. ~46 of 58 rules.

So: **the discovery read goes through `sendCommandLong`** (`src/lib/rcon-long.ts`, see
`rcon-frame.ts` for the framing) and the parser splits on the `/gamerule ` delimiter, strips
`minecraft:` and de-duplicates. Per-rule `gamerule <id>` queries are ~50 bytes and stay on
the cached socket.

And because a short read is indistinguishable from a small build at the call site,
`assessGameRuleList` is a **floor**: under 10 rules it refuses, and the message says what was
actually read ("Read 1 game rule out of the server's 5082-character reply … which mentions
gamerule 116 times") rather than naming a cause. A reply exactly 4096 long warns about the
packet cliff even though it clears the floor, because ~46 rules looks complete. The PUT
applies the same floor **before** judging whether a rule exists — on a misread list it used
to answer `400 "this build has no game rule called fall_damage. 26.1 renamed the rules"` for
a rule the server had just listed 116 times.

### The defaults table states a default or states none

`MC_GAME_RULES` adds the two things the server does not supply: help text and defaults,
joined to a discovered id by a case- and separator-insensitive canonical form so one entry
covers both spellings of the rename. **`default` is optional.** Five entries leave it empty
on purpose — the four rules 26.x created out of `server.properties` keys (`pvp`,
`spawn_monsters`, `command_blocks_work`, `allow_entering_nether_using_portals`) did not exist
in 1.21.x, so the column's only stated provenance cannot be true of them, and
`playersNetherPortalCreativeDelay` was written as `1` where the deployed registry reports
`0`. The column drives one soft "not the vanilla default" hint and nothing that writes; a
rule with no default renders no hint. Verify a default or state none.

**24 of the 58 live ids have no table entry** (measured: the table describes 34, pinned by a
test) — `advance_time`, `spawn_mobs`, `block_drops`, `natural_health_regeneration`, `raids`,
`locator_bar` and so on, because the 26.x rename was not mechanical (nothing canonical gets
from `doDaylightCycle` to `advance_time`) and nobody has measured what each new one does. They still render,
grouped under "Other", with their live value and no help — annotation is additive here, never
a filter. Adding help for them is real work left undone, not a bug.

## Modpacks — and the better way, which we are not using

**The current implementation is not the best way to do this, and the evidence is inside the
image we already run.**

`/api/mods/install-modpack` resolves a pack to a list of mods and downloads each one into the
mods directory itself. Measured against the running `itzg/minecraft-server` container
2026-10-01, that image ships a first-class Modrinth modpack installer we are not calling:

| | ours | `mc-image-helper install-modrinth-modpack` |
|---|---|---|
| Pack format | a resolved mod list | the real `.mrpack`, including its `overrides/` tree (configs, datapacks, scripts the pack needs) |
| Client-only mods | nothing filtered | `env.server` **plus** a curated list of **104** known-client-only slugs at `/image/modrinth-exclude-include.json`, maintained upstream. More than `env.server` gives you: plenty of mods declare `server: optional` and are still useless or harmful on a server |
| Hash verification | none | yes |
| Mod loader | assumed to already match | installed from the pack, with `--force-modloader-reinstall` |
| Escape hatches | none | `--exclude-files`, `--force-include-files`, `--overrides-exclusions`, `--ignore-missing-files` |

Facts, first-hand from the container: `/usr/bin/mc-image-helper` exists;
`mc-image-helper install-modrinth-modpack --help` lists the options above;
`/image/scripts/start-deployModrinth` wires it to `MODRINTH_MODPACK` / `MODRINTH_PROJECT`,
`MODRINTH_LOADER`, `MODRINTH_VERSION` and friends under `MODPACK_PLATFORM=MODRINTH`;
`globalExcludes` in that json has 104 entries.

**Why this fits this project better than it looks.** It runs at container start from env
vars, which sounds like the wrong shape for a dashboard that installs things at runtime —
but applying a modpack through it would be an `.env` patch plus
`create --force-recreate`, which is **exactly** the mechanism `applyServiceEnv` already
implements for the version/loader change, with the control lock, the graceful stop, the
"a stopped world stays stopped" rule and the operation ledger all already in place. The
hand-rolled downloader is the part that does not fit the architecture.

**Not a reason to drop the per-mod work.** `/api/mods/install` installs a *single* mod and
has no image-level equivalent, so `env.server` filtering and hash verification still have to
live in this app for that path. The pack path is where the image is strictly better.

Decide before building more on the current installer. Switching is a real change — the
ledger copy, the `InstalledMod` rows (the image owns the mods dir, so the app's inventory
becomes a *read* of what landed rather than a record of what it put there), and the existing
pack import/export would all move.

### Pack facts that are not bugs

`COBBLEVERSE` publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11. On a 26.1.2 server
neither can install no matter how often it is re-imported, and the apply refuses with an
honest version mismatch. That is a fact about those packs. Do not "fix" it.

## The version guard

The version dropdown recreates the container and used to validate **nothing**: 30 versions
are offered (down to 1.18.2), the world records 26.1.2 and every installed mod declares
26.1.x, and choosing any of the other 29 answered `{success:true}` and left a permanent
"Starting…" with no explanation.

`src/lib/mc-version-guard.ts` compares the target against `world/level.dat` and the
`InstalledMod` rows and refuses with `needsConfirm` unless the caller passes `confirm: true`.
Two details worth keeping:

- It is checked **before** the DB write. Writing the row and then refusing is how the
  configured and running versions came to disagree for weeks.
- An override is recorded in the operation title (`(mismatch confirmed)`), because the ledger
  is the only durable record that somebody was told the world and the mods disagree and chose
  to go ahead — which is the first thing anyone debugging a world that no longer boots will
  want to know.
