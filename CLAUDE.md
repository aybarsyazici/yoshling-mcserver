# Yoshling — Game Server Control

A web app to control three game servers (Minecraft + 7 Days to Die + Project
Zomboid) running on a single netcup box, from a Discord-authed dashboard. One
box, three worlds: only one game runs at a time (16 GB RAM), and powering one on
gracefully saves + stops whichever other one is running. Access is per world —
a user only sees the servers an admin has granted them.

## Documentation rules — READ THIS, THEN KEEP IT TRUE

**These docs are the only thing that survives a lost conversation.** A previous
chat that built the Minecraft side was deleted and the work had to be
reconstructed from scratch. Treat the files below as the project's memory.

Two rules, both non-optional:

1. **Keep `CLAUDE.md` current.** It is a *living status doc*, not a one-time
   writeup. After any meaningful change — a feature, a deploy, an infra or config
   change, a gotcha you paid for — reflect it here **before** you finish the task.
   If you discover that something written here is wrong, fix it rather than working
   around it.
2. **Put depth in `docs/<TOPIC>.md`, not in this file**, and add a pointer to the
   table below. This file is the **shared** architecture; anything long or specific
   to one game belongs in its own doc so an agent working on a different game
   doesn't carry it. **Keep those docs updated with the same discipline** — a stale
   deep doc is worse than no doc, because it gets trusted.

Why rule 2 exists: this file reached 723 lines, 231 of them (32%) Project Zomboid
Workshop-manifest archaeology that every Minecraft and 7DTD session paid for. Worse,
splitting it revealed how much had rotted unnoticed — the intro still said
"Hetzner" and "8 GB" long after the netcup migration, a database migration was
headed "Pending" 200 lines above a Status section saying it was applied, and 8
references pointed at the decommissioned box. **Long files stop being read, and
then they stop being true.** Keep this one short enough to re-read.

### Per-game deep docs — load on demand

| Working on | Read first |
|------------|-----------|
| **Project Zomboid** — mods, maps, `.ini`, Workshop updates, sandbox options, anti-cheat, a log error | **[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md)** |
| A broken/misbehaving PZ **mod** | [`docs/PZ-MOD-BACKLOG.md`](docs/PZ-MOD-BACKLOG.md) — open defect list; check its harmless list before investigating |
| 7 Days to Die | the "7 Days to Die specifics" section below (not yet split out) |
| Minecraft | this file; MC has no separate doc |
| Moving hosts | [`MIGRATION.md`](MIGRATION.md) |

**Do not guess PZ behaviour from this file's summary.** Several of its traps we got
wrong twice and documented wrong once; the corrected versions are only in that doc,
which also keeps a **Corrections** section — worth imitating, because a wrong
explanation that was plausible enough to write down twice is worth recording as
wrong rather than quietly deleting.

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
| `yoshling-pz` | `yoshling/project-zomboid` (built from `pz/`) | Project Zomboid, ports 16261-16262/udp + 8766-8767/udp, RCON 27015 (unpublished) | host `zomboid` |
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
  - **The lock is kept alive by a heartbeat, and expiry is judged on that** — not
    on when the operation started. It used to expire 300s after `since`, which is
    *shorter than a single PZ graceful stop* (`PZ_STOP_TIMEOUT` is 300 seconds).
    So a long operation lost its own lock partway through and a second one could
    start on top: two SteamCMD runs raced on the same workshop volume and one
    reported "updated 0 of 1 mods". Don't reintroduce a total-duration cap.
  - `setControlStage()` lets a long operation describe itself; it surfaces as
    `busy.stage` and is rendered as a progress line in `game-controls.tsx`.
  - **`OperationBanner` (mounted in `dash-shell.tsx`) shows that stage on EVERY
    page**, plus elapsed time, and toasts on the start/end transitions. It is a
    banner and not only a toast on purpose: a mod-update apply takes ~6 minutes and
    a toast is gone in seconds, so anyone who looked a little late saw silence — the
    original bug wearing a hat. Measured 2026-09-15: an apply ran 18:30:25 →
    18:36:23 with the power buttons correctly locked and **nothing anywhere saying
    why**, which reads as the feature having done nothing. Disabled controls now
    state their reason too. If you add another long operation, give it a stage.
  - **`restartGame()` is stop-then-start, not `driver.restart()`** — deliberately.
    Every driver's `restart()` is one opaque "save, then `docker restart`" call, so
    it could not say which half it was in, and it set no stage at all. For PZ the
    stop half alone is up to 300s, so a manual Restart showed a spinning
    "Restarting…" with no stage and no bar for minutes, which is indistinguishable
    from hung — and got reported as exactly that. Splitting into `gracefulStop()` +
    `start()` is behaviourally identical and lets each phase name itself; `start()`
    then returns quickly, so the lock releases and the per-boot progress
    (`snap.boot`) takes over. Don't collapse it back into one call.
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

- **Role** — ADMIN / MOD / MEMBER, says what a user may *do*. **MOD has the same
  capabilities as ADMIN** — power, restart, settings, mods — and differs only in
  *scope*: a MOD acts solely on the worlds in `User.games`, while ADMIN implicitly
  holds all of them. The one exception is `users.manage`, which stays ADMIN-only:
  a MOD who could edit world access could grant themselves the worlds they were
  kept out of, making the gate decorative. MEMBER is read-only (browse + activity).
  Changed 2026-09-14 — power used to be ADMIN-only, which meant a trusted mod
  couldn't restart after a Workshop mod update locked players out.
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
- `/api/games/status` also returns `can: {start, stop, restart}`, and
  `game-controls.tsx` disables the buttons accordingly. Without it the controls
  were shown to everyone and only the API refused, so a MEMBER pressed Power on
  and got an unexplained "Forbidden" — which is exactly how this was reported.
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
(`89.58.50.155`, key `~/.ssh/mc_yoshling`) is kept as a rollback until each
game has been played on netcup. Deploy dir: `/opt/yoshling` (a git checkout tracking
`main`). Public domain `https://yoshling.xyz` is proxied through **Cloudflare**;
**Caddy** is the origin reverse proxy (`/etc/caddy/Caddyfile`) forwarding to
`localhost:3000`.

### Tooling — prefer these over hand-rolling

`scripts/` holds the four things that were repeatedly done by hand and repeatedly
got wrong. Each one encodes a trap that prose warnings did not prevent, so reach
for the script rather than writing the snippet again.

| Script | Use it for | The trap it removes |
|--------|-----------|---------------------|
| `scripts/pz-rcon.sh <cmd>…` | any RCON command against PZ | A naive client reads the **auth** reply as the first command's answer, so every response is shifted by one. That made `players` report 0 while someone was connected, and the wrong reading got reported as fact. Also handles PZ's RCON port not being published — it runs on the compose network and reads the password from the box's `.env`. |
| `scripts/deploy.sh [--service web\|zomboid] [--verify STR]` | shipping code | Verifies the change is in the **built image**, not just at git HEAD — a correct checkout can sit in front of a stale container and `git rev-parse` looks identical either way. Also refuses to run while a SteamCMD seed is in flight, because two seeds race on the same volume and the loser silently updates nothing. |
| `scripts/pz-stale-mods.py` | "why can nobody join?" | `appworkshop_108600.acf` has **two** id-keyed sections and both carry a `timeupdated`; slicing to EOF makes installed == published and the check silently always answers "nothing to do". |
| `scripts/pz-jar.py {find,grep,strings,enum}` | turning a mystery number or command name into a fact | There is no `javap` and no `strings` in the game image. `enum` is how `AntiCheatHit=2` becomes "Kick" (`Ban=1 Kick=2 Log=3 Disabled=4`) instead of a guess. |

Run the two Python ones over stdin so nothing needs installing on the box:
`ssh BOX 'python3 -' < scripts/pz-stale-mods.py`. `scripts/rcon.py` is the plain
client the wrapper ships; it also works against Minecraft on 25575.

### Deploying code (the box has NO GitHub SSH key)

`git fetch origin` fails on the box. Ship a **git bundle** instead:

```bash
git bundle create /tmp/y.bundle main
scp -i ~/.ssh/mc_yoshling /tmp/y.bundle root@89.58.50.155:/root/
ssh -i ~/.ssh/mc_yoshling root@89.58.50.155 '
  cd /opt/yoshling
  git fetch /root/y.bundle main
  git checkout -f -B main FETCH_HEAD
  git clean -fd -e .env -e "*.db"        # reset leaves old untracked files
  docker compose build web
  docker compose up -d --no-deps web'    # rebuild web only; leave game containers
```

The web service gained the `pz-data` + `pz-workshop` mounts and the `PZ_*` env, so
that deploy **recreates** the web container (not just restarts it) — expected.
Project Zomboid is a **locally built** image (`pz/Dockerfile`), so a deploy that
touches it needs `docker compose build zomboid`. It must NOT start automatically —
see [`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md).

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

**APPLIED 2026-09-13** — migration `20260913144054_add_game_access_and_zomboid_mods`.
Kept as the worked example of a hand-applied migration, and because the backfill is
the part that's easy to forget: it grants every existing account all three worlds,
so nobody signed in loses access. Omit it and everyone but ADMINs sees an empty
dashboard.

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

> ## ⚠️ READ `docs/PROJECT-ZOMBOID.md` FIRST
>
> **Anything Project Zomboid — mods, maps, the `.ini`, Workshop updates, memory,
> sandbox options, anti-cheat, backups, a log error — is documented in
> [`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md). Open it before you touch
> PZ.** It is ~480 lines of hard-won specifics and it is kept out of this file on
> purpose: an agent working on Minecraft or 7 Days to Die should not carry
> Workshop-manifest archaeology it will never need.
>
> Several traps in there are ones we got wrong *twice* and wrote down wrong once,
> so guessing from this summary is actively expensive.

The bare minimum for shared code that has to know PZ exists:

- Image is a **derived build** — `pz/Dockerfile` on top of
  `danixu86/project-zomboid-dedicated-server`, because the upstream image's map
  scanner is broken. Compose builds it as `yoshling/project-zomboid`.
- Game files are baked into the image; only Workshop mods download at runtime.
- One data dir, mounted into web as `/zomboid` (`PZ_SERVER_DIR`): the `.ini`, the
  sandbox Lua, the save, the player db. Workshop content is a second, read-only
  mount at `/zomboid-workshop`.
- **Control is RCON on 27015**, unpublished — the web container reaches it as
  `zomboid:27015`. `PZ_RCON_PASSWORD` must match the game's `RCONPASSWORD`.
- **`stop_grace_period: 300s`**, and the driver stops with `-t 300`. The entrypoint
  saves the world on SIGTERM and a 76-mod save overran 120s once, so Docker
  SIGKILLed it mid-save.
- The web app also runs a **Workshop update watcher** (`src/lib/zomboid-updates.ts`,
  a 15s interval in `src/instrumentation.ts` that does a full check at most every
  5 min) which can restart the server by itself when it is empty. If PZ restarts
  unexpectedly, look there first.

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
connect **directly to the box IP `89.58.50.155`**:
- **Minecraft:** `mc.yoshling.xyz` (a **DNS-only / grey-cloud** A record → the box)
  or the IP, port 25565.
- **7DTD:** the app shows both `7dtd.yoshling.xyz:26900` and the raw
  `89.58.50.155:26900`. 7DTD's direct-connect box often only accepts a
  **literal IP**, so the IP is the reliable one. The `7dtd` A record is also
  DNS-only. (`connect` in `games.ts` is a `string[]` so a game can list several.)
- **Project Zomboid:** `pz.yoshling.xyz:16261` or the raw
  `89.58.50.155:16261`. **The `pz` A record still has to be created** as a
  DNS-only (grey-cloud) record → the box; until then, use the IP.
- **Firewall is one layer now.** netcup has no cloud-firewall product, so `ufw` on
  the box is the only gate: 25565/tcp, 26900/tcp, 26900-26902/udp, 16261-16262/udp,
  8766-8767/udp. (On Hetzner this was two layers and missing either meant "connect
  hangs, nothing in logs" — that trap is gone with the move.)
- Server-browser listing: 7DTD `ServerVisibility=2` (public) in `sdtdserver.xml`;
  set a unique `ServerName` (via 7DTD Settings) to find it, or just direct-connect.

## Status

**Live** at `https://yoshling.xyz` on **netcup `89.58.50.155`** (Cloudflare Full
(strict), verified end-to-end). Migrated off Hetzner 2026-09-13 — see MIGRATION.md.

- **Minecraft:** all features working (mods, console, files, backups, settings,
  whitelist). Not yet started on netcup since the migration.
- **7 Days to Die:** on `latest_experimental` (game **V3.1.0 b11**). Telnet control,
  file browser, world upload and in-game join all verified — on the *old* box. It
  will re-download ~17 GB via SteamCMD on its first netcup start.
- **Project Zomboid:** running, 89 mods, played on daily. Full status, what's
  verified and what's outstanding: **[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md#status)**.
- **Per-world access:** deployed; `User.games` + `ZomboidMod` applied to the prod
  DB and all 5 accounts backfilled with all three worlds. **They are all ADMIN**, a
  leftover from the old signup bug — a non-ADMIN role is what makes the per-world
  chips actually bite, so demote whoever shouldn't be an admin on the Crew page.
- **MOD now has the same capabilities as ADMIN**, scoped to its granted worlds;
  only `users.manage` is ADMIN-only. See "Roles & per-world access".

Outstanding across the project:

- The old Hetzner box (`~/.ssh/mc_yoshling`) is still running as a rollback. Delete
  it once Minecraft and 7DTD have been started and joined on netcup.
- **`pz.yoshling.xyz` DNS record** doesn't exist yet (needs the Cloudflare
  dashboard); players use the raw IP.
- **The netcup root password was pasted into a chat transcript and should be
  rotated.**

> **Keep this file current** — see "Documentation rules" at the top. Update it after
> meaningful changes (features, deploys, infra/config, new gotchas) so a fresh
> session can tell where things stand, and put game-specific depth in that game's
> `docs/` file rather than here. Both are part of finishing a task, not optional
> extras.

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
