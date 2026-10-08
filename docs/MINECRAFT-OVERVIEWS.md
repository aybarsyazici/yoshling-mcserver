# Automatic Minecraft profile covers

## Product behavior

A ready profile gets a default **generated world overview** when verified saved
Overworld terrain is available. This is a 3D view near the saved spawn, covering a
64-block radius. It is an overview of actual saved blocks, not a player-camera
screenshot. Gallery, picker and profile detail use this order:

1. A custom manual upload or companion screenshot.
2. A verified generated overview.
3. A labeled decorative illustration while no image is available.

Custom covers remain in the existing database fields. Generated images are
separate private files and never replace a custom cover or change the profile's
numeric editor revision. Removing a custom cover reveals the generated default.
Companion replacement consent applies to an existing custom cover; a generated
default alone does not require it. See [MINECRAFT-SCREENSHOTS.md](MINECRAFT-SCREENSHOTS.md).

New worlds wait for saved terrain. The dashboard does not start, stop or save a
game to obtain an image. Missing defaults are generated automatically; managers
can use **Refresh world overview** to update a saved image. Existing generated
images are retained until an explicit refresh. The UI shows generated time,
source-world save time when known, and snapshot time separately.

Initially supported targets are **Minecraft 26.1.2 and 1.21.1**. All supported
server loaders use pinned vanilla rendering assets; modded blocks can be simplified
or missing. Nether/End views, arbitrary camera locations, additional versions and
custom mod resource packs are not implemented. Unsupported targets keep custom
cover controls and a labeled illustration.

## Sources and boundaries

`minecraft-profile-overview-source.ts` admits an inactive or verified stopped
profile under the Minecraft file reservation, copies minimal saved-world files,
and compares source identity/hashes before and after. A running selected world
requires a verified private checkpoint or a sealed, hash-verified, flushed backup
bound to that profile. It never renders the mutable live world directly. A backup's
checksum alone does not establish gameplay consistency; normal backup limitations
still apply. A successful backup only records a cheap generation notification;
source admission occurs separately.

Only `level.dat` and nearby Overworld region/external-chunk files enter the renderer.
Player files, server properties, mods, control credentials and other dimensions
are excluded. Limits: 256 MiB total input, 128 MiB per file and 16 MiB expanded NBT.
Legacy and namespaced Overworld layouts are supported. Input manifests bind the
profile, target, job, saved spawn, layout, timestamps and every file's length/hash.
The renderer independently validates those files and their aggregate digest.

Private storage is `/app/data/minecraft-profile-overviews/<profile UUID>/`:
`overview.json`, hashed generated images and bounded job metadata. Input/output
scratch is removed with readback after completion or verified interruption.
Directories are owned mode 0700; files are mode 0600, regular and singly linked.
At most three completed job records are retained per profile. Generated-image GETs
require Minecraft access and the exact current image revision. No public map is
served, and no database migration is required.

## Worker and operations

The separate Compose `minecraft-overview` tool uses BlueMap CLI 5.28 followed by
headless Chromium, sequentially. Pinned assets are built into the private local
image `yoshling/minecraft-overview:5.28`; runtime networking is disabled. It mounts
only the job's read-only input and writable output subpaths of `yoshling_web-data`.
It has no game volume, Docker socket, database, `.env` or published port. Root is
read-only, capabilities are dropped, privilege escalation is disabled, and limits
are one CPU, 1,536 MiB memory/no swap, 256 PIDs and a 256 MiB `/tmp`.

`src/instrumentation.ts` checks every 60 seconds, first at 90 seconds after boot.
`MC_OVERVIEWS=false` disables automatic checks after web recreation. One queue and
one `render:minecraft-overview` operation lane serialize renders; Docker worker
labels also prevent a new job from overlapping a worker left by a web restart.
Snapshot/publication hold short Minecraft file reservations; rendering does not.
Game power activity, starting/stopping/installing worlds, unknown probes or low
memory defer rendering. Admission reserves the worker ceiling plus 1 GiB host
headroom; monitoring accounts for memory already used by the worker. Resource
probes are bounded, and a render has a ten-minute watchdog.

`profile.overview` operations report copy, queue, render and publication separately.
A queued receipt is not a completed image. Success requires matching renderer
receipt, independent PNG hash/dimensions, profile/source revalidation and atomic
image/metadata readback. A verified deferral stops/removes only the exact admitted
worker, resets scratch and retries after 15 minutes. Ambiguous creation, cleanup,
persisted rendering without a live owner or malformed manifests remain
**unverified** and require owner review; age is not proof of completion.

## Deployment and recovery

Use `scripts/deploy.sh --service web --verify 'literal from the actual change'`.
The script builds the renderer before web and refuses replacement while any
labeled renderer container, active/unverified metadata or unresolved scratch
exists. Waiting and fully verified queued input may survive replacement. The
scanner runs read-only inside the current web container and is also checked after
build. This rollout does not recreate or power any game container.

For owner recovery, inspect the tracked operation, persisted job, exact Docker
identity/mounts and image/source receipts before deciding which state to repair.
Do not delete markers or force deployment merely because their timestamp is old.
Orphan queued metadata for a deleted profile is marked unverified, allowing other
profiles to proceed while retaining its private staging for owner review.
An unknown worker must be reviewed before another render is allowed. Disabling
automatic checks does not prove an existing worker has stopped.

## Verification scope

Project fixtures exercise source/archive validation, filesystem publication,
operation admission, API authorization, custom-cover precedence, UI receipt
rechecks and fake-Docker interruption paths without Docker or a running game.
Offline worker fixtures exercise bounded manifests and hashes. Separate synthetic
world renders validate the real Java/Chromium pipeline; they do not establish
correctness for every modded block or prove a game join. Dated check totals,
mutation proofs, actual resource measurements and deployment evidence belong in
[CLOSED.md](CLOSED.md), keeping this document current.

Primary references: [BlueMap installation](https://bluemap.bluecolored.de/wiki/getting-started/Installation.html),
[BlueMap 5.28](https://github.com/BlueMap-Minecraft/BlueMap/releases/tag/v5.28),
[render masks](https://bluemap.bluecolored.de/wiki/customization/Masks.html),
[modded assets](https://bluemap.bluecolored.de/wiki/customization/Mods.html), and
[Docker volume subpaths](https://docs.docker.com/engine/storage/volumes/).
