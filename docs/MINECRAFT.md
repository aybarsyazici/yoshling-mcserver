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

## Bans

`/api/server/bans` (GET list, POST add one, DELETE remove one) + `McBansCard` on the settings
page, added 2026-10-01. The third member of the whitelist/ops/bans set, and the only one whose
write is often not a write at all. Logic is in `src/lib/mc-bans.ts`.

**One target per request, not a whole-list PUT** like ops and whitelist. While the server is up
a ban is an RCON `ban <name>`, and there is no "set the ban list to exactly this" command — a
whole-list endpoint would have to diff and then issue N commands, each able to fail separately.

### The path is chosen on a live RCON socket, not on `docker inspect`

The game holds both ban lists **in memory** and rewrites the json from that memory whenever a
ban changes, so a file edit made while it is up is an edit with a delete scheduled behind it.
And `containerState` in `game-manager` answers `"missing"` for *any* inspect failure, so
`containerRunning === false` is not evidence the game is stopped.

| container | RCON answering | path |
|---|---|---|
| running | yes | `rcon` |
| running | no | **`refuse` (503)** — never a fall-back to the file |
| stopped | yes | `rcon` — a socket that answers outranks docker's report |
| stopped | no | `file` |

The refuse row is the third reachability state `a7d76b8` named for the power controls. The one
tempting thing to do there — write the file — is the write that disappears.

### The read-back decides, and three traps live in it

The command's own reply only picks the *wording*; `banlist` (or the file off disk) decides the
outcome, and anything unconfirmed answers **non-2xx** so `res.ok` alone cannot report a ban
that did not happen. The reply strings are vanilla translations (`commands.banlist.entry` →
`"%s was banned by %s: %s"`), so a version or locale change can make all of them stop matching
at once.

- **`banlist` must go over `rconCommandLong`** (via `sendCommandLong`). It enumerates, one RCON
  packet carries 4096 bytes, and `rcon-client` resolves on the first and discards the rest —
  measured against PZ's `showoptions`, see [`../CLAUDE.md`](../CLAUDE.md) and
  `src/lib/rcon-frame.ts`. A truncated banlist makes a real ban read as absent, so the route
  reports a success as a failure; a pardon read back against one looks confirmed while the
  target is still banned.
- **Never match on the raw reply buffer.** `reason` and `source` are free text the server echoes
  back into that same reply, so a ban stored with the reason `"Bob was banned by me: spam"`
  makes a substring search answer "Bob is banned" for a Bob who is not. `banlistLists` matches
  the **parsed** entry name, and `banlistUsable` refuses a reply whose entry boundaries could
  not be recovered (`recognised && separated`) rather than guessing.
- **Absence only proves a pardon if the reply was readable.** Written inline as
  `action === "ban" ? present : !present`, an unreadable reply makes `present` false and so
  *confirms* the pardon. `banlistProves` answers `null` for both directions instead;
  `banDrift` answers `null` rather than reporting every ban on disk as unenforced.

### A ban entry needs a real UUID — and whose entries a write answers for

Same measured failure as ops and whitelist (see "Identity" above) with the sign flipped and
worse: the page shows the ban and the player keeps connecting. `resolveEntryUuids` fills the id
in and `serializePlayerBans` **refuses** a blank or undashed one rather than trusting a caller
to have run it.

Its second argument, `require`, is the part that is easy to get wrong in the other direction.
Validating *every* entry made one pre-existing blank-uuid entry — the state an older install
leaves behind, since this repo shipped `uuid: ""` for months — refuse **every** file-path edit,
including the pardon that would have removed it, and the 500 named whichever entry the loop
reached first rather than the player the request was about. So `require` is the entry being
added (`[]` for a pardon), and anything already on disk is carried through unchanged. A bad
entry is not made worse by being preserved; `banDrift` is what surfaces it while the server runs.

### Deliberately not supported, and deliberately not asserted

- **Timed bans.** `banned-players.json` has `expires`, but vanilla's `/ban` has no duration
  argument — so a duration would only be settable while the server is *stopped* and the same
  control would silently become permanent-only once it was running. Every entry is
  `expires: "forever"`.
- **IPv6** is refused with a stated reason. Whether a running 26.1.2 server matches a v6 peer
  against `banned-ips.json` has not been verified on this box, and an entry nobody can show is
  enforced is a ban that silently does nothing.
- **None of this has been run against the live server.** That is exactly why the read-back
  outranks the reply strings, and why the card distinguishes "could not read" from "nothing
  banned" everywhere.

### Why the card is not just a list

It reports **file-versus-running drift**, the same idea as the memory card's
configured-vs-live comparison. Two things it must not do, both of which it did:

- Disable its controls because a ban file is malformed **while the path is `rcon`**. The route
  never opens a file on that path, so that removed the one working way to ban somebody and
  claimed bans could not be changed while they could. Gating is per kind and per path.
- Attribute every `notEnforced` entry to one cause. "The files were changed while it was up" is
  the common one, not the only one — an entry whose uuid the game cannot use lands there too.

### Not a `runOperation`

Three RCON round trips at most, sequenced. There is nothing to narrate — no eviction, no
stages, no artefact — and a ledger record per ban would be noise in the strip. The budgets
(`BAN_RCON_TIMEOUT_MS`, `BANLIST_RCON_TIMEOUT_MS`) only govern because `rcon.ts` was fixed to
pass a caller's timeout down to `Rcon.connect`; see the next section.

## RCON timeouts actually apply now

`rcon-client` keeps its own per-packet deadline in `config.timeout` (**default 2000 ms**), read
from an object fixed when the socket is opened, and it rejects the `send` itself when that
fires. `rcon.ts` also wraps each send in `withTimeout(…, timeoutMs)` — so the shorter of the
two wins, and because nothing passed the caller's budget to `Rcon.connect`, **every declared
timeout was silently capped at 2 s**. Two callers were affected:
`FLUSH_RCON_TIMEOUT_MS = 120_000` for `save-all flush` on a 217 MB world (whose own comment
explains that a short budget "would put the everyday path down the failure branch and stamp a
warn fact on every backup" — which is what was happening), and the bans route's 5 s.

The fix: the cache stores the budget each socket was opened with, passes it through at connect,
and **reuses a socket only when its fuse is at least as long as the new caller's budget**. A
shorter fuse cannot be stretched, so a 3 s status-poll socket must not serve a 120 s flush —
and since the status probe polls every few seconds, that socket is almost always the one a
backup would have inherited. Pinned in `src/lib/__tests__/rcon-timeout.test.ts`.

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
