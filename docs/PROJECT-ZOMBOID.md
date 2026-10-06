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
`src/lib/zomboid.ts`, `src/lib/zomboid-maps.ts`, `src/lib/zomboid-updates.ts`,
`src/lib/zomboid-ini-contract.ts`, `src/lib/sandbox-lua.ts`.

**Two committed fixtures are copies of the live server, and with no production access they
will settle most PZ questions on their own.** Reach for them before reasoning from this
file:

| File | What it is |
|------|-----------|
| `tests/fixtures/pz-server.ini` | The **verbatim** production `Server/yoshling.ini`, 2026-09-29 — 144 keys, 134 comment lines, `Mods=` 87 entries, `WorkshopItems=` 75, `Map=` 22. `RCONPassword` redacted; `Password`, `DiscordToken` and `ServerPlayerID` were already empty |
| `src/lib/__tests__/fixtures/pz-sandboxvars.lua` | A verbatim **38-option excerpt** of the production `SandboxVars.lua` (2026-10-01), chosen for its traps — a duplicate key at two nesting levels, a key with no comment under another's 27 enum lines, Min/Max on an int and a float |
| `tests/fixtures/appworkshop-stale.acf` | A Workshop manifest with a **planted** stale mod, the fault the detector has to find |

The invariants are pinned by six test files, all runnable with no Docker, no network and
no server: `src/lib/__tests__/{sandbox-lua,zomboid-sandbox-io,zomboid-ini-contract,zomboid-maps}.test.ts`
and `tests/{zomboid-ini,acf}.test.ts`. Extend one rather than re-deriving a fact here.

## Contents

- [How it runs](#how-it-runs) — image, control channel, graceful stop
- [Mods](#mods) — the two lists, `Map=`, dependency resolution
- [Workshop updates](#workshop-updates) — the watcher, the manifest, seeding
- [Maps and cells](#maps-and-cells)
- [Memory](#memory)
- [Settings, backups, firewall](#settings-backups-firewall)
- [Sandbox options](#sandbox-options)
- [Anti-cheat](#anti-cheat)
- [When the server hangs](#when-the-server-hangs) — up but unjoinable, and how to prove it
- [Known mod defects](#known-mod-defects) — moved to [`PZ-MOD-BACKLOG.md`](PZ-MOD-BACKLOG.md)
- [Status](#status)
- [What is measured, and what is not](#what-is-measured-and-what-is-not) — read before quoting a number
- [Corrections](#corrections) — things this file once got wrong

## How it runs

- Image: **`danixu86/project-zomboid-dedicated-server`** (Danixu/project-zomboid-server-docker
  — the actively maintained one). The game files are **baked into the image**, so
  there's no long SteamCMD install like 7DTD's; the only thing downloaded at
  runtime is Workshop mods. Build 42 is what the default tag ships.
- Everything lives in one data dir, mounted into web as `/zomboid`
  (`PZ_SERVER_DIR`): `Server/<name>.ini` (**144** keys **and the mod lists**),
  `Server/<name>_SandboxVars.lua` (**742** options — loot, zombies, XP; see
  [Sandbox options](#sandbox-options)), `Server/<name>_spawnregions.lua`,
  `Saves/Multiplayer/<name>/` (the world), `db/<name>.db` (player accounts).
  144 counted off the production file 2026-09-29 (the fixture above). This said
  "~139", worth correcting rather than rounding because **every derived figure in the
  code is computed off 144** — 137 shown with 7 hidden, 8 restart-only — and none of
  them reconcile against the old number.
- Server name is `yoshling` (`SERVERNAME` / `PZ_SERVER_NAME`); `serverName()` in
  `src/lib/zomboid.ts` discovers it from disk if it ever differs — **by stat-then-guess,
  and it prefers `servertest.ini` when the configured name's file is absent.** That is
  the reachable path into a backup with no world: a rename through the settings page, or
  a config import that drops a second `.ini`, and the create then refuses rather than
  writing a 4 MB archive (see [Settings, backups, firewall](#settings-backups-firewall)).
- **The service sits behind `profiles: ["games"]`, so a bare `docker compose up -d`
  cannot start it — and a human verifying PZ by hand needs `--profile games`.** Verified
  on the box 2026-10-01: with no profiles, `up --dry-run -d` printed `yoshling-mc
  Started` *and* `yoshling-7dtd Started` while PZ was running — all three worlds,
  ~22 GB of configured heap on a 15.6 GB box, i.e. the 2026-09-26 co-residency incident
  with a one-command trigger. Named services are unaffected, which is what the app uses.
  The three `mem_limit`s deliberately sum to more than the box because **only one world
  runs at a time**; `src/lib/coresidency.ts` detects a breach of that invariant and says
  so, which nothing did before.
- **Control is RCON on 27015**, not published to the host — the web container
  reaches it as `zomboid:27015`. `PZ_RCON_PASSWORD` (web) must match
  `RCONPASSWORD` (the game container); the entrypoint writes that value into the
  .ini on every boot, which is why `RCONPassword` is locked out of the settings
  editor. `IP`/`BIND_IP` is deliberately **not** set, so RCON listens on all
  interfaces and stays reachable from the web container.
- **Graceful stop: the driver asks the game to `quit` over RCON. `docker stop` has never
  been able to stop this container.** `zomboidDriver.stop()` sends RCON `save`, then `quit`,
  then polls the container for up to `PZ_QUIT_WAIT_MS` (60 s), and only falls back to
  `docker stop -t ${PZ_STOP_TIMEOUT}` if the game never went away. A stop is **~12 s, exit
  code 0**. `stop_grace_period` on the `zomboid` service is **300s** (Minecraft's and 7DTD's
  are 120s) and is now only the fallback's budget.
  - > **This bullet said the opposite until 2026-10-06, and it is the single most expensive
    > wrong sentence in this repo.** It claimed "the image's entrypoint traps SIGTERM,
    > writes `quit` to the server console and blocks until the world is saved", with
    > `stop_grace_period: 120s`. Every clause was false: `grep -c trap entry.sh` is **0**,
    > `/proc/1/status` shows `SigCgt: 0000000000010002` (SIGINT + SIGCHLD only), and **the
    > kernel discards uncaught signals aimed at a namespace's PID 1** — so SIGTERM was never
    > delivered, not once. The result was a flat five-minute stop ending in SIGKILL, and
    > `docker-compose.yml` records that this exact wording "stopped three separate audits
    > looking". The mechanism was fixed on 2026-09-29; this paragraph was not, and it sat
    > 520 lines above the section that refutes it. See **Corrections** at the end of this
    > file, and `docs/CLOSED.md`.
- **The .ini is the single source of truth, and that's load-bearing.** The image
  rewrites .ini keys from env vars, but only for keys whose env var is *set*. So:
  - `SELF_MANAGED_MODS: "true"` keeps its hands off `Mods` / `WorkshopItems`.
  - `PASSWORD`, `PUBLIC` and `DISPLAYNAME` are deliberately **absent** from
    docker-compose, because those are `Password` / `Public` / `PublicName` in the
    Settings page. Setting any of them in compose would silently overwrite the UI
    on every restart.

## Memory

Current values, all in `docker-compose.yml`'s `zomboid` block, and all three measured
on production 2026-09-30 — the JVM's own command line reads `-Xms2048m -Xmx12288m`, so
these two env vars land verbatim rather than being interpreted:

| | value | who may change it |
|---|---|---|
| `MIN_MEMORY` → `-Xms` | `2048m` | compose only — **not** UI-owned |
| `MAX_MEMORY` → `-Xmx` | `${PZ_MAX_MEMORY:-12288m}` | the Settings page, via `.env` |
| `mem_limit` (the cgroup ceiling) | `14g` | compose only |

Three things not to re-break:

- **`setMemory` reads `MIN_MEMORY` and refuses before admission.** It patches only the
  max, so a heap chosen below the floor would write `-Xmx` under a larger `-Xms` — a JVM
  that refuses to start. The memory card's buttons therefore begin at 2 GB instead of
  offering 1.
- **Do not lower `mem_limit` to 13g. That was tried and measured.** Booted and empty,
  `anon` (unreclaimable) was 1.1 GiB while `file` (page cache from reading mods and map
  cells) was 11.6 GiB, so the cgroup sat at 98 % of its limit and had already reclaimed
  601 times. Cache pressure is harmless, but `-Xmx12288m` means the heap may grow to
  12 GiB of *anon*, and at that point 13g is an OOM kill mid-session. 14g is also the
  practical maximum: 15.6 GiB box, minus ~1 GB for the dashboard and the OS. If PZ ever
  needs more, the heap comes down rather than the ceiling going up.
- **Judge it from `memory.stat`, not `docker stats`.** The latter's `MemUsage` counts
  page cache, so a healthy PZ reads as 98 % of its limit — which is how 13g came to look
  adequate in the first place.

> **This whole section was the pre-migration Hetzner box until 2026-10-06 and stated none
> of the values above** — "4.83 GiB RSS of the box's 7.56 GiB on `-Xmx4096m`" with 2 mods,
> "8 GB is fine for a small list", "needs a 16 GB box, not heap tuning". Every sentence
> was an honest measurement, correctly dated 2026-09-13, of a box decommissioned that same
> day; it was believable precisely because it was real. The cost was that both traps above
> were live re-break candidates against a world on a 12 GB heap with 87 mods.
>
> The old conclusion is kept because it was right, and it is what bought the 16 GB box: on
> 2026-09-13 PZ was **kernel** OOM-killed (`OOMKilled=true`, *not* a Java
> `OutOfMemoryError`) with 76 mods on `-Xmx4096m`, after GC thrash in the log
> (`SteamnetworkingSockets service thread waited 132ms for lock`). A kernel kill means
> total RSS was the limit — heap **plus** the off-heap and mmap'd map and tile data — so
> raising the heap alone would not have helped.

## Workshop updates

- **Seed a big mod list with SteamCMD, don't let PZ download it.** PZ's own
  downloader fails intermittently on a long list (`result=10` Busy, `result=2`
  Fail) and each failure kills the whole server via the NPE below — so a 75-item
  list becomes a crash loop. Then PZ starts cleanly because nothing needs downloading.
  - **The app does this itself now, and that is the path to use.** `seedMods(ids)` in
    `src/lib/zomboid-updates.ts` runs SteamCMD with `validate` in a throwaway
    `--rm` container sharing the `pz-workshop` volume, under SteamCMD's own 45-minute
    exec timeout, and **throws unless SteamCMD reported every item downloaded** — so
    reaching the end *is* the read-back, and the count is Steam's rather than ours.
    It deliberately leaves `appworkshop_108600.acf` alone, for the reason in the next
    bullet. `POST /api/zomboid/updates` forces a round.
  - **The container carries the label `yoshling.role=pz-seed`, and the label is
    load-bearing outside the module.** `scripts/deploy.sh` refuses to deploy while a
    seed is in flight, because two SteamCMD runs race on the same volume and the loser
    silently updates nothing — the documented "updated 0 of 1 mods". If you rename the
    label, rename it there too. (The guard used to look for the image name, which meant
    it never fired once.)
  - The by-hand equivalent was `/root/seed-mods.sh` on the box, looping SteamCMD over
    every id in `WorkshopItems` with `validate` and one retry: 75/75, zero failures,
    ~15 min for 3.8 GB on 2026-09-14. **Unverified since — nothing in git creates or
    references that file**, so check before reaching for it:
    `ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 'ls -la /root/seed-mods.sh'`.
    Prefer the route either way: a host script run by hand is outside the deploy
    interlock, and the watcher's seed is the **normal** path rather than the edge case
    (PZ is off whenever another world holds the box), so racing it is the likely
    outcome, not the unlucky one.
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
  15s interval in `src/instrumentation.ts`; knobs `PZ_UPDATE_WATCH` /
  `PZ_UPDATE_POLL_MS` on the web service). Policy, chosen deliberately: it
  **never interrupts play** — if anyone is connected it announces the update over
  RCON `servermsg` and waits; it applies one only when the server is empty. If PZ
  is already stopped it just seeds the files so the next start is clean.
  - **Two cadences, one timer.** A fixed `setInterval` at 15 s
    (`PZ_UPDATE_PENDING_POLL_MS`) always fires; a `running` guard declines to
    overlap, and a due-time check skips the expensive Steam call unless an update
    is already pending or `PZ_UPDATE_POLL_MS` (5 min) has elapsed. So detection
    costs one batched request every 5 min, but once something *is* pending it
    notices the server emptying within 15 s. On a single 5-min cadence, logging off
    meant waiting out the rest of a poll before the restart even began, which reads
    to players as the server being stuck rather than updating.
  - **Never re-arm the loop from a `finally` block.** It was briefly
    self-scheduling (`setTimeout` at the end of each tick) to get the adaptive
    cadence, and that made a single hung call **permanently fatal**: if the body
    never settles, `finally` never runs, no timer is armed, and the watcher is dead
    with no error and no log line. That is not theoretical — see
    [Corrections](#corrections) #6. A plain interval keeps firing regardless.
  - **Every outbound call must be timeboxed.** Node's `fetch` has **no default
    timeout**, so `publishedVersions()` carries an explicit
    `AbortSignal.timeout(15_000)`. RCON and the SteamCMD `execAsync` already had
    bounds; the Steam call did not, and it is the one that hung.
  - **`applyingSince` / `applyingTitles` are written BEFORE the stop begins.** This
    said they were "cleared on every exit path including failure" and that was wrong:
    the `none` and `seeded` paths omitted `applyingSince` from `next`, and
    `{...state, ...next}` re-persisted whatever was there — so after any crash
    mid-apply the card read "Updating now… Started 3 days ago" **permanently**, with
    `disabled={checking || !!applying}` on the one control that could have cleared it.
    Fixed 2026-09-28; `readWatchState` also discards a marker that predates the current
    process, since an apply cannot survive a restart. Without them the state machine
    went pending → [silence] → applied, so the mods card still read "restarts once
    everyone has logged off" while the server was already being restarted. The
    watcher also logs when an apply *starts*, not only when it finishes — the
    `running` guard correctly suppresses other ticks meanwhile, so that line is the
    only signal that exists. **`OperationLedger` covers the same window globally** —
    `src/components/operation-ledger.tsx`, mounted in `src/app/home/layout.tsx` and
    `src/components/dash-shell.tsx`. This said `OperationBanner`, which no longer
    exists: the only hit left in `src/` is a comment in `operations-provider.tsx`
    recording that it is gone, so grepping for it reads as "there is no global progress
    surface" and invites adding a second one beside the ledger.
  - **The apply is silent for ~6 minutes, and that got misread as broken.** A real
    apply on 2026-09-14 ran 20:42:22 → 20:48:10: a graceful stop, a 137 MB
    download, then a full boot. The watcher logs only *after* it finishes, so the
    log went quiet and it looked like nothing was happening — the operator clicked
    "Check now", which then collided with the apply already in flight (see the lock
    bug below). Progress is now reported as the operation's steps, and these are the
    strings the code actually emits, so they are greppable:
    **`Saving Project Zomboid`** → **`Downloading mods from Steam`** →
    **`Starting Project Zomboid`** (`op.step` in `game-manager.ts`'s `narratedStop` /
    `narratedStart`, and `downloadStep` in `zomboid-updates.ts`; the world's name comes
    from `GAMES[game].name`). `/api/games/status` still exposes the current one as
    `busy.stage`. The three quoted here before — "Saving and stopping the server",
    "Downloading updated mods", "Starting the server" — appear nowhere in the repo.
  - **Boot progress.** `GameStatus.boot` (`{stage, percent}`) is filled while
    `status === "starting"`, from one `docker logs | awk` pass over the container
    log. Mod loading dominates the wait, and every mod logs `> loading <id>`, so
    the percentage is `loaded / len(Mods=)` mapped onto 15–90%. Note the count can
    **exceed** `Mods=` (dependency mods load too — 89 loading lines against 87
    entries), so it is clamped.
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
  - **Both branches run inside the operation registry**, not just the control lock, so
    they cannot interleave with a restart from the UI and a refusal is reported as a
    refusal. Each enters `runOperation({kind: "mods.update", game: "zomboid", …})`; the
    restart branch goes through `withGameStopped()`, and the **stopped-server seed branch
    claims `POWER_RESOURCES`, not merely `files:zomboid`** — the harmful case is a
    `powerOn("zomboid")` booting the game onto a half-written workshop volume, and the
    world is already down so nothing is being held hostage that could not wait. An
    `OperationConflictError` is deliberately **not** recorded as `lastError` and does
    **not** start a cooldown: nothing was attempted, so the next tick must be free to
    try, and putting "Project Zomboid is busy" on the card would read as the watcher
    having broken. If you add any long PZ operation, wrap it in `runOperation` — see
    [`OPERATIONS.md`](OPERATIONS.md).
  - **Four knobs, and there are two failure cooldowns rather than one.**
    `APPLY_RETRY_COOLDOWN_MS` **1 h** guards the restart-the-world path (a failed apply
    spent the world's uptime); `SEED_RETRY_COOLDOWN_MS` **15 min** guards the
    stopped-server path (CPU and Steam bandwidth, nobody waiting, so four runs an hour
    instead of twelve). `REANNOUNCE_MS` **30 min** re-announces a pending update so
    latecomers see the warning; `APPLY_MAX_MS` **1 h** is the ceiling past which an
    `applyingSince` marker is treated as stale. The seed branch — the *normal* one — had
    no cooldown and no `try/catch` at all at first, so one undownloadable item launched a
    SteamCMD container every poll interval forever. The 1 h cooldown then spent a while
    not working at all; see [Corrections](#corrections).
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
  **Run `scripts/pz-stale-mods.py` to find the culprit**, over stdin so nothing has to
  be installed on the box:

  ```bash
  ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 'python3 -' < scripts/pz-stale-mods.py
  ```

  Then `validate`-download the id it names and restart. A normal restart with nothing
  updated downloads nothing.
  - **Do not hand-roll the check, and in particular do not compare file mtimes.** This
    bullet used to tell you to diff each `WorkshopItems` id's Steam `time_updated`
    against the newest mtime under `pz-workshop/_data/content/108600/<id>/`; it did
    pinpoint Authentic Z (`2335368829`) in about a minute on 2026-09-14, which is why it
    was written down. But the app deliberately compares Steam's manifest and **not**
    mtimes (see "It compares Steam's manifest, not file mtimes" above), the script
    encodes the two-`timeupdated`-sections trap described with it, and the documented
    failure mode of getting it wrong is the detector answering **"nothing to do" on a
    server that genuinely has a stale mod** — [Correction #5](#corrections), the bug
    agreeing with itself. A wrong answer here is indistinguishable from a healthy server.

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
  `media/maps` at any depth and dedupes by map name.
  **Measured before/after:** distinct maps registering cells went from **2 → 16**,
  and `Map=` from 3 entries to 22.
  I previously recorded the opposite in this file — that PZ itself prunes add-on
  maps and that this was correct behaviour. That was wrong; the pruning was the
  image's sed, and the maps genuinely were not loading.
  - **The script reads the existing `Map=` first and emits those names in that order**,
    appending only newly-found maps by cell count (bigger first, so a 22-cell base does
    not lose a shared cell to a 4-cell checkpoint). Added 2026-09-29 (`b580852`), and it
    is the load-bearing half: because entry.sh's `sed` is unconditional, **whatever this
    script emits IS the load order**, so before that change an order saved by a human or
    by `/api/zomboid/maps` "survived exactly zero restarts" while the dashboard's toast
    told the user to restart to apply it. Verified by writing a reorder to the .ini and
    finding `Map=` back to the script's output byte for byte after one boot. **If you
    rewrite or "simplify" this script, keep the saved-order read** — dropping it silently
    restores that bug, and the UI will keep reporting success.
  - It also **skips mods whose own `mod.info` `name=` contains DEPRECATED** (including a
    retired map still shipped inside a live mod), honours `MAP_EXCLUDE` from compose, and
    **strips `\r`** — the live .ini is LF today, but `/api/zomboid/config/import` writes
    an uploaded file verbatim, so a CRLF .ini from a Windows server would make the last
    entry `"Muldraugh, KY\r"`, matching neither the skip nor any installed map.
  - **The boot log is the oracle, and the string is `map(s)`:**
    `docker logs yoshling-pz | grep "map(s)"` → `Found N map(s): K kept in the saved
    order, A newly found`. This said `grep "INFO: Added maps"`, which appears nowhere in
    this repo, so the first diagnostic step returned nothing.
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
- **One Workshop item can ship many maps, and every one of them needs its own `Map=`
  entry** — a cell-less spawn or basement definition included, which is why
  `search_folder.sh` keys on the map name existing rather than on its cell count.
  SecretZ Pandemic is the example: production's `Map=` carries **16** `SZ_`-prefixed
  entries out of its 22, so one Workshop item owns three quarters of the load order. Its
  own maps also overlap each other (`SZ_Checkpoint6`/`SZ_Riverside_Checkpoint_2`,
  `SZ_Checkpoint5`/`SZ_MuldraughCrossroads_Checkpoint`), so the order **within** a single
  mod matters too.
  - The 16 is counted from `tests/fixtures/pz-server.ini`, the verbatim production .ini
    taken 2026-09-29 (22 `Map=` entries: `map_distanciado`, 16 × `SZ_*`,
    `FoxtrotWarehouse`, `AZSpawn`, `ArmyGroup_Spawn`, `DeltaForce_Team_Spawn`,
    `Muldraugh, KY`). Re-measured 2026-10-06 and still 22.
  - **How many map folders the mod actually ships is unverified since 2026-09-14**, and
    the figure that was here cannot be reconciled with the 16. Settle it by listing the
    folders rather than trusting either number, then diff that list against the `SZ_*`
    entries in `Map=`:

    ```bash
    ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 \
      'docker exec yoshling-web-1 find /zomboid-workshop/content/108600 \
         -maxdepth 8 -type d -path "*/media/maps/*"' \
      | grep -i secretz | sed 's#.*/maps/##' | cut -d/ -f1 | sort -u
    ```

    Do **not** "restore" names to `Map=` from a folder count: the generator only emits
    names it finds under the workshop mount, so a name that is not there is dropped on
    the next boot and the generator looks broken.
    - > This said "**20** map folders (16 with cells, 4 cell-less spawn/basement
      > definitions)", with "every one of them needs a `Map=` entry". Only one absence is
      > accounted for (`SZ_Checkpoint6`, via `MAP_EXCLUDE`), which leaves three
      > unexplained: either three SecretZ maps are silently inert in the live world, or
      > the 20/16 split is wrong. "16 with cells" is also the same number as two
      > unrelated whole-server measurements ("distinct maps registering cells went from
      > 2 → 16"; Status's "16 register cells"), which is what a conflation looks like.
- **A big map/tile collection costs off-heap RSS, not just heap — see
  [Memory](#memory).** This bullet used to hold a *second* copy of the 2026-09-13
  Hetzner measurement, 190 lines from the first, ending in "Change it on the Settings
  page (see "Server memory")" — a heading that exists only in CLAUDE.md, so the one
  pointer to the real numbers dead-ended.
- **Dependency resolution needs `STEAM_API_KEY`.** The keyless Workshop endpoint
  returns no dependency data at all; `IPublishedFileService/GetDetails` with a key
  adds `children`, which is the Workshop's "Required items" list. Adding a mod
  pulls its required items in and puts them **before** it in both lists, since PZ
  loads `Mods=` in order and a library must precede its consumer. Without a key it
  falls back and behaves as before.
- **Map mods need a THIRD list, `Map=`, and the app owns it: the Maps card on the Mods
  page.** A map mod that is in `WorkshopItems` and `Mods` still shows nothing in-game
  until its map name is in `Map=`, where the **first** entry wins any cell two maps both
  claim. `GET /api/zomboid/maps` returns every installed map with its cell count, its
  position in `Map=` and every cell conflict; `POST` writes the order, via
  `writeMapOrder()` in `src/lib/zomboid-maps.ts`.
  - **Write it through that route and nothing else.** `Map` is in `CARD_OWNED_KEYS`
    (`src/lib/zomboid-ini-contract.ts`), so the generic "All settings" editor refuses it
    by name and says which card owns it. That refusal is not tidiness: `search_folder.sh`
    regenerates the line on every boot and drops any name it cannot find on disk, so a
    name typed into "All settings" would be written, reported saved, told to restart, and
    deleted by that restart — and a name *removed* there would come straight back. The
    Maps card is the only view that knows which names survive.
  - > This bullet said "a THIRD list the mod manager does not own yet" and that the add
    > route "doesn't edit `Map=`" until 2026-10-06, 195 lines above a Status section
    > already listing the maps card as verified working. Believable because it was true
    > when written and the card arrived without the bullet being revisited; harmful
    > because the two actions it invites are building a card that exists, or writing
    > `Map=` through `/api/zomboid/config`, which is the one key that route is locked
    > against for a reason.
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
  - **`readModState` / `writeModState` rewrite both lines wholesale**, so the structure
    of those lines is a contract. What is measured: in `tests/fixtures/pz-server.ini`
    each is **one single line** — `Mods=` 1,518 bytes / 87 entries, `WorkshopItems=`
    824 bytes / 75 — `;`-separated, no trailing separator, no duplicates, and order in
    `Mods=` **does** matter because PZ loads it in order and a library must precede its
    consumer. `splitList()` trims and drops empties, and `modIdPrefix()` mirrors the
    file's existing backslash convention rather than imposing one.
  - **What nobody here has measured**, and it is worth knowing you are guessing: the
    maximum line length PZ tolerates (87 entries work; nothing establishes a ceiling),
    whether order in `WorkshopItems=` matters at all, and what the game does with a
    `Mods=` entry whose Workshop item has been removed. Pinned behaviour for the parser
    and writer is in `tests/zomboid-ini.test.ts`, which runs against that real .ini —
    extend it rather than reasoning about the format from this paragraph.

## Settings, backups, firewall

- **Settings:** `/api/zomboid/config` exposes the whole .ini generically (the `#`
  comment above each key becomes its help text). Quick settings (name/password/max
  players/public/PVP/pause-when-empty) write to the same endpoint, so there's no second
  copy to drift. Sandbox options are Lua, not .ini, and have **their own editor** — see
  [Sandbox options](#sandbox-options), not the file browser.
- **What that route is allowed to write, and what it may *claim* afterwards, is
  `src/lib/zomboid-ini-contract.ts`** — a module this doc did not name until 2026-10-06,
  and the one to read before touching any PZ settings surface. Added 2026-10-01
  (`4c131bd`, `ff0f0d0`), pure and therefore tested without a server:
  `src/lib/__tests__/zomboid-ini-contract.test.ts` and `tests/zomboid-ini.test.ts`.
  - **A .ini write is applied *live* for ~136 of the 144 keys. Do not tell anyone to
    restart.** `RESTART_KEYS` is the only eight a running server cannot pick up:
    `Mods`, `WorkshopItems`, `Map` (read once while the world loads), `DefaultPort`,
    `UDPPort`, `RCONPort` (sockets bound at startup), and `ResetID` /
    `ServerPlayerID` (the soft-reset handshake, compared at connect). Measured against
    the live server 2026-10-01. The UI used to say "Restart Project Zomboid to apply"
    for every key, so a `MaxPlayers` change kicked everyone off the daily-played world
    for nothing.
  - **`reloadLiveOptions()` in `src/lib/zomboid.ts` proves it rather than assuming.** It
    sends `reloadoptions`, re-reads with `pzConsoleLong("showoptions")` — the draining
    reader, because a truncated reply would report the first 79 keys as checked and leave
    the rest unverifiable — and buckets every key as **verified** / **unverified** /
    **stale**. "Absent from `showoptions`" means *unverifiable*, never *rejected*: the
    game withholds seven of the 144 (`Password`, `RCONPassword`, `RCONPort`,
    `DiscordToken`, the three `Discord*Channel`) and masks `BadWordReplacement`.
    `describeIniSave()` builds the sentence the UI says from what the route actually did,
    and the suite asserts that the word "live" can appear only when something was
    verified live.
  - **Two defects already fixed here, both the house class.** An unmatched key used to be
    **appended** to the file and listed in `applied`, so `PUT {"Maxplayerz":"99"}`
    answered `{"applied":["Maxplayerz"]}` and added a line the game ignores — it now
    comes back in `ignored`. And the lock list was compared **case-sensitively**, so
    `rconpassword` slipped past it and was appended as a second, game-ignored copy of the
    control channel's password; `canonicalKeyIndex()` resolves every request to the
    file's own spelling first, which makes every check downstream an exact comparison.
- **The locks are `INFRA_KEYS` *plus* `CARD_OWNED_KEYS`, and `INFRA_KEYS` is four keys.**
  `src/lib/zomboid.ts` → `["RCONPassword", "RCONPort", "DefaultPort", "UDPPort"]`: this
  deployment's own settings, which stay local on an import so control and connectivity
  survive it. `CARD_OWNED_KEYS` is `{Map, Mods, WorkshopItems}` — the keys another page
  owns, each mapped to the name of its owner so the refusal says where to go instead of
  "not editable". `/api/zomboid/config` locks the union.
  - > **This listed six `INFRA_KEYS`, ending in `SteamPort1`/`SteamPort2`.** They were
    > removed deliberately on 2026-10-01 because **Build 42 has no such server options**:
    > the live .ini's 144 keys contain neither, and `showoptions` does not report them.
    > The Steam query ports are published by docker-compose (`8766-8767/udp`) and are not
    > in the .ini at all. So two of the six locked and preserved nothing, and the reason
    > the code records for caring is worth repeating — "a lock list that is a third
    > fiction invites trusting the rest of it", and this list is also what the import
    > route promises to carry across. "Restoring" the two entries reinstates dead code;
    > leaving `Map` out of the lock list re-exposes the one key whose write through this
    > route *cannot work at all*.
- **Config import** (`/api/zomboid/config/import`, the card on the Settings page):
  upload an existing server's `.ini` to move a server you already ran. It
  replaces the file wholesale — settings *and* both mod lists, which is usually
  the point — but **puts this box's `INFRA_KEYS` back**, so an imported config can't take
  the app's control channel or point the server at unpublished ports. POST without
  `apply` returns a preview (what changes / what's added / what's dropped / which
  keys stay local / which mods come across); POST with `apply: true` backs the
  current file up to `<name>.ini.bak-<stamp>` and writes. An import whose
  `Mods=` names ids that no Workshop item provides shows up in the Mods page's
  "Loaded without a Workshop item" list — that's the intended catch. It writes the
  uploaded bytes verbatim, which is why `search_folder.sh` strips `\r`.
- **Backups** bundle `Saves/Multiplayer/<name>` + `db/<name>.db` + `Server/<name>*`
  + a `manifest.json`, so one restore rebuilds the world, the accounts and the
  settings together. **PZ's is the slow and dangerous one of the three**, and that shape
  is the part to carry (`src/lib/backup-create.ts`, `createZomboid`):
  - **It takes about eleven minutes, and that is not a hang.** Measured on production
    2026-09-29: **442,064 files, 1.9 GB, ~11 minutes**, of which the world copy was ~10.5.
    The `tar` alone was **261,370 ms** on 2026-09-30.
  - **There is deliberately no wall-clock cap on the archive step** (`TAR_TIMEOUT_MS` is
    `undefined`). It was 300 s, i.e. 13 % away from breaking PZ's backups for good, and
    the first *automatic* run had already failed on it. A timeout cannot make a slow
    archive faster; it can only turn "slow" into "no restore point". **Do not reintroduce
    one** — a genuinely stuck tar is visible through `runOperation`'s narration and the
    ledger's elapsed time instead.
  - **It calls `refuseIfPreemptedEarly` at every step boundary**, not just before the
    tar. On 2026-09-29 `op.preempted` was set 94 s into a 9m 43s backup and the only
    check ran last, so the app spent a further **7m 55s** copying 291 MiB it had already
    decided to discard, competing for disk with the power operation that condemned it,
    and then handed the user an error.
  - **With no world on disk it throws rather than writing a world-less 4 MB archive.** It
    used to settle that as a `noop` and carry on, which concluded `partial` → journal
    `outcome: "ok"` → scheduler cooldown cleared, *and* the archive took the
    never-pruned newest slot: simulated against the real `selectForPruning`, five real
    archives plus one world-less newest at `keep: 5` selected a genuine restore point for
    deletion. Repeat daily and every real archive is gone, each step logged a success.
    The reachable trigger is `serverName()` resolving to the wrong `.ini` — see
    [How it runs](#how-it-runs).
  - **Automatic backups exist for PZ.** `src/lib/backup-schedule.ts`, driven by a
    5-minute *check* clock in `src/instrumentation.ts` (the check is a `readdir`; it only
    probes the game once the clock says one is due). Default one per world per day,
    **refused while any player is connected** — and refused when the player count cannot
    be read, because that is not a green light. Retention is `BACKUP_KEEP_ZOMBOID`,
    falling back to `BACKUP_KEEP`, default `keep: 5`.
- **Firewall: `ufw` does not gate these ports, and there is no cloud firewall.**
  docker-compose publishes `16261/udp`, `16262/udp`, `8766/udp` and `8767/udp` on all
  interfaces, and **every `ports:` entry is world-reachable regardless of ufw**: Docker
  publishes with a DNAT rule and the `FORWARD` chain reaches Docker's own chains before
  any ufw chain, so that traffic never passes through `INPUT` at all. `DOCKER-USER` is
  the only place a rule can intercept it. It was **empty** when measured 2026-09-28 — from
  outside, `curl http://89.58.50.155:3000/login` returned 200 in cleartext and 7DTD's telnet
  on 8081 accepted a public connection. **It is not empty now:** re-measured 2026-10-06 it
  carries DROP rules for **8081, 8080 and 3000**, installed by a `yoshling-firewall` systemd
  unit whose file is not in this repo. Those are three specific ports, not a default-deny —
  **PZ's four UDP ports are still open to the internet by design**, because players connect
  to them directly.
  So: publish to `127.0.0.1:` when only the host needs a port, and put DROP rules in
  `DOCKER-USER`, never in ufw.
  - > This said the ports "must be open in BOTH the box's `ufw` and the Hetzner Cloud
    > Firewall". Both halves are wrong. The box has been **netcup** since 2026-09-13 and
    > netcup has no cloud-firewall product, so there is no console to open anything in —
    > and a clean `ufw status` says nothing about whether these ports are reachable. It
    > was believable because it was correct on Hetzner, where two layers really did both
    > have to be opened and missing either produced "connect hangs, nothing in logs".
    > The fix landed in CLAUDE.md and `docs/AUDIT-2026-09-28.md` and missed this file.

## Sandbox options

Sandbox settings are Lua, not `.ini`: `Server/<name>_SandboxVars.lua`. They are
read at **world load**, so a change needs a server restart.

**There is a sandbox editor on the Settings page — do not send anybody to the file browser.**
Shipped 2026-10-01: `/api/zomboid/sandbox` + `src/components/zomboid-sandbox.tsx`, backed by
`src/lib/sandbox-lua.ts` and `src/lib/zomboid-sandbox.ts`. It parses the live **742** options,
groups them, refuses the ones that cannot take effect (`PRESET_ONLY` — `Zombies`,
`ZombieRespawn`, `ZombieMigrate` — plus `CREATION_ONLY` and the version key), and reads every
write back. The writer is the concentrated data-loss risk in this app and carries four guards
for it; see [`SETTINGS.md`](SETTINGS.md) for them and for the live verification.

> This section told the reader to hand-edit the Lua in the file browser for five days after
> the editor shipped — a 74,711-byte, 1,803-line file, by hand, on the one world people
> actually play. The file browser still *can* edit it (`lua` was added to the editable
> allowlist on 2026-09-14), which is the fallback, not the route.

**742 is the file's total; a single API response is not.** Of the 742, **403 were added by
mods** (`BurdJournals` alone contributes 182), so the endpoint partitions on the Lua table
an option lives in: `?scope=world` is the top level plus the five vanilla tables (~335
options), `?scope=mods` is every other table, and nothing is dropped by the split. Counting
one response and calling it the file is how "335 options" gets written down. The writer's
backstop against a partial read, `MIN_PLAUSIBLE_OPTIONS`, is **200** — a 27 % floor, set low
on purpose so a build that adds or removes options does not start refusing every save, with
the delimiter checks as the primary guard. `src/lib/__tests__/sandbox-lua.test.ts` asserts a
real-shaped truncation is refused at that default.

- **Muscle strain** is `MuscleStrainFactor` (min 0.00, max 10.00, default 0.70) —
  "a multiplier when applying muscle strain from swinging weapons or carrying
  heavy loads". It is the only vanilla strain knob; there is **no** option for
  recovery rate. Weak shoves are a *consequence* of accumulated strain, not a
  separate setting, so this one value covers both complaints. `0.0` disables the
  mechanic, which makes melee strictly better than guns in every situation.
  - The min/max/default are the file's own `Min: 0.00 Max: 10.00 Default: 0.70` comment,
    not an inference, and that line is committed as
    `src/lib/__tests__/fixtures/pz-sandboxvars.lua:123` — a verbatim 38-option excerpt of
    the production file, so it is checkable without the box. The excerpt is a snapshot
    (taken with the editor, 2026-10-01); for the live value, read it off the box or the
    sandbox editor rather than from here.
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
  and PZ writes the value into the `.ini` itself, which is what makes the file the proof
  that it stuck. It did: `tests/fixtures/pz-server.ini` (the production file, 2026-09-29)
  carries `AntiCheatSpeed=4`, `AntiCheatNoClip=4`, `AntiCheatPacketException=4` and
  `AntiCheatHit=4`, against `=2` for the other six `AntiCheat*` keys. Snapshot, not live —
  re-read the file if it matters.
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

## When the server hangs

**The server can be "running" and completely unjoinable.** This happened 2026-09-22 and cost
an evening, so the symptoms and the proof are worth keeping. **The dashboard now tells you
so** — that half was fixed on 2026-09-27 and this section described the old behaviour for
nine days.

What it looks like:

- Players get "we crashed and now we can't rejoin — the server thinks we're still
  in". The PZ log fills with `Steam client <id> is initiating a connection.`
  repeated, with **no** following `Connected new client`.
- The dashboard shows **"Not responding"** and names **Restart** as the way out. That is the
  recovery route; use it.
  - > It used to show the world as **powered down** and offer **Power on**, which runs
    > `docker start` on an already-running container — a no-op that toasts success and
    > changes nothing, leaving no route out of the UI. Fixed 2026-09-27 (`a7d76b8`):
    > `GameStatus` carries `containerRunning` and `startedAtMs` separately from `status`, the
    > UI derives *Stopped* / *Starting…* / *Not responding* (unreachable for >12 min), and
    > **Restart is gated on `containerRunning`, not on `isOnline`** — that inversion is the
    > whole fix. The "KNOWN BUG note in CLAUDE.md" this bullet pointed at no longer exists.
- RCON **authenticates but `players` returns an empty body.** That is the tell:
  the RCON thread is healthy, but the answer needs the game loop, which is not
  running. `scripts/pz-rcon.sh players` printing `(no output)` means hung, not idle
  — an idle server answers `Players connected (0):`.

### Proving it rather than guessing

Two cheap checks, in order:

1. **Is the game loop advancing?** Every in-game log line carries a frame counter
   (`f:29843`). Sample it twice ~25s apart; if it is identical while CPU is pinned,
   the loop is wedged. Caveat: an **idle** server with nobody connected emits no
   frame-stamped lines at all, so a frozen-looking counter on an empty server is
   meaningless — cross-check with CPU (a wedge burns ~100% of one core; healthy
   idle was 5.9%).
2. **Get a JVM thread dump.** `pgrep`/`jstack` do not exist in the image, so do it
   from the host: `kill -3 $(ps -eo pid,comm | grep ProjectZomboid | awk '{print $1}')`.
   SIGQUIT makes HotSpot dump all threads to stdout and **keeps running**, so it is
   safe on a live server. Read it back out of `docker logs`. `top -H -p <pid>`
   names the thread actually burning CPU.

### The one we found

Thread `UdpEngine`, RUNNABLE, spinning with no deadlock reported:

```
zombie.iso.IsoGridSquare.removeGlassAttachments(IsoGridSquare.java:8345)
zombie.iso.IsoGridSquare.RemoveTileObject(IsoGridSquare.java:6159)
zombie.iso.IsoObjectUtils.getAllMultiTileObjects(IsoObjectUtils.java:153)
zombie.iso.IsoObjectUtils.safelyRemoveTileObjectFromSquare(IsoObjectUtils.java:60)
```

An infinite loop in **vanilla** tile-removal code, triggered by removing a
multi-tile object with glass attachments (a window). The reason it locks everyone
out is that `UdpEngine` is also the thread that accepts connections — so one bad
tile removal takes the whole server's networking with it. Dump kept at
`/root/pz-threaddump-20260922-212623.txt`. If it recurs, compare stacks before
assuming a mod: this one is `zombie.iso.*`, not mod Lua.

### Recovery

A graceful stop **cannot work** — the save runs on the wedged loop, so
`docker stop -t 300` just waits out the full five minutes and then SIGKILLs. Use a
short timeout (60s was enough to confirm it wouldn't save) and accept losing
progress since the last autosave. There is no better option once the loop is gone.

### Exit 137 and a five-minute stop are now a *symptom*, not the normal case

**Budget ~12 seconds for a PZ stop, exit code 0.** Measured through the dashboard on
production 2026-09-29: request → container exited in **11.4 s**, and **9.0 s** end to
end on the driver path, with `failed to exit within 5m0s of signal 15` going from 14
events in three days to 0. The mechanism is in [How it runs](#how-it-runs) — the driver
asks the game to `quit` over RCON.

So if you see a stop take five minutes and end in **137**, that means **the RCON `quit`
did not land**: the fallback `docker stop -t 300` ran, SIGTERM was discarded as it always
is, and the kernel killed it. That is the wedged-server case (see
[When the server hangs](#when-the-server-hangs)) and it is worth escalating, not waiting
out. The one reassurance from the old behaviour still holds: both historical 137s
(2026-09-22, and 2026-09-26 during a hand-off to 7DTD) had `Saving finish` /
`Saving took …ms` as their last written lines, so the explicit save had completed and
**no data was lost** — check for those lines before assuming the worst.

> This section was headed "the graceful stop has hung twice on the way down" and ended
> "expect a hand-off away from PZ to take up to five minutes", 130 lines above the block
> that measures 11.4 s. True as history, wrong by 25× as an expectation, and the damage
> is in both directions: a timeout or a UI string sized off five minutes, and — worse —
> an actual five-minute 137 read as the documented normal case rather than as the one
> signal that RCON has stopped answering.

## Known mod defects

Moved. The full inventory — every broken mod with a verdict, the two unmet
dependencies, both NullPointerException analyses, the verified-harmless list, and
whether we can patch mods ourselves — lives in
**[`PZ-MOD-BACKLOG.md`](PZ-MOD-BACKLOG.md)**, because it is a backlog to work
through rather than reference material.

Two things worth knowing without opening it:

- The server is **healthy**: no OOM, zero GC stalls, 87/87 `Mods=` entries load,
  `RestartCount=0`, and no error class is growing. ~19,000 lines/boot are verified
  vanilla or cosmetic noise.
- **Not one finding is a player complaint.** Before investigating a log error,
  check the backlog's "Verified harmless — do not chase these" list; most of the
  boot log is already accounted for there.


## Status

**Live on netcup `89.58.50.155`** (8 vCPU / 16 GB / Debian 13). Migrated off
Hetzner 2026-09-13 — see MIGRATION.md.

Working and verified in production:

- **87** mods load from **75** Workshop items, across **22** maps — re-measured off the live
  `.ini` on 2026-10-06 (`Mods=` 87 non-empty ids, `WorkshopItems=` 75, `Map=` 22). This said
  **89** mods, which was true when written; a mod list that people edit is not a constant, so
  **re-measure rather than quoting this number**:
  `grep -oE '^Mods=.*' /zomboid/Server/yoshling.ini | tr ';' '\n' | sed '/^$/d' | wc -l`.
  The Workshop count has not moved, which is the expected shape — one Workshop item can carry
  several mod ids.
- `SERVER STARTED`, RCON on 27015, 16261/udp reachable, 0 failed downloads,
  `OOMKilled=false`.
- Power on/off/restart, console, file browser (Config/Saves/All data), backups,
  settings, config import, the mods page, and the maps card.
- `Map=` carries all 22 maps and **16 register cells** (was 2 before the scanner
  fix).
- The Workshop update watcher: detection, in-game announcement while players are
  connected, and the automatic restart-when-empty — all three exercised for real, and
  now **observed running completely unattended in production.** 2026-10-01 18:10 CEST it
  found `[B42] I Don't Need A Lighter` had updated, saw the server empty, and restarted
  to apply it with nobody watching. The evidence is a one-second correlation: the
  container's `StartedAt` is `16:10:30Z` and the watcher's own `appliedAt` is
  `16:10:31Z`, with `[pz-updates] applying (server restart): [B42] I Don't Need A
  Lighter` in the web log.
  - **Five days on it has applied three, and that is the result worth having.** The web log
    shows `applying (server restart):` for `[B42] I Don't Need A Lighter`, `W900 Semi-Truck
    [B42]` and `Mini Health Panel`; the most recent restarted PZ at `2026-10-05T19:51:34Z`
    against an `appliedAt` of `19:51:34.962Z` — the same one-second correlation, three times,
    unprompted. Checked 2026-10-06: `lastError: ""`, `pendingIds: []`, last poll three minutes
    earlier. One restart per update and no flap, which is what the unbounded-retry fix below
    was for.
- 12 GB heap; peak RSS 9.7 GB of 16 GB.

Players connect to **`pz.yoshling.xyz:16261`** or the raw `89.58.50.155:16261`. The `pz`
A record exists (DNS-only / grey-cloud → the box, correctly bypassing Cloudflare, which
carries only HTTP), as do `mc` and `7dtd`; resolved 2026-10-02.

Outstanding — everything here is genuinely open:

- The mod defects in [Known mod defects](#known-mod-defects) that are tagged for
  removal — none applied yet; they want one batched restart.
- `MuscleStrainFactor` is still at the vanilla `0.7`; a player has asked for it to
  be lowered. (Last read 2026-10-01 from the sandbox excerpt in
  `src/lib/__tests__/fixtures/pz-sandboxvars.lua`, so "still" is unverified since then.)
- The `x_extends` lowercase log spam could be silenced with lowercase symlinks
  (5 mods, 565 lines/run). Cosmetic, never done.

> **The `pz.yoshling.xyz` record was the first item on this list while it already
> existed.** It had been struck through in place and annotated "it does" rather than
> removed, which is the shape CLAUDE.md's documentation rules single out — a migration
> headed "Pending" 200 lines above a Status section saying it was applied. A list whose
> first entry is done is a list people stop reading, so the fact moved up into the
> paragraph above and the entry is gone.

## What is measured, and what is not

`PZ-MOD-BACKLOG.md` has had a "What is NOT verified" section since it was written and this
file has not, which means it mixes numbers taken off the box with numbers somebody reasoned
to, in the same voice. For a reader with no memory of how any of it came to be, that is the
difference between a fact and a plausible sentence. The rule going forward: **say how a
number was established and when, beside the number.** Where that is missing, assume
inferred.

Measured, with the measurement named above: the 144 .ini keys and the 742 sandbox options;
87 / 75 / 22 for `Mods=` / `WorkshopItems=` / `Map=`; the 9.0 s and 11.4 s stops and the
433 ms save; the 2 → 16 jump in maps registering cells; `442,064` files and `261,370 ms` of
tar in a PZ backup; eight restart-only keys out of 144; three unattended Workshop applies.

Inferred, or measured once long ago and never since — treat each as a claim, not a fact:

- **SecretZ's "20 map folders (16 with cells, 4 cell-less)"** — cannot be reconciled with
  the 16 entries in `Map=`. The command to settle it is beside the claim.
- **`~9 mod updates/week`** — one week's observation, 2026-09-14, across what was then a
  75-mod list. It is the whole argument for polling rather than a nightly restart, so it
  is worth re-counting from `appliedAt` history if that argument is ever reopened.
- **`/root/seed-mods.sh`** — unverified since 2026-09-14; nothing in git references it.
- **Everything in `PZ-MOD-BACKLOG.md`** — bytecode- and log-derived, never tested
  empirically. That file says so; this one should not launder it by citing it plainly.
- **The `.ini` line-format limits** — what PZ tolerates in `Mods=` is not established
  beyond "87 entries on one line works".

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
6. **The watcher died silently for six minutes, and the fix that caused it was one
   day old.** 2026-09-15: the last player disconnected at 14:03:54; the watcher's
   last tick was 14:03:49 — five seconds earlier — and then nothing at all until
   14:10:01. It had not mis-read the player count; it had stopped running.
   Yesterday's adaptive-cadence change re-armed the timer from a `finally` block, so
   one call that never settles kills the loop permanently, with no error and no log
   line. The un-timeboxed Steam `fetch` was the thing that hung.
   Three lessons worth keeping:
   - **A "responsiveness" refactor can quietly remove a safety property.**
     `setInterval` was immune to hangs; self-scheduling isn't. Nothing in the diff
     looked like it touched reliability.
   - **Diagnose from the tick log's *gaps*, not its contents.** Every line said
     `announced`, which looks like healthy disagreement about the player count. The
     signal was the 6m12s with no lines at all.
   - **Don't trust a hand-rolled RCON probe.** Mine printed responses off by one
     (the auth reply is read as the first command's answer), and I briefly concluded
     from it that a player was still connected — then said so. Send the command
     twice and read the second reply, or use the app's own client.

### `stop_grace_period: 300s` is not protecting a slow save (found 2026-09-28)

**What we believed:** the entrypoint saves the world on SIGTERM, and a 76-mod save
overran 120s once, so Docker SIGKILLed it mid-save — hence 300s.

**What is actually true:** the save is fast and the process never exits. Measured
twice, stopping with `docker stop -t 300` after an RCON `save`:

```
LOG  : General   f:0 st:...> Saving finish
LOG  : General   f:0 st:...> Saving took 433.556991 ms
...
real  5m1.012s        ExitCode=137   OOMKilled=false
```

Minecraft, for contrast, stops in **0.719s with exit 0**. So PZ saves promptly and then
sits until the timeout expires and Docker kills it. Two consequences:

- ~~Every PZ stop costs the full five minutes and ends in SIGKILL.~~ **FIXED
  2026-09-29 — see the follow-up below.** It was true, and raising the timeout from 120s
  to 300s made every stop slower without making a single one cleaner.
- **The old explanation was measuring the wrong thing.** A save that takes 433 ms was
  never the reason for the SIGKILL at 120s; the failure to exit was, and it would have
  SIGKILLed at any timeout.

**Was "not fixed, deliberately" — now FIXED, 2026-09-29.** The note here said lowering
the timeout on the strength of the 433 ms alone would repeat the original mistake in the
other direction, because the save completing is not the same as the process being safe to
kill. That was right, and the timeout was never the answer.

### Why `docker stop` could never work, and what does

`entry.sh` runs as **PID 1** and has no signal handling at all:

```
$ docker exec yoshling-pz sh -c 'grep -c trap /server/scripts/entry.sh'
0
$ docker exec yoshling-pz sh -c 'grep SigCgt /proc/1/status'
SigCgt: 0000000000010002        # SIGINT(2) + SIGCHLD(17) only — no SIGTERM(15)
```

That last line is the whole story, and it is stronger than "the shell does not forward
the signal": **the kernel discards uncaught signals sent to a namespace's PID 1.** So
`docker stop` was not being ignored by a middleman — SIGTERM was never delivered to
anything. No timeout, no `init: true` and no amount of grace period could have fixed it.
`dockerd` recorded the consequence 14 times in the three days before the fix:
`failed to exit within 5m0s of signal 15 — using the force`.

**The fix is to ask the game instead of the kernel.** PZ's own RCON advertises it:

```
$ ./scripts/pz-rcon.sh help
...
* quit : Save and quit the server
```

`zomboidDriver.gracefulStop()` now sends `save`, then `quit`, then waits for the
container to exit, falling back to `docker stop -t 300` only if RCON cannot land — which
is exactly the 2026-09-22 wedge, the one case where `quit` is the thing that cannot work.

**Measured on production through the dashboard, 0 players:**

| | before | after |
|---|---|---|
| request → container exited | 5m 02s | **11.4 s** |
| exit code | 137 (SIGKILL) | **0** |
| ledger outcome | `partial` | **`ok`** |
| `failed to exit` events | 14 in 3 days | **0** |

And the save is genuinely first, not skipped: 20 save files were rewritten, with
`Saves/yoshling/map_t.bin` stamped one second after the request and **ten seconds before
the exit**. A fast stop that lost the world would be far worse than the slow one; this
one saves, then quits.

**Do not lower `PZ_STOP_TIMEOUT` / `stop_grace_period` from 300s.** They are no longer
the normal path — they are the fallback for a server too wedged to answer RCON, and that
is precisely when a long grace period earns its keep.

### The update watcher could restart the server forever (fixed 2026-09-28)

`withGameStopped` gained a `try/finally` so a failed mod download no longer leaves the
world stopped. Correct on its own, and combined with an unbounded retry it was a
restart flap: `seedMods` throws for **permanent** reasons as readily as transient ones —
a Workshop item that was hidden or deleted can never download — so one dead mod would
produce graceful stop → seed → fail → boot the whole mod list → repeat, every poll
interval, forever, on the world people play daily.

Fixed with `applyFailedAt` and a one-hour cooldown. A refusal (`ControlBusyError`, now an
`OperationConflictError`) does **not** start the cooldown, because nothing was attempted;
a success clears it. The mod list is unchanged after a failure, so nothing about an
immediate retry would differ — which is why it is a flat cooldown rather than a backoff.

### …and the cooldown that fixed it did not engage (fixed later, same bug class)

A correction of a correction, which is why it is worth its own entry. `applyFailedAt` was
written by the inner `catch`, but `pollModUpdates` reads the whole state **before** the
poll and its outer `catch` persisted `{ ...state, … }` — so every failure stamp was
reverted a moment later by the handler one frame up. The one-hour cooldown never fired on
a real failure; the restart flap was still live and the fix for it looked done. The lesson
is narrower than "test it": **a function that returns its state changes to a caller that
also persists a pre-call snapshot has two writers, and the outer one always wins.** Fields
that must survive a throw now go through an explicit `stamp` object merged into both exit
paths, with `next` applied last so a success clearing the stamp still wins.

The sibling defect is the same shape: the **stopped-server** branch — the normal one —
had no cooldown and no `try/catch` at all, so it neither recorded a failure nor consulted
one. It now has `SEED_RETRY_COOLDOWN_MS`, 15 min rather than the apply path's hour.
