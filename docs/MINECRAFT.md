# Minecraft

Depth that was accumulating in `CLAUDE.md` with nowhere to go. The shared architecture —
memory, versions, `applyServiceEnv`, the operation registry — stays there; this is the
Minecraft-specific part.

Status: boots and has been exercised end to end. Compose, `ServerConfig.mcVersion` and the
jars on disk all say **26.1.2**; it starts in `Done (1.661s)!`. **No in-game join has ever
been observed on netcup** — only a person with the game can prove a client connects.

## Where the files are, and what a live measurement costs

**`MC_DIR` is `/minecraft` in the web container and `/data` in the game's** — one volume,
two mounts. Compose gives the `minecraft` service `mc-data:/data` and `web` `mc-data:/minecraft` plus
`MC_SERVER_DIR: "/minecraft"`; the app reads it as `RUNTIME.minecraft.dir`
(`process.env.MC_SERVER_DIR || "/minecraft"`, `src/lib/game-manager.ts`) and re-exports it as
`MC_DIR` from `backup-create.ts`, which is the symbol the rest of this doc uses without
expanding. So `MC_DIR/mods` and `/data/mods` are the same bytes, and `mc-properties.ts`
reasoning about `/data/versions/26.1.2/server-26.1.2.jar` is the *game's* name for a path
this doc writes as `MC_DIR/versions/…`. `MC_SERVER_DIR` is set in compose, not in `.env`.

**Minecraft is normally stopped** — `exited exit=0`, and on 2026-10-06 only Project Zomboid
and web were running. So every live figure in this doc was taken while it was deliberately
up, and re-checking one means starting it again:

- `docker exec yoshling-mc rcon-cli "<command>"` is the route to anything RCON, and the one
  the 2026-10-02 game-rule write was independently cross-read with (recorded in
  `CLAUDE.md`'s Status). **RCON 25575 is not published to the host** — the service publishes only
  `25565:25565` — so `CLAUDE.md`'s note that `scripts/rcon.py` "also works against Minecraft
  on 25575" holds only from inside the compose network, which is the thing
  `scripts/pz-rcon.sh` handles for PZ. There is no Minecraft equivalent of that wrapper.
- **The compose *service* is `minecraft`; `mc` is only part of the container and volume
  names** (`yoshling-mc`, `mc-data`). `docker compose up mc` fails with "no such service",
  profile or no profile — an earlier version of this section called the service `mc` three
  times.
- the service carries `profiles: ["games"]`, so a by-hand `docker compose up minecraft` needs
  `--profile games`. `docker start yoshling-mc` does not.
- **powering it on through the dashboard stops whichever world is running** (`powerOn` evicts
  every other game), and `docker start yoshling-mc` instead leaves both up: MC's
  `mem_limit: 6g` on top of PZ's `14g` does not fit 16 GB, and `src/lib/coresidency.ts`
  *reports* co-residency rather than preventing it. Re-measuring a game rule is a decision
  about somebody's PZ session, not a read.

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
  wrong for what is running. **Nothing hardcodes an id that reaches a console command** —
  that is the invariant, and this sentence used to overstate it as "nothing in the app
  hardcodes either". `MC_GAME_RULES` *does* hardcode 54 ids, 50 of them the camelCase 1.21.x
  spellings (`mobGriefing`, `keepInventory` and `doFireTick` are literal entries) plus the
  four 26.x created out of `server.properties` keys — but only as help text and defaults,
  joined to a discovered id by `canonicalGameRuleId`, never interpolated into a command. An
  agent reading the old sentence literally would delete that table as a violation and lose
  the help for the 34 live ids it covers; see
  [the defaults table](#the-defaults-table-states-a-default-or-states-none).

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

- the full reply is **5,082 bytes** and contains **zero newlines**.
  `RconConsoleSource.sendSystemMessage` appends each feedback message to one buffer with no
  separator, so brigadier's usage lines arrive as one run-together string.
  (This bullet said *"5,099 bytes (5,082 as captured)"*, and `src/lib/rcon.ts`'s comment
  still says 5,099 — **one measurement with two numbers and nothing explaining the 17-byte
  gap.** 5,082 is the checkable one: `wc -c` on the fixture, `Buffer.byteLength` the same,
  `mc-gamerules.test.ts` pins `FIXTURE.length === 5082`, and every other mention in the tree
  agrees. Treat 5,082 as the reply and 5,099 as unsourced.)
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

## The mods page's write controls — gated 2026-10-02

`/minecraft/mods` had **never** had the fix `CLAUDE.md` records for the power buttons, and it
is the same defect verbatim: a MEMBER was shown Create Modpack, Edit, Install to Server,
Delete, Remove, + Add to Pack and Import, and every one answered a bare 403 with nothing on
screen saying why. None of the four components read a session.

`/api/games/status`'s existing `can` projection now carries **`modsInstall`** and
**`modsRemove`** beside the three power booleans and `settings`. No new endpoint, no second
poller: `useGames` already polls this one, and the components read it (`mod-card.tsx` takes
it as a required prop from `mod-browser.tsx`, because "Load More" appends 20 cards at a time
and a hook per card would be 20, 40, 60 pollers for one boolean).

**Two of the controls moved when the page became one surface**, and the gate moved with
them: `Add a mod` and `Change pack` are buttons on `installed-mods.tsx` now, and
`tests/mods-surfaces.test.tsx`'s row for that file lists both. **If you move a control, the
test that asserts a MEMBER cannot see it has to follow it, not be deleted.**

Three things worth not re-deriving:

- **Export is deliberately ungated, and that was measured, not assumed.**
  `/api/modpacks/[id]/export` calls `denyGame` and **no** `hasPermission`, so it answers a
  MEMBER — it is a read that hands back download links for the viewer's own launcher, which is
  the one thing on this page a read-only account is meant to do. Hiding it would have removed
  a working capability under cover of fixing refused ones. `tests/mods-surfaces.test.tsx` pins
  its presence for a MEMBER, so a later "tidy the inconsistency" pass fails.
- **Two flags, not one.** `permissions.ts` keeps `mods.install` and `mods.remove` separate, so
  the surfaces do too, and each is pinned from both directions — granting one must not grant
  the other. A single `can.modsInstall || can.modsRemove` passes a MEMBER/MOD pair of tests.
- **The gate is proven through the rendered DOM**, never by calling `hasPermission`: an
  assertion on the helper cannot fail when a component stops asking it, which is the only
  failure that has actually happened here. `tests/mods-can-route.test.ts` is the other half —
  that the route still *sends* both flags, derived from the real table — because with
  `useGames` stubbed, a route that dropped `modsInstall` would leave the DOM suite green while
  hiding Install to Server from an **admin**.

### Dead weight removed in the same pass

- **An unreachable "Import from Modrinth" dialog in `modpacks.tsx`** — 66 lines plus
  `handleImport`, `searchModrinch` and five state hooks. `setShowImport(true)` was never
  called anywhere, so `open={showImport}` was permanently false and nothing in it could run.
  The working import lives in `modpack-browser-modrinth.tsx` — which was the page's other
  sub-tab at the time and is the "Import a pack from Modrinth" toggle in the saved-sets
  section since the page became one surface.
- **`model ModRequest` and `User.modRequests`** in `prisma/schema.prisma`: zero rows in
  production, zero references outside the generated client. This is the other half of the
  cleanup `permissions.ts` records, which deleted `mods.request` for guarding "a request
  feature that exists in the Prisma schema and nowhere in the code". **The empty table is
  deliberately left on the production DB** — prod runs no automatic migrations, so dropping it
  means a hand-run `DROP TABLE` for no gain.

### Copy that was false

- The banner and the install confirm both advised **deleting the world folder** before
  switching packs — on the page whose own install archives the world first precisely so the
  save survives, and refuses to continue if that fails. Both state the checkable facts
  instead: every installed jar is removed, and the archive is taken first.
  **The replacement was itself wrong within the week** — it said the archive's only member
  is `world`, "so the mods folder is not in it", which stopped being true on 2026-10-02 when
  the apply started tarring `world` **and** `mods`. Corrected, and now pinned against
  `MC_ARCHIVE_MEMBERS` rather than against itself; see
  [Archives](#archives-world-and-mods-only-where-it-matters--2026-10-02).
- `Download All` toasted `success("Starting download of N mods...")` for a loop that
  synthesises up to 166 anchor clicks — a claim about what the browser did with them, which
  the code cannot observe. It now says what it asked for and names the per-mod Download links
  as the recovery.
- The page subtitle promised "install with one click". Nothing on this page installed a
  single mod at the time: `/api/mods/install` existed with **no caller anywhere in the
  tree**. It has one since 2026-10-02, so the subtitle names installing again — but still
  not as "one click", because an install can open a client-only confirm dialog.
- `modpacks.tsx` pointed at a tab that did not exist, twice in a row: first "import from the
  Modrinth/Technic tabs" (the Technic tab was removed in `e718acd`), then "from the Modrinth
  tab" (gone when the page became one surface). Naming a place rather than a control is what
  made the same sentence wrong twice — it says what a set *is* now.

## Installing one mod

`POST /api/mods/install` + the **Install** button on every search result
(`src/components/mod-card.tsx`), wired 2026-10-02.

**The route existed, hardened and tested, with no caller at all** — its own comment said so,
and `mod-install-routes.test.ts` used that as the argument for covering it anyway. So the only
way to put one jar on the server was to make a one-mod pack and apply it, which tars the world
and deletes every installed mod first. Add-to-pack stays, as the *secondary* action: staging a
set of mods to apply together is a different job from installing one.

Three things came with the wiring, each closing a gap that was already in the code.

### The search facet defaults to the server's own version

`/api/mods/search` passed `serverSide: true` and set `versions:` **only when a modpack was
selected**, so the default grid — the one that now carries an Install button on every card —
mixed every Minecraft version Modrinth publishes into a 26.1.2 Fabric server's results, and
`/api/mods/install` then refused them one at a time with "No compatible version found".

- The route reads `ServerConfig` (the same row `/api/settings` GET projects) and defaults both
  facets from it.
- It **answers with `filter: {mcVersion, loader}`**, so the page states what was actually
  faceted rather than inferring it from the request it made. `null` there is the difference
  between "no mods exist for this server" and "no mods matched your search", and the empty
  state names the filter instead of blaming the modpack selector that is not set.
- **Widening is the literal `any`**, sent only by the "show all versions" control. An omission
  must never mean "every version" again, which is the whole bug. The precedence —
  nothing / `any` / a selected pack's own target, where the pack wins — is in
  `src/lib/mod-search-filter.ts` rather than inline, because reaching it through the component
  means driving a base-ui combobox behind a 300 ms debounce.
- **The loader is lowercased.** The facet is a Modrinth *category slug* (`fabric`, `forge`,
  `neoforge`); `ServerConfig.modLoader` holds whatever was saved and `/api/settings` uppercases
  it for compose's `TYPE`, so both spellings genuinely exist in this app. `categories:FABRIC`
  matches nothing and the symptom is an empty browser with no stated cause.

### Both single-mod writers now *defer to* `files:minecraft`

`POST /api/mods/install` and `DELETE /api/mods/[id]` took **no resource at all**, while 23
handlers across 18 other route files already take this lane through `fileLaneBusy`. They could
therefore interleave with `mods.apply`, which holds the lane for the whole of a 166-mod install
— a window that opens by deleting *every* installed jar:

- an **install** that lands inside it is not in the apply's plan, so it is not among the files
  the apply re-downloads, and it survives the wipe: the pack boots with a stranger in it;
- a **remove** racing the apply's own `removeMod` makes the loser throw (`removeMod` reads the
  row first and throws `Mod not found` once it is gone), so the apply pushes
  `"<name>: could not be removed"` into `errors` and names a failure for a jar that *was*
  deleted. A reported fault that did not happen costs the same to chase as a real one.

Both are sub-second writes, so they enter no operation record of their own — the discipline
`docs/OPERATIONS.md` sets out for config writers.

**They do not *hold* the lane, and this section said they did.** `fileLaneBusy` calls
`assertResourceFree`, which only *reads* the live registry and throws if a registered operation
is holding the resource; it registers nothing. So the guard is **one-directional by design**,
and that is the documented intent — a sub-second write defers to a long operation, which is what
the config writers use it for.

What that means for the race above, precisely:

| order | covered? |
|---|---|
| the apply is running, then an install/remove arrives | **yes** — 409 naming the lane, nothing written |
| an install is already in flight when the apply starts | **no** — the apply does not wait for it |

The second case stays open and is cheap to live with: **`/api/mods/installed` now reports a jar
on disk with no row as `untracked` and names it** — see "What is installed is now a reading"
below — and a `refuseIfPreempted` call would shorten the window. Saying "neither can interleave"
was the overstatement — a reviewer disproved it with a direct probe, with an install mid-download
and an apply started on top.

### The client-only refusal is a dialog, with the override

The 409 carried `serverSide` and `decidedBy` and accepted `allowClientOnly`, and **nothing read
any of it**: the refusal and its only exit were both unreachable from the dashboard. It is now
a named dialog ("Install *name* anyway?") stating the consequence, with a `destructive`
"Install it anyway".

- The 409 also carries **`refusal`** — `message` minus the "send allowClientOnly" instruction —
  so the dialog renders the sentence verbatim. `CLIENT_ONLY_CONSEQUENCE` cannot be imported into
  a client component (`mod-admission.ts` pulls in `node:crypto`), and the alternative was a
  second hand-written copy of the one sentence that constant exists to keep single: this route
  once stated the consequence twice and the two copies disagreed about whether a client-only jar
  is harmless.
- **`decidedBy` is deliberately not rendered.** Its values (`version-environment`,
  `project-server-side`, `file-env`) name our own signal ordering, while `reason` already says
  which publisher made the claim — "this build declares `client_only`" versus "Modrinth lists
  this project as server-side unsupported" — which is the part a user can check.
- The lane 409 is **not** mistaken for it. The dialog opens only on `error === "client-only"`;
  offering an override for a busy lane would re-send the same request into the same held lane
  and refuse again, which reads as a broken button.

Covered by `src/lib/__tests__/mods-file-lane.test.ts` (the lane held for real by a parked
operation, not a stubbed `fileLaneBusy`), `src/lib/__tests__/mods-search-route.test.ts` (the
facet array Modrinth would have received, with the real `buildFacets`),
`src/lib/__tests__/mod-search-filter.test.ts`, `tests/mod-card.test.tsx` and
`tests/mod-browser.test.tsx`.

**Not verified against a live server.** Every claim above is about code and is pinned by tests;
nobody has yet pressed Install on the box and watched a jar appear in `mods/`.

## What is installed is now a reading, not a memory — 2026-10-02

`GET /api/mods/installed` reconciles the `InstalledMod` rows against `MC_DIR/mods` and
answers three named groups. Logic in `src/lib/mod-inventory.ts`, rendered by
`src/components/installed-mods.tsx`.

**It was `db.installedMod.findMany()` and nothing else, and there was no `readdir` anywhere
in the mod code.** So the tab headed "Installed" showed what the app last remembered
writing, which is a different claim from what the server will load. Nothing had ever looked,
so *"the two agree"* was not something anybody could know, and this app's named defect class
is exactly the one that produces.

**Something has looked now.** Read against the production container — 3 matched, **0
untracked, 0 missing**, and with the opt-in hash path every `sha512` and byte count equal to
an independent `sha512sum` on the volume (recorded 2026-10-06). That is the measurement that
moves this section from "pinned by tests" to "read against the thing it reads", and it is the
only part of the mods work with a production datum behind it. The three jars totalled 5.8 MB
when that was last measured, on 2026-10-02.

| group | means | what it is called by |
|---|---|---|
| `matched` | a row, and the jar it names is in the directory | file name |
| `untracked` | a jar in the directory that no row names | file name — the only name it has |
| `missing` | a row whose jar is not in the directory | file name, with the mod's name in the list |

**The groups are names, never counts, and that is the whole point.** "2 untracked jars"
sends somebody to the file browser to guess which two; the only reason to take the reading
is to be told. They are also **derived from the one `mods` list** by filter rather than
accumulated beside it, so a reader that trusts `untracked` and a reader that filters `mods`
cannot get different answers. There are four ordinary ways the two sides part:

- someone dropped a jar in with the file browser;
- `removeMod`'s `unlink` hit `ENOENT` (it is swallowed), so the row went and the jar did not
  — or the reverse;
- a restore replaced `mods` from an archive whose manifest carried no `installedMods`, so
  the whole set is on disk with nothing naming it — **and nothing tells the operator.** This
  doc said `/api/server/backups` "already says so and points here"; it does not. The row
  restore sits behind
  `if (result.replaced.includes("mods") && manifest?.installedMods?.length)`, so an archive
  with no rows skips the whole branch silently: no `op.fact`, no warning, `restoredMods`
  simply absent from the 200. The only prose about the recovery is a code comment on that
  block's `catch`, which is the *other* case (the row write threw). It is reachable two ways,
  because `archiveMembersPresent` probes for the directory while the manifest's
  `installedMods` needs `installedMods.length > 0`: an apply on a server that has a `mods/`
  directory and no `InstalledMod` rows, or a hand-made archive. Taking this reading is
  currently the only way to see it;
- an install landed inside a `mods.apply` window — the half `fileLaneBusy` cannot cover, see
  the table above.

Four things worth not re-deriving:

- **Hashing is opt-in (`?hash=1`), `stat` is not.** No digest can change the reconcile
  verdict, and there is nothing to compare one against: `checkIntegrity` verifies a download
  against Modrinth's sha512 *before* the jar is written and keeps no column. So a hash here
  answers "are these two jars the same bytes" — which is a real question, because the two
  writers name files differently (`installMod` uses Modrinth's filename, the Technic path
  writes `<slug>.jar`) and Fabric loading one mod twice is a crash. The page reports a
  duplicate pair by name. `stat` stays unconditional: one syscall, and a 0-byte jar is a torn
  download worth seeing without asking.
- **A missing `mods/` directory is "nothing installed", not an error** — and the catch is
  **ENOENT-only**. Swallowing an EACCES would report every installed mod as missing and every
  jar as absent, which is the read-nothing-report-success shape again. Pinned by a test that
  points the reconcile at a path whose parent is a file (ENOTDIR).
- **Classification is `!isDirectory()`, not `isFile()`.** `readdir` does not follow links, so
  a jar reached through a symlink answers `isSymbolicLink()` and the server loads it anyway.
  A directory called `extracted.jar` is the case worth excluding. Anything that is not a
  `.jar` goes in `ignored` — listed, so nothing is silently dropped, but never called an
  untracked *mod*, because `.DS_Store` is not one.
- **Only names `readdir` returned are ever joined onto the directory.** A row carrying
  `../../something` fails the presence check, stays `missing` and is never opened.

### Provenance: `source` and `versionId`

Two nullable columns on `InstalledMod`, migration
`20261002143000_add_installed_mod_provenance` — **applied in production on 2026-10-02, and
do not paste it again.** Verified 2026-10-06: `PRAGMA table_info("InstalledMod")` carries
both `source` and `versionId`, and all three live rows read `source: manual`,
`versionId: NULL`. `CLAUDE.md` headed the SQL "NOT YET APPLIED" for four days after it was
applied, which is why this — the doc its own rule 2 sends you to for the depth — now states
the status in both directions rather than only the reasoning.

- **`source`** is `"pack"` or `"manual"`, written at both writers —
  `/api/mods/install-modpack` (both its paths, including the Technic direct-create) and
  `/api/mods/install`. Before it, "which of these jars did the pack put there" was not
  answerable at all: after an apply the only record of the difference was in whoever had been
  watching. **`installMod`'s parameter is required, not defaulted** — a default would let a
  third caller silently inherit somebody else's provenance, which is worse than no column.
- **`versionId`** is the Modrinth version id. Both writers had it in hand and discarded it;
  `version` is `version_number`, a publisher's free text that does not identify a build.
  Absent on the Technic path, which has no Modrinth version.
- Both nullable because the three production rows predate them. The migration backfills
  `source = 'manual'`, which is **true of those rows** and not a default standing in for one:
  each was installed on its own, before any pack had ever been applied. A row with no source
  renders "source not recorded" rather than being labelled either way — a restore puts rows
  back from an archive that never carried provenance.
- The backfill is `WHERE "source" IS NULL`. The hand-apply is a human pasting SQL into a
  container and the one that gets pasted twice is the one that read as having failed;
  without the guard a second run after the next pack apply would rewrite every `'pack'` row
  to `'manual'` and undo the column's purpose.

### Tests, and two mutants that survived first

`src/lib/__tests__/mod-inventory.test.ts` (real files in a temp directory — a faked `readdir`
is a second place to write down the answer being tested),
`mods-installed-route.test.ts` (the route over a real directory, with only `auth`, Prisma and
`getModsDir` faked), `tests/installed-mods-reconcile.test.tsx` (the rendering), and
`mod-provenance-migration.test.ts`.

Three of those exist because a mutation went green:

- **A band that renders `"2 file(s)"` instead of the names passed the entire suite.** Each row
  prints its own `fileName` a few pixels below, and `document.body.textContent` cannot tell
  the two apart. Every band now carries `data-band` and the names are asserted *inside* it.
  **If you add a band, give it a `kind`.**
- **A verdict line that consults only `untracked` passed too**, so a server with a missing jar
  was told "every mod on this list has its jar on disk". Pinned from both directions now.
- **The migration SQL was executed by nothing**, so deleting the whole backfill left 1346
  tests green. `mod-provenance-migration.test.ts` runs the file verbatim against an in-memory
  libSQL database — the same client production is read through, no Docker, no network, no
  file — over the `CREATE TABLE` taken out of `20260519104842_init` rather than a hand-written
  approximation.

A fourth mutation found a **latent** defect, not a live one, and the difference is worth
keeping straight: `removing === mod.id` is `true` for an untracked entry, because `removing`
is `null` when nothing is being removed and an untracked `id` is also `null`. Nothing was
ever visible on screen — the control is gated on `mod.id` too, so it never rendered for an
untracked row in the first place. The `mod.id != null &&` is defence in depth against a
future edit that drops the outer gate, which is worth having and is not a bug that shipped.
The first version of this paragraph called it live; a reviewer checked and it was not.

## The mods page is one surface — 2026-10-02

`/minecraft/mods` was three tabs — **Browse mods / Installed / Modpacks** — with the last
holding two sub-tabs of its own. It is one page now: the pack as a header, the installed
list grouped by where each jar came from, saved sets below, and both Modrinth searches as
dialogs. `src/app/minecraft/mods/page.tsx` is 100 lines of layout; everything else moved
into components.

### Why the tab split was wrong, which is not a matter of taste

- **Two of the three tabs were inert until 2026-10-02.** You could not install from Browse
  (`/api/mods/install` had no caller anywhere in the tree) and could not add from Installed.
  So the page *opened* on a debounced Modrinth search whose only outcome was adding a mod to
  a list, and the thing anyone comes here for — what the server will load — was the second
  tab.
- **All the power sat in a nested sub-tab**, and the empty state of the *collection* was
  where the install instructions lived. That is the clearest available proof the hierarchy
  was inverted.
- **"Modpacks" with a Modrinth sub-tab nests a *source* under a *collection*** and stacks
  two different kinds of thing: a set somebody curated here, and somebody else's published
  artefact. The Modrinth sub-tab was a one-shot importer with no reason to persist as a
  place — nothing is ever read from it again.
- **"Modpack" is the wrong word for a `Modpack` row.** A modpack is a published, versioned
  artefact with a loader and configs; a row here is a label over a list of project ids, and
  **566 of 569 production rows carry no version pin**. Calling both "modpack" is why
  `Add to pack` read as "stage for later".

### Provenance is carried by the grouping, not by a badge per row

The list is split into five sections, each with `data-group` on it: `missing`, `untracked`,
`pack`, `manual`, `unrecorded`. Problems first; a section with no rows does not render.

"Which of these did the pack put there and which did we add ourselves" is the question
`InstalledMod.source` finally makes answerable — before it, after an apply the only record
of the difference was in whoever had been watching. **Four identical-looking pills would
bury the answer it has**, so the claim is the heading and the row carries only its own
facts. The counting is in `src/lib/mod-provenance.ts`, so the numbers are pinned by unit
tests rather than by reading a sentence off a page, and
`jars === fromPack + ownInstall + unrecorded + untracked` holds by construction (a
`missing` row is **not** a jar — folding it in would report a mod the server will not load
as installed).

**A group heading and a row a few pixels below it are the same string to
`document.body.textContent`** — the trap that let a `"2 file(s)"` mutant pass the whole
suite for the drift bands. Assert names *inside* `[data-group=…]`. **If you add a group,
give it a `kind`.**

### The pack is a header, and it states two separate facts

`GET /api/mods/installed` carries the reading **plus** the last recorded apply and what the
server is configured to run (`InstalledReading`). One request, so the header and the list
cannot disagree about the same server.

| what | kind of claim |
|---|---|
| "Vanilla Perfected — applied 2 Oct 2026 by Aybars · 78 of 81 mods installed" | a **record** of an apply |
| "81 jars in the mods folder — 78 from a pack, 3 added one at a time" | a **measurement** of the directory |

**They are never joined.** `source` is `"pack"` / `"manual"` with no pack id, so "78 jars
from Vanilla Perfected" is not a sentence the data supports.

`packHeadline` (`src/lib/mod-provenance.ts`) therefore has **four** states, and this section
listed three — the one it left out is the first branch and the load-bearing one:

| when | header | `named` |
|---|---|---|
| a row, and `counts.fromPack === 0` | *"`<pack>` was applied, and none of it is left"* | false |
| a row, and jars from a pack | the pack's name, with the apply's own counts | true |
| no row, `counts.fromPack > 0` | *"A pack was applied, but not from here"* | false |
| no row, no pack jars | *"No pack applied"* | false |

**A recorded apply is not evidence the pack is still on the server**, and the first row is
the guard for that: it returned `named: true` with the Activity row's pack name under an
eyebrow reading "Pack on the server", so a pack whose jars had all since been removed went on
being claimed as the running set. The row says what happened once, `counts.fromPack` says
what is there now, and the header is about now. Reading `counts.fromPack === 0` as redundant
and dropping it restores that bug — which is why it is in the table rather than left to the
code comment. The third row exists for the opposite gap: "No pack" would be false and a pack
name would be invented.

`packVersionNote` reports a pack applied for a Minecraft version the server no longer runs —
real drift, because the version dropdown can be changed afterwards and the jars do not move
with it. It answers `null` when there is nothing to compare, the way every settings surface
here does.

### `apply_modpack`: one durable row, which nothing wrote

`/api/mods/install-modpack` is the most destructive endpoint in the app and it entered **no
`Activity` row of its own**. Its 166 `installMod` calls each wrote `install_mod`, so the log
recorded every leaf and not the act — and "which pack is on this server" was answerable from
nothing durable, since the operation registry keeps a non-`ok` record for six hours and loses
everything on a web-container restart.

**No schema change.** A modpack apply is exactly the kind of event `Activity` exists for: it
inherits the `User` relation (so the actor's name resolves without a second lookup) and the
`details.game` tag `/api/activity` filters on. `src/lib/modpack-applied.ts` owns the action
constant, the blob builder and the parser; `/api/mods/installed` reads the newest row with a
`findFirst` (a scan would read the 332 rows a 166-mod apply adds).

Four properties worth not breaking:

- **Written after the mods were replaced, never on a refusal path.** Every `return` above the
  download loop leaves the mod set untouched, and a log of things that did not happen is a
  defect this project has fixed twice (`powerOff` returning whether it stopped anything,
  `powerOn` returning `[]`).
- **It records `total`, the plan's denominator** — the pack minus the mods positively
  declared client-only — not `modpack.mods.length`. A mutation swapping them survived the
  first version of the test, because the fixture it used was a pack whose every mod belonged
  on a server. A large pack is 30–50% client mods, so the row-count version would record a
  shortfall on every correct apply.
- **A failure to write it is a warning, not a fatal.** The jars are already replaced by then.
  But it is not silent either: with no row the page heads itself "a pack was applied, but not
  from here", and the warning says why.
- **Both `formatAction` renderers were taught the action.** `/activity`'s and
  `game-overview.tsx`'s both end in a `default` that prints bare underscored words, and that
  fallback has already produced three documented defects (`backup_restore`, `backup_failed`,
  `set_gamerule`). `tests/activity-modpack-row.test.tsx` renders the first and reads the
  second's map.

### Change pack: the comparison before the button

The old route to changing the server's mod set was: Modpacks tab → Modrinth sub-tab →
**Import** (writes a `Modpack` row) → back to My Modpacks → **Install to Server** → confirm.
Six steps, and the one fact that decides whether any of it can work arrived at the *end*, as
a 409 in a toast that lives four seconds. On this box that refusal is the **normal** outcome:
COBBLEVERSE publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11. Production has **9
`Modpack` rows for 6 distinct packs**, three of them `(re-imported)` duplicates — that is
what a flow where looking and taking are the same act produces.

`GET /api/modpacks/preview` answers the same question and **writes nothing**: no `Modpack`,
no `ModpackMod`, no `Activity`. It is a read, so it gates on session + world access and no
capability, like `/api/modpacks/search` and `[id]/export`.

**The version choice is shared with the import** (`src/lib/modpack-resolve.ts`,
`chooseModpackVersion`). This is the load-bearing part: a preview that resolved a *different*
build from the import behind it would be worse than no preview, because the comparison
somebody read would not be the comparison that was applied. Pinned as a drift guard — both
routes driven over the same stubbed Modrinth data and asserted to **agree** — because a
mutation replacing the import's call with `versions[0]` survived everything else:
`/api/modpacks/import` had no behavioural test of any kind.

What the review states, and what it declines to:

| stated | because |
|---|---|
| needs MC *x* / loader *y*, against what the server runs, with a verdict | the whole point; `compatibility: null` is a third verdict for "no `ServerConfig` row", never rendered as a disagreement |
| the versions the pack *does* publish | "it needs 1.21.1" invites "then which build should I pick", and often the answer is "there is none for this server" |
| how many of its mods carry no pinned version | 566 of 569 production rows — an apply installs each mod's newest matching build, so a set is not reproducible |
| how many jars are removed, and how many of those were added by hand | "this will remove every mod currently installed" says nothing about whether that is three jars or eighty-one |
| that applying also saves the pack under Saved sets | it does — `install-modpack` takes a `modpackId`, so this is genuinely import-then-apply |
| **not** a client-only count | it comes from reading every mod's Modrinth build, which is what the apply does over up to 166 sequential requests. A number here would be that work done in a dialog, or an invention |

`Choose this pack` is **ungated** and `Import` is not, which is a decision: choosing fetches
the preview, a read that deliberately answers a MEMBER, while importing writes a row. It also
made the Apply gate testable — with both gated, a mutation removing `can.modsInstall` from
**Apply this pack** survived, because the MEMBER case never reached the step the button is on.
A vacuous pass on a gate is worse than no test. The control that keeps a read-only account out
of this dialog at all is `Change pack` on the page.

### There is deliberately no "Remove pack"

Nothing in this app removes a set of mods as **one** operation. Doing it as N client-side
`DELETE /api/mods/[id]` calls would be a bulk destructive action with no rollback archive, no
operation record, and a partial-failure state the page could not report — this project's
named defect class. Per-row **Remove** is the supported way out of one mod; **Change pack** is
the supported way to replace the set, and it archives `world` and `mods` first. Pinned by a
test, so it does not get added by reflex.

### The pack search is faceted now, like the mod search

`/api/modpacks/search` sent `versions:` and `categories:` only when the caller passed them,
and the one caller never did — so the pack browser listed every modpack Modrinth publishes
against a 26.1.2 Fabric server. The identical defect `/api/mods/search` was fixed for one
route along, and it matters more here because a modpack apply is the most destructive endpoint
in the app. Widening is the literal `any`, the response says what was faceted, and the loader
facet is lowercased (`ServerConfig.modLoader` holds `FABRIC` or `fabric` depending on who
wrote it; `categories:FABRIC` matches nothing and the symptom is an empty browser).

### The apply's client half is one module

`src/lib/modpack-apply.ts` holds what the apply's response *means*, because two surfaces apply
packs now (**Change pack** and **Install to Server**) and the power control already reached
three copies here with two of them missing a fix. Three things it gets right, each of which
was wrong once:

- **`res.ok` is not the verdict.** The route answers non-2xx when it could not install every
  mod. Trusting `res.ok` reported *"Installed 0/166 mods"* in a **green** toast.
- **A body with no counts is not an apply report** — a 403 opened the dialog as "Installed
  undefined of undefined mods".
- **A request that gave up is not a failed apply, and `still-running` is its own case with no
  counts in it.** `modpacks.tsx` substituted `{installed: 0, total: 0}` there and the report
  rendered a **destructive-red "Installed 0 of 0 mods"** — a failure headline for an apply
  that was succeeding at that moment, on exactly the runs long enough (166 sequential fetches,
  past a ~100 s origin timeout) to reach it.

The report dialog itself is `src/components/apply-report-dialog.tsx`, shared by both. Its
title is destructive **only** when `installed === 0`; a mutation hard-coding the class survived
until a test pinned the colour, and the colour is a claim — this repo has already shipped a
`noop` step that painted every clean backup amber.

### Copy that had gone stale, and the test that was holding it there

The saved-sets banner and the install confirm both said the pre-apply archive *"holds the
world only, not the mods folder"*. That was true on 2026-09-30 and **stopped being true the
same week**: `install-modpack` tars `archiveMembersPresent(MC_DIR)` — `world` *and* `mods` —
and `restoreMinecraftArchive` renames both back. So the page was **understating its own safety
net**, telling an operator their jars are not recoverable when they are, immediately before
the button that deletes every one of them.

`tests/mods-surfaces.test.tsx` was asserting the wrong sentence, which is why it survived a
copy review. It now reads the two members out of `MC_ARCHIVE_MEMBERS` and asserts the new
wording, so a future change to what an archive holds reddens the test instead of quietly
making the copy wrong again. **Pin copy against the module that decides it, not against
itself.**

### The drift guard grew a second predicate

`tests/mods-surfaces.test.tsx` finds every component that writes a mod or a modpack and
requires it to be in its table. Keyed on a literal `fetch("/api/mods…", {method: "POST"})`,
it missed `change-pack-dialog.tsx` entirely: that file writes through
`src/lib/modpack-apply.ts` and contains no write `fetch` at all. The guard matches the shared
applier's import too now — **if you move a write behind a helper, teach the guard the
helper.** `COVERED_ELSEWHERE` lets a stepped flow be pinned in its own file and asserts that
file exists, so "covered elsewhere" is checkable rather than a way to silence the guard.

### What was left alone on purpose

- **The nine `Modpack` rows.** Three `(re-imported)` duplicates and one named `a` with four
  mods and no target version. Not deleted and not hidden: a set with no pinned versions says
  so, and a set with no target version says so, because both change what Apply would do.
- **Pinning `ModpackMod.versionId`.** The preview *counts* the unpinned ones; writing the pins
  is its own increment.
- **`checkForUpdates()` still has no route**, so there is no "Check updates" control. A button
  that does nothing is worse than its absence.
- **No new animation.** This is a dense reading surface and the shared `Reveal` primitive does
  not consult `usePrefersReducedMotion`, so adding it would be adding motion a reduced-motion
  user still gets.
- **No live verification of the page.** Nobody has opened `/minecraft/mods` on the box, and
  everything above about the rendering is code pinned by tests. **The reading underneath it
  has been read against production**, though — `GET /api/mods/installed` answered 3 matched /
  0 untracked / 0 missing with matching hashes (recorded 2026-10-06, see
  [What is installed](#what-is-installed-is-now-a-reading-not-a-memory--2026-10-02)) — and
  the header, the five groups and every count on this page come from that one request. So the
  reconcile is proven against production and only the rendering is not; this bullet said
  neither was.

## Modpacks — and why we are NOT delegating to the image

> **This section used to say the opposite.** It argued that
> `mc-image-helper install-modrinth-modpack`, which ships inside the
> `itzg/minecraft-server` image we already run, was the better way and that our own installer
> was "the part that does not fit the architecture". A design review then measured three things
> that reverse the conclusion. The original recommendation is kept below, struck through,
> because a plausible wrong answer that survived a writeup is worth recording as wrong — and
> because the image genuinely does have the capabilities it was credited with. It is the
> *trade* that was wrong, not the inventory.

### The decisive reason: it would install nothing, and say so only by accident

Driving `MODRINTH_MODPACK` means patching `.env` and recreating the service, which is what
`applyServiceEnv` does for the version dropdown. But `applyServiceEnv` calls
**`recreateService(game, { start: false })`** and starts the world again only
`if (wasRunning)` — `setMemory`, a few functions below it in `src/lib/game-manager.ts`, does
exactly the same, which is why neither can boot a stopped world. (This cited
`game-manager.ts:1974` *and* `:2108` as both being inside `applyServiceEnv`; `:2108` is
`setMemory`. The argument holds for both functions, so name the symbols — a line number in
the decisive citation of a section is wrong after the next edit to that file.)
**Minecraft is `exited exit=0` on this box** — verified 2026-10-02, still stopped
2026-10-06 — and it is the world that spends most of its time stopped.

So "apply a pack" would recreate a stopped container, install **nothing**, and the only honest
ledger entry would be *"requested, not applied"*. The actual download would happen on some
later Power on, where a failure is a line in `docker logs` behind `restart: "no"` with no
operation record and nobody watching. That is this project's named defect class —
reports-success-after-doing-nothing — reached **structurally** rather than by a bug, which means
no amount of care in the calling code fixes it.

### Two claims in the original writeup were simply wrong

| Claimed here | Measured |
|---|---|
| the image verifies hashes | its **Modrinth** path uses `skipExisting(true)` and applies `FileHashVerifier` only under `curseforge/`. Delegating would **lose** `downloadVerifiedJar`'s verify-before-write, which this repo added deliberately |
| its client-only filtering is better than ours | it reads sidedness from the `.mrpack` index. **COBBLEVERSE's index declares all 168 files `server: required` — zero client-only — while the per-version API reports 43 `client_only`** (50 counting `client_only_server_optional`). Trusting the index writes ~43 client-only jars into `mods/`, and Fabric Loader aborts on a jar with no server entrypoint |

The second one is the sharper lesson: **the `.mrpack` index's `env` is written by the pack
author and is frequently wrong, while `version.environment` is derived by Modrinth.** Take
sidedness from the API, which is what `mod-admission.ts` already does. The image and
Pelican's egg both take it from the index.

### And the pinning problem needs no zip reader

The thing our importer actually gets wrong is that it discards data it already has:
`dependencies[].version_id` is present on **168 of COBBLEVERSE's 186 dependencies** and the
import throws every one away, which is why **566 of 569 production `ModpackMod` rows are
unpinned** and "Apply" installs the newest build of each mod rather than the pack.

Two batched calls replace the whole problem — measured 2026-10-02:

| call | result |
|---|---|
| `GET /v2/versions?ids=[…]` | 168 pinned versions in **424 ms**, every primary file carrying sha512 |
| `GET /v2/projects?ids=[…]` | 168 projects in ~0.79 s, 1.5 MB |

That is two requests in place of up to 166 sequential ones, and it removes any need for a
`.mrpack` zip reader, a central-directory parser, or a schema migration to hold file lists.

### What we are deliberately not doing, and why

- **Not installing `overrides/`.** Real cost measured: 7 files for `adrenaline`, **2,436** for
  `cobblemon-fabric`, up to ~4,645 and 424 MB for the largest. Writing those into a live server
  directory collides with every settings surface in this app, for packs that cannot run on
  26.1.2 anyway. The cheap half of the value is free: the preview *says* "18 dependencies carry
  no pinned version, so this pack may ship files we do not install", which turns a silent
  incompleteness into a stated one.
- **Not writing a real `.mrpack` exporter.** Nobody here is round-tripping a pack into Prism.
- **Not adding a `Profile` table.** Prisma 7 cannot express `CREATE UNIQUE INDEX … WHERE active
  = 1`, so dev and prod would agree only while a human kept them agreeing — in a repo whose own
  history includes a migration headed "Pending" two hundred lines above a Status section saying
  it was applied.

### ~~The original recommendation, kept as a record of being wrong~~

~~The image ships `/usr/bin/mc-image-helper`, wired to `MODRINTH_MODPACK` by
`/image/scripts/start-deployModrinth`, and it handles real `.mrpack` files including the
`overrides/` tree, installs the mod loader from the pack, and filters client-only mods via a
curated 104-slug exclude list at `/image/modrinth-exclude-include.json`. Driving it would be an
`.env` patch plus `create --force-recreate`, exactly what `applyServiceEnv` already does.~~

Those capabilities are real and the 104-slug list is a genuinely useful artifact — it is the
`env.server` half and the hash half that do not hold up, and the `start: false` behaviour that
makes the whole shape unprovable here.

### Sidedness: `ENVIRONMENT_TO_SERVER` is the table, and it is in the code on purpose

`src/lib/mod-admission.ts` holds the mapping from Modrinth's per-version `environment` string
to an install/skip decision, **ten rows**, each with the count and sampling that produced it
(527 projects / 2,751 versions). It is not restated here: a second copy of an enum Modrinth can
extend is how one of them goes stale, and that has already happened once in `CLAUDE.md`.

Two things worth knowing without opening it:

- **`singleplayer_only` is the value that changes an answer from install to skip**, and it was
  missing from the first draft's table — so every `singleplayer_only` mod was being installed
  onto a server. A narrow 160-version sample did not contain one.
- An **unmapped** value now fails loudly rather than falling through to install. The enum is
  Modrinth's to extend, so silence was the wrong default.

### Pack facts that are not bugs

`COBBLEVERSE` publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11. On a 26.1.2 server
neither can install no matter how often it is re-imported, and the apply refuses with an
honest version mismatch. That is a fact about those packs. Do not "fix" it.

## Archives: `world`, and `mods` only where it matters — 2026-10-02

Two shapes of Minecraft archive now exist, and the rule is in `src/lib/mc-archive.ts`:

| archive | members | written by |
|---|---|---|
| routine backup | `world` | `createMinecraft` in `backup-create.ts`, by hand or on the schedule |
| pre-apply rollback point | `world` **and** `mods` | `/api/mods/install-modpack` |

**What was wrong.** `install-modpack` tarred `-C MC_DIR world` and then `removeMod`-ed
**every** installed jar, and the ledger labelled that archive a *"Rollback point"*. So it
preserved the one directory the apply never touches and nothing of what it destroys — the
mods directory was archived nowhere in this app — and `removeMod` deletes the
`InstalledMod` row along with the jar, so after an apply there was no record left of what
had been installed either. It had not hurt yet only because production has three mods
totalling 5.8 MB.

**The dangerous half is the restore, not the tar.** `/api/server/backups` extracts *every*
member into a `.restore-*` staging dir, asserts the shape, renames the member(s) into place
and `rm -rf`s the staging dir in a `finally`. Before this change it renamed **only**
`world` — so a two-member archive would have restored, answered `{success: true}`, and
**silently discarded the mods** on the way out. Adding `mods` to the tar without that is
strictly worse than the original bug, which is why both halves are one module and one
commit. If you ever add a third member, add it to `MC_ARCHIVE_MEMBERS` and nowhere else.

Four properties worth not breaking:

- **A legacy one-member archive restores world-only and leaves the live `mods/`
  untouched.** Every archive on the box is `-C MC_DIR world`, and deleting the mod set
  because the archive has nothing to put there would make the first restore after this
  change wipe it.
- **Routine backups stay world-only.** They run on a schedule against a 217 MB world;
  folding in an unchanged mods directory would grow every archive and the retention
  pressure with it, for a copy of something nothing is about to delete. `createMinecraft`
  writes the member list **once** and reads it twice — the `tar` arguments and the
  manifest's `members` — because the listing answers off the manifest and never opens the
  tar, so the two drifting apart is what tells somebody a restore brings their jars back
  when it would not.
- **The pre-apply archive goes through `sealArchive`** (exported from `backup-create.ts`
  for this; it is the one caller outside that module). Written raw it had no
  checksum, so the listing read `verifiable: false` and a restore could not refuse a
  corrupt one; it never reached the durable journal; and it sat outside the retention
  policy while `listArchives` counted it anyway — consuming a `keep` slot that protects a
  real restore point and standing as a prune candidate itself.
- **The members are probed, not assumed.** `tar -czf … world mods` exits non-zero on a
  member that is not there and `install-modpack` treats a failed tar as fatal, so a
  hardcoded `mods` would refuse every apply on a server that has never installed one. A
  server with jars but no world yet gets a **mods-only** archive, and the restore accepts
  it — there is still something to lose there, and an archive the restore refuses would be
  a rollback point in name only.

`GET /api/server/backups` reports `includesMods` off the manifest's `members` and the list
renders a `· mods incl.` badge for it. Both shapes sit in the same list under names that
both end in `.tar.gz`, so nothing else said which one undoes a modpack apply.
`manifestIncludesMods` answers **false** for an archive that recorded no members — not
"unknown" — and that is a measurement, not a guess: every archive written before this was
one member.

**The page's copy did not follow this change, and a test was holding it back.** The
saved-sets banner and the install confirm both still said the archive *"holds the world
only, not the mods folder"*, and `tests/mods-surfaces.test.tsx` asserted that sentence — so
for days the page understated its own safety net, telling an operator their jars are not
recoverable when they are, immediately before the button that deletes every one of them.
Fixed 2026-10-02, with the assertion rewritten to read `MC_ARCHIVE_MEMBERS` so the next
change to what an archive holds reddens the test rather than making the copy wrong again.
**When a module decides what a sentence claims, pin the sentence against the module.**

Tests: `src/lib/__tests__/mc-archive.test.ts` and `backup-create-minecraft.test.ts` use
**real `tar` in a temp directory** and assert the bytes that landed, because the member that
goes missing does so between `tar -xzf` and `rename` and a fake tar cannot show it;
`mc-backups-route.test.ts` drives the route, so the wiring is pinned as well as the helper;
`tests/backup-mods-badge.test.tsx` renders the list.

**Still true, and not fixed here:** `create` snapshots a live world, so a manual backup
taken while people play can be torn. And nothing archives `config/`, `logs/` or the
`server.properties` next to them — `mods` was added because it is the directory an apply
*destroys*, which is a narrower claim than "a Minecraft backup is complete".

**The apply still runs with the world possibly up, and it is the largest open hazard in the
Minecraft code.** `/api/mods/install-modpack` deletes every jar and writes a new set under a
live JVM, then tells the user to restart. Measured against the route: it is **not** wrapped
in `withGameStopped`; its `runOperation({kind: "mods.apply"})` takes the default resources
for that kind, which are `["files:minecraft"]` and **not** `power`, so a Power on can start
the world in the middle of it; and it calls `refuseIfPreempted` **zero** times, against ten
call sites in `backup-create.ts` (two of it, eight of `refuseIfPreemptedEarly`; counted
2026-10-06). On Linux a running JVM keeps the descriptors for jars that have been unlinked,
so the server goes on serving the set it loaded at boot while the directory it will load next
already says something else — a divergence nothing on screen names, and nothing forces the
restart that ends it. What it should be is
`withGameStopped(…, {restartOnFailure: false})` — a half-replaced mod set booted is worse
than a stopped world — claiming `power` alongside the file lane. Also in `CLAUDE.md`'s
"Genuinely open" list; this is the depth for it.

## Bans

`/api/server/bans` (GET list, POST add one, DELETE remove one) + `McBansCard` on the settings
page, added 2026-10-01. The third member of the whitelist/ops/bans set, and the only one whose
write is often not a write at all. Logic is in `src/lib/mc-bans.ts`.

**One target per request, not a whole-list PUT** like ops and whitelist. While the server is up
a ban is an RCON `ban <name>`, and there is no "set the ban list to exactly this" command — a
whole-list endpoint would have to diff and then issue N commands, each able to fail separately.

**The GET is gated on `settings.read`, which the ops and whitelist GETs are not** — those gate
on world access alone. A ban list carries IP addresses, so handing a read-only MEMBER every
address banned from the box is a privileged read rather than a browse (the same argument the
7DTD config makes about `ServerPassword`). So a MEMBER gets **403** here by design, not by
oversight; the reasoning was only in a comment in `src/app/api/server/bans/route.ts`. A second
reader of these files has to answer the same question.

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
- ~~**None of this has been run against the live server.**~~ **Wrong since 2026-10-02** —
  the run is 110 lines above, under "Verified on the live container", and the committed
  three-ban `banlist` fixture is a live capture too (151 bytes, zero newlines; it could not
  exist otherwise). The bullet was left behind when that section was added above it, and it
  reads as "the whole feature is unproven", which invites either banning somebody on the
  world people play on to settle a settled question or distrusting the measurements this
  section is built on — the real UUID and the 2-or-more-bans refusal. **The honest residual
  is narrower:** the IPv6 bullet above, and the `file` path, since the self-test ran against
  a *running* container and the stopped-server branch has only `tests/mc-bans-route.test.ts`
  behind it. The read-back still outranks the reply strings for the reasons in
  [The read-back decides](#the-read-back-decides-and-three-traps-live-in-it), not for want of
  a live run.

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

## Wanted: apply a pack that needs a different Minecraft version — NOT BUILT

**Owner's requirement, 2026-10-02, in their words:** *"I want to be able to run any minecraft
version and then just install mods relevant to that version. But also have the
capability/possibility/feature that if a modpack requires a certain minecraft version then the
ability to switch to it and install the modpack."*

The first half is done — the Modrinth search is bound to the server's own version and loader, so
Browse only offers mods that fit what is running. The second half is **not built**, and this
section is here so whoever picks it up does not redesign it from scratch: most of the parts
already exist and one decision has already been made.

### The decision, which is the owner's and is already made

**Warn, and let them confirm and proceed.** Not "use a separate world", which was the
alternative offered and declined. So the flow must state the consequence plainly, require an
explicit confirmation, and then do exactly what was asked — no silent substitution of a safer
behaviour, and no refusal dressed up as a warning.

### The hazard the warning has to carry

**Minecraft worlds do not downgrade.** The live server runs **26.1.2**; `COBBLEVERSE` publishes
only **1.21.1** and `Hoplite` only up to **1.21.11**. Switching down to play one of them will
very likely leave the existing world unopenable — that is Minecraft's save format, not anything
this app does, and no amount of care in the apply changes it.

Note what that means for the increment that pins pack versions: pinning makes a 166-mod pack
install *the pack*, but the only two large packs saved here still cannot run on 26.1.2. Pinning
is worth doing on its own merits; this flow is what makes those two packs reachable at all.

### What already exists — do not rebuild these

- **`isDowngrade(target, current)`** in `mc-version-guard.ts`, and the warning text is already
  written and already correct: *"The world on disk was last opened by Minecraft X. Y is a
  different version — and an older one, which cannot open a newer world at all."* For an upgrade
  it says the save format changes and older versions can never open it again. Reuse this
  sentence; do not write a second one.
- **The warn-and-confirm handshake**, in `/api/settings`: mismatches with `confirm !== true`
  answer `400 { needsConfirm: true, mismatches }`, and a caller that passes `confirm: true`
  proceeds *and gets the override recorded in the operation title* (`(mismatch confirmed)`) —
  deliberately, because the ledger is the only durable record that somebody was told the world
  and the mods disagree and chose to go ahead. That is exactly the shape the owner asked for.
- **`/api/mods/install-modpack` already refuses and already hands up the structured answer**:
  `needsVersionChange: { mcVersion, modLoader }`, with a message naming both versions. Its long
  comment explains why the apply must *not* change the version itself — it once regenerated
  `docker-compose.yml` from a two-service template, deleting the `sevendtd` and `zomboid`
  services and the volumes the web container mounts. **Switching belongs to `applyServiceEnv`,
  which patches the scoped block and recreates the container.** Keep it that way.
- **`applyServiceEnv`** does the patch + graceful stop + `create --force-recreate` + restart-only-
  if-it-was-running, under the control lock.

### So the work is a flow, not a mechanism

`needsVersionChange` is **read by nothing** today (only by a test) — the same unread-structured-
field shape the client-only 409 had before it got a dialog. The increment is:

1. The Change pack sheet reads `needsVersionChange` instead of showing a dead end, and renders
   the comparison it already has (*"this pack needs 1.21.1, you run 26.1.2"*) as an offer.
2. The confirmation names the world consequence from `versionChangeMismatches`, and **says a
   backup is taken first** — the pre-apply archive now holds `world` *and* `mods`, so the
   rollback for this is already real. Take it before the version change, not after.
3. On confirm: `PUT /api/settings { mcVersion, modLoader, confirm: true }`, then the apply.
   Two operations, so the ledger shows both; do not fold them into one that cannot say which
   half it is in — that lesson is `restartGame`'s.
4. The world consequence is the part to get right in copy. "This may make your current world
   unopenable" is the honest sentence, and it belongs next to the confirm button, not in a
   paragraph above it.

**Pair it with the pinning increment** (`dependencies[].version_id`, discarded at import today,
566 of 569 rows unpinned). Switching the server to 1.21.1 and then installing the newest build
of each of a pack's 166 mods is not installing the pack, and the version switch is the thing
that makes the mismatch *not* catch it.
