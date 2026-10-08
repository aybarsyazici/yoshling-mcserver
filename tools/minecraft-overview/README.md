# Saved-world overview worker

This private, optional worker renders a 128 × 128 block area around the recorded
overworld spawn into one 1280 × 800 PNG. It reads an immutable saved-world copy.
It does not start Minecraft, generate chunks, install server mods, capture a
player's camera, or publish a map website. BlueMap's rendered canvas supplies the
image; the dashboard must label it as a **generated world overview**.

V1 packages vanilla Minecraft resources for **26.1.2 and 1.21.1 only**. Fabric and
other loaders do not change the resource selection. Modded blocks can be absent
or look different because the worker receives neither mod code nor resource
packs. Missing/unlit chunks, unsupported versions, malformed files, exhausted
limits and failed renders produce no verified cover. A custom upload or player
companion screenshot has priority over this default image.

## Build and runtime

Build the separate worker image, with network access during asset setup:

```sh
docker build -t yoshling-minecraft-overview:local tools/minecraft-overview
```

Do not publish this image or its asset cache: it contains Mojang client resource
jars downloaded from official endpoints. The app's web Docker context excludes
`tools/`, so these assets never become part of the web image.

Entrypoint: `node /opt/overview/run.mjs`. Execute each job in a newly created,
sanctioned worker container, using these admission requirements:

| Setting | Required value |
| --- | --- |
| CPU | 1 CPU |
| Memory / memory plus swap | 1536 MiB / 1536 MiB |
| Root filesystem | Read only |
| Network | `none`; no published ports |
| Capabilities / privileges | Drop all; no new privileges |
| UID | 0, to read the private root-owned snapshot |
| `/input` | Read-only, owned immutable snapshot only |
| `/output` | Empty private directory, writable; no other data |
| `/tmp` | 256 MiB tmpfs |
| Other mounts | None; no Docker socket, app DB, grants or live game volume |

The worker verifies source bytes before rendering and again before publishing
the receipt. It rejects links, hardlinks, extra files, unsupported paths and
source-inventory fingerprint changes. Java runs with one render thread and a
512 MiB maximum heap, then exits before Chromium starts. CLI execution is bounded
to 90 seconds and 1 MiB logs; the complete worker is bounded to 120 seconds. The
external bridge must verify container exit/removal before cleaning failed output.
The browser serves only generated scratch files on an ephemeral loopback port
inside the container and blocks requests to other origins. No cookies or public
map endpoint are used.

`umask 077` and output readback produce UID/GID 0 files with mode 600 in a mode
700 directory. Worker environment path overrides exist only for isolated native
fixtures; the production bridge must use the fixed mount paths and image.

## Input and output

`/input/manifest.json` has format 1, profile/job UUIDs, target `mcVersion`, source
receipt, integer `center: {x,z}`, `radius: 64`, `dimension: "overworld"`,
`layout: "legacy" | "namespaced"` and a bounded file table. World files reside in
`/input/world/`. Only `level.dat`, matching overworld `.mca` regions and their
`.mcc` chunks are admitted. Total source is at most 256 MiB and 4096 files;
compressed `level.dat` is at most 1 MiB. The producer separately bounds expanded
NBT to 16 MiB. The source digest is SHA256 of `JSON.stringify(files)` in the
original table order, and each table entry has `{path,bytes,sha256}`.

Legacy region paths are `region/r.x.z.mca`; new namespaced paths are
`dimensions/minecraft/overworld/region/r.x.z.mca`. Old spawn NBT uses `SpawnX` /
`SpawnZ`; 26.1.2 also supports `spawn.pos` in the `minecraft:overworld` dimension.
The producer chooses the spawn and region subset; the renderer does not inspect
or copy live game data.

Success produces `/output/overview.png` and `/output/receipt.json`:

```json
{
  "format": 1,
  "profileId": "<profile UUID>",
  "jobId": "<job UUID>",
  "sourceSha256": "<source inventory SHA256>",
  "renderer": {"name": "bluemap", "version": "5.28"},
  "width": 1280,
  "height": 800,
  "image": {"file": "overview.png", "sha256": "<PNG SHA256>", "bytes": 1},
  "center": {"x": 0, "z": 0},
  "radius": 64,
  "dimension": "overworld"
}
```

The example byte count is a placeholder. The real receipt is compared with the
published PNG. A browser error, missing geometry, unexpected canvas dimensions,
invalid PNG header or image larger than 5 MiB refuses publication. Callers must
check the receipt and independently verify the source, image and profile identity.

## Verification

Offline guard checks need Node 22 only; no dependency install, Docker, network or
running game is required:

```sh
node --test tools/minecraft-overview/worker.test.mjs
node tools/minecraft-overview/fixtures/mutate-guards.mjs
```

The mutation script uses disposable copies, confirms each disabled protection
produces an assertion failure, checks the original files are unchanged, and
reruns the green suite.

An explicitly requested **local Docker proof** generates synthetic Anvil worlds,
checks a local Unix-socket Docker context, and never selects an existing game
container or volume. After building the image above, choose a new output path:

```sh
python3 tools/minecraft-overview/fixtures/prove-container.py \
  --docker-context desktop-linux \
  --image yoshling-minecraft-overview:local \
  --output /tmp/yoshling-overview-proof
```

It renders both version/layout fixtures sequentially with the policy above,
reads back PNG/source/receipt hashes and output permissions, records whole-cgroup
peak memory, and removes only its newly named containers and output volumes.
Proof images and logs stay in the chosen output directory.

The 2026-10-08 local Linux ARM64 proof used 64 saved chunks / four regions per
fixture (~295 KiB source). 26.1.2 completed in 17.416 seconds, peaked at
523,464,704 bytes and used 50,576 KiB scratch; 1.21.1 completed in 22.492 seconds,
peaked at 512,438,272 bytes and used 38,536 KiB scratch. Both retained actual
1280 × 800 PNGs and verified receipts with the 256 MiB tmpfs and 1536 MiB/no-swap
hard limit. An earlier cold proof peaked at 1,132,523,520 bytes, so the admission
budget remains 1536 MiB. Tests cover 22 offline cases; 32 isolated guard mutations
were killed and restored.

These are synthetic fixture results, not a production world render, production
deployment or player screenshot. Complex saved worlds may hit the time, memory
or scratch limits and should remain pending/failed without affecting game power.
See [PROVENANCE.md](PROVENANCE.md) for upstream versions and verified assets.
