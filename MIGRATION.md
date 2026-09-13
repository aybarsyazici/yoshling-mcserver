# Migration runbook — Hetzner → netcup

**Status: DONE, 2026-09-13.** Live on netcup `89.58.50.155` (8 vCPU / 16 GB /
314 GB, Debian 13). The old Hetzner box is still running as a rollback and should
be deleted only once each game has been played on netcup.

What tripped us up, for next time:
- The provisioned SSH key file was missing its **trailing newline**, so OpenSSH
  rejected it as "invalid format". `printf '\n' >> key` fixed it; no password needed.
- **Seed the Workshop mods with SteamCMD before starting PZ** (see CLAUDE.md).
  Letting PZ download 75 items crashed it twice.
- Only ~1.3 GB actually moved, in ~13 s at 109 MB/s box-to-box. 7DTD's 16.8 GB of
  game files and PZ's 3.8 GB of mods were re-fetched on the new box as planned.
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
| `yoshling_sdtd-server` | 16.8 GB | **No** — 7DTD game files, SteamCMD re-downloads on first boot |
| `yoshling_pz-workshop` | 624 MB+ | **No** — Workshop mods, the server re-downloads them |
| `yoshling_sdtd-log` | 18 MB | No |

Plus `/opt/yoshling` (the git checkout, 262 MB) and critically **`/opt/yoshling/.env`**,
which is gitignored and holds secrets that exist nowhere else:

```
DATABASE_URL  DISCORD_CLIENT_ID  DISCORD_CLIENT_SECRET  AUTH_SECRET  AUTH_URL
RCON_PASSWORD  ALLOWED_DISCORD_USERS  SDTD_TELNET_PASSWORD  DIRECT_UPLOAD_HOST
PZ_RCON_PASSWORD  PZ_ADMIN_PASSWORD  STEAM_API_KEY  STEAM_API_KEY_DOMAIN_NAME
```

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

### 3. Move the four volumes that matter

```bash
# on the OLD box, with the game containers STOPPED
for v in web-data mc-data sdtd-saves pz-data sdtd-backup; do
  docker run --rm -v yoshling_$v:/from -v /root/vols:/to alpine \
    tar czf /to/$v.tar.gz -C /from .
done
scp -r root@178.105.163.254:/root/vols /root/vols   # ~1.6 GB

# on the NEW box
cd /opt/yoshling && docker compose create   # creates the named volumes
for v in web-data mc-data sdtd-saves pz-data sdtd-backup; do
  docker run --rm -v yoshling_$v:/to -v /root/vols:/from alpine \
    sh -c "cd /to && tar xzf /from/$v.tar.gz"
done
```

### 4. Build and start

```bash
cd /opt/yoshling
docker compose build web
docker compose up -d --no-deps web
# Game containers: create but DO NOT start more than one. Only one world fits.
docker compose create minecraft sevendtd zomboid
```

7DTD will re-download ~17 GB via SteamCMD on its first start; PZ will
re-download its Workshop mods on its first start (~10 min for the current list).

### 5. Firewall (netcup has no cloud-firewall layer — `ufw` only, simpler than Hetzner)

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw allow 25565/tcp                                   # Minecraft
ufw allow 26900/tcp && ufw allow 26900:26902/udp       # 7 Days to Die
ufw allow 16261/udp && ufw allow 16262/udp             # Project Zomboid
ufw allow 8766:8767/udp                                # PZ Steam query
ufw enable
```

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
| `pz.yoshling.xyz` | A | DNS-only (grey) | NEW_IP — **still needs creating** |

Cloudflare SSL/TLS mode stays **Full (strict)**.

### 8. Verify before cancelling Hetzner

- [ ] `https://yoshling.xyz/login` → 200
- [ ] Sign in with Discord (proves `AUTH_SECRET` + OAuth carried over)
- [ ] Crew page lists all users with their world access intact
- [ ] Power on each world from the UI in turn; each reaches Online
- [ ] Actually join Minecraft, 7DTD and PZ from a client
- [ ] Backups page lists the old backups
- [ ] `docker ps -a` shows exactly 4 containers, no duplicates

### 9. Set `AUTH_URL` if the domain changes

It won't here — the domain follows. But if it ever does, `AUTH_URL` in `.env`
must match or Discord OAuth breaks.

---

## Sizing, measured (not guessed)

On 16 GB with the full 76-mod list loaded:

| | Value |
|---|---|
| PZ resident | **9.74 GiB** |
| Host used | 10.4 GB of 15.2 GiB |
| Swap used | **0** |
| Free | ~5.1 GB |
| PZ CPU | ~3% of 4 vCPU |

- The heap cap the UI offers is computed from the host: `floor(totalGb - 2.5)`,
  so 16 GB → **12 GB**, which is what's set.
- On the old 8 GB box the same list was OOM-killed at a 4 GB heap. Most of PZ's
  footprint is **shared memory** (`shmem-rss` was 4.1 GB in the OOM report), not
  JVM heap — which is why raising `-Xmx` alone never fixed it.
- 6 netcup vCores is ample: the workload never approached CPU saturation.
- If GC stutter ever shows up, try 8–10 GB rather than 12 — a very large heap can
  lengthen pauses.

## Known issues to clean up (unrelated to the move)

- **Two SecretZ variants are installed at once.** `SZ_Muldraugh_Traindepot_EVAC`
  (old MODULAR variant) and `SZ_Muldraugh_Traindepot_Refugee` (new B42 one) fight
  over 15 cells. Three more overlaps exist inside SecretZ itself. See the Maps
  card on `/zomboid/mods`; the first entry in `Map=` wins.
- `WorkshopItems` contains a duplicate (`3600377019`). Harmless — the server
  ignores it — and adding mods through the UI dedupes.
- Of the 107 `Mods=` entries, a number don't resolve to a folder on disk and so
  silently don't load. Reconcile against
  `/zomboid-workshop/content/108600/<id>/mods/*`.
