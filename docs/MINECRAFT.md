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
  effect.
- `gamerule <name>` is the **query** form and `gamerule <name> <value>` is the write. Game
  rule names are camelCase (`mobGriefing`, `keepInventory`, `doFireTick`) while
  `server.properties` keys are kebab-case — the mapping matters where the two meet.

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
