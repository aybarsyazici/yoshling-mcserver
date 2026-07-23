# Yoshling — Game Server Control

A web app to control two game servers (Minecraft + 7 Days to Die) running on a
single Hetzner box, from a Discord-authed dashboard. One box, two worlds: only
one game runs at a time (8 GB RAM), and powering one on gracefully saves + stops
the other.

## Stack

- **Next.js 16** (App Router, Turbopack, `output: "standalone"`) + **React 19**
- **Prisma 7** with the **libSQL/SQLite** adapter (`@prisma/adapter-libsql`) — client generated to `src/generated/prisma`
- **NextAuth v5** (Discord OAuth, JWT sessions, invite-only via `ALLOWED_DISCORD_USERS`)
- **Tailwind v4** + shadcn/base-ui components + **Catppuccin** theming (Latte/Mocha)
- **motion** (Framer) for animation; **recharts** for monitor graphs
- Server control is done by shelling out to the **Docker CLI** against a mounted
  `/var/run/docker.sock`

## Architecture

Three containers via `docker compose` (see `docker-compose.yml`):

| Container | Image | Purpose | Web reaches it as |
|-----------|-------|---------|-------------------|
| `yoshling-mc` | `itzg/minecraft-server` | Minecraft, ports 25565 + RCON 25575 | host `minecraft` |
| `yoshling-7dtd` | `vinanrra/7dtd-server` | 7DTD, ports 26900-26902, telnet 8081, webadmin 8080 | host `sevendtd` |
| `yoshling-web-1` | this app | Next.js dashboard | — |

The **web container runs as root** with `docker-cli` installed and the docker
socket bind-mounted — that's how it does `docker start/stop/inspect/stats/logs`
on the game containers. **Do not** revert the Dockerfile to a non-root user or
drop docker-cli; the app cannot control containers without them.

### Game abstraction

- `src/lib/games.ts` — client-safe metadata for both games (accents, routes,
  RAM, connect strings). Single source of truth for identity.
- `src/lib/game-manager.ts` — server-side driver per game. `powerOn(game)`
  performs the graceful hand-off: if the *other* game is running, it saves +
  stops it first, then starts the requested one. Active game is persisted in the
  `GameState` table so a reboot only revives the intended world. A module-level
  **control lock** serializes all start/stop/restart ops — a concurrent request
  throws `ControlBusyError` → HTTP 409 (prevents Restart-button spam / racing
  `docker` commands). `/api/games/status` exposes the in-flight lock as `busy`;
  `useGames` surfaces it so every control UI disables while an op runs.
- `src/lib/rcon.ts` — Minecraft control (save-all, player list) over RCON.
- `src/lib/telnet.ts` — 7DTD control (saveworld, listplayers, console) over telnet.
- `src/lib/server-manager.ts` — thin backward-compat shim delegating to
  `game-manager` for the legacy Minecraft-only `/api/server/*` routes.

### Routes

- `/` → redirect to `/home` (or `/login`)
- `/home` — dual-world landing (the Power Core + one-click power, hand-off confirm)
- `/minecraft/*` — MC overview, mods, server (controls/monitor/backups/console/files), settings, whitelist
- `/7dtd/*` — 7DTD overview, server (controls/monitor/backups/console/files), settings
- `/users`, `/activity` — shared across both games
- API: `/api/games/{status,control,stats}`, `/api/7dtd/{console,backups,config,files}`,
  and the legacy `/api/server/*` + `/api/mods/*` + `/api/modpacks/*`.
- `src/components/file-browser.tsx` is shared: MC uses the default
  `/api/server/files`; 7DTD passes `/api/7dtd/files` + `roots` (Config = the
  serverfiles mount `/sevendtd-config`, Saves = `/sevendtd`).

### Roles & permissions

`src/lib/permissions.ts` — ADMIN / MOD / MEMBER. Server power is ADMIN-only;
mod management is ADMIN/MOD; browsing is everyone. First Discord user to sign in
becomes ADMIN.

## Local development

```bash
npm run dev      # dev server (needs .env — see below)
npm run build    # production build (also the deploy build)
npm run lint     # eslint (not run during build; pre-existing `any` warnings exist)
npx tsc --noEmit # typecheck
```

`.env` (gitignored) needs at least: `DATABASE_URL`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL`, `RCON_*`, and
`SDTD_TELNET_PASSWORD`. Local dev uses `dev.db`.

Migrations: `npx prisma migrate dev --name <x>` locally. **Production has no
automatic migrations** — apply schema changes to the prod DB by hand (below).

## Production / deployment

Host: Hetzner `178.105.163.254`, 4 vCPU / 8 GB RAM / 150 GB disk. SSH as `root`
with `~/.ssh/mc_yoshling`. Deploy dir: `/opt/yoshling` (a git checkout tracking
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

Back up the DB before schema-affecting deploys:
`docker cp yoshling-web-1:/app/data/yoshling.db /root/yoshling-deploy-backup/`.

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
  (name/password/players/difficulty/day length/RAM) plus an **"All settings"**
  expander backed by `/api/7dtd/config/all`, which reads *every* `<property>` in
  `sdtdserver.xml` (comment → help text) and writes back changed ones. Telnet/admin
  keys are locked out of that editor. All XML edits need a 7DTD restart to apply.
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
  first. There is NO in-UI version switcher yet (the web container can't run
  `docker compose` and doesn't mount `/opt/yoshling`; the MC version-switcher in
  Settings has the same latent limitation).
- **World upload:** `/api/7dtd/world` (ADMIN) accepts a `.zip`, auto-detects
  world-vs-save from marker files (`dtm.raw`/`biomes.png`/`prefabs.xml` → world →
  `GeneratedWorlds/<name>`; `main.ttw`/`players.xml` → save → `Saves/`), extracts
  with the container's `unzip`. UI is the uploader card in 7DTD Settings. To play
  an uploaded world: set `GameWorld` to its name in All settings + restart.

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

### Connecting to the game servers (NOT via Cloudflare)

Game traffic can't go through Cloudflare (it only carries HTTP/HTTPS). Players
connect **directly to the box IP `178.105.163.254`**:
- **Minecraft:** `mc.yoshling.xyz` (a **DNS-only / grey-cloud** A record → the box)
  or the IP, port 25565.
- **7DTD:** the app shows both `7dtd.yoshling.xyz:26900` and the raw
  `178.105.163.254:26900`. 7DTD's direct-connect box often only accepts a
  **literal IP**, so the IP is the reliable one. The `7dtd` A record is also
  DNS-only. (`connect` in `games.ts` is a `string[]` so a game can list several.)
- **Firewall is two layers** — the game ports must be open in BOTH the server's
  `ufw` (25565/tcp, 26900/tcp, 26900-26902/udp) AND the Hetzner Cloud Firewall in
  the console. Missing either = "connect hangs, nothing in logs".
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
- Both `main` (local + `/opt/yoshling` on the box) at the merge of the dual-world
  work. `GameState` + `SevenDaysConfig` tables applied to the prod DB.

> Keep this file current. It's the project's living status doc — update it after
> meaningful changes (features, deploys, infra/config, new gotchas) so a fresh
> session can tell where things stand.

## Conventions

- Match the existing component style (shadcn/base-ui + Tailwind, `cn()` helper).
- Per-game accent via the `--tint` CSS var (`GAMES[game].tint`): Minecraft =
  emerald/teal, 7DTD = rust/orange.
- Reusable motion primitives live in `src/components/motion.tsx`; shared bits in
  `src/components/ui-bits.tsx`. The central power indicator is `power-core.tsx`.
- **Copy tone: plain and to-the-point.** No gamer lingo or theatrical framing
  ("reactor", "horde", "hand over", "outlast", etc.). Say what a control does:
  "Start / stop the server", "Switch servers?".
- The silly vacation photos go in page **footers** only (`PhotoFooter` /
  `PhotoStrip`), never the landing, never blocking controls. `caption` is
  optional — most footers show the photo with no text. Only two captions are
  kept: MC mods ("approves of your mod list") and MC whitelist ("I decide who
  gets in!"); 7DTD settings shows "I cant let you get close!".
- Easter egg: `MikuEasterEgg` (mounted in the root layout) — resting the pointer
  in the bottom-right corner for ~1.1s reveals British Miku (image only, no
  caption). Image at `public/british-miku.webp`.
