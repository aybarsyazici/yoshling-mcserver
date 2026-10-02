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

`/api/mods/install-modpack` resolves a pack to a list of mods and downloads the server-side
ones into the mods directory itself. Measured against the running `itzg/minecraft-server`
container 2026-10-01, that image ships a first-class Modrinth modpack installer we are not
calling:

| | ours | `mc-image-helper install-modrinth-modpack` |
|---|---|---|
| Pack format | a resolved mod list | the real `.mrpack`, including its `overrides/` tree (configs, datapacks, scripts the pack needs) |
| Client-only mods | filtered, since 2026-10-01: the version's own `environment` (a measured ten-value enum in `src/lib/mod-admission.ts`), falling back to the project's `server_side`, skipping only a **positive `unsupported`**. Skips are named in the report and in the ledger, never silent; a value the enum has no row for is reported rather than guessed at. No curated slug list | `env.server` **plus** a curated list of **104** known-client-only slugs at `/image/modrinth-exclude-include.json`, maintained upstream. More than `env.server` gives you: plenty of mods declare `server: optional` and are still useless or harmful on a server |
| Hash verification | yes, since 2026-10-01: Modrinth's sha512 is compared **before the jar is written** (`downloadVerifiedJar` → `checkIntegrity`), with sha1 and then size as fallbacks, and "installed without a checksum to verify against" reported when the registry published no checksum and no size. A direct (Technic/Solder) download has no registry hash and is checked against the response's `Content-Length` | yes |
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
has no image-level equivalent, so side filtering and hash verification have to live in this
app for that path — and they do, in `src/lib/mod-admission.ts` and `src/lib/mod-manager.ts`,
shared by both installers so the single-mod and the 166-mod path cannot disagree about the
same jar.

**What the image still has that we do not**, now that the two rows above have been closed:
the `.mrpack`'s `overrides/` tree, the loader install, the curated 104-slug exclude list, and
the four escape-hatch flags. The first is the substantial one — a pack's configs and
datapacks are not in a resolved mod list at all. **Switching remains the owner's call and is
deliberately not implemented**; the point of the table is that the decision is informed, not
that it is overdue.

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

### Verified on the live container, 2026-10-02

Ban → the game answers `There are 1 ban(s):zz_selftest_01 was banned by Rcon: …` → the file the
game parses carries a **real UUID** (`95911851-7751-3f09-a457-de4586d1fe86`, not the `uuid: ""`
that locked everyone out in September) → pardon → `{verified:true, contradicted:false,
noop:false}` with *"the running server applied it, and reading its ban list back confirms it"* →
game and file both empty again. The name is lowercased by the game and matching is
case-insensitive, so the read-back still recognised `ZZ_SelfTest_01`.

Two refusals are worth knowing because both look like bugs and are not: a 20-character name is
rejected (Minecraft's limit is 16), and `DELETE` takes `?kind=&target=` **query parameters**, not
a body — a body gives `Expected kind to be "player" or "ip"`.

### `banlist` with 2+ bans cannot be parsed — and the obvious fix is wrong

**The hard limit of the live cross-check, and it belongs to the server.** Measured by banning
three throwaway names and hexdumping the reply: 151 bytes, **zero newlines**.

```
There are 3 ban(s):zz_fix_a was banned by Rcon: fixture capturezz_fix_c was banned by Rcon: …
```

`RconConsoleSource.sendSystemMessage` appends every feedback message to one buffer with no
separator — the same thing that makes `help gamerule` arrive as one 5 KB line. So one entry's
reason runs straight into the next entry's name: `fixture capture` + `zz_fix_c` is the literal
`capturezz_fix_c`, and **nothing in the reply says where the boundary was.** A single ban parses,
which is why every manual test passed.

**Walking the reply globally for each `(\S+) was banned by ` does not fix it — it makes it
worse.** That was tried against this exact reply: it produces three entries, which *satisfies*
the `entries.length === count` cross-check, named `zz_fix_a`, `capturezz_fix_c` and
`capturezz_fix_b`. An honest refusal becomes a confidently wrong answer about who is banned.
The real reply is committed at `src/lib/__tests__/fixtures/mc-banlist-players.txt` and two tests
pin the refusal; the global walk turns them red.

So `parseBanlist` stays line-anchored and refuses any reply whose entry count disagrees with its
own header. The cost is that `liveReadState` reads `unreadable` and `banDrift` returns `null`
whenever more than one ban exists — the **files stay authoritative and are read directly**, so
the list on screen is right; what is lost is the second opinion. For a read-back whose only job
is to decide whether a ban is genuinely in effect, declining to answer is the correct failure.

Line-anchoring also buys a real security property on builds that *do* separate lines: the line
boundary says where an entry ends, so a reason containing the literal `" was banned by "` cannot
forge an entry for someone who is not banned.

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
