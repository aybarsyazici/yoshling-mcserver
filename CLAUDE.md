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
| **Adding anything that takes more than ~10s**, or touching banners/toasts | **[`docs/OPERATIONS.md`](docs/OPERATIONS.md)** — the operation registry. A route cannot state its own outcome, and that is enforced by the compiler |
| **Any pre-existing bug, or "is this feature actually correct?"** | **[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md)** — 185 reviewed findings across every route. Check it before assuming a defect is new, and check its §5 before trusting any finding |
| **Any settings page**, or "does this setting actually apply?" | **[`docs/SETTINGS.md`](docs/SETTINGS.md)** — the three-layer settings architecture, configured-vs-live, and the write discipline every settings route obeys |
| **Project Zomboid** — mods, maps, `.ini`, Workshop updates, sandbox options, anti-cheat, a log error | **[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md)** |
| A broken/misbehaving PZ **mod** | [`docs/PZ-MOD-BACKLOG.md`](docs/PZ-MOD-BACKLOG.md) — open defect list; check its harmless list before investigating |
| **7 Days to Die** — telnet, the config wipe, builds, worlds, resets | **[`docs/7-DAYS-TO-DIE.md`](docs/7-DAYS-TO-DIE.md)** |
| **Minecraft** — modpacks, game rules, bans, the offline-UUID trap, the version guard | **[`docs/MINECRAFT.md`](docs/MINECRAFT.md)** |
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
  running, then starts the requested one. **`powerOn` is the only path that
  evicts** — `/api/settings`, `/api/7dtd/update` and `install-modpack` all start a
  container without it, and nothing anywhere *detects* two running worlds and says
  so. Active game is written to the `GameState` table, but **nothing revives
  anything from it**: what comes back after a reboot is decided entirely by each
  service's compose `restart:` policy. (The column is write-mostly; it was
  documented here as the reboot mechanism for months and never was.) A module-level
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
  - **Every long operation goes through the operation registry — see
    [`docs/OPERATIONS.md`](docs/OPERATIONS.md).** `OperationBanner` is **gone**,
    replaced by `OperationLedger`. The control lock is now a projection of that
    registry rather than the source of truth, so `busy` still means what it always
    did for `game-controls.tsx` and `mission-control.tsx`. **If you add a long
    operation, wrap it in `runOperation` — do not invent a second mechanism.**
  - **"Container running but unreachable" is its own state — FIXED 2026-09-27
    (`a7d76b8`), don't collapse it back into "stopped".** The status probe asks the
    game (RCON/telnet), so a container that is up but not answering used to render
    as powered down. The UI then offered **Power on**, which runs `docker start` on
    an already-running container — a no-op that toasted success and changed nothing,
    leaving no route to recovery from the dashboard. Seen 2026-09-22 when PZ's game
    loop wedged (see docs/PROJECT-ZOMBOID.md). `GameStatus` now carries
    `containerRunning` and `startedAtMs` separately from `status`, and
    `game-controls.tsx` derives three states from them: *Stopped*, *Starting…*
    (unreachable but young), and *Not responding* (unreachable for >12 min, which
    names Restart as the way out). **Restart is gated on `containerRunning`, not on
    `isOnline`** — that inversion is the whole fix, because the useful action and
    the honest label were both missing at the same time.
  - **`withGameStopped(game, action, fn, {stage, restartOnFailure})`** is the wrapper
    for "stop the world, do something to its files, start it again". It captures
    `wasRunning` **before** stopping and gates both halves on it, so it can never
    start a world that was already stopped — several audit findings claimed otherwise
    and were refuted; preserve that property. `restartOnFailure` matters and the two
    callers want opposite things: a **mod update** passes `true`, because `seedMods`
    throws on a partial download and leaving the world down for one unfetchable mod is
    worse than booting the previous version (`restart: "no"` means nothing revives
    it). A **backup restore** passes `false`, because a half-replaced save booted is
    worse than a stopped one — the game rewrites the mess on its first autosave and
    takes the archive's contents with it. Getting this backwards is silent.
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
  **A reply over 4096 bytes does not fit one RCON packet and this transport loses the
  rest** — `rcon-client` resolves on the first packet and drops the others. That silently
  cut PZ's `showoptions` from 137 settings to 79 (the first 4,102 of 6,789 bytes) with no
  error and `available: true`. Anything that *enumerates* — `showoptions`, `banlist`, a
  `list` on a busy server — must use **`rconCommandLong`** (`src/lib/rcon-long.ts`), which
  drains until the server goes quiet the way `scripts/rcon.py` always has. Short control
  commands stay on the cached socket; that is the right transport for a poll running every
  few seconds. Framing and the reasoning: `src/lib/rcon-frame.ts`. `sendCommandLong` is the
  Minecraft wrapper for it.
  **A `timeoutMs` argument only governs because the cache now passes it to `Rcon.connect`
  (fixed 2026-10-01).** `rcon-client` keeps its own per-packet deadline in `config.timeout`
  — default **2000 ms**, fixed when the socket opens — and rejects the send itself when it
  fires, so for months every declared budget was silently capped at 2 s and the
  `withTimeout` race never ran. `FLUSH_RCON_TIMEOUT_MS = 120_000` for a 217 MB world flush
  was one of the two victims. A cached socket is therefore **reused only when its own fuse
  is at least as long as the new caller's budget** — a shorter fuse cannot be stretched, and
  the 3 s status-poll socket is the one almost any slower caller would otherwise inherit.
  Pinned in `src/lib/__tests__/rcon-timeout.test.ts`; worked example in
  [`docs/MINECRAFT.md`](docs/MINECRAFT.md#rcon-timeouts-actually-apply-now).
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
  `/minecraft/whitelist` 301s to it. Minecraft's *in-game* whitelist, ops **and bans**
  live on the MC settings page (`/api/server/{mc-whitelist,ops,bans}`). The activity log
  hides entries for worlds the viewer can't see.
- API: `/api/games/{status,control,stats}`, `/api/7dtd/{console,backups,config,files,world}`,
  `/api/zomboid/{console,backups,config,config/import,files,mods}`, and the legacy
  `/api/server/*` + `/api/mods/*` + `/api/modpacks/*`.
- **Minecraft game rules are `/api/server/gamerules`** (the Game rules panel on MC
  settings) — the only config surface in the app that reads and writes the **running game**
  rather than a file. Two properties to keep, both load-bearing: **the rule ids are
  discovered with `help gamerule`, never hardcoded**, and **a write is followed by a fresh
  query** so the UI shows what the game read back rather than what was typed. That
  discovery read **must** go through `sendCommandLong` — its reply is 5 KB with zero
  newlines and `sendCommand` cuts it at 4096. Depth, the measurement and the floor that
  stops a short read rendering as a complete one:
  [`docs/MINECRAFT.md`](docs/MINECRAFT.md#game-rules).
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

1. patches **`.env`**, not compose (`lib/dotenv-patch.ts`). Compose interpolates —
   `MEMORY: "${MC_MEMORY:-4G}"` — so the app no longer writes a git-tracked file and
   `deploy.sh`'s `git checkout -f` can no longer discard a setting. The scoping lesson
   survives one layer down as per-service key names (`MC_VERSION` vs the `sevendtd`
   block's own `VERSION`), because the same word means different things in different
   service blocks. The write is temp-file + `rename`, ENOENT-only on read, mode 0600,
   one `.env.bak` kept — **`.env` is gitignored and holds every production secret, so
   unlike the compose file it replaced there is nothing to restore it from.**
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
none** — it's a Unity native server with no JVM, so the card explains that instead
of offering a control that does nothing. (It is not actually *mounted* on the 7DTD
settings page, so that explanation currently never renders — a real gap, not a
deliberate omission.)

**There is no `MAX_GAME_GB` constant**, and this said "6" and "the 8 GB box" long
after the move to netcup. The cap is derived at request time:
`maxGameGb()` = `/proc/meminfo` MemTotal − `HOST_RESERVE_GB` (2.5) ≈ **13 GB** on
the 16 GB box. Two things follow. That ceiling **assumes the world is alone on the
box** — but it now *says so* where someone picks a heap, and two worlds running at once
is reported rather than silent (see `src/lib/coresidency.ts`). And PZ's `RUNTIME` entry
patches only `MAX_MEMORY`, not `MIN_MEMORY` — choosing a heap below the compose
`MIN_MEMORY` would write `-Xmx` under a larger `-Xms`, a JVM that refuses to start.
**`setMemory` now reads `MIN_MEMORY` and refuses before admission**, and the card's
buttons start at that floor rather than offering 1 GB for a world whose `-Xms` is 2 GB.
`MIN_MEMORY` → `-Xms` is measured, not inferred (production: `-Xms2048m -Xmx12288m`).

**Every container now has a `mem_limit`** (MC 6g, 7DTD 10g, PZ 14g) — previously none
did, and it was the only thing that would have contained the over-commit that put this
box 2 GB into swap. **Size one against `-Xmx` plus 1–2 GB of non-heap, and judge it
from `memory.stat`, not `docker stats`** — the latter's `MemUsage` includes page cache,
so a healthy PZ reads as 98% of its limit. Worked example, including why PZ's first
limit was wrong: [`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

`/api/settings` no longer touches memory at all; it only patches `TYPE`/`VERSION` —
and it does that through **`applyServiceEnv`** in `game-manager`, which is now the one
sanctioned way to change a service's env: it patches the scoped compose block, saves +
stops if the world was running, runs `create --force-recreate` (never `up`, so a
stopped world stays stopped rather than being booted into co-residency), starts it
again only if it was running, and holds the control lock throughout. `setMemory` had
all of that right and `/api/settings` had open-coded a bare `docker compose up -d`
with none of it.

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
npm test         # vitest, 731 tests, ~2s, no Docker/network/server needed
```

**Run `npm test` before you ship.** It exists because the same classes of defect kept
coming back: the power control drifted into three copies where two missed a fix, and a
`noop` step turned every clean backup into an amber "this is not a restore point". Both
were one assertion away from being caught. Details, and what it deliberately does *not*
cover, are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

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
(**`178.105.163.254`** — this file had it as `89.58.50.155`, a copy of netcup's own
IP, which makes the two indistinguishable in exactly the commands where it matters;
key `~/.ssh/mc_yoshling`) is kept as a rollback until each game has been played on
netcup. **The two keys are not interchangeable** — verified 2026-09-28,
the **Hetzner** key against the netcup box gets
`Permission denied (publickey,password)`. Every command in this file targets netcup,
so it must use `~/.ssh/mc_yoshling_netcup`; snippets here that said `mc_yoshling`
simply did not work. Deploy dir: `/opt/yoshling` (a git checkout tracking
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
scp -i ~/.ssh/mc_yoshling_netcup /tmp/y.bundle root@89.58.50.155:/root/
ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 '
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

**`/api/settings` writes `/opt/yoshling/.env`, NOT `docker-compose.yml`** (changed
2026-09-30). Changing the Minecraft version/loader in the UI patches `MC_TYPE` /
`MC_VERSION`, which compose interpolates as `${MC_TYPE:-FABRIC}` / `${MC_VERSION:-26.1.2}`,
then recreates the service through `applyServiceEnv`. `.env` is gitignored, so the value
survives `deploy.sh`'s `git checkout -f` — which is the whole reason it moved.

Two pieces of history worth keeping, because both were expensive:

- The route once regenerated the whole compose file from a **two-service template**,
  silently deleting the `sevendtd` (and later `zomboid`) services and the volume
  declarations the web container mounts. Keep any compose write a *scoped patch*.
- `VERSION` means the Minecraft version in one service block and the **Steam branch** in
  another, which is why the `.env` keys are per-service (`MC_VERSION`, not `VERSION`).

**One writer of compose remains**: `/api/7dtd/update` flips `START_MODE` to 3 and back to
1 inside a single operation. Deliberately left there — moving it to `.env` would have the
first update rewrite `${SDTD_START_MODE:-1}` into a bare literal and detach the line
permanently, trading a dirty file that self-heals within one operation for silent drift.
`deploy.sh`'s compose guard is the backstop.

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

> **Read [`docs/7-DAYS-TO-DIE.md`](docs/7-DAYS-TO-DIE.md) first for anything 7DTD.**
> It was 99 lines in this file that every Minecraft and Project Zomboid session paid
> for. The three traps worth carrying without opening it:
>
> - **Control is telnet on 8081, and the `TELNET_PASSWORD` env var does not enable it**
>   — only a `TelnetPassword` in `sdtdserver.xml` does, and it must match
>   `SDTD_TELNET_PASSWORD` in `.env`.
> - **A fresh SteamCMD install wipes `sdtdserver.xml` to defaults, and a host
>   migration counts as fresh.** It boots a brand-new empty world and the dashboard
>   goes blind. The app's `SevenDaysConfig` DB row survives and is the recovery source;
>   the live save is `GameWorld=Reveo Valley` + `GameName=Fresh2`.
> - **Client↔server build mismatch is the #1 "stuck at Starting game" cause.** The
>   server only re-downloads on `START_MODE=3`. It is not a corrupt save — we chased
>   that.

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
- **The driver stops PZ by asking the game to `quit` over RCON — FIXED 2026-09-29.**
  A PZ stop is now **~12 seconds, exit code 0**; it used to be a flat five minutes
  ending in SIGKILL. `entry.sh` runs as PID 1 with no SIGTERM trap, and the kernel
  *discards* uncaught signals for a namespace's PID 1, so `docker stop` could never
  reach the game — the only thing that works is asking the game itself. The
  `stop_grace_period: 300s` / `PZ_STOP_TIMEOUT` stays as the **fallback** for a server
  too wedged to answer RCON; it is no longer the normal path. Before touching this read
  [`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md) — this file claimed for months
  that the entrypoint trapped SIGTERM, which is what stopped three audits looking.
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
- **Project Zomboid:** `pz.yoshling.xyz:16261` or the raw `89.58.50.155:16261`.
  The `pz` A record **does exist** (DNS-only / grey-cloud → the box), as do `mc`
  and `7dtd`; this file claimed for weeks that it still had to be created.
- **`ufw` is NOT the only gate, and it does not cover published container ports.**
  netcup has no cloud-firewall product, so ufw is the only *host* gate
  (25565/tcp, 26900/tcp, 26900-26902/udp, 16261-16262/udp, 8766-8767/udp) — but
  Docker publishes ports with a DNAT rule, and the `FORWARD` chain reaches Docker's
  own chains **before** any ufw chain, so that traffic never passes through `INPUT`
  at all. `DOCKER-USER` is the only place a rule can intercept it, and on this box
  `iptables -S DOCKER-USER` is empty. Measured 2026-09-28 from outside:
  `curl http://89.58.50.155:3000/login` → **200, cleartext, bypassing Cloudflare
  and Caddy entirely**, and 7DTD's telnet on 8081 accepted a connection from a
  public IP (it logged `INF Telnet connection from: …`). So **every `ports:` entry
  in `docker-compose.yml` is world-reachable regardless of ufw** — publish to
  `127.0.0.1:` when only the host needs it, and put DROP rules in `DOCKER-USER`,
  not in ufw. (On Hetzner this was two layers and missing either meant "connect
  hangs, nothing in logs"; the move removed the cloud layer, which is what made
  this gap consequential.)
- Server-browser listing: 7DTD `ServerVisibility=2` (public) in `sdtdserver.xml`;
  set a unique `ServerName` (via 7DTD Settings) to find it, or just direct-connect.

## Status

**Live** at `https://yoshling.xyz` on **netcup `89.58.50.155`** (Cloudflare Full
(strict), verified end-to-end). Migrated off Hetzner 2026-09-13 — see MIGRATION.md.

- **Minecraft: boots and has been exercised end to end** (2026-09-29/30). The old
  version mismatch is gone — compose, `ServerConfig.mcVersion` and the jars on disk all
  say **26.1.2**, and it starts in `Done (1.661s)!`. Power on, off, restart, backups
  (including a real restore), mods, modpack refusals, `server.properties`, the file
  browser and the console have all been run against the live container.
  **Its in-game whitelist and ops never worked until 2026-09-30** — both files were
  written with `uuid: ""`, which matches nobody, so enabling the whitelist and adding
  yourself locked *everyone* out with a green success toast. `src/lib/mc-identity.ts`
  now derives the offline UUID the way the server does
  (`md5("OfflinePlayer:" + name)`, v3). The MC layer is still the oldest code here.
  **Game rules became reachable 2026-10-01** (`/api/server/gamerules` + the Game rules
  panel) — see Routes and [`docs/MINECRAFT.md`](docs/MINECRAFT.md#game-rules). Before that
  the dashboard could *detect* that a `server.properties` key had moved to a game rule,
  refuse the write, and then only tell you to type the command yourself, for 58 rules none of
  which it listed. Someone was doing exactly that: production has
  `enable-command-block=false` in the file against `command_blocks_work = true` in the world,
  and `mob_griefing` is false with nothing in this app having set it. **The live
  `help gamerule` reply has been captured and is a test fixture** — 5 KB, no newlines, 58
  rules each listed twice; it is parsed by the suite. The first version of this shipped a
  parser that read **one** rule out of it and a route that answered 200 with that one rule,
  and the write path is now **exercised on the live container too** (2026-10-02): the GET
  reads all **58** rules in **0.787 s** (58 RCON round trips, against a 4 s budget), a write
  lands and is confirmed by an independent `rcon-cli` read, a camelCase id is refused with
  *"not one of the 58 game rules this server just listed, so nothing was sent"*, and
  `random_tick_speed=banana` is refused with the current value so the control can snap back.
  Production also confirms two things this file already claimed: `mob_griefing` is `false`
  with nothing in this app having set it, and `command_blocks_work = true` against
  `enable-command-block=false` in the file.
  **Ban management was added 2026-10-01** (`/api/server/bans` + a card on the MC settings
  page), closing the whitelist/ops/bans set. It is routed on a live RCON socket rather than
  on `docker inspect` and reads every outcome back. **Exercised end to end on the live
  container 2026-10-02**: ban → the game reports it → the file carries a real UUID
  (`95911851-…`, *not* the `uuid: ""` that used to lock everyone out) → pardon → verified by
  read-back → files and game both empty again. **One hard limit, and it is the server's:**
  `banlist` sends no separator between entries, so a reply with two or more bans cannot be
  parsed and the live cross-check honestly answers "cannot confirm". The files stay
  authoritative. Measured, with the real reply committed as a fixture, and the obvious fix is
  wrong — see [`docs/MINECRAFT.md`](docs/MINECRAFT.md#bans).
- **The mod installers now filter by side and verify downloads** (2026-10-01,
  `src/lib/mod-admission.ts`, tested). Two holes, both the house defect class. Every pack
  mod went into the *server's* mods dir regardless of side — a large pack is 30–50%
  client-only (Sodium, Iris), where the good case is wasted disk and the bad case is Fabric
  Loader aborting on a jar with no server entrypoint, i.e. a permanent "Starting…" with the
  cause nowhere on screen. And `ModrinthFile.hashes` had been typed since the file was
  written with nothing reading it, so a truncated download wrote a bad jar and the route
  answered `{success:true}`. Now: **skip only on a positive `unsupported`** (`environment` is
  a *string* on the API, not the `env:{client,server}` object the `.mrpack` format uses), skips
  are **named** in the response and the ledger, and `downloadVerifiedJar` hashes in memory and
  throws `ModIntegrityError` **before** any write, so a bad jar never exists in the mods
  directory. One helper for both `/api/mods/install` and `install-modpack`. **The denominator
  changed and that is the load-bearing part:** "installed n of m" counts *mods that belong on
  this server* (pack rows − client-only), because counting the skips would make every correct
  apply settle `noop` → outcome `partial` → amber, which is the backup-`noop` regression the
  test suite exists for. See `serverModTotal`.
  - **Not yet run against a live pack.** The enum and the hashes were measured against the
    real Modrinth API, but no modpack has been applied through it. The three saved packs that
    could exercise it are the ones a version guard refuses anyway (below).
  - **`environment` has ten values, not six and not nine.** This said nine over 200 projects /
    360 versions, which was an intermediate scan; the one the code is built from is **527
    projects / 2,751 versions** and it is the table on `ENVIRONMENT_TO_SERVER` in
    `src/lib/mod-admission.ts` — ten rows, with each value's count and its sampling written
    out beside it. Don't restate the list here; a second copy of an enum Modrinth can extend
    is how one of them goes stale, which is exactly what happened to this bullet. The narrow
    160-version sample missed `singleplayer_only`, the one value that changes an answer from
    install to skip. An earlier version of this paragraph also said the two signals "never
    disagree on a skip, only on an install"; true of the 160-version sample, false of the
    wider one (17 counter-examples). An unmapped value now fails loudly rather than silently.
  - **Both installers and the report UI have behavioural tests** (2026-10-02):
    `src/lib/__tests__/mod-install-routes.test.ts` drives `/api/mods/install-modpack` and
    `/api/mods/install` as routes with only the edges faked — the real gates, the real plan,
    the real operation registry — and `tests/modpack-report.test.tsx` renders the report
    dialog. Written against eleven named mutants; see
    [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
- **7 Days to Die: running on netcup since 2026-09-26**, game **V 3.3.0 (b14)** on
  `latest_experimental`. The first start re-downloaded 17.7 GB and wiped
  `sdtdserver.xml` to defaults — see the 7DTD section; config was restored from the
  `SevenDaysConfig` DB row and the save on disk (`Reveo Valley` / `Fresh2`). Telnet
  control verified working again (the app's status probe runs every ~10s). **An
  in-game join on netcup has still not been observed** — the server reported
  `Total of 0 in the game` when it was handed back.
- **Project Zomboid:** running, 89 mods, played on daily. Full status, what's
  verified and what's outstanding: **[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md#status)**.
- **Per-world access:** deployed; `User.games` + `ZomboidMod` applied to the prod
  DB and all 5 accounts backfilled with all three worlds. **They are all ADMIN**, a
  leftover from the old signup bug — a non-ADMIN role is what makes the per-world
  chips actually bite, so demote whoever shouldn't be an admin on the Crew page.
- **MOD now has the same capabilities as ADMIN**, scoped to its granted worlds;
  only `users.manage` is ADMIN-only. See "Roles & per-world access".

### Full audit, 2026-09-28

A 22-agent audit covered every feature and route: **[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md)**.
185 findings, each adversarially reviewed. Read its §5 (refuted/downgraded) before
acting on anything in it — **9 of 13 criticals were downgraded by their own
verifier**, several findings are simply wrong, and two prescribe fixes that don't
work. The corrections it produced are already applied throughout this file.

Two conclusions outrank the individual findings. **The recently-rewritten core is
good — don't spend time there**; the control lock, reachability states, staged
`restartGame`, scoped `patchServiceEnv` and `gameGate` all held up, and several
findings blaming them were refuted by forensics. And **the recurring defect class is
"reports success after doing nothing or the wrong thing"**, not crashes — so when you
add anything here, make the success path *prove* it succeeded, the way the memory
card's configured-vs-live comparison does.

Outstanding across the project:

**Fixed and deployed 2026-09-28** (kept here only so nobody re-reports them): the MC
backup shell injection; the public exposure of ports 3000/8080/8081; `install-modpack`
clobbering compose; restores that never stopped the server; the missing `mem_limit`s
and log rotation; the Minecraft version mismatch (**Minecraft now boots — verified,
`Done (1.661s)!`**); `/api/settings` starting a stopped world outside the lock; the
file-browser GETs exposing `rcon.password`; and the zombie-process leak. Details and
the per-finding corrections are in
[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

Still open — and the list is now short enough to state precisely.

**Closed 2026-09-29/30, listed only so nobody re-reports them:** PZ's five-minute
SIGKILL stop (now ~12 s, exit 0, via RCON `quit`); the app writing `docker-compose.yml`
(now `.env`, gitignored, survives `git checkout -f` — compose hashes verified identical
on deploy); no test suite (`npm test`, 731 tests); no co-residency detection; backups
having no retention/pruning/checksums/download/schedule; Minecraft's in-game whitelist
and ops writing `uuid: ""`; the 7DTD `TelnetPassword` (rotated and telnet control
re-verified end to end); the 224 dead `ModpackMod` rows (re-imported). Details in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) and
[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

**Closed 2026-10-01 — the settings revision.** Every settings page now shows **configured
next to live**: the game is asked what it believes (`showoptions` over RCON for PZ,
`getgamepref` over telnet for 7DTD, `difficulty`+`list` over RCON for Minecraft) and the
answer is compared with the file, with "not reported" as a third verdict so an unanswered
question never renders as a disagreement. Full architecture, coverage numbers and the write
discipline: **[`docs/SETTINGS.md`](docs/SETTINGS.md)**. Also closed: the PZ sandbox options
are editable from the dashboard and the writer is **verified against the live 74 KB /
335-option file** (new inode, hard-linked `.bak`, a real value round-tripped and the file
returned to its exact starting md5); the `server.properties` help layer; the 7DTD
`ServerMaxPlayerCount` silent clamp; the XML entity-doubling round trip; and the console
route calling a busy-but-running server "powered off" (see `src/lib/rcon-failure.ts` —
`ETIMEDOUT` as a socket code and the bare message `"timeout"` mean opposite things).

Genuinely open:

- **`COBBLEVERSE` publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11**, so on a
  26.1.2 server neither can install no matter how often it is re-imported. The apply
  refuses with an honest version mismatch. Not a bug — a fact about those packs.
- **`create` still snapshots a live world**, so a manual backup taken while people play
  can be torn. The automatic ones refuse while anyone is connected; a manual one is the
  operator's call.
- **Two out-of-band safety sets are on the box** and nothing prunes them:
  `/root/pre-fix-backup-2026-09-28/` (1.1 GB) and `/root/safety-backup-2026-09-29/`
  (1015 MB), both finished writing on the dates in their names. Retention does not reach
  outside `/app/data`, so they stay until somebody deletes them — but measured 2026-10-01
  the box is at **34 % of 314 GB with 201 GB free**, so this is tidiness, not pressure. It
  read like it needed action; it does not.
- **`/api/7dtd/update` is the last compose writer** (a transient `START_MODE` flip inside
  one operation). Deliberate — see the deployment section.
- **Needs a human, not code:**
  - **The netcup root password is still the one from a chat transcript.** Rotating it
    needs the netcup control panel; nothing in this repo can do it.
  - **The old Hetzner box (`178.105.163.254`) is still running** as a paid rollback.
    Minecraft now boots on netcup and every feature has been exercised here, so the
    original reason to keep it is gone — but deleting it is a judgement call.
  - **No in-game join has ever been observed on netcup**, for 7DTD *or* Minecraft. The
    dashboard's telnet and RCON views are healthy and the worlds boot, but only a person
    with the game can prove a client connects.

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
