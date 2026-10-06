# Migration runbook — Hetzner → netcup

**Status: the move is DONE (2026-09-13). The acceptance checklist is NOT.** Live on netcup
`89.58.50.155` (8 vCPU / 16 GB / 314 GB, Debian 13).

**Do not read "DONE" as "Hetzner can be deleted."** Step 8's gate — *"Actually join
Minecraft, 7DTD and PZ from a client"* — is still unticked, and `CLAUDE.md` confirms it:
**no in-game join has ever been observed on netcup for Minecraft or 7 Days to Die.** Project
Zomboid is played on daily, so one of the three is proven and two are not. Both unproven
worlds boot and their telnet/RCON views read healthy, but only a person with the game can
prove a client connects — and "healthy server, client cannot join" is precisely the 7DTD
build-mismatch failure mode this repo has already paid for. **The old Hetzner box (`178.105.163.254`) is the rollback for
exactly that risk**, so deleting it is a judgement call someone has to make knowingly, not
something that falls out of this line being green. This header said a flat "DONE" with the
unmet gate 160 lines below it.

What tripped us up, for next time:
- The provisioned SSH key file was missing its **trailing newline**, so OpenSSH
  rejected it as "invalid format". `printf '\n' >> key` fixed it; no password needed.
- **Seed the Workshop mods with SteamCMD before starting PZ** (see CLAUDE.md).
  Letting PZ download 75 items crashed it twice.
- Only ~1.6 GB actually moved, in ~13 s at 109 MB/s box-to-box. 7DTD's 16.8 GB of
  game files and PZ's 3.8 GB of mods were re-fetched on the new box as planned.
  (This said ~1.3 GB against ~1.6 GB in two other places in this file. 1.6 is the one the
  volume table and the `scp` comment agree on.)
- The Cloudflare Origin cert moved as-is (wildcard, valid to 2041) and
  `direct.yoshling.xyz` re-issued from Let's Encrypt automatically.
- To prove which origin Cloudflare was using, add a temporary
  `header X-Origin-Box "..."` to the new box's Caddyfile and curl the public URL —
  DNS can't tell you, because the root is proxied.

Why we're moving: Hetzner wanted ~€40/mo for 16 GB; netcup is €12.61 for the
same RAM. The workload is **RAM-bound, not CPU-bound** — Project Zomboid sits at
~3% CPU — so netcup's cheaper shared cores are fine here. See "Sizing" below.

Do not cancel Hetzner until the new box is verified working. Hetzner bills
hourly, so a few days of overlap costs ~€2.

---

## What actually has to move

Only **~1.6 GB**. Most of the 19 GB of volumes is re-downloadable game content.

| Volume | Size | Move it? |
|--------|------|----------|
| `yoshling_web-data` | 601 MB | **Yes** — the app DB (`yoshling.db`), backups, stats |
| `yoshling_mc-data` | 489 MB | **Yes** — the Minecraft world |
| `yoshling_sdtd-saves` | 490 MB | **Yes** — 7DTD worlds + `GeneratedWorlds` |
| `yoshling_pz-data` | 25 MB | **Yes** — PZ `Server/*.ini`, save, player db |
| `yoshling_sdtd-backup` | 1 MB | Yes (tiny) |
| `yoshling_sdtd-server` | 16.8 GB | **The 16 GB of game files: no. `sdtdserver.xml` inside it: YES — see below** |
| `yoshling_pz-workshop` | 624 MB+ | **No** — Workshop mods, the server re-downloads them |
| `yoshling_sdtd-log` | 18 MB | No |

> ### ⚠️ `sdtd-server` is not only game files — it holds the 7DTD config
>
> **This row said a flat "No" and that is how the last migration cost what it cost.**
> `yoshling_sdtd-server` is mounted at `/home/sdtdserver/serverfiles` in the game container
> **and at `/sevendtd-config` in the web container**, and `sdtdserver.xml` — every 7DTD
> setting, including the `TelnetPassword` without which the dashboard has no control at all —
> lives in it. Verified 2026-10-06: `/sevendtd-config/sdtdserver.xml`, 13,726 bytes, carrying
> `GameWorld="Reveo Valley"`, `GameName="Fresh2"`, `ServerVisibility=2`.
>
> Skipping the volume wholesale is right for the 16 GB SteamCMD payload and **wrong for that
> one file**. A fresh SteamCMD install writes a default `sdtdserver.xml`, which boots a
> brand-new empty world with telnet disabled and the dashboard blind — exactly what happened
> on 2026-09-26. So: **copy `sdtdserver.xml` out before you migrate, and put it back after the
> first boot has finished re-downloading.** The app's `SevenDaysConfig` DB row is the other
> recovery source; see [`docs/7-DAYS-TO-DIE.md`](docs/7-DAYS-TO-DIE.md).

Plus `/opt/yoshling` (the git checkout, 262 MB) and critically **`/opt/yoshling/.env`**,
which is gitignored, exists nowhere else, and holds **two different things**:

```
# Secrets
DATABASE_URL  DISCORD_CLIENT_ID  DISCORD_CLIENT_SECRET  AUTH_SECRET  AUTH_URL
RCON_PASSWORD  ALLOWED_DISCORD_USERS  SDTD_TELNET_PASSWORD  DIRECT_UPLOAD_HOST
PZ_RCON_PASSWORD  PZ_ADMIN_PASSWORD  STEAM_API_KEY  STEAM_API_KEY_DOMAIN_NAME

# Applied settings — every value the dashboard has ever written. Compose
# interpolates each one; losing the file silently reverts the setting to the
# compose default, with no error anywhere.
MC_TYPE  MC_VERSION  MC_MEMORY  PZ_MAX_MEMORY  SDTD_START_MODE
```

> **This block listed only the first group, and framed the file as credentials.** Since
> 2026-09-30 `.env` is also **where applied settings live**: `/api/settings` and `setMemory`
> patch it rather than `docker-compose.yml`, precisely so that `deploy.sh`'s
> `git checkout -f` cannot discard a setting. Compose reads them back as
> `${MC_VERSION:-…}`, `${MC_MEMORY:-4G}`, `${PZ_MAX_MEMORY:-12288m}` and friends — so
> **reconstructing `.env` from the old list, which is what this block is for, silently
> reverts the Minecraft version, both heap sizes and the 7DTD start mode to compose
> defaults.** For `MC_VERSION` that means dropping back to the default against a 26.1.2
> world on disk, i.e. the version-mismatch crash loop this project already paid for once —
> and it fails as a perpetual "Starting…" with the cause nowhere on screen. Believable
> because the list was complete and correct when it was written, and because every name in
> the first group still *is* a secret.
>
> Two consequences. **`.env` has no restore source** — unlike the compose file it replaced,
> nothing in git can rebuild it, so it is the single most important thing to copy. And
> `${PZ_RCON_PASSWORD}` and `${SDTD_TELNET_PASSWORD}` are declared `${VAR:?…}` in compose
> with **no default**, deliberately: a lost `.env` makes the container refuse to start
> rather than authenticate with a stale fallback and have the dashboard quietly report the
> world offline.

`AUTH_SECRET` must carry over or every existing session is invalidated.

---

## Steps

### 1. On the new box (before touching DNS)

```bash
# Docker + the compose plugin. The plugin is REQUIRED — the app recreates
# containers through compose to apply config changes (see CLAUDE.md).
curl -fsSL https://get.docker.com | sh
docker compose version   # must work

# 8 GB swap. Not optional: PZ's shared-memory region is large and cold pages
# belong in swap. Without it, a spike is a hard OOM kill.
fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab
echo "vm.swappiness=10" > /etc/sysctl.d/99-swappiness.conf && sysctl -p /etc/sysctl.d/99-swappiness.conf
```

### 2. Ship the code (the box has no GitHub key — use a bundle, as always)

```bash
# on the laptop
git bundle create /tmp/y.bundle main
scp /tmp/y.bundle root@NEW_IP:/root/
scp root@178.105.163.254:/opt/yoshling/.env /tmp/y.env   # secrets, not in git
scp /tmp/y.env root@NEW_IP:/root/y.env

# on the new box
mkdir -p /opt/yoshling && cd /opt/yoshling
git init -q && git fetch /root/y.bundle main && git checkout -f -B main FETCH_HEAD
git remote add origin git@github.com:aybarsyazici/yoshling-mcserver.git
mv /root/y.env .env
```

### 3. Move the five volumes that matter

(The heading said four; the table marks five and both loops iterate five. Five.)

```bash
# on the OLD box, with the game containers STOPPED
for v in web-data mc-data sdtd-saves pz-data sdtd-backup; do
  docker run --rm -v yoshling_$v:/from -v /root/vols:/to alpine \
    tar czf /to/$v.tar.gz -C /from .
done
scp -r root@178.105.163.254:/root/vols /root/vols   # ~1.6 GB

# on the NEW box. --profile games, or the three worlds' volumes are not created:
# every game service is behind `profiles: ["games"]` and a bare `create` reaches
# only `web`.
cd /opt/yoshling && docker compose --profile games create
for v in web-data mc-data sdtd-saves pz-data sdtd-backup; do
  docker run --rm -v yoshling_$v:/to -v /root/vols:/from alpine \
    sh -c "cd /to && tar xzf /from/$v.tar.gz"
done
```

### 4. Build and start

```bash
cd /opt/yoshling
# TWO images are built here, not one. Project Zomboid is a LOCAL build
# (pz/Dockerfile on top of danixu86/project-zomboid-dedicated-server, because the
# upstream image's map scanner only looks one level deep and finds no B42 maps).
# Skip it and `zomboid` starts from a stale or absent image, and the debugging goes
# into the map scanner instead of the missing build.
docker compose build web zomboid
docker compose up -d --no-deps web
# Game containers: create but DO NOT start more than one. Only one world fits.
# Naming them explicitly is what reaches them past `profiles: ["games"]`.
docker compose create minecraft sevendtd zomboid
```

> **All three game services are behind `profiles: ["games"]`** (added 2026-10-01, after a
> `--dry-run` showed a bare `docker compose up -d` printing *Started* for all three on a
> 15.6 GB box — the 2026-09-26 co-residency incident with a one-command trigger). Naming a
> service explicitly enables its profile, so the `create` above works as written; a bare
> `up -d` or `create` cannot reach any world, which is the point. A human verifying with
> `docker compose config` or `ps` needs `--profile games`.

7DTD will re-download ~17 GB via SteamCMD on its first start; PZ will
re-download its Workshop mods on its first start (~10 min for the current list).

### 5. Firewall — `ufw` is NOT sufficient, and this is the step that was wrong

> **`ufw` does not cover published container ports, so this step used to build a box whose
> dashboard and 7DTD telnet were open to the internet — with `ufw status` showing a tidy
> allow-list that implied otherwise.** That was the box's real state for two weeks, and it
> was measured from outside on 2026-09-28: `curl http://89.58.50.155:3000/login` returned
> **200 in cleartext**, bypassing Cloudflare and Caddy entirely, and 7DTD's telnet on 8081
> accepted a connection from a public IP (the game logged `INF Telnet connection from: …`).
>
> The mechanism: Docker publishes a port with a **DNAT** rule, and the `FORWARD` chain
> reaches Docker's own chains **before** any ufw chain, so that traffic never passes through
> `INPUT` at all. ufw only ever sees host-process traffic. **`DOCKER-USER` is the only place
> a rule can intercept it.** The heading said "`ufw` only, simpler than Hetzner" — true that
> netcup has no cloud-firewall product, and the wrong conclusion, because removing the cloud
> layer is what made this gap consequential rather than redundant.
>
> **So treat every `ports:` entry in `docker-compose.yml` as world-reachable regardless of
> ufw.** Publish to `127.0.0.1:` when only the host needs the port, and put DROP rules in
> `DOCKER-USER`.

```bash
# Host-process traffic only. Necessary, not sufficient.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw allow 25565/tcp                                   # Minecraft
ufw allow 26900/tcp && ufw allow 26900:26902/udp       # 7 Days to Die
ufw allow 16261/udp && ufw allow 16262/udp             # Project Zomboid
ufw allow 8766:8767/udp                                # PZ Steam query
ufw enable

# The part that actually closes the published ports: 3000 (the dashboard, which
# must only be reachable through Caddy), 8080 (7DTD web admin) and 8081 (7DTD
# telnet). Must persist across reboots AND across a docker daemon restart, which
# rebuilds the other chains.
iptables -I DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 8080 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 8081 -j DROP
iptables -S DOCKER-USER     # verify: three DROPs, not just the chain declaration
```

> ### ⚠️ The `yoshling-firewall` systemd unit is NOT in this repo
>
> On the live box those rules are installed by a `yoshling-firewall` systemd unit, and
> **that unit exists nowhere in git** — `find . -name '*.service'` returns nothing, and it is
> referenced in prose only (here, [`docs/7-DAYS-TO-DIE.md`](docs/7-DAYS-TO-DIE.md), and a
> comment on `ENVIRONMENT_INERT` in `src/lib/sdtd-settings.ts`). So the one thing standing
> between the public internet and ports 3000/8080/8081 is **unreproducible from the
> repository**, and the `iptables` lines above are a reconstruction from the rule that
> comment records (`-A DOCKER-USER -i eth0 -p tcp -m tcp --dport 8080 -j DROP`, plus 8081
> and 3000, read on 2026-10-01) rather than a copy of the unit.
>
> Worse, the docs disagree about whether the protection is there at all: `CLAUDE.md` and
> `docs/AUDIT-2026-09-28.md` both say `iptables -S DOCKER-USER` is **empty** (2026-09-28,
> three days older). **Capture and commit the unit** — that closes both problems at once:
>
> ```bash
> ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 \
>   'iptables -S DOCKER-USER; systemctl cat yoshling-firewall'
> ```

### 6. TLS + Caddy

- Copy `/etc/caddy/Caddyfile`, `/etc/caddy/certs/origin.pem` and `origin.key`
  (640/600, owned `caddy`) from the old box. The Cloudflare origin cert is a
  **wildcard valid to 2041**, so it moves as-is — no reissue.
- Caddy must be the **official 2.11.4 binary**, not the Ubuntu package: the
  `direct.yoshling.xyz` vhost needs `auto_https ignore_loaded_certs` and
  `request_body { max_size 2GB }`.
- `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` then
  `systemctl reload caddy`.

### 7. DNS last, so there's no outage window

All in Cloudflare. Only the root is proxied; game traffic cannot go through
Cloudflare (it only carries HTTP/HTTPS).

| Record | Type | Proxy | Points to |
|--------|------|-------|-----------|
| `yoshling.xyz` | A | **Proxied** (orange) | NEW_IP |
| `mc.yoshling.xyz` | A | DNS-only (grey) | NEW_IP |
| `7dtd.yoshling.xyz` | A | DNS-only (grey) | NEW_IP |
| `direct.yoshling.xyz` | A | DNS-only (grey) | NEW_IP |
| `pz.yoshling.xyz` | A | DNS-only (grey) | NEW_IP |

All five exist. This table said `pz.` "still needs creating" for three weeks after it was
created — the 2026-09-28 audit flagged it as stale, `CLAUDE.md` has since corrected it, and
`src/lib/games.ts` ships `pz.yoshling.xyz:16261` as a connect address people are given.

Cloudflare SSL/TLS mode stays **Full (strict)**.

### 8. Verify before cancelling Hetzner

State as of **2026-10-06**. The ticks are carried over from what `CLAUDE.md` and
[`docs/CLOSED.md`](docs/CLOSED.md) record as verified, **not re-run today**; the unticked box
is the gate the header refers to, and the whole reason the Hetzner box is still being paid
for.

- [x] `https://yoshling.xyz/login` → 200 (Cloudflare Full (strict), verified end to end)
- [x] Sign in with Discord (proves `AUTH_SECRET` + OAuth carried over)
- [x] Crew page lists all users with their world access intact — 5 accounts, all three
      worlds backfilled
- [x] Power on each world from the UI in turn; each reaches Online — all three have booted
      on netcup, Minecraft last (`Done (1.661s)!`, 2026-09-29)
- [ ] **Actually join Minecraft, 7DTD and PZ from a client** — **PZ only.** It is played on
      daily. **No in-game join has ever been observed on netcup for Minecraft or 7 Days to
      Die**, and nothing in the dashboard can close this one: RCON and telnet both read
      healthy while a client still fails to connect, which is exactly the 7DTD
      build-mismatch failure mode. Needs a person with the game.
- [x] Backups page lists the old backups
- [x] `docker ps -a` shows exactly 4 containers, no duplicates. Note **only PZ and web are
      *running*** (2026-10-06) — normal, since one world fits at a time and both game
      services are `restart: "no"`

### 9. Set `AUTH_URL` if the domain changes

It won't here — the domain follows. But if it ever does, `AUTH_URL` in `.env`
must match or Discord OAuth breaks.

---

## Sizing, measured (not guessed)

Measured 2026-09-13, on 16 GB, with the mod list as it stood then (76 mods; it is **87** as
of 2026-10-06 — re-measure rather than quoting, see
[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md#status)):

| | Value |
|---|---|
| PZ resident | **9.74 GiB** |
| Host used | 10.4 GB of 15.2 GiB |
| Swap used | **0** |
| Free | ~5.1 GB |
| PZ CPU | ~3% |

- **The box is 8 vCPU.** This section said "~3% of 4 vCPU" and "6 netcup vCores is ample",
  against the 8 on line 4 — three numbers for one box, which makes any capacity reasoning
  from here unsafe. 8 is what `CLAUDE.md` and `docs/PROJECT-ZOMBOID.md` both carry. **The
  denominator of the ~3% was never recorded**, so the percentage is kept without one; the
  load-bearing part survives every reading of it, which is that **the workload is RAM-bound
  and never approached CPU saturation.** Confirm with `nproc` if it ever matters.
- **The heap ceiling the UI offers is `floor(totalGb - 2.5)` = 13 GB, not 12.** This said
  12 "which is what's set", conflating two different numbers: 13 GB is the *ceiling*
  (`maxGameGb()` in `src/lib/game-manager.ts`, from `/proc/meminfo` MemTotal 15.62 GB minus
  `HOST_RESERVE_GB` 2.5; pinned in `src/lib/__tests__/coresidency.test.ts`), while 12 GB is
  PZ's *configured heap* (`MAX_MEMORY: "${PZ_MAX_MEMORY:-12288m}"`). The arithmetic in the
  stated formula gives 13, so this read as a one-GB bug in `maxGameGb` that does not exist.
  Note the ceiling **assumes the world is alone on the box**.
- On the old 8 GB box the same list was OOM-killed at a 4 GB heap. Most of PZ's
  footprint is **shared memory** (`shmem-rss` was 4.1 GB in the OOM report), not
  JVM heap — which is why raising `-Xmx` alone never fixed it.
- If GC stutter ever shows up, try 8–10 GB rather than 12 — a very large heap can
  lengthen pauses. The floor is `MIN_MEMORY` (2048m → `-Xms2048m`): `setMemory` refuses
  anything under it, because `-Xmx` below `-Xms` is a JVM that will not start.
- Every container now has a `mem_limit` (MC 6g, 7DTD 10g, PZ 14g, web 2g), which this
  section predates. **Size one against `-Xmx` plus 1–2 GB of non-heap and judge it from
  `memory.stat`, not `docker stats`** — the latter counts page cache, so a healthy PZ reads
  as 98% of its limit. Worked example, including why PZ's first limit was wrong:
  [`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

## Known issues to clean up — moved out of this file

> **This section was a fourth copy of Project Zomboid mod archaeology, carrying the oldest
> numbers and, in one case, the opposite advice.** It is deleted rather than updated,
> because the repo's own rule is that per-game depth lives in the game's doc:
>
> - **[`docs/PZ-MOD-BACKLOG.md`](docs/PZ-MOD-BACKLOG.md)** — the live mod defect list, with
>   a harmless list to check before investigating.
> - **[`docs/PROJECT-ZOMBOID.md`](docs/PROJECT-ZOMBOID.md)** — the `.ini`, Workshop updates,
>   and "Maps and cells".
>
> The one that would have caused harm: this said two SecretZ variants fight over 15 cells
> and pointed at the Maps card, which reads as "remove one". **`PZ-MOD-BACKLOG.md` says the
> opposite — "Do not remove SecretZ — it owns 16 of the 22 `Map=` entries"**, and lists it
> among the two mods that *cannot* be removed. Following this file would have taken 16 of 22
> maps off the server. It also omitted the mechanic that makes the Maps card not work the
> way it looks: **the image overwrites `Map=` on every boot**, so a hand reorder does not
> survive a restart. Its mod counts were stale too — "76-mod list", "107 `Mods=` entries",
> against 87 mods / 75 Workshop items / 22 maps re-measured on 2026-10-06.
>
> **Two of its observations are recorded in no other doc, so they are carried here rather
> than lost. Neither has been re-checked since 2026-09-13, and both belong in a PZ doc:**
>
> - `WorkshopItems` contained a duplicate id, `3600377019`. Harmless — the server ignores
>   it — and adding mods through the UI dedupes, so this may already be gone; the Workshop
>   count is now 75.
> - **Some `Mods=` entries do not resolve to a folder on disk and so silently don't load.**
>   That is the one with teeth, because the failure is silent and a missing mod reads as a
>   mod that does nothing. Reconcile with
>   `ls /zomboid-workshop/content/108600/*/mods/` against the `Mods=` line in
>   `/zomboid/Server/yoshling.ini`. The old count was 107 entries against 87 today, so the
>   gap may simply have been cleaned up — measure before investigating.
