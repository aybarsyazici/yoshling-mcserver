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

## The mods page's write controls — gated 2026-10-02

`/minecraft/mods` had **never** had the fix `CLAUDE.md` records for the power buttons, and it
is the same defect verbatim: a MEMBER was shown Create Modpack, Edit, Install to Server,
Delete, Remove, + Add to Pack and Import, and every one answered a bare 403 with nothing on
screen saying why. None of the four components read a session.

`/api/games/status`'s existing `can` projection now carries **`modsInstall`** and
**`modsRemove`** beside the three power booleans and `settings`. No new endpoint, no second
poller: `useGames` already polls this one, and the four components read it (`mod-card.tsx`
takes it as a required prop from `mod-browser.tsx`, because "Load More" appends 20 cards at a
time and a hook per card would be 20, 40, 60 pollers for one boolean).

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
  The working import lives in `modpack-browser-modrinth.tsx`, on the page's other sub-tab.
- **`model ModRequest` and `User.modRequests`** in `prisma/schema.prisma`: zero rows in
  production, zero references outside the generated client. This is the other half of the
  cleanup `permissions.ts` records, which deleted `mods.request` for guarding "a request
  feature that exists in the Prisma schema and nowhere in the code". **The empty table is
  deliberately left on the production DB** — prod runs no automatic migrations, so dropping it
  means a hand-run `DROP TABLE` for no gain.

### Copy that was false

- The banner and the install confirm both advised **deleting the world folder** before
  switching packs — on the page whose own install archives the world first precisely so the
  save survives (`/api/mods/install-modpack` runs `tar -czf … -C MC_DIR world` and refuses to
  continue if it fails). Both now state the two checkable facts instead: every installed jar
  is removed, and the rollback archive's only member is `world`, so **the mods folder is not
  in it**.
- `Download All` toasted `success("Starting download of N mods...")` for a loop that
  synthesises up to 166 anchor clicks — a claim about what the browser did with them, which
  the code cannot observe. It now says what it asked for and names the per-mod Download links
  as the recovery.
- The page subtitle promised "install with one click". Nothing on this page installs a single
  mod: `/api/mods/install` exists and has **no caller anywhere in the tree**.

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

### Both single-mod writers now hold `files:minecraft`

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

Both are sub-second writes, so they take the lane through `fileLaneBusy` and enter no
operation record of their own — the discipline `docs/OPERATIONS.md` sets out for config writers.

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
**`recreateService(game, { start: false })`** (`game-manager.ts:1974` and `:2108`) and starts the
world again only `if (wasRunning)`. **Minecraft is `exited exit=0` on this box** — verified
2026-10-02 — and it is the world that spends most of its time stopped.

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

Tests: `src/lib/__tests__/mc-archive.test.ts` and `backup-create-minecraft.test.ts` use
**real `tar` in a temp directory** and assert the bytes that landed, because the member that
goes missing does so between `tar -xzf` and `rename` and a fake tar cannot show it;
`mc-backups-route.test.ts` drives the route, so the wiring is pinned as well as the helper;
`tests/backup-mods-badge.test.tsx` renders the list.

**Still true, and not fixed here:** `create` snapshots a live world, so a manual backup
taken while people play can be torn. And nothing archives `config/`, `logs/` or the
`server.properties` next to them — `mods` was added because it is the directory an apply
*destroys*, which is a narrower claim than "a Minecraft backup is complete".

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
