# Yoshling current project memory

Read this before changing the project. This file contains current instructions and operating state only. Keep it within 220 lines, 2,400 words and 18,000 characters so it can load every session. Replace obsolete statements rather than stacking corrections here. Move incident stories, old measurements, completed fixes and superseded explanations to [MEMORY-HISTORY.md](docs/MEMORY-HISTORY.md) or [CLOSED.md](docs/CLOSED.md).

Update documentation with each meaningful change. State what was verified locally, what was deployed, and what still needs a live check. Never write a behavioral guarantee that the evidence does not establish. `AGENTS.md` is a pointer and agent-specific rules; do not duplicate this architecture there.

## Read by topic

| Work | Read |
| --- | --- |
| Long operations, status, toasts, background work | [OPERATIONS.md](docs/OPERATIONS.md) |
| Minecraft user tutorial | [MINECRAFT-GUIDE.md](docs/MINECRAFT-GUIDE.md) |
| Frontend readiness, permissions, stale data and result handling | [FRONTEND.md](docs/FRONTEND.md) |
| Configuration and configured versus live values | [SETTINGS.md](docs/SETTINGS.md) |
| Discord identity, invitations, revocation and legacy preparation | [AUTHENTICATION.md](docs/AUTHENTICATION.md) |
| Minecraft mods, packs, identity, bans and rules | [MINECRAFT.md](docs/MINECRAFT.md) |
| Minecraft profile implementation and migration | [MINECRAFT-PROFILES.md](docs/MINECRAFT-PROFILES.md) |
| Automatic Minecraft covers and isolated rendering | [MINECRAFT-OVERVIEWS.md](docs/MINECRAFT-OVERVIEWS.md) |
| Player screenshot pairing and client companion | [MINECRAFT-SCREENSHOTS.md](docs/MINECRAFT-SCREENSHOTS.md) |
| Any Project Zomboid change | [PROJECT-ZOMBOID.md](docs/PROJECT-ZOMBOID.md); mod incidents also [PZ-MOD-BACKLOG.md](docs/PZ-MOD-BACKLOG.md) |
| 7DTD telnet, XML, worlds, reset and updates | [7-DAYS-TO-DIE.md](docs/7-DAYS-TO-DIE.md) |
| Host setup and migration | [MIGRATION.md](MIGRATION.md) |
| Original audit findings | [AUDIT-2026-10-06.md](docs/AUDIT-2026-10-06.md) |
| Was a defect already repaired, and how was it verified | [CLOSED.md](docs/CLOSED.md) |
| Historical reasoning and superseded documentation | [MEMORY-HISTORY.md](docs/MEMORY-HISTORY.md), [September audit](docs/AUDIT-2026-09-28.md) |

The dated audits are diagnosis snapshots, not current backlogs. Current remediation status is below; detailed verification belongs in `CLOSED.md`.

## Product and runtime

A Next.js App Router dashboard with React, Discord OAuth through NextAuth v5, Prisma 7 with the libSQL/SQLite adapter, Tailwind v4, shadcn/Base UI and Catppuccin themes. Docker builds use Node 22. Package versions are authoritative in `package.json` and `package-lock.json`.

Three games share one netcup host with 16 GB RAM. Only one game should run at a time. Power on saves and gracefully stops every other running game. Access is granted per game; Minecraft profiles share the Minecraft grant. Project Zomboid contains real, actively played save data; treat production as live.

| World | Compose service | Container | Web data path | Control |
| --- | --- | --- | --- | --- |
| Minecraft | `minecraft` | `yoshling-mc` | `/minecraft` | RCON `minecraft:25575` |
| 7 Days to Die | `sevendtd` | `yoshling-7dtd` | `/sevendtd` saves, `/sevendtd-config` server files | Telnet `sevendtd:8081` |
| Project Zomboid | `zomboid` | `yoshling-pz` | `/zomboid`; Workshop read-only at `/zomboid-workshop` | RCON `zomboid:27015` |
| Dashboard | `web` | `yoshling-web-1` | `/app/data` | HTTPS through Cloudflare and Caddy |

Game services use `profiles: ["games"]` and `restart: "no"`; bare Compose up cannot start them. Web uses `restart: unless-stopped`. Explicit service names enable their profiles; inspection by hand may need `--profile games`.

Web runs as root with Docker CLI, Compose, `/var/run/docker.sock`, and the host deploy directory mounted at `/opt/yoshling`. Preserve those dependencies. Compose owns names, labels, aliases and mounts; never hand-build a replacement game container with `docker run`.

## Source map

- `src/lib/games.ts`: client-safe game identity, routes, connections, file root labels and UI capabilities.
- `src/lib/game-manager.ts`: drivers, status/probes, graceful lifecycle, container recreation and memory settings.
- `src/lib/operations.ts`: shared operation registry on `globalThis`, admission, resource lanes, heartbeats and evidence-derived outcomes.
- `src/lib/coresidency.ts`: running-world reporting and non-power start refusal.
- `src/lib/permissions.ts` and `game-gate.ts`: roles and world authorization.
- `src/lib/compose.ts`: scoped Compose reads/patches and atomic `.env` writes.
- `src/lib/backup-create.ts`, `backup-store.ts`, `backup-integrity.ts`, `backup-retention.ts`, `backup-schedule.ts`: shared backup pipeline.
- `src/lib/file-guard.ts`: lexical and physical path checks for all three browsers and upload destinations.
- `src/lib/game-data-path.ts`: the same boundary for normal configuration, player lists and backup sources; derived paths stay anchored to the game volume.
- `minecraft-profile-{store,path,prepare,activation,adoption}.ts` and `minecraft-active-profile.ts`: isolated profile storage, exact preparation, verified switching, legacy adoption and stale editor guards.
- `src/lib/upload-tree-guard.ts`: rejects extracted links and special files before upload placement.
- Prisma client is generated into gitignored `src/generated/prisma`; schema is `prisma/schema.prisma`.

Pages: `/home`, per-game `/{minecraft,7dtd,zomboid}` overview/server/backups/settings, Minecraft and PZ mods, Minecraft `/minecraft/guide`, plus `/users`, `/whitelist` and `/activity`. API details belong beside their implementation and in the topic docs rather than an exhaustive list here.

## Required safety and success rules

- Prove writes and operations succeeded with readback. Unknown, refused, partial and unchanged results must remain distinct.
- Use `runOperation` for work that may take more than ten seconds. Routes record steps/facts; the registry derives outcomes and completion sentences.
- Power operations hold the shared power resource. Non-power actions that start a world must explicitly refuse co-residency before modifying data.
- Pack/reset/update preflights hold their world's files, then use `claimOperationPower` before lifecycle/file changes. Preflight refusals do not take power or invalidate unrelated backups. Single-mod installs hold Minecraft files through download and jar readback.
- Heartbeat expiry measures liveness, not total operation duration. Keep shared mutable state on `globalThis` across Next module graphs.
- Container env, limits, ports and mounts are fixed at creation. Use `applyServiceEnv` or `setMemory` to stop if necessary, recreate with Compose `create`, and restart only when appropriate.
- `withGameStopped` must establish prior state and verify shutdown before file changes. Restores use `restartOnFailure:false`; do not boot a partially replaced save or claim a restart after an observed failed start.
- PZ shutdown asks the game to `quit` over RCON. `docker stop` is only the fallback for an unresponsive game; it does not provide the normal graceful path.
- Enumeration uses `rconCommandLong`/`sendCommandLong`. Cached RCON drops reply packets after the first. Minecraft responses may concatenate entries without newlines.
- Treat upstream mod descriptions as untrusted HTML/Markdown; parse raw markup, then sanitize before rendering.
- Use `execFile` with argument arrays for input-derived subprocess arguments. Shell quoting with `JSON.stringify` is not safe.
- File paths must remain physically inside their configured root, including existing parents of new files. Reject root deletion and extracted links/special files. Do not treat a filename prefix as physical containment.
- Short writes use quiet registry reservations across read-modify-write/readback. Publication/terminal checks detect forced interruption; prior writes may remain. Editors send opaque revisions; selected Minecraft profiles additionally require the captured profile identity.

## Configuration and data

Minecraft target, heap and profile mount/Java/loader selectors, and PZ `MAX_MEMORY`, are UI-owned `.env` values referenced by Compose. `writeEnvFile` uses an atomic rename, mode 0600 and one `.env.bak`; only ENOENT means an absent file. `.env` is gitignored and contains production secrets. Profile deployment requires the additive schema migration first; never migrate or adopt on boot.

Compose itself is git-owned. The 7DTD update route temporarily patches its literal `START_MODE` and restores it; deploy refuses uncommitted host Compose edits. Heap limits must respect both the host budget and each container's limit, with native overhead and PZ's `MIN_MEMORY` floor. 7DTD is native Unity and has no JVM heap setting.

Game configuration is file-backed; live probes cover only settings each game reports. Do not equate container env agreement with a successful game boot. Minecraft game rules are discovered from the running game and written with a fresh query afterward. Offline-mode player list files use `mc-identity.ts` UUIDs.

7DTD reads `TelnetPassword` from `sdtdserver.xml`, not the image env. Keep it consistent with web's `SDTD_TELNET_PASSWORD`; archived control credentials must not replace current deployment settings. PZ's `.ini`, sandbox Lua, save and player DB share `/zomboid`; read its deep doc before changes.

Routine Minecraft archives are world-only; pre-pack rollback archives also include mods and inventory metadata. 7DTD bundles saves, active custom map and XML; PZ bundles world, player DB and server config. Verify checksums before stopping for restore. Archive hashes prove byte identity, not gameplay consistency. Scheduled backups skip known players but do not prevent a later join; live-world snapshot consistency remains a limitation.

## Roles and authentication

ADMIN has all worlds and all capabilities. MOD has the same world-scoped capabilities except `users.manage`; MEMBER reads granted worlds. Server routes enforce both world grants and the relevant capability. Role/grants are re-read from the DB on each JWT resolution.

The first registered Discord account becomes ADMIN; later accounts start as MEMBER with no worlds. `/users` grants role/access. `/whitelist` admits immutable ID strings; names are labels. The file wins over the ID seed; deliberately empty permits sign-in, while invalid/unknown policy refuses. Legacy name lists need reviewed ID preparation before deployment; read `AUTHENTICATION.md`.

JWT resolution rechecks current policy and DB identity/role/worlds; deleted or uninvited accounts lose access. Upload tokens require a real `AUTH_SECRET`, expire after ten minutes, and recheck current policy/role/worlds when spent. They remain reusable until expiry.

## Local development

Use a supported Node 22 installation. On this machine:

```bash
export PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH"
npm ci
npx prisma generate
npm test
npx tsc --noEmit
npm run build
npm run lint
npm run dev
```

Prisma generation is required after install/schema changes; there is no postinstall hook. The generated client is not committed. Lint is separate from build; record its current result rather than assuming it passed. Added regression tests must fail when their protection is removed; record that proof.

A local `.env` needs `DATABASE_URL`, Discord OAuth client ID/secret, `AUTH_SECRET`, `AUTH_URL`, a sign-in seed, and control/Steam values for the features being exercised. Use local paths for files/whitelist instead of assuming container mounts. Never print `.env` or whole container environments. Local authenticated UI setup still needs a documented recipe.

Telnet transport fixtures bind loopback ports. Restricted sessions can block them and Turbopack's local workers; Google font builds also require fetch access. Record those limits and any alternate compile separately from the normal checks.

`npm run build` cleans and verifies standalone artifacts; `npm run verify:artifact` verifies an existing artifact. Docker independently verifies the assembled runner. The build context excludes env files, databases, keys, Git/worktrees and unrelated host inputs. These checks concern forbidden files and link containment; they do not scan arbitrary source literals for secrets.

## Production and deployment

Host: `89.58.50.155`, deploy directory `/opt/yoshling`, SSH `root` with `~/.ssh/mc_yoshling_netcup`. Public dashboard: `https://yoshling.xyz`. Read live run state before an action; do not infer it from saved documentation.

Use `scripts/deploy.sh --service web --verify 'literal from the actual change'`. It requires committed work, ships a git bundle, guards running seeds/copying backups, profile/overview staging and dirty host Compose, builds the overview tool and web, and checks the literal in the running built image. The host has no GitHub key. Checkout pushes use the configured repository `core.sshCommand`.

Web replacement rechecks invitation policy, seeds and backup/profile staging after build. Private profile operation markers persist in `/app/data/minecraft-profile-operations`. Leftovers are active or unverified until reviewed; size/age cannot prove completion. Admission observations do not hold a deployment lock; avoid concurrent operations during rollout.

For PZ image deployment, power PZ off through the dashboard first. The script refuses a running/unknown state, rechecks after build, recreates with `create`, and verifies stopped state, actual image ID and Compose identity. Power on separately through the dashboard. Do not operate game power concurrently with a PZ deployment.

Cloudflare uses Full strict; Caddy serves the origin with a Cloudflare Origin certificate. Direct uploads use `direct.yoshling.xyz` with a public certificate. Game connections bypass Cloudflare through DNS-only records: `mc.yoshling.xyz`, `7dtd.yoshling.xyz:26900`, `pz.yoshling.xyz:16261`; raw host IP also works.

Docker published ports bypass UFW INPUT. The host firewall must protect TCP 3000/8080/8081 in `DOCKER-USER`; game ports remain published. The firewall unit is host-owned and not yet reproducible from this checkout; see `MIGRATION.md`.

### Applying DB migrations in production

No migration runs on boot. Back up `/app/data/yoshling.db` before schema changes. Apply reviewed SQL with the libSQL client inside web, then query the schema/data to prove the change. Confirm compatibility with the deployed generated client before dropping columns.

```bash
docker cp yoshling-web-1:/app/data/yoshling.db /root/yoshling-deploy-backup/
docker exec yoshling-web-1 node -e '
  const {createClient}=require("/app/node_modules/@libsql/client");
  const c=createClient({url:"file:/app/data/yoshling.db"});
  c.execute("REVIEWED SQL HERE").then(()=>c.close()).catch(e=>{console.error(e.message);process.exitCode=1});
'
```

Applied migration history and worked SQL are in `CLOSED.md` and `MEMORY-HISTORY.md`; do not reapply historical ALTER statements. Removing unused 7DTD DB columns remains a separate manual migration with client-first ordering.

## Current remediation status

- Remaining dependency advisories need applicability/exposure review. Feature limits include idempotent saved-set re-imports, draft review for Minecraft's custom settings cards, and owner-only checkpoint/drift recovery.
- Minecraft profile contracts and remaining rollout work are in `MINECRAFT-PROFILES.md`. Different targets use separate profiles; profile version/loader editing is unavailable after preparation.
- Default Minecraft covers use isolated saved-world rendering for 26.1.2/1.21.1; custom uploads/captures take priority. Source, worker limits and recovery are in `MINECRAFT-OVERVIEWS.md`.
- Player-camera capture uses an opt-in Fabric 26.1.2 client companion; additional client targets and a real graphical capture trial remain open. Read `MINECRAFT-SCREENSHOTS.md` before changing pairing/publication.
- Verification gaps: genuine Discord login/denial/revocation, controlled restores, new 7DTD telnet completion/save protocol after rotation, real Minecraft/7DTD joins, and complete mobile/keyboard/contrast coverage.
- Infrastructure/manual work: reproduce the host firewall unit, assess retained secret-bearing images/cache, verify old-host decommissioning, and owner-managed credential rotation.

Update these groups after each verified change; do not append closed stories here.

## UI conventions

Use existing shared components and `cn()`. Identity comes from `GAMES` and `GameMark`; colors use `--tint` and Catppuccin tokens. Keep operational copy plain and direct. Photos remain in MC/7DTD footers; PZ/shared pages have none. The deliberate Miku corner reveal and Roadhog drawer remain UI elements. Prefer shared behavior over per-game copies and verify responsive/error/permission states when changing controls.
