# Yoshling — Game Server Control

A web app to control three game servers (Minecraft + 7 Days to Die + Project
Zomboid) running on a single Hetzner box, from a Discord-authed dashboard. One
box, three worlds: only one game runs at a time (8 GB RAM), and powering one on
gracefully saves + stops whichever other one is running. Access is per world —
a user only sees the servers an admin has granted them.

## Stack

- **Next.js 16** (App Router, Turbopack, `output: "standalone"`) + **React 19**
- **Prisma 7** with the **libSQL/SQLite** adapter (`@prisma/adapter-libsql`) — client generated to `src/generated/prisma`
- **NextAuth v5** (Discord OAuth, JWT sessions, invite-only via `ALLOWED_DISCORD_USERS`)
- **Tailwind v4** + shadcn/base-ui components + **Catppuccin** theming (Latte/Mocha)
- **motion** (Framer) for animation; **recharts** for monitor graphs
- Server control is done by shelling out to the **Docker CLI** against a mounted
  `/var/run/docker.sock`

## Architecture

Four containers via `docker compose` (see `docker-compose.yml`):

| Container | Image | Purpose | Web reaches it as |
|-----------|-------|---------|-------------------|
| `yoshling-mc` | `itzg/minecraft-server` | Minecraft, ports 25565 + RCON 25575 | host `minecraft` |
| `yoshling-7dtd` | `vinanrra/7dtd-server` | 7DTD, ports 26900-26902, telnet 8081, webadmin 8080 | host `sevendtd` |
| `yoshling-pz` | `danixu86/project-zomboid-dedicated-server` | Project Zomboid, ports 16261-16262/udp + 8766-8767/udp, RCON 27015 (unpublished) | host `zomboid` |
| `yoshling-web-1` | this app | Next.js dashboard | — |

The **web container runs as root** with `docker-cli` **and `docker-cli-compose`**
installed, the docker socket bind-mounted, and the deploy dir mounted at
`/opt/yoshling` (same path inside and out). **Do not** revert the Dockerfile to a
non-root user, drop either docker package, or remove the `./:/opt/yoshling` mount.

- socket + docker-cli → `docker start/stop/inspect/stats/logs`
- compose plugin + the mounted deploy dir → recreating a container to apply a
  config change. **A container's env, ports and mounts are fixed when it is
  created**, so `docker restart` can never apply a new memory value or image
  version. Only a recreate can, and compose is the only way to do that without
  losing the container's labels, network aliases and mounts.
- `recreateService()` in `game-manager` is the one sanctioned way to do it, and
  `assertSingleContainer()` runs afterwards: it refuses to continue if the name
  now has 0 or 2+ containers, or if the container lost its compose labels. Never
  hand-build `docker run` — that produces a container compose can't adopt, and
  the next `docker compose up` either errors on the name or orphans it. (The 7DTD
  update route used to do exactly that; it flips `START_MODE` in compose now.)

### Game abstraction

- `src/lib/games.ts` — client-safe metadata per game (accents, routes, RAM,
  connect strings, per-game API endpoints, file-browser roots, which sidebar
  pages exist). Single source of truth for identity: adding a game means adding
  a `GameMeta` entry, a driver, and the API routes — the shared components read
  everything else from the table. `otherGames(id)` (not `otherGame`) returns
  every *other* world, so nothing assumes there are exactly two.
- `src/lib/game-manager.ts` — server-side driver per game. `powerOn(game)`
  performs the graceful hand-off: it saves + stops *every other* game that is
  running, then starts the requested one. Active game is persisted in the
  `GameState` table so a reboot only revives the intended world. A module-level
  **control lock** serializes all start/stop/restart ops — a concurrent request
  throws `ControlBusyError` → HTTP 409 (prevents Restart-button spam / racing
  `docker` commands). `/api/games/status` exposes the in-flight lock as `busy`;
  `useGames` surfaces it so every control UI disables while an op runs.
- `src/lib/rcon.ts` — the shared Source-RCON transport, keyed per target with one
  cached authenticated socket each. Minecraft (25575) and Project Zomboid (27015)
  both speak it; `sendCommand`/`getPlayerList` are the Minecraft wrappers.
- `src/lib/telnet.ts` — 7DTD control over telnet. `telnetSession()` runs multiple
  commands in ONE connection and always sends `exit` to close cleanly (dropping
  the socket makes 7DTD spam `IOException ... socket has been shut down` in its
  console). Status probe = one session (`getSdtdStatus`: listplayers+gettime+
  version), cached ~4s + single-flight in `game-manager` so many tabs don't each
  hit telnet.
- `src/lib/zomboid.ts` — Project Zomboid: RCON control (`players`/`save`), the
  `.ini` parser/writer, and the mod-list helpers. Status probe = one RCON
  `players` call, cached ~4s + single-flight like 7DTD's (see `cachedProbe` in
  `game-manager`).
- `src/lib/server-manager.ts` — thin backward-compat shim delegating to
  `game-manager` for the legacy Minecraft-only `/api/server/*` routes.

### Routes

- `/` → redirect to `/home` (or `/login`)
- `/home` — the landing: the Power Core, the **power bus** (one trunk, one branch
  per world, only the running world's branch lit), one card per world the viewer
  can see, hand-off confirm, RAM budget. A viewer with no worlds gets a "No
  worlds yet" screen instead.
- `/minecraft/*` — MC overview, mods, server (controls/monitor/console/files), backups, settings
- `/7dtd/*` — 7DTD overview, server (controls/monitor/console/files), backups, settings
- `/zomboid/*` — PZ overview, mods, server (controls/monitor/console/files), backups, settings
- Backups are their own sidebar page per game (`/{game}/backups`), not a server tab.
- `/users` (Crew), `/whitelist`, `/activity` — shared, and they wear the accent of
  the first world the viewer can see. `/whitelist` is the **app sign-in** list
  (`ALLOWED_DISCORD_USERS` / `whitelist.json`), which was never Minecraft-specific;
  `/minecraft/whitelist` 301s to it. Minecraft's *in-game* whitelist and ops live
  on the MC settings page (`/api/server/{mc-whitelist,ops}`). The activity log
  hides entries for worlds the viewer can't see.
- API: `/api/games/{status,control,stats}`, `/api/7dtd/{console,backups,config,files,world}`,
  `/api/zomboid/{console,backups,config,config/import,files,mods}`, and the legacy
  `/api/server/*` + `/api/mods/*` + `/api/modpacks/*`.
- `src/components/file-browser.tsx` is shared: MC uses the default
  `/api/server/files`; 7DTD and PZ pass their own endpoint + `roots` from
  `GAMES[game].fileRoots` (7DTD: Config = `/sevendtd-config`, Saves =
  `/sevendtd`; PZ: Config = `/zomboid/Server`, Saves = `/zomboid/Saves`, All
  data = `/zomboid`).
- `src/components/config-panel.tsx` is the shared "All settings" expander. Both
  7DTD's XML and PZ's .ini document themselves with a comment per setting, so
  both config endpoints return the same `{properties:[{name,value,help}]}` shape
  and only the grouping/dropdowns/copy differ per game.

### Server memory

`/api/games/memory` + the `MemoryCard` on each game's Settings page.

**A container's environment is fixed when the container is created.** Editing
`docker-compose.yml` and running `docker restart` looks like it worked and
silently doesn't — the old heap size stays. This is the trap the Minecraft memory
setting fell into before. So `setMemory` in `game-manager`:

1. patches only that service's env in compose (`lib/compose.ts`, scoped — `MEMORY`
   and `VERSION` mean different things in different service blocks),
2. gracefully saves + stops the world **if it was running**,
3. `docker compose create --force-recreate <service>` — `create`, not `up`, so a
   stopped world **stays stopped** and changing its memory can't evict whichever
   world currently holds the box,
4. starts it again only if it was running before, and
5. reads the value back off the new container.

The card shows the compose value next to what the existing container was actually
created with, and warns when they disagree — so "applied" is something you can
see rather than assume. Verified on the box: `MAX_MEMORY=4096m` in compose →
`MAX_MEMORY=4096m` on the container → `-Xmx4096m` in the running JVM.

Per-game support lives in `RUNTIME[game].memory`: Minecraft uses `MEMORY` (`4G`
form), Project Zomboid uses `MAX_MEMORY` (`4096m` form), and **7 Days to Die has
none** — it's a Unity native server with no JVM, so the card says so instead of
offering a control that does nothing. Cap is `MAX_GAME_GB` (6), leaving room for
the OS and the dashboard on the 8 GB box. `/api/settings` no longer touches
memory at all; it only patches `TYPE`/`VERSION`.

### Roles & per-world access

Two orthogonal axes, both in `src/lib/permissions.ts`:

- **Role** — ADMIN / MOD / MEMBER, says what a user may *do*. Server power is
  ADMIN-only; mod management is ADMIN/MOD; browsing is everyone.
- **World access** — the `User.games` column, a CSV of game ids
  (`"minecraft,7dtd"`), says which servers they may *see at all*. `gameAccess()`
  resolves it; **ADMIN ignores the column and always has every world**, and is
  the only role that can hand access out.

So a MOD with only `zomboid` can install PZ mods and never learns the Minecraft
pages exist. The **first** Discord account to sign in becomes ADMIN with all
worlds; **every account after that starts as MEMBER with no worlds** and an admin
grants them on the Crew page. (Before this, *every* new account was created as
ADMIN — that was a bug.)

**Signing in vs. seeing a world are two different lists**, and conflating them
was a bug: `/whitelist` (the page) controls who may sign in *at all*, and it and
the `signIn` callback now share `src/lib/whitelist.ts`. Before that the page wrote
`/app/data/whitelist.json` while `signIn` only read `ALLOWED_DISCORD_USERS`, so
adding someone in the UI silently did nothing and Discord refused them. The file
wins; the env var is only the seed for a fresh install; a missing or corrupt file
falls back to env rather than locking everyone out; and matching accepts the
Discord @handle *or* the display name. Refusals are logged with the attempted
name. Being whitelisted grants **no** world — that's `User.games` on the Crew page.

Enforcement, in layers:

- `src/lib/game-gate.ts` — `gameGate(game)` (session + access in one call, used
  by the newer routes) and `denyGame(session, game)` (drop-in for routes that
  already resolved a session). **Every** route that touches one game's
  containers, files or config starts with one of these; `/api/games/control` and
  `/api/games/stats` gate on the `game` request parameter.
- The three game layouts (`src/app/{minecraft,7dtd,zomboid}/layout.tsx`) redirect
  to `/home` when the viewer lacks that world, so the pages simply don't exist
  for them.
- `/api/games/status` returns `access: GameId[]`, which `useGames` surfaces and
  the UI filters on (sidebar world switcher, landing cards). It still reports the
  *run state* of worlds the user can't open — only one server fits on the box, so
  their Start button stops whatever is running and the confirm dialog has to be
  able to name it — but strips player names from those.
- Access changes take effect immediately: the NextAuth `jwt` callback re-reads
  `role` + `games` from the DB on **every** call, because a JWT would otherwise
  stay frozen until the user signed out.

`/users` (Crew) is where an admin toggles worlds — one tinted chip per world per
user, lit = granted. Admin rows show all three chips lit and locked.

## Local development

```bash
npm run dev      # dev server (needs .env — see below)
npm run build    # production build (also the deploy build)
npm run lint     # eslint (not run during build; pre-existing `any` warnings exist)
npx tsc --noEmit # typecheck
```

`.env` (gitignored) needs at least: `DATABASE_URL`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL`, `RCON_*`,
`SDTD_TELNET_PASSWORD`, and `PZ_RCON_PASSWORD` + `PZ_ADMIN_PASSWORD`. Local dev
uses `dev.db`.

Migrations: `npx prisma migrate dev --name <x>` locally. **Production has no
automatic migrations** — apply schema changes to the prod DB by hand (below).

**Prisma CLI needs Node ≥ 20.19 / 22.** `prisma@7`'s `@prisma/dev` `require()`s
an ESM-only dep, so on Node 20.12 every `prisma` command dies with
`ERR_REQUIRE_ESM`. Run it with a newer Node, e.g.
`PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH" npx prisma generate`.
(The Docker build is fine — `node:20-alpine` is 20.19+.)

## Production / deployment

Host: **netcup `89.58.50.155`**, 8 vCPU / 16 GB RAM / 314 GB disk, Debian 13,
8 GB swap. SSH as `root` with `~/.ssh/mc_yoshling_netcup`. Migrated off Hetzner
2026-09-13 (€12.61 vs €40/mo for 16 GB); see MIGRATION.md. The old Hetzner box
(`178.105.163.254`, key `~/.ssh/mc_yoshling`) is kept as a rollback until each
game has been played on netcup. Deploy dir: `/opt/yoshling` (a git checkout tracking
`main`). Public domain `https://yoshling.xyz` is proxied through **Cloudflare**;
**Caddy** is the origin reverse proxy (`/etc/caddy/Caddyfile`) forwarding to
`localhost:3000`.

### Deploying code (the box has NO GitHub SSH key)

`git fetch origin` fails on the box. Ship a **git bundle** instead:

```bash
git bundle create /tmp/y.bundle main
scp -i ~/.ssh/mc_yoshling /tmp/y.bundle root@178.105.163.254:/root/
ssh -i ~/.ssh/mc_yoshling root@178.105.163.254 '
  cd /opt/yoshling
  git fetch /root/y.bundle main
  git checkout -f -B main FETCH_HEAD
  git clean -fd -e .env -e "*.db"        # reset leaves old untracked files
  docker compose build web
  docker compose up -d --no-deps web'    # rebuild web only; leave game containers
```

The web service gained the `pz-data` + `pz-workshop` mounts and the `PZ_*` env, so
that deploy **recreates** the web container (not just restarts it) — expected.
Project Zomboid itself is created on first use with
`docker compose up -d --no-deps zomboid` (it must NOT start automatically; see
below).

Back up the DB before schema-affecting deploys:
`docker cp yoshling-web-1:/app/data/yoshling.db /root/yoshling-deploy-backup/`.

**`/api/settings` edits `/opt/yoshling/docker-compose.yml` in place.** Changing the
Minecraft version/loader/memory in the UI rewrites exactly the `TYPE`, `VERSION`
and `MEMORY` lines *inside the `minecraft:` service block* (`patchServiceEnv`), then
runs `docker compose up -d --force-recreate minecraft`. It used to regenerate the
whole file from a two-service template, which silently deleted the `sevendtd` (and
now `zomboid`) services and the volume declarations the web container mounts. If
you ever touch that route: keep it a scoped patch, and remember `VERSION` means the
Minecraft version in one block and the Steam branch in another.

### Applying DB migrations in production (manual)

No migration runs on boot. Apply SQL directly to the prod DB (in the
`yoshling_web-data` volume at `/app/data/yoshling.db`) via the libSQL client
already inside the web container:

```bash
docker exec yoshling-web-1 node -e "
  const {createClient}=require('/app/node_modules/@libsql/client');
  const c=createClient({url:'file:/app/data/yoshling.db'});
  c.execute('CREATE TABLE IF NOT EXISTS ...').then(()=>console.log('ok'));
"
```

**Pending for the per-world-access + Project Zomboid deploy** (migration
`20260913144054_add_game_access_and_zomboid_mods`) — run these four statements in
order, and note the backfill: it grants every existing account all three worlds,
so nobody currently signed in loses anything. Skip it and everyone but ADMINs
sees an empty dashboard.

```sql
CREATE TABLE "ZomboidMod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "modIds" TEXT NOT NULL DEFAULT '',
    "previewUrl" TEXT,
    "addedBy" TEXT NOT NULL DEFAULT '',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "User" ADD COLUMN "games" TEXT NOT NULL DEFAULT '';
UPDATE "User" SET "games" = 'minecraft,7dtd,zomboid';
```

### 7 Days to Die specifics

- First boot runs a one-time **SteamCMD install (~17 GB, ~10-20 min)**. The
  `sevendtd` service is `restart: "no"` so it never auto-starts on reboot — the
  web UI powers it on deliberately (and stops MC first).
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
  `latest_experimental` (game V3.1.0).** Switching branches needs a one-time
  update run: recreate the container with `START_MODE=3` (update+start) so the
  ~17GB files re-download, then it goes back to `START_MODE=1` normal start.
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

### Project Zomboid specifics

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
- **Measured memory use (2026-09-13):** with just 2 mods installed, PZ sits at
  **4.83 GiB RSS** of the box's 7.56 GiB (~1.2 GB free) on `-Xmx4096m`. With 76
  mods it was OOM-killed. So 8 GB is fine for a small list and has room for maybe
  a handful more mods; a large map-heavy collection needs a 16 GB box, not heap
  tuning.
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
  item) and got `result=2`. Fix: delete
  `appworkshop_108600.acf` from the workshop volume and re-download with
  `steamcmd … +workshop_download_item 108600 <id> validate`, which then succeeds.
- **Mod ids from a Workshop description are a guess; disk is truth.** Community
  Tile Pack's description implies `UnofficialMappersCommunityTilePack`, but the
  folder on disk — and the only thing that works — is `CommunityTilePack`. Always
  reconcile against `content/108600/<id>/mods/*` once an item has downloaded.
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
- **Mod XML that uses `x_extends` breaks on Linux.** PZ lowercases the *whole*
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

### TLS / the domain

`yoshling.xyz` is proxied through **Cloudflare** (DNS resolves to Cloudflare IPs,
not the Hetzner box). Full chain, all encrypted:
**browser → Cloudflare (Let's Encrypt edge cert) → origin (Caddy on the box).**

- Cloudflare SSL/TLS mode is **Full (strict)**.
- The Cloudflare→origin hop uses a **Cloudflare Origin Certificate** installed on
  the box at `/etc/caddy/certs/origin.pem` (644) + `origin.key` (600, owned
  `caddy`); covers `yoshling.xyz` + `*.yoshling.xyz`, valid to **2041**.
- `/etc/caddy/Caddyfile` serves `yoshling.xyz` HTTPS on :443 with that cert
  (`tls <pem> <key>; reverse_proxy localhost:3000`) plus an `http://` → 301 https
  redirect. Backups at `/etc/caddy/Caddyfile.bak.*`. After edits:
  `caddy validate --config <file> --adapter caddyfile` then `systemctl reload caddy`.
- The origin cert is a Cloudflare Origin cert — **not publicly trusted** (only
  Cloudflare trusts it), so plain `curl https://127.0.0.1` fails with "unable to
  get local issuer certificate". That's expected; Full (strict) validates it
  against Cloudflare's Origin CA. To renew: regenerate in the Cloudflare dashboard
  (SSL/TLS → Origin Server), overwrite the two files, reload Caddy.
- **Gotcha:** some corporate networks (Cisco Umbrella) DNS-sinkhole new `.xyz`
  domains, showing a bogus cert-mismatch page in the browser — that's a
  client-network block, not a server problem. Verify from the box with
  `curl https://yoshling.xyz/login` (expect 200).
- **`direct.yoshling.xyz`** is a **DNS-only (grey-cloud)** record → the box, for
  large uploads that exceed Cloudflare's 100MB cap. Caddy serves it with a
  **Let's Encrypt** cert (publicly trusted) via the global option
  `auto_https ignore_loaded_certs` (so it doesn't reuse the loaded CF Origin
  wildcard), and `request_body { max_size 2GB }`. Caddy was upgraded from the
  Ubuntu 2.6.2 package to the **official 2.11.4 binary** for this
  (`/root/caddy-2.6.2.bak` is the rollback).

### Connecting to the game servers (NOT via Cloudflare)

Game traffic can't go through Cloudflare (it only carries HTTP/HTTPS). Players
connect **directly to the box IP `178.105.163.254`**:
- **Minecraft:** `mc.yoshling.xyz` (a **DNS-only / grey-cloud** A record → the box)
  or the IP, port 25565.
- **7DTD:** the app shows both `7dtd.yoshling.xyz:26900` and the raw
  `178.105.163.254:26900`. 7DTD's direct-connect box often only accepts a
  **literal IP**, so the IP is the reliable one. The `7dtd` A record is also
  DNS-only. (`connect` in `games.ts` is a `string[]` so a game can list several.)
- **Project Zomboid:** `pz.yoshling.xyz:16261` or the raw
  `178.105.163.254:16261`. **The `pz` A record still has to be created** as a
  DNS-only (grey-cloud) record → the box; until then, use the IP.
- **Firewall is two layers** — the game ports must be open in BOTH the server's
  `ufw` (25565/tcp, 26900/tcp, 26900-26902/udp, 16261-16262/udp, 8766-8767/udp)
  AND the Hetzner Cloud Firewall in the console. Missing either = "connect hangs,
  nothing in logs".
- Server-browser listing: 7DTD `ServerVisibility=2` (public) in `sdtdserver.xml`;
  set a unique `ServerName` (via 7DTD Settings) to find it, or just direct-connect.

## Status

- **Live** at `https://yoshling.xyz` (Cloudflare Full (strict), verified end-to-end).
- **Minecraft:** running/healthy; all features (mods, console, files, backups,
  settings, whitelist) working.
- **7 Days to Die:** installed (~17 GB via SteamCMD), on the **`latest_experimental`**
  branch (game **V3.1.0 b11**). Telnet control, file browser (Config/Saves), world
  upload, and in-game join verified. Powered off by default (MC is the default
  active world; `GameState.activeGame = minecraft`).
- **Project Zomboid: deployed 2026-09-13.** Container `yoshling-pz` is **created
  but not started** (7DTD held the box at deploy time), so the first Power on from
  the UI is what boots it. Image pulled (10.4 GB; box went 47% → 55% disk). ufw
  has 16261/udp, 16262/udp and 8766-8767/udp. `PZ_RCON_PASSWORD` +
  `PZ_ADMIN_PASSWORD` were generated and appended to `/opt/yoshling/.env`.
  Verified in production: every route 401s unauthenticated, all pages render, the
  web container can `docker inspect yoshling-pz`, the `zomboid` network alias is
  in place, `SELF_MANAGED_MODS=true`, `PASSWORD`/`PUBLIC`/`DISPLAYNAME` absent,
  StopTimeout=120, and the stats collector is writing `stats-zomboid.json`.
  Verified locally against real inputs: the .ini parser/writer round-trips a real
  139-key `servertest.ini` (writes touch only the intended lines, all comments
  survive), the Steam Workshop lookup + `Mod ID:` parse work on live items, and
  add/edit/remove/import all produce the correct `Mods=` / `WorkshopItems=` lines.
  **Still untested because it needs the game running:** RCON control, backups, and
  a real Workshop download.
- **Per-world access: deployed.** `User.games` + `ZomboidMod` applied to the prod
  DB; all 5 existing accounts backfilled with all three worlds. Note they are
  **all ADMIN** — a consequence of the old signup bug (every new account was
  created ADMIN). Demote whoever shouldn't be on the Crew page; a non-ADMIN role
  is what makes the per-world chips take effect.
- **Not done, needs a dashboard I don't have:** the `pz.yoshling.xyz` DNS record
  (DNS-only / grey-cloud → the box) and the **Hetzner Cloud Firewall** rules for
  the PZ ports. Until both exist, players connect on `178.105.163.254:16261` and
  only if the cloud firewall lets them.
- At deploy time the active world was **7 Days to Die** (up 6 weeks), Minecraft
  stopped — not what an earlier version of this file claimed.

> Keep this file current. It's the project's living status doc — update it after
> meaningful changes (features, deploys, infra/config, new gotchas) so a fresh
> session can tell where things stand.

## Conventions

- Match the existing component style (shadcn/base-ui + Tailwind, `cn()` helper).
- Per-game accent via the `--tint` CSS var (`GAMES[game].tint`), all Catppuccin:
  Minecraft = green/teal (`--mc`), 7DTD = peach/red (`--sd`), Project Zomboid =
  blue/sapphire (`--pz`). Each has a Latte and a Mocha value in `globals.css`.
- Per-game glyph via `GameMark` in `glyphs.tsx` (MC = creeper face, 7DTD = hazmat
  skull, PZ = boarded window). Never branch on the game id for a glyph inline.
- Reusable motion primitives live in `src/components/motion.tsx`; shared bits in
  `src/components/ui-bits.tsx`. The central power indicator is `power-core.tsx`;
  the landing's signature element is the **power bus** in `mission-control.tsx`
  (one trunk from the core, one branch per world, only the running one energised).
  It only draws while the cards are on a single row — the branches have to line up
  with the columns underneath — but it always reserves its height so the spacing
  doesn't jump.
- **Copy tone: plain and to-the-point.** No gamer lingo or theatrical framing
  ("reactor", "horde", "hand over", "outlast", etc.). Say what a control does:
  "Start / stop the server", "Switch servers?".
- The silly vacation photos go in page **footers** only (`PhotoFooter` /
  `PhotoStrip`), never the landing, never blocking controls. They are now only on
  the **Minecraft and 7 Days to Die** pages: MC mods keeps its caption
  ("approves of your mod list") and 7DTD settings shows "I cant let you get
  close!". **The Project Zomboid pages and the shared pages (Crew, Whitelist,
  Activity) have none** — deliberate, so don't "fix" the inconsistency by adding
  one back.
- Easter egg: `MikuEasterEgg` (mounted in the root layout) — resting the pointer
  in the bottom-right corner for ~1.1s reveals British Miku (image only, no
  caption). Image at `public/british-miku.webp`.
