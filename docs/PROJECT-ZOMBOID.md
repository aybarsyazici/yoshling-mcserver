# Project Zomboid — the full picture

Everything Project Zomboid specific for the Yoshling dashboard: how the server is
wired, every gotcha we've paid for, what's done and what isn't.

**Read this before touching anything PZ.** It is deliberately separate from
CLAUDE.md so that an agent working on Minecraft or 7 Days to Die doesn't carry
230 lines of Workshop-manifest archaeology it will never need. CLAUDE.md holds the
shared architecture; this file holds the depth.

**And keep it current.** Same rule as CLAUDE.md — see "Documentation rules" there.
When you learn something about PZ, or find something below that turned out to be
wrong, update this file before you finish. A stale deep doc is worse than none,
because it gets trusted: every entry in [Corrections](#corrections) was believed
and acted on first.

Companions: `pz/search_folder.sh` + `pz/Dockerfile` (the map-scanner fix),
`src/lib/zomboid.ts`, `src/lib/zomboid-maps.ts`, `src/lib/zomboid-updates.ts`.

## Contents

- [How it runs](#how-it-runs) — image, control channel, graceful stop
- [Mods](#mods) — the two lists, `Map=`, dependency resolution
- [Workshop updates](#workshop-updates) — the watcher, the manifest, seeding
- [Maps and cells](#maps-and-cells)
- [Memory](#memory)
- [Settings, backups, firewall](#settings-backups-firewall)
- [Sandbox options](#sandbox-options)
- [Anti-cheat](#anti-cheat)
- [Known mod defects](#known-mod-defects) — investigated 2026-09-14
- [Status](#status)
- [Corrections](#corrections) — things this file once got wrong

## How it runs

- Image: **`danixu86/project-zomboid-dedicated-server`** (Danixu/project-zomboid-server-docker
  — the actively maintained one). The game files are **baked into the image**, so
  there's no long SteamCMD install like 7DTD's; the only thing downloaded at
  runtime is Workshop mods. Build 42 is what the default tag ships.
- Everything lives in one data dir, mounted into web as `/zomboid`
  (`PZ_SERVER_DIR`): `Server/<name>.ini` (all ~139 settings **and the mod
  lists**), `Server/<name>_SandboxVars.lua` (loot/zombie/XP preset),
  `Server/<name>_spawnregions.lua`, `Saves/Multiplayer/<name>/` (the world),
  `db/<name>.db` (player accounts). Server name is `yoshling` (`SERVERNAME` /
  `PZ_SERVER_NAME`); `serverName()` in `src/lib/zomboid.ts` discovers it from
  disk if it ever differs.
- **Control is RCON on 27015**, not published to the host — the web container
  reaches it as `zomboid:27015`. `PZ_RCON_PASSWORD` (web) must match
  `RCONPASSWORD` (the game container); the entrypoint writes that value into the
  .ini on every boot, which is why `RCONPassword` is locked out of the settings
  editor. `IP`/`BIND_IP` is deliberately **not** set, so RCON listens on all
  interfaces and stays reachable from the web container.
- **Graceful stop:** the image's entrypoint traps SIGTERM, writes `quit` to the
  server console and blocks until the world is saved. Docker's default 10s grace
  period would SIGKILL it mid-save, so `stop_grace_period: 120s` is set in
  compose *and* the driver passes `docker stop -t 120` / `docker restart -t 120`.
  (`LOCK_MAX_MS` in `game-manager` is 300s to cover a hand-off that includes one.)
- **The .ini is the single source of truth, and that's load-bearing.** The image
  rewrites .ini keys from env vars, but only for keys whose env var is *set*. So:
  - `SELF_MANAGED_MODS: "true"` keeps its hands off `Mods` / `WorkshopItems`.
  - `PASSWORD`, `PUBLIC` and `DISPLAYNAME` are deliberately **absent** from
    docker-compose, because those are `Password` / `Public` / `PublicName` in the
    Settings page. Setting any of them in compose would silently overwrite the UI
    on every restart.

## Memory

- **Measured memory use (2026-09-13):** with just 2 mods installed, PZ sits at
  **4.83 GiB RSS** of the box's 7.56 GiB (~1.2 GB free) on `-Xmx4096m`. With 76
  mods it was OOM-killed. So 8 GB is fine for a small list and has room for maybe
  a handful more mods; a large map-heavy collection needs a 16 GB box, not heap
  tuning.

## Workshop updates

- **Seed a big mod list with SteamCMD, don't let PZ download it.** PZ's own
  downloader fails intermittently on a long list (`result=10` Busy, `result=2`
  Fail) and each failure kills the whole server via the NPE below — so a 75-item
  list becomes a crash loop. `/root/seed-mods.sh` on the box loops SteamCMD over
  every id in `WorkshopItems` with `validate` and one retry: 75/75, zero failures,
  ~15 min for 3.8 GB. Then PZ starts cleanly because nothing needs downloading.
- **A failed Workshop download crashes the server, and a stale manifest causes
  it.** PZ's `GameServerWorkshopItems.Install` throws an unhandled
  `NullPointerException` when an item fails to download, so the whole server
  exits ~17s after start. Seen when an item had just been updated on Steam: the
  server had a stale manifest (tried to fetch the old 179 MB version of a 429 MB
  item) and got `result=2`. Fix: re-download the one item with
  `steamcmd … +workshop_download_item 108600 <id> validate`.
  **Do NOT delete `appworkshop_108600.acf` to do this.** That file is Steam's
  record of which items are installed and at what version; removing it makes all
  75 look missing, so the next start re-downloads ~3.8 GB one item at a time —
  which is exactly the crash-prone path the seeding note above exists to avoid.
  (Done on 2026-09-14 while fixing a single stale mod; cost a second restart and
  a full re-seed.) Only nuke the manifest if an item still fails `validate`
  because its recorded version is wrong, and then re-seed everything deliberately.

- **Automatic Workshop mod updates** (`src/lib/zomboid-updates.ts`, driven by a
  5-min timer in `src/instrumentation.ts`; knobs `PZ_UPDATE_WATCH` /
  `PZ_UPDATE_POLL_MS` on the web service). Policy, chosen deliberately: it
  **never interrupts play** — if anyone is connected it announces the update over
  RCON `servermsg` and waits; it applies one only when the server is empty. If PZ
  is already stopped it just seeds the files so the next start is clean.
  - **Two cadences.** Detection every 5 min (`PZ_UPDATE_POLL_MS`); while an update
    is pending it drops to 30 s (`PZ_UPDATE_PENDING_POLL_MS`), because at that
    point nothing new can be discovered and it is only waiting for the last player
    to leave. On one cadence, logging off meant waiting out the remainder of a
    5-minute poll before the restart even began — which reads to players as the
    server being stuck rather than updating.
  `GET/POST /api/zomboid/updates` exposes and force-runs it.
  - **It compares Steam's manifest, not file mtimes.**
    `appworkshop_108600.acf` → `WorkshopItemsInstalled.<id>.timeupdated` is the
    version on disk; `GetPublishedFileDetails` → `time_updated` is the published
    one, cross-checked against `WorkshopItemDetails.<id>.latest_timeupdated` with
    the newer of the two winning. Exact, and one small file read plus **one batched
    HTTP request for all 75 mods** (not one per mod) — which is what makes 5-min
    polling free.
  - **TRAP: that .acf has TWO sections keyed by workshop id** —
    `WorkshopItemsInstalled` (on disk) and `WorkshopItemDetails` (what Steam knows,
    incl. `latest_timeupdated`) — and **both carry a `timeupdated`**. The first
    version of this read from `"WorkshopItemsInstalled"` to end-of-file, so the
    second section's values overwrote the first, `installed` came out equal to
    `published` for every mod, and the check could never fire. Parse it with
    brace-matched bounds (`kvSection()`), never a slice-to-EOF.
    Worth remembering *how* that got through: the first validation run reported
    "0 stale" and I read that as a pass, when the server genuinely had an
    out-of-date mod — the bug agreeing with itself. **Validate a detector by
    planting a fault it must find**, not by observing it find nothing. Rolling one
    mod's `timeupdated` back by a day in the manifest is the cheap way to do it;
    it self-heals, because applying the update re-downloads that mod.
  - Verified in production this way: planted stale mod → detected as
    `Better Push (3715137752)`, one player online → **announced and did not
    restart**, `StartedAt` unchanged, state file written.
  - It holds the **control lock** via `withGameStopped()`, so it can't interleave
    with a restart from the UI; a busy lock just skips that round.
  - **There is no push alternative — this was checked, not assumed.** Steam has no
    Workshop webhook. PICS changelists are a timer poll (`changelistUpdateInterval`
    → `ClientPICSChangesSinceRequest`) and carry **only appIDs and packageIDs**, so
    they would report a Project Zomboid *game* patch and never a mod update. PZ has
    no server option for it and no Lua event that fires on an upstream change
    (`OnModsModified` is the local list). And the version check is **client-side**
    (`gameStates/ConnectToServerState`), so the server logs nothing when a join is
    refused — there is no failed-join event to trigger on either. Don't re-litigate
    this without new evidence.
  - Measured 2026-09-14: **~9 mod updates/week** across the 75-mod list, 3 in one
    day. That is why a nightly scheduled restart (what most community servers do)
    is not sufficient here.
- **`checkModsNeedUpdate` is PZ's own check, over RCON**, and it is authoritative:
  it went `Mods need update` → (fix) → `Mods updated` for us. **But its reply says
  the answer is written "in the log file and in the chat"**, so do NOT poll it on a
  timer — it would likely spam players. Use it for confirmation around a restart;
  use the Steam manifest comparison for detection.
- **When a mod updates on Steam, the server keeps serving the old version until it
  restarts, and clients that auto-updated cannot join.** No mismatch line appears
  in the server log — the join just fails, so it looks like the server is broken.
  To find the culprit, compare each `WorkshopItems` id's Steam `time_updated`
  against the newest file mtime under
  `pz-workshop/_data/content/108600/<id>/`; that pinpointed Authentic Z
  (`2335368829`) in about a minute. Then `validate`-download that one id and
  restart. A normal restart with nothing updated downloads nothing.

## Mods

- **Mod ids come from `mod.info`'s `id=`, not the folder name — and this file had
  it backwards for Community Tile Pack.** The folder on disk is `CommunityTilePack`
  but the declared id is `UnofficialMappersCommunityTilePack`, which is what `Mods=`
  contains and what the log confirms loading. An earlier version of this note
  claimed the reverse. Reconcile against the `id=` inside
  `content/108600/<id>/mods/*/[<version>/]mod.info`, never against `ls`.

## Maps and cells

- **The IMAGE overwrites `Map=` on every boot — this was the "maps do nothing" bug.**
  `/server/scripts/entry.sh` line ~234 runs
  `sed -i "s/Map=.*/Map=${map_list}Muldraugh, KY/"`, where `map_list` comes from
  the image's `search_folder.sh`. That scanner only looked at
  `<workshopId>/mods/<mod>/media/maps` — **one fixed level** — but B42 mods keep
  content under a version folder (`Secretz42/42.20/media/maps`), so it found none
  of them and produced `AZSpawn;AZSpawn;`. Any correct hand-written `Map=` was
  destroyed ~3 seconds into every start. **`SELF_MANAGED_MODS` does not protect
  `Map=`** — it only guards `Mods` and `WorkshopItems`.
  Fixed by `pz/search_folder.sh` + `pz/Dockerfile` (a derived image, because
  entry.sh runs `sed -i` on the script itself so a bind mount fails): finds
  `media/maps` at any depth, dedupes, orders by cell count so a 22-cell map
  outranks a 4-cell checkpoint, and honours `MAP_EXCLUDE` from compose.
  **Measured before/after:** distinct maps registering cells went from **2 → 16**,
  and `Map=` from 3 entries to 22. If maps ever stop working, check
  `docker logs yoshling-pz | grep "INFO: Added maps"` first.
  I previously recorded the opposite in this file — that PZ itself prunes add-on
  maps and that this was correct behaviour. That was wrong; the pruning was the
  image's sed, and the maps genuinely were not loading.
- **`MAP_EXCLUDE`** keeps a map out of the generated list. `SZ_Checkpoint6` is in
  it: retired on 42.20 (content moved into `SZ_Riverside_Checkpoint_2`, map title
  says `ONLY 42.19`, its standalone mod is tagged `DEPRECATED`) yet still shipped
  inside the current `Secretz42`, so both claimed cells 22_22/22_23/23_22/23_23.
  It is also removed from `Mods=`.
- **The `mod "X" overrides media/maps/…/<x>_<y>.lotheader` lines ARE the signal
  that a map's cells registered.** Counting distinct map names across them is how
  the 2 → 16 fix above was verified.
- **A mod.info can mark itself deprecated, and that's how you find dead
  duplicates.** `SZ_Checkpoint6` is `name=…[42.20 DEPRECATED]`, `versionMax=42.20`,
  with map title `Checkpoint 6 (ONLY 42.19)`. On 42.20 its content moved into
  `SZ_Riverside_Checkpoint_2`, which is why the two claim the same 4 cells. Grep
  mod.info `name=` for DEPRECATED before chasing a cell overlap.
- **Mod XML that uses `x_extends` breaks on Linux — in FIVE mods, not one.**
  565 failures/run: `GunsOfMarz` 400, **`Authentic Z - Current` 60**, `HBVCEF` 30,
  `tsarslib` 10, `TrueSmoking` 5. The Authentic Z ones are the trap: the `LOG` line
  names a *vanilla* file (`media/AnimSets/player/ext/Ext02_1Handed.xml`) while the
  actual `FileNotFoundException` is on the mod's own lowercased path, so they read
  as a vanilla fault. PZ lowercases the *whole*
  resolved path when following `x_extends` and hands it to `FileInputStream`, so
  `RackLeverAction_HB.xml`'s `x_extends="LoadLeverAction_HB.xml"` is looked up as
  `…/gunsofmarz/42.16/media/animsets/…/loadleveraction_hb.xml` and fails on ext4
  even though the file is right there. Harmless log spam (animation is
  client-side, and clients are on case-insensitive filesystems); silence it with
  lowercase symlinks for the dir and file names if it ever matters.
- **One Workshop item can ship many maps.** SecretZ Pandemic ships **20** map
  folders (16 with cells, 4 cell-less spawn/basement definitions), and every one
  of them needs a `Map=` entry. Its own maps even overlap each other
  (`SZ_Checkpoint6`/`SZ_Riverside_Checkpoint_2`,
  `SZ_Checkpoint5`/`SZ_MuldraughCrossroads_Checkpoint`), so the order within a
  single mod matters too.
- **Memory: 4 GB is not enough for a big mod list.** On 2026-09-13 the PZ server
  was **OOM-killed by the kernel** (`OOMKilled=true`) with 76 mods installed and
  `-Xmx4096m`, after GC-thrash symptoms in the log (`SteamnetworkingSockets
  service thread waited 132ms for lock`, `IPC function call ... took too long`).
  The box has 7.6 GB total. Note the failure was a *kernel* OOM kill, not a Java
  `OutOfMemoryError`, so total RSS — heap **plus** the off-heap/mmap'd map and
  tile data — was the limit. Raising the heap alone may not be enough; a large
  collection of map/tile packs may simply not fit on this box. Change it on the
  Settings page (see "Server memory").
- **Dependency resolution needs `STEAM_API_KEY`.** The keyless Workshop endpoint
  returns no dependency data at all; `IPublishedFileService/GetDetails` with a key
  adds `children`, which is the Workshop's "Required items" list. Adding a mod
  pulls its required items in and puts them **before** it in both lists, since PZ
  loads `Mods=` in order and a library must precede its consumer. Without a key it
  falls back and behaves as before.
- **Map mods need a THIRD list the mod manager does not own yet: `Map=`.** A map
  mod that's in `WorkshopItems` and `Mods` still shows nothing in-game until its
  map name is added to `Map=` (first entry wins where two maps overlap). The add
  route detects the Workshop "Map" tag and says so, but doesn't edit `Map=`.
- **Mods = two lists that must agree** (`/zomboid/mods`, `/api/zomboid/mods`):
  - `WorkshopItems=2169435993;2200148440` — what the server *downloads*.
  - `Mods=\AuthenticZ;\Brita` — what it then *loads* (mod folder names).
    **Build 42 requires the leading backslash** per entry; B41 does not.
    `modIdPrefix()` mirrors whatever the file already uses and defaults to B42.
  - Having one without the other is the classic "my mods aren't working" trap, so
    the route always writes both, and a mod with no mod id is flagged in the UI
    rather than failing silently.
  - Mod ids come from, in order: what's already on disk
    (`/zomboid-workshop/content/108600/<id>/mods/<modId>/`, read-only mount), the
    `Mod ID: X` line in the Workshop description, or typed in by hand on the
    card. Titles/thumbnails come from Steam's public
    `ISteamRemoteStorage/GetPublishedFileDetails` (no API key needed) and are
    cached in the `ZomboidMod` table — the .ini stays authoritative for what's
    enabled.
  - Timing to tell players: a mod **downloads on the next start and loads on the
    one after that**.

## Settings, backups, firewall

- **Settings:** `/api/zomboid/config` exposes the whole .ini generically (the `#`
  comment above each key becomes its help text). `INFRA_KEYS` in
  `src/lib/zomboid.ts` (RCON + the published ports) plus `Mods`/`WorkshopItems`
  are locked out of that editor — the ports would break connectivity, and the mod lists
  belong to the Mods page. Quick settings (name/password/max players/public/PVP/
  pause-when-empty) write to the same endpoint, so there's no second copy to
  drift. Sandbox options are Lua, not .ini — the page points at the file browser.
- **Config import** (`/api/zomboid/config/import`, the card on the Settings page):
  upload an existing server's `.ini` to move a server you already ran. It
  replaces the file wholesale — settings *and* both mod lists, which is usually
  the point — but **puts this box's `INFRA_KEYS` back** (RCON password/port,
  DefaultPort, UDPPort, SteamPort1/2), so an imported config can't take the app's
  control channel or point the server at unpublished ports. POST without
  `apply` returns a preview (what changes / what's added / what's dropped / which
  keys stay local / which mods come across); POST with `apply: true` backs the
  current file up to `<name>.ini.bak-<stamp>` and writes. An import whose
  `Mods=` names ids that no Workshop item provides shows up in the Mods page's
  "Loaded without a Workshop item" list — that's the intended catch.
- **Backups** bundle `Saves/Multiplayer/<name>` + `db/<name>.db` + `Server/<name>*`
  + a `manifest.json`, so one restore rebuilds the world, the accounts and the
  settings together.
- **Firewall:** as with the other games, the ports must be open in BOTH the box's
  `ufw` and the Hetzner Cloud Firewall — 16261/udp + 16262/udp (game) and
  8766-8767/udp (Steam query, needed for the public server list).

## Sandbox options

Sandbox settings are Lua, not `.ini`: `Server/<name>_SandboxVars.lua`. They are
read at **world load**, so a change needs a server restart. Editable in the
dashboard file browser under Config (the browser's editable-extension allowlist
had no `lua` until 2026-09-14, which silently made this page useless).

- **Muscle strain** is `MuscleStrainFactor` (min 0.00, max 10.00, default 0.70) —
  "a multiplier when applying muscle strain from swinging weapons or carrying
  heavy loads". It is the only vanilla strain knob; there is **no** option for
  recovery rate. Weak shoves are a *consequence* of accumulated strain, not a
  separate setting, so this one value covers both complaints. `0.0` disables the
  mechanic, which makes melee strictly better than guns in every situation.
- The `ArmStrainGainMultiplier` / `ArmStrainPenaltyMultiplier` / etc. block belongs
  to the **`CyesPushDoors`** mod and applies only to forcing doors open, not
  combat. All at a neutral `1.0`. Don't mistake it for a strain control.

## Anti-cheat

`AntiCheat*` keys in the `.ini` take a policy **enum**, extracted from
`zombie/network/anticheats/AntiCheat$Policy` in `projectzomboid.jar`:

| value | meaning |
|-------|---------|
| 1 | Ban |
| 2 | Kick |
| 3 | Log |
| **4** | **Disabled** |

- **`AntiCheatSpeed=4`** (was 2 = Kick). Any mod that teleports a player — RV
  interiors, bunkers, elevators — registers as a single-tick jump of thousands of
  tiles against a limit of 20 and gets them kicked. Real case: `speed=11486.9 >
  limit=20.0 counter=4/4 action="Kick"` on entering an RV. The game itself already
  ships `AntiCheatNoClip=4` and `AntiCheatPacketException=4` for the same reason;
  Speed just wasn't among them.
- Set it live with RCON **`changeoption AntiCheatSpeed 4`** — no restart needed,
  and PZ writes the value into the `.ini` itself.
- **Leave `AntiCheatPacketException` at 4.** 16 `logInconsistentPacket` warnings in
  14 h (Thump, PlayerHitSquare, AttackCollisionCheck…) are ordinary MP jitter.
  Tightening it turns them into kicks.

### Useful RCON commands

- `players` — connected list. `save` — save the world. `servermsg "..."` — broadcast.
- **`teleportplayer "a" "b"`** moves player a to b. Plain `teleport` teleports
  *you* to a player, which has no meaning from the server console, so it just
  prints its usage text — that is not an error, it's the wrong command.
- `changeoption <Key> <value>` — set a server option at runtime.
- `checkModsNeedUpdate` — see [Workshop updates](#workshop-updates).

## Known mod defects

Investigated 2026-09-14 across the whole log history (5 boots, 106k lines). The
server is healthy: no OOM, zero GC stalls, 87/87 `Mods=` entries load, disk 14%,
`RestartCount=0`, and **no error class is growing**. ~19,000 lines/boot are
verified vanilla or cosmetic noise. These are the ones that actually break
something.

### Breaks something — worth acting on

| Mod | Defect | Action |
|-----|--------|--------|
| **Better Push** (`3715137752`) | `BetterPush_Server.lua:40` calls `getZombieByOnlineID`, which **exists nowhere** (0 hits in the jar, no mod defines it). The handler throws on every invocation, so MP domino-knockdown is 100% dead — clients predict the push, zombies snap back. | Remove. Zero risk; the feature already doesn't work. |
| **Extra Gun Slot** (`3120702374`) | `holsterbackb` is defined only under `media/lua/**client**/`. A dedicated server never loads `lua/client/*`, so every attach is rejected: `no such location "holsterbackb"`. 216 events, 3 players. The slot doesn't sync and may not survive a relog. | Remove, or upstream moves the definition to `lua/shared`. **Unknown** whether items in the slot are lost — have players empty it first. |
| **`truemusic_mixtape_megapack`** | Declares `require=truemusic`, which is **not installed**. 60 cassette items have no world model and no playback base. | Install True Music, or drop the megapack. |
| **`SwapIt`** | Declares `require=EasyConfigChucked`, **not installed**. Config layer absent; unknown whether it still works on defaults. | Install it, or drop SwapIt. |
| **`Secretz42_tilepack_com`** | Ships `secretz_42.tiles` claiming **tiledef number 6264**, the same as `Secretz42` — and the two files *differ* (different md5). One set of tile properties is silently discarded, so SecretZ tiles can resolve to the wrong definition (worst case: a wall you can walk through). Also the source of 2,490 duplicate-sprite warnings. | Probably remove from `Mods=` — the pack is a *compatibility* shim for servers running SecretZ tiles **without** the map mod, i.e. either/or. **Verify first**: confirm no other installed map builds on it, and back up the `.ini`. |
| **`[B42] SecretZ Pandemic`** | `SZCServer.lua` is 683 lines and throws at line 394 (`Commands` is nil, after `require("server/SZCBlueServer") failed`) on **every** boot, so ~289 lines never run — door despawn and no-key autoclose are dead. | Report upstream. **Do not remove SecretZ** — it owns 16 of the 22 `Map=` entries. |
| **`errorMagnifier`** (`2896041179`) | A debug mod; entirely `lua/client`, so inert server-side. Only effect is error popups for players. | Remove for their sake. |

### Investigated and deliberately not fixed

- **The `NetTimedAction` NPE** — ~35/boot, `Cannot invoke "java.lang.Boolean.booleanValue()" because ... protectedCallBoolean(...) is null`.
  A **vanilla defect**: `NetTimedAction.perform()` (line 140) does
  `protectedCallBoolean(...).booleanValue()` with no null check, while its siblings
  `start()`/`stop()`/`animEvent()` all guard with `rawget` + skip-if-null.
  - **The trace carries no Lua frames and never will** — `KahluaThread.pcallBoolean`
    leaves its result `null` unless the pcall succeeded *and* returned a Boolean,
    and never reads or logs the Lua error object. Don't waste time grepping for a
    `MOD:` tag; there isn't one. Getting the action name requires a restart with
    `DebugType.Action` DEBUG on (`ActionManager.update:69` then prints it).
  - Dominant source is *probably* vanilla `ISGenericCraftStart`, whose `complete()`
    is commented out in the vanilla source — inferred from timing (hard floor of
    3.90 s between events, mode 7-8 s, and a lone player producing sub-6.3 s gaps,
    which excludes every 50-150 s candidate). **Not proven.**
  - Impact is nil: the Lua work finishes, the NPE is on unboxing afterwards, the
    client has always completed first so the reject packet matches nothing, and
    nothing reads the action's done/rejected state. Flat at 5-12 per player-hour.
  - Three mods *do* have a real one-word bug of this shape — they wrap a vanilla
    `complete()` and drop its return value: **`lgd_antibodies`** (5 actions),
    **`EQUIPMENT_UI`** (`ISWearClothing`), **`GunsOfMarz`** (`ISUpgradeWeapon`).
    Worth an upstream report; patching locally gets clobbered by the next update.
- **`[B42] PROJECT RV Interior`** (`3543229299`) — `RVServerMP_V3.lua:188` throws
  `Cannot read field "loadedBits" because "square.chunk" is null`.
  - Cause: line 162 uses `getCell():getOrCreateGridSquare(...)`, which **does not
    check that a chunk exists** (the sibling `createNewGridSquare` does). On an
    unloaded chunk it fabricates a detached square, and `AddSpecialObject` →
    `PolygonalMap2.squareChanged` → `PathfindNative.squareChanged` dereferences
    `square.chunk`.
  - **Caught**: `KahluaThread.pcall` has a `catch Throwable` handler, so Lua
    continues. The object was already added; only three trailing bookkeeping calls
    are skipped.
  - **The interior is static map content** in `world_92_47.lotpack`, not generated
    at runtime — `gen()` only places one generator for RV power. There is no
    half-generated state to reach. Worst case: that visit's RV has no power.
  - The 4× `IsoGenerator not found on square` lines are a **separate** ordering bug
    — the mod calls `setFuel`/`setCondition`/`setConnected`/`setActivated` (each of
    which `sync()`s) *before* `AddSpecialObject`, so `getObjectIndex()` is -1 and
    four broadcasts are dropped. Harmless (re-sent after attach) but happens on
    **every** RV entry.
  - **`AntiCheatSpeed=4` removed the trigger.** `gen()` fires ~14 s after entry;
    the anti-cheat kick was force-disconnecting the only nearby player, so nothing
    kept the cell loaded. The kick caused the NPE, not the reverse.
  - Installed version is the latest published (`modversion=2.3`, no update
    pending), so there is no fix to apply. **Don't remove it**: it ships
    `map_distanciado`, which is first in `Map=`, and removal would strand anyone
    inside an interior.

### Verified harmless — do not chase these

All byte-identical every boot, so not growing. Largest first:
`buildingDef.ID=N expected=N` (1,146/boot, vanilla building renumber across 22
stacked maps) · `XuiSkin ... Could not find icon` (1,068/boot, **client** UI icons)
· `ModelScript.checkMesh no such mesh` (856/boot, gun mods vs B42 mesh moves) ·
`Sprite duplicate texture` (498/boot — symptom of the tilepack collision above) ·
`AdvancedAnimator$1.visitFileFailed` / `NoSuchFileException .../{AnimSets,actiongroups}`
(321/boot, 267 dirs — the animation loader logs a full ERROR trace for every mod
that simply has no animations) · `SkeletonBone not resolved for bone: Bone_Door*`
(vehicle rig bones; message ends "defaulting to SkeletonBone.None", and ragdoll is
client-side) · `AnimState not found: turning180` (vanilla ships transitions *into* a
state it never defines — `turning180` appears nowhere in the jar) ·
`ItemPickInfo -> cannot get ID for container: inventorymale/inventoryfemale`
(vanilla zombie pseudo-containers) · `Mannequin zone missing properties` (1/boot,
vanilla Muldraugh data defect) · `action was null, object: null` (vanilla animal AI)
· `No packet handler for type: ...` (**one** line carrying 60 vanilla packet names,
not 60 problems) · `Missing ThumpSound` · `ladderW/ladderS Property Name not found`
· `module "Base" imports itself`.

Two with a non-harmless tail worth knowing:
- `ItemPickInfo` also fires for ~120 **modded vehicle** containers (`SeatP1-6`,
  `B700Trunk*`, `DAM60Gunrack`…), paired with 60 `template "..." not found` and 80
  `vehicle type "Base.BTR-80Burnt" doesn't exist`. Inferred: those military
  vehicles spawn empty/incomplete.
- Authentic Z uses the B41 skill name in one recipe: `Unknown skill "Metalworking"
  in recipe "Fix Chainsaw with Small Sheet Metal"` — that recipe is unusable.

### A burst that has already settled

Boot 1 on 2026-09-13 produced one `MetaEntitySystem.loadMetaEntities` failure
(`newPosition > limit: 1769171059 > 1172`) plus 233 `IsoThumpable not found on
square`, 4 `IsoGenerator not found`, and 8 `CreatePlayerPacket` position warnings.
Per boot since: 233 / 0 / 0 / 2 / 4 — over.

**Inferred cause, and it's self-inflicted:** that was the first boot after the
`Map=` / mod-list rework, so already-saved chunks referenced objects the new map
set no longer resolved. **Some placed entities were probably silently dropped.** If
a player reports a missing generator or crafting station, this is why. Escalate
only if it recurs.

Related, still present: 14 dead spawn buildings (`initSpawnBuildings: no room or
building at x,y,0`), 5 maps in `Map=` with no `objects.lua`
(`SZ_ExtraSpawnPoints`, `SZ_Basements`, `SZ_Bunker_3`, `SZ_DeerheadLake_Base`,
`DeltaForce_Team_Spawn`), `invalid room metaID` in cell 25,33 (**0 in boot 1, 4 in
every boot since** — appeared with the map rework and is now permanent), and 18
duplicate `RoomDef.metaID`/boot. The price of 22 stacked maps; act only on a
concrete player report.

## Status

**Live on netcup `89.58.50.155`** (8 vCPU / 16 GB / Debian 13). Migrated off
Hetzner 2026-09-13 — see MIGRATION.md.

Working and verified in production:

- 89 mods load from 75 Workshop items; `SERVER STARTED`, RCON on 27015, 16261/udp
  reachable, 0 failed downloads, `OOMKilled=false`.
- Power on/off/restart, console, file browser (Config/Saves/All data), backups,
  settings, config import, the mods page, and the maps card.
- `Map=` carries all 22 maps and **16 register cells** (was 2 before the scanner
  fix).
- The Workshop update watcher: detection, in-game announcement while players are
  connected, and the automatic restart-when-empty — all three exercised for real.
- 12 GB heap; peak RSS 9.7 GB of 16 GB.

Outstanding:

- **`pz.yoshling.xyz` DNS record** (DNS-only / grey-cloud → the box) does not exist
  yet. Players use the raw IP `89.58.50.155:16261`. Needs the Cloudflare dashboard.
- The mod defects in [Known mod defects](#known-mod-defects) that are tagged for
  removal — none applied yet; they want one batched restart.
- `MuscleStrainFactor` is still at the vanilla `0.7`; a player has asked for it to
  be lowered.
- The `x_extends` lowercase log spam could be silenced with lowercase symlinks
  (5 mods, 565 lines/run). Cosmetic, never done.

## Corrections

Kept deliberately: each of these cost real time, and the wrong version was
plausible enough to write down twice.

1. **A mod id is `id=` inside `mod.info`, not the folder name.** Pruning `Mods=`
   entries by comparing them to folder names broke a working 88-entry list. One
   folder can also ship *several* `mod.info` files (root + version folders) with
   different ids — `installedModIds()` collects all of them. Community Tile Pack is
   the standing example: folder `CommunityTilePack`, id
   `UnofficialMappersCommunityTilePack`. An earlier note here asserted the reverse.
2. **`Map=` being rewritten was the Docker image, not the game.** For a while this
   file claimed B42 deliberately strips add-on maps from `Map=` and that this was
   correct behaviour. It isn't — `entry.sh` was overwriting the line from a scanner
   that couldn't see B42 version folders, and 20 maps were inert as a result.
3. **A cell is 256×256 squares in B42**, not B41's 300 (`IsoCell.CELL_SIZE_IN_SQUARES`
   = 32 chunks × 8). Teleport coordinates derived as `cell * 300 + 150` pointed at
   the wrong place. Cross-check: the save stores chunks at `map/<x/8>/<y/8>.bin`,
   and square 23700,12060 is in the shipped cell `92_47` (23700/256 = 92.6).
4. **Deleting `appworkshop_108600.acf` to fix one stale mod** made all 75 look
   missing and sent the next boot down the crash-prone download-everything path.
5. **"0 stale" from a detector is not proof it works.** The first version of the
   update check reported no updates on a server that demonstrably had one — a
   parsing bug agreeing with itself. Validate a detector by planting a fault it
   must find. Rolling one mod's `timeupdated` back a day in the manifest is the
   cheap way; it self-heals, since applying the update re-downloads that mod.
