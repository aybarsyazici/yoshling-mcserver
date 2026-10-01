# 7 Days to Die — the specifics

Split out of `CLAUDE.md` on 2026-09-28, where it was 99 lines that every Minecraft and
Project Zomboid session paid for. Same discipline as
[`PROJECT-ZOMBOID.md`](PROJECT-ZOMBOID.md): **keep this current, and correct what turns
out to be wrong rather than working around it.**

Shared architecture — the container topology, the control lock, per-world access, the
deploy — is in [`../CLAUDE.md`](../CLAUDE.md). This file is only what is specific to
7DTD.

## The one-paragraph version

Control is **telnet on 8081**, which 7DTD only binds if a `TelnetPassword` is set in
`sdtdserver.xml` — **the `TELNET_PASSWORD` env var does not set it.** The service is
`restart: "no"` so it never auto-starts. A **fresh install wipes `sdtdserver.xml` back
to defaults, and a host migration counts as fresh**; the app's `SevenDaysConfig` DB row
survives that and is the recovery source. The live save is `GameWorld=Reveo Valley` +
`GameName=Fresh2`. Client↔server build mismatch is the number one cause of "stuck at
Starting game".

- First boot runs a one-time **SteamCMD install (~17 GB, ~10-20 min)**. The
  `sevendtd` service is `restart: "no"` so it never auto-starts on reboot — the
  web UI powers it on deliberately (and stops MC first).
- **A FRESH 7DTD INSTALL WIPES `sdtdserver.xml` BACK TO DEFAULTS — and a host
  migration counts as fresh.** Hit on 2026-09-26, the first time 7DTD started on
  netcup: SteamCMD re-installed 17.7 GB and regenerated the config, so
  `GameWorld` became `Navezgane`, `GameName` became `MyGame`, `ServerName` became
  "My Game Host", `Region` reverted to `NorthAmericaEast`, `SandboxCode` became a
  default, and `TelnetPassword` was blank. **The server booted a brand-new empty
  world and the dashboard went blind**, minutes before people tried to join.
  - **Recovery source: the app's own `SevenDaysConfig` DB row survives**, because
    it lives in `web-data`, not in the game volume. Read it with the libSQL snippet
    in "Applying DB migrations". **Only four of its columns are real**:
    `serverName`, `password`, `maxPlayers`, `sandboxCode`. This used to list
    `gameDifficulty` and `dayLength` as recoverable too, which was wrong twice over
    — the XML has no such property to restore them into, and nothing has been able
    to *set* them since those controls were deleted, so the row holds a default
    nobody chose (measured 2026-10-01: `2` and `60`). `version` (`latest_experimental`)
    and `maxMemory` (`6G`) are dead the same way: the Steam branch is read from
    compose and 7DTD has no JVM heap. The four are no longer written at all
    (2026-10-01); dropping the columns needs a hand-applied production migration.
  - **Which save is live is decided by two XML values**, and getting them wrong
    silently starts yet another empty world rather than erroring:
    `GameWorld=Reveo Valley` + `GameName=Fresh2`. Identify the right one from disk
    rather than guessing — count `<player ` entries in each
    `Saves/<world>/<name>/players.xml` (Fresh2 had 2, and its world loads at
    416 MiB / 59,651 chunks versus 193 MiB for the empty Navezgane one).
  - `GameDifficulty` is **not** a property in the current XML — don't try to set it.
  - Junk left behind from that incident: `Saves/Navezgane/MyGame` (18 MB, no
    players). Safe to delete.
  - After any fresh install, restore the XML and restart **before** anyone joins;
    doing it afterwards costs them a kick.
- **7DTD telnet password gotcha:** the app controls 7DTD over telnet (8081), but
  7DTD only binds telnet to the network interface (reachable from the web
  container) if a `TelnetPassword` is set in
  `serverfiles/sdtdserver.xml`. The `TELNET_PASSWORD` **env var does NOT set
  it** — you must edit the XML and restart the container. **The telnet password
  had to be set in `sdtdserver.xml` (not the env var), and it is set to match
  `SDTD_TELNET_PASSWORD` in the app's `.env`.** If you change one, change both.
  (Path on the box:
  `/var/lib/docker/volumes/yoshling_sdtd-server/_data/sdtdserver.xml`.)
- **7DTD settings:** the Settings page has a curated "Quick settings" card
  (name/password/players/**Sandbox code**) plus an **"All settings"** expander backed
  by `/api/7dtd/config/all`, which reads *every* `<property>` in `sdtdserver.xml`
  (comment → help text) and writes back changed ones. Telnet/admin keys are locked
  out of that editor. All XML edits need a 7DTD restart to apply. (The card listed
  difficulty, day length and RAM until 2026-09-29; the first two wrote XML properties
  that do not exist and the third had nothing to set.)
- **`ServerPort` and `WebDashboardPort` are pinned by the compose port map** and are
  refused by `/api/7dtd/config/all`, with the reason attached to their help text.
  Editing either used to save cleanly and toast success — and move the listener off
  the only published port, so nobody could connect. `TelnetPort` was already hidden
  for the same reason; these two were not.
- **`WebDashboardEnabled` / `WebDashboardPort` / `WebDashboardUrl` /
  `EnableMapRendering` are inert on this box**, and now say so in their help text
  rather than being hidden. 8080 is published by compose but DROPped at `eth0` in
  `DOCKER-USER` by the `yoshling-firewall` unit (checked 2026-10-01), so the game's
  web dashboard answers only on the box itself; map rendering exists only to feed it.
- **Sandbox code** (`SandboxCode` in `sdtdserver.xml`) is the game's encoded
  difficulty/loot/XP preset from *New Game → Sandbox Options → Copy Code*. It is the
  highest-impact setting, so it is in Quick settings, not just All settings. The
  encoding is proprietary and the app deliberately does not decode it. Three things
  about it are worth knowing and none of them were written down before 2026-10-01:
  - **It does not affect a world that already exists.** Measured live with Reveo
    Valley / Fresh2 running, by reading all 153 values `getgamepref` returns over
    telnet: `SandboxCode` came back as exactly the 94-character string in the XML — so
    the file does reach the game — while `BloodMoonEnemyCount` was `8` where that code
    decodes to `5/16 Enemies`, `ZombieMove` `0` (Walk) where it says `1/Jog`, and
    `ZombieFeralMove` `3` (Sprint) where it says `4/Nightmare`. The server's own boot
    dump prints `GamePref.SandboxCode = <the code>` next to `GameStat.SandboxCode = `
    (empty) and `GamePref.GameDifficulty = 1` next to `GameStat.GameDifficulty = 2`:
    **the save carries its own values and they win.** A new code takes effect on a new
    save — `/api/7dtd/reset` is what makes one. The Settings card says this now.
  - **`sdtdserver.xml` is the single source of truth for it.** The Quick settings GET
    reads `SandboxCode` out of the file; it used to read the DB row, which "All
    settings" did not mirror, so editing the code there and renaming the server a week
    later silently restored the old code — green toast both times.
  - **Shape:** every code on the box is uppercase A-Z with `(length - 1) % 3 == 0` —
    the live 94-character preset, the 19-character fresh-install default (22 boot logs)
    and the game's own example preset `ABEABTBBWADFP`. The character class is refused;
    the length only **warns**, because exactly one of 23 boot logs printed the live code
    one character short (93, so `(93-1) % 3 = 2`) with no XML write between it and the
    boots either side, and an unexplained counter-example is not something to refuse on.
- **Server-browser visibility:** `ServerVisibility=2` (public) + `Region` must
  match where players filter (box is in Germany → set `Region=Europe`, not the
  default `NorthAmericaEast`). A fresh/empty server can still take 15-30 min to
  appear and is best found by searching its exact `ServerName`.
- **Game version / Steam branch:** set by the `VERSION` env on the `sevendtd`
  service — `stable` (Default Public) or `latest_experimental`. **Currently
  `latest_experimental`, installed build V 3.3.0 (b14)** as of 2026-09-26 — the
  fresh netcup install pulled whatever was current, up from V3.1.0 b11 on the old
  box. Anyone whose client is older will hang at "Starting game" and must let Steam
  update first. Switching branches needs a one-time update run: recreate the
  container with `START_MODE=3` (update+start) so the ~17GB files re-download, then
  it goes back to `START_MODE=1` normal start.
  IMPORTANT: recreate with **`docker compose up -d sevendtd`** (NOT `docker
  compose run`, which omits the `sevendtd` network alias and breaks the web
  app's telnet-by-name). Branch switches can break existing saves — back up
  first.
- **CLIENT↔SERVER BUILD MISMATCH = the #1 "stuck at Starting game" cause.**
  `latest_experimental` gets frequent Steam patches; players' clients auto-update
  but the **server only re-downloads on `START_MODE=3`**. If the server build ≠
  the client build, join fails with a server-side `NullReferenceException` in
  `ItemValue.SetMetadata`/`PlayerDataFile.ReadNetwork` (reading the client's
  uploaded character) — client hangs at "Starting game". It is NOT a corrupt
  save/world/profile (we chased all those). **Fix = update the server to match.**
- **In-UI server maintenance** (7DTD Settings → "Server maintenance" card):
  - `/api/7dtd/update` (GET compares installed `appmanifest_294420.acf` buildid
    vs the branch's latest via `api.steamcmd.net`; POST recreates the container
    via `docker run` with `START_MODE=3` + the `sevendtd` alias, so the web
    container can update without compose). Surfaces build + "update available".
  - `/api/7dtd/reset` (GET previews; POST = guarded reset): backs up the save,
    stops the server, **wipes `Saves/<world>` but keeps the map** in
    `GeneratedWorlds`, bumps `GameName` (Fresh2→Fresh3) so no client has a stale
    cached character, then restarts. This is the sanctioned "start from scratch".
- **World upload:** `/api/7dtd/world` (ADMIN) accepts a `.zip`, auto-detects
  world-vs-save from marker files (`dtm.raw`/`biomes.png`/`prefabs.xml` → world →
  `GeneratedWorlds/<name>`; `main.ttw`/`players.xml` → save → `Saves/`), extracts
  with the container's `unzip`. UI is the uploader card in 7DTD Settings. To play
  an uploaded world: set `GameWorld` to its name in All settings + restart.
  Large worlds exceed **Cloudflare's 100MB request cap** (→ 413), so the uploader
  routes the file to the **direct (non-Cloudflare) host** `direct.yoshling.xyz`
  using a short-lived HMAC token from `/api/7dtd/world/token` (the session cookie
  isn't sent cross-origin). See the TLS section for the direct-host cert setup.
  `GameWorld` in All settings is a **dynamic dropdown** (stock `Data/Worlds` +
  uploaded `GeneratedWorlds`, fed by `/api/7dtd/world` `allWorlds`).
- **World delete:** `DELETE /api/7dtd/world?name=` (ADMIN) removes a custom world,
  but **refuses if it's the active `GameWorld` or referenced by any backup**
  (trash button on the uploader's world chips).
- **7DTD backups are self-contained:** each bundles `Saves/` + the custom world
  map (`GeneratedWorlds/<world>`) + `sdtdserver.xml` + a `manifest.json` (records
  the world), so one-click restore rebuilds saves, map, and settings together.
  (MC backups remain just the `world/` folder.) Note: tar stores members as
  `./name`, so manifest reads try `./manifest.json` first.

## Added 2026-09-28

- **`mem_limit: 10g` and `stop_grace_period: 120s`** now exist on the service. 7DTD is a
  Unity native server with no heap setting, so the ceiling is the *only* bound it can
  have and there is no configured number to size it against. Docker's default 10s stop
  was optimistic for a 416 MiB / 59,651-chunk world.
- **Telnet on 8081 was reachable from the public internet** until 2026-09-28 — the
  7DTD log had recorded `INF Telnet connection from: <public IP>`. `ufw` does not cover
  published container ports; see the firewall note in `CLAUDE.md`. Now dropped in
  `DOCKER-USER` by the `yoshling-firewall` systemd unit. 8080 (web admin) was published
  too but refused connections, since `WebDashboardEnabled=false`.
- **The `TelnetPassword` has been exposed in a chat transcript and should be rotated.**
  It must change in **both** `sdtdserver.xml` and `SDTD_TELNET_PASSWORD` in `.env`, or
  the dashboard loses telnet control and reports the server as offline.
- **Two quick settings write XML properties that do not exist.** The live
  `sdtdserver.xml` has neither `GameDifficulty` nor `DayNightLength` — both moved into
  the sandbox preset. `/api/7dtd/config/all` now returns them in an `ignored` array
  instead of silently dropping them. **Closed:** the controls were deleted 2026-09-29,
  and on 2026-10-01 the two `XML_KEYS` mappings went with them — a mapping that can only
  write a frozen default nobody chose is the same defect one game version later.
- **`/api/7dtd/config/all` now validates values, not just key names.** `GameWorld` and
  `GameName` become filesystem path segments (`Saves/<world>/<name>`) and `tar`/`rm`
  arguments in the reset and backup routes, so an empty or `..` value did its damage
  two routes away from the mistake. That one hole was the reachability for three
  separate audit findings.
- **`/api/7dtd/{reset,world}` use `execFile`, not `exec`.** Their guards reject slashes
  and dots, but `JSON.stringify` quotes with *double* quotes and `sh` still expands
  `$(…)` inside those — and in the world route two arguments come from the contents of
  the uploaded zip.
- **Uploading a world no longer refuses because a backup references it.** That rule is
  right for `DELETE` and wrong for replace: it told an admin to delete their only 7DTD
  backup in order to upload a map. The active `GameWorld` is still refused.
- **The restore validates `manifest.gameWorld`**, which is read from inside the archive
  and reached `rm -rf` as root.
- **`/api/7dtd/reset` writes its safety archive outside the backups directory.** It has
  no `manifest.json` and its members are rooted at `<world>/`, so it used to list as an
  ordinary restorable row — and restoring it wiped every save.

## Added 2026-10-01 — the settings audit's 7DTD items

A nine-agent audit counted what the dashboard exposes against what each game really
supports (7DTD: **64 of 219** properties) and tested whether each exposed setting reaches
the game. Its verdict for this game was *"ours is adequate"* — pasting a sandbox code is
the right design — so what follows is the mechanics around it, not a redesign. The
measurements are in `src/lib/sdtd-settings.ts`, which is where the pure logic lives so it
can be asserted (`src/lib/__tests__/sdtd-settings.test.ts`, 27 tests).

- **`ServerMaxPlayerCount` is clamped to 1–16 and now says so.** `PUT maxPlayers=99`
  stored 16, answered `{success:true}` with no mention, and left `99` in the box. The route
  returns a `clamped` array and a note, and the page redisplays what the server stored
  rather than what was typed.
- **`getgamepref` over telnet returns 153 live values** (measured, one session) and is now
  **wired into the page** as the configured-versus-live comparison — `readLive()` in
  `game-manager.ts`, parsed by `parseGamePrefs` in `live-settings.ts`, one batched telnet
  session like every other 7DTD read. This paragraph said it was "deliberately **not**
  wired" for a day after it was; that sentence was true when written and the reason it gave
  is still true, which is exactly how a doc goes wrong while every sentence in it once
  passed review.
  - The reason survives as a **per-row exception, not a reason to skip the feature**:
    `SandboxCode` reads back **identical** to the file on a world where the code's options
    demonstrably are *not* in effect, so a green tick on that one row means "the string
    matches", not "the options are live". The card says so. Comparing the decoded options
    would mean decoding the code, which this project still does not do.
  - Eight keys are in the file but absent from `getgamepref` (measured 2026-10-01) and read
    "not reported" rather than amber — an unanswered question is not a disagreement.
- **No declarative settings schema**, by decision. 7DTD's XML and PZ's `.ini` both carry a
  comment per setting, which is why one generic `ConfigPanel` serves both; the only facts
  the file cannot know are what the *deployment* does to a setting (the pinned ports, the
  firewalled web dashboard), and those are attached to `help` in the API rather than kept in
  a second table that would rot.
