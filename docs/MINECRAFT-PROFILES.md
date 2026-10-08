# Minecraft profiles

## Current implementation

Profiles are the playable unit: a name, cover image, complete server directory,
Minecraft version, exact loader build, Java image, mods and world settings. There
is still one Minecraft server address and one running Minecraft container.

The feature is deployed to production web and passes complete project checks.
The reviewed additive schema is applied and verified. The existing world has been
adopted as a ready profile with its installed mods scoped to it. Read live selection
and run state from the dashboard; this document does not track changing game power.

### User flow

- Start Minecraft opens the profile picker. Select a ready profile and start it.
- Switch and restart selects another ready profile, saves and stops the current
  game, verifies a private checkpoint, applies the new container target, and
  confirms the new Minecraft server responds.
- Create prepares a fresh vanilla, saved mod set or published Modrinth pack
  profile. Creation alone does not start a game or stop another game.
- Published pack choices show exact build names and declared Minecraft/loader
  versions. Preparation checks the actual pack index and keeps that build pinned.
- Adopt preserves the existing server directory and its installed-mod records
  in the first profile. Unmanaged populated data requires adoption before new
  profiles can be created.
- Existing mods, file tools and world backups operate on the selected profile.
  Inactive profile world settings have an explicit profile endpoint.
- Inactive profiles can be deleted after a named confirmation. World backups are
  retained separately. An interrupted preparation may need deletion and recreation;
  a persisted `preparing` row is not proof that a worker is still running.

The gallery and dialogs use decorative pixel landscapes, source choices and
motion that respects reduced-motion preferences. Illustrations are labeled and
never represent actual world contents. Background profile refreshes retain a
validated snapshot; failed reads and real permission/runtime changes still block
actions. Preparation and player-disconnection confirmations remain separate.

Covers currently come from authenticated manual screenshot uploads. The owner
chose actual player-camera captures for the next enhancement: a client companion
for Fabric 26.1.2 with explicit, short-lived profile pairing. Client capture is not
deployed yet; the server has no camera or renderer.

### Storage and identity

Stable UUIDs identify profiles; renaming does not move files. A profile server
directory is `/minecraft/profiles/<id>/server`. Covers and private checkpoints
are outside that server directory. The dashboard retains access to the volume;
the Minecraft service mounts only the selected server subdirectory. Legacy
installations keep the root mount until adoption.

`MinecraftRuntime` records the selected profile and revision. Container mount,
image and target readback establish the applied profile. Pointer/container drift
is an unknown state and blocks ordinary writes. Browser edits carry the profile
identity from their read, so an old tab cannot write to a newly selected profile.
An invalidated editor stays frozen until reload, including late replies from its
old profile. Recovery logs remain readable without granting command readiness.
Installed mods are scoped by profile; null identities remain legacy until
adoption. Backups carry a profile identity and use separate namespaces. Routine
downloadable backups remain world archives; private complete checkpoints may
contain control credentials and are not member downloads.

### Preparation and switching

Preparation holds the Minecraft file lane. It resolves exact source builds,
checks published hashes, validates contained regular files and publishes only a
complete directory. Downloads and ZIP overrides stream to private staging with
independent hash readback; file contents are not accumulated in dashboard memory.
Published `.mrpack` files supply the Minecraft/loader target,
server-compatible files, ordinary overrides and server overrides. Client
overrides are excluded. Returning to a ready profile does not update upstream
builds implicitly.

Supported limits are 256 MiB per source archive, 128 MiB per file, 2 GiB per prepared
server and 20,000 archive/index entries. `server.properties` is limited to 1 MiB,
1,024 distinct keys and 4,096 lines for configuration tools. Index and optional
registry JSON are bounded at 8 MiB. Downloads accept the supported HTTPS Modrinth
and GitHub hosts and validate redirects. Legacy direct-download saved sets without
published checksums are refused. Preparation reserves disk space for transient
source/configuration files, the server tree and a 1 GiB free-space margin.

Switching uses tracked operation admission and the shared power lane. Every peer
shutdown requires explicit confirmation. A save failure refuses the switch while
the current game remains running. Java images are resolved before shutdown.
The reviewed peer IDs must match the running peers; a newly appeared peer requires
a fresh review. File operations that hold required lanes block selection. Profile
switching does not promise to interrupt those jobs.
After shutdown, a verified private checkpoint precedes container recreation.
Selection commits only after mount/target readback. Recovery before selection
commit restores the prior target in a stopped container; recovery never silently
boots a partially changed save.

Admission checks tree shape and disk space before stopping. Complete checkpoints
keep the three newest verified copies for each profile. Contained regular-file
aliases, including itzg's generated vanilla jar link, are materialized with verified
bytes and ownership. Directory links, special files, excluded legacy storage and
links crossing a profile boundary are refused. A newer saved world cannot start
under an older recorded target. Legacy target repair happens before adoption.

The reserved volume-root `profiles` directory admits backed profile IDs and exact
staging names. Unknown existing legacy contents require owner review; they are never
silently excluded or permission-changed. Private operation markers live in the web
volume at `/app/data/minecraft-profile-operations`, outside game data. Deployment
checks these and source/prepare/checkpoint/delete staging before work and before web
replacement, including nested profile backup staging. Leftovers block deployment
unless explicitly reviewed; neither age nor unchanged size proves completion.

Global ports, RCON credentials, host memory budget and dashboard grants remain
deployment settings. Profile settings cannot replace them. Profile creation does
not reuse the current world's save. Profile targets are fixed after preparation;
create another profile for a different Minecraft/loader target. Legacy target
editing retains the world/mod mismatch guard. New profiles default to online mode;
adoption preserves the existing mode. The simple inactive editor excludes identity
policy; the active advanced properties editor retains its existing online-mode control.

World archives, retention, schedule decisions and journal entries are scoped to the
profile. The adopted legacy profile retains the original archive namespace and
legacy untagged backups. A stale scheduled decision is skipped. Private checkpoints
have no download or restore UI; checkpoint recovery and runtime identity drift still
need reviewed owner intervention.

### Production rollout

Production received `prisma/migrations/20261007180000_add_minecraft_profiles/migration.sql`
and the web deployment on 8 October 2026. Existing records, integrity and foreign keys were verified against
private pre-migration snapshots. Do not replay this migration. Evidence and backup
locations are in `CLOSED.md`.

For a fresh host, apply reviewed SQL manually after a consistent verified SQLite
backup and verify schema/data before deploying the generated client. Use
`scripts/deploy.sh` with a literal verification string and keep game/profile work
idle during deployment. No migration or adoption runs automatically on boot.

On a fresh legacy installation, adopt through the dashboard afterward, reviewing any loader/Java hints required
by an ambiguous legacy install. Adoption keeps original data at the volume root,
copies and verifies the complete server, transfers legacy inventory without changing
its history, selects the stopped profile and leaves Minecraft stopped. Start and
verify a real game join separately. A read-only production check confirms completed
legacy adoption; real game joins, controlled restores and authenticated browser
verification remain unexercised by the agent. No browser verification
surface was available during deployment; anonymous route checks do not prove sign-in.

### Remaining delivery work

- Real Minecraft joins for multiple profiles.
- Controlled restore/checkpoint recovery and full browser visual/mobile verification.

Local verification and mutation evidence are recorded in [CLOSED.md](CLOSED.md).

### Format and runtime references

[Modrinth's pack format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
defines server environments and override precedence.
[Docker volume subpaths](https://docs.docker.com/engine/storage/volumes/)
require an existing contained directory.
[itzg Java variants](https://docker-minecraft-server.readthedocs.io/en/latest/versions/java/)
define supported image tags. The local Docker/Compose subpath mechanism was
checked using a disposable stand-in volume, without mounting game data.
