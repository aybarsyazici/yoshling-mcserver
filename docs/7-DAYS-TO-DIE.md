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
    it lives in `web-data`, not in the game volume. It held the real
    `serverName` / `password` / `maxPlayers` / `gameDifficulty` / `dayLength` /
    `sandboxCode`. Read it with the libSQL snippet in "Applying DB migrations".
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
  (name/password/players/difficulty/day length/RAM/**Sandbox code**) plus an
  **"All settings"** expander backed by `/api/7dtd/config/all`, which reads *every*
  `<property>` in `sdtdserver.xml` (comment → help text) and writes back changed
  ones. Telnet/admin keys are locked out of that editor. All XML edits need a 7DTD
  restart to apply.
- **Sandbox code** (`SevenDaysConfig.sandboxCode` → `SandboxCode` XML property) is
  the game's encoded difficulty/loot/XP preset from *New Game → Sandbox Options →
  Copy Code*. It's the highest-impact setting, so it's surfaced in Quick settings
  (not just All settings). The format is proprietary/opaque — the app just stores
  and writes the pasted string.
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
  instead of silently dropping them, but **the controls still render** in
  `src/app/7dtd/settings/page.tsx` and should be deleted.
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
