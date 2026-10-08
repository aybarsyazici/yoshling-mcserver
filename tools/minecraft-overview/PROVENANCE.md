# Renderer dependencies and verified resources

The worker uses official release artifacts. It downloads resources only while
building the private image, verifies their receipts, and runs without external
network access. Do not commit the downloaded jars or publish the image/cache.

## BlueMap

- Release: [BlueMap 5.28](https://github.com/BlueMap-Minecraft/BlueMap/releases/tag/v5.28).
- Source commit: `0f3a9fbfb87ecfafc809d673b11254634e734ae2`.
- CLI: `bluemap-5.28-cli.jar`, 7,287,266 bytes.
- SHA256: `c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2`.
- License: upstream MIT; the official jar is unchanged.

BlueMap 5.28 declares wider Minecraft support, but this image admits only the
two versions whose client resources are baked and proven below. Official
[standalone installation](https://bluemap.bluecolored.de/wiki/getting-started/Installation.html),
[map settings](https://bluemap.bluecolored.de/wiki/configs/Maps.html) and
[screenshots example](https://bluemap.bluecolored.de/community/python-screenshots.html)
describe the CLI/map and camera approach. The worker captures the actual BlueMap
WebGL canvas after saved chunk geometry loads, then closes its private browser.
Resource limitations follow the upstream
[mod support documentation](https://bluemap.bluecolored.de/wiki/customization/Mods.html).

`OfflineBlueMap.java` supplies BlueMap's pinned version-manifest singleton before
calling the unchanged CLI. This avoids its upstream version metadata fetch even
when all client resources are cached. It is deliberately coupled to release
5.28 and fails if the required private upstream API changes.

## Minecraft assets

Official metadata comes from Mojang's
[version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json);
client jars come from `https://piston-data.mojang.com`. The build checks official
SHA1/byte counts and records SHA256; the worker verifies baked bytes against the
build receipt before each job. These jars contain rendering resources, not game
server processes installed or launched by the worker.

| Version | Client bytes | Official SHA1 | Verified SHA256 |
| --- | ---: | --- | --- |
| 26.1.2 | 38,113,927 | `4e618f09a0c649dde3fdf829df443ce0b8831e65` | `b1b3158572666445eff01e82fad8c7de2e4953db6d354f311730d77a8359d0b0` |
| 1.21.1 | 26,836,906 | `30c73b1c5da787909b2f73340419fdf13b9def88` | `499f6897d1837516680f3114072d8106e11c9adcd933fe5cf051b551089b0c99` |

The baked thin version manifest retains the exact versions and BlueMap's 1.13 /
1.19.4 compatibility threshold entries. Its verified build SHA256 is
`6f1501185f3241cc8fc63961929b90f968449d84f00cdee980841d87439f3dd6`.
26.1.2's official client metadata reports world DataVersion 4790; the older
1.21.1 synthetic fixture uses DataVersion 3955.

## Browser and Java image pins

- Playwright npm: `1.64.0`, exact version plus npm lockfile integrity.
- Official browser image: `mcr.microsoft.com/playwright:v1.64.0-noble` at digest
  `sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`.
- Official Java build image: `eclipse-temurin:25-jdk-noble` at digest
  `sha256:589ff4cc3f71aab462e7048a47a0d10edf57fbccde3fceea2281e610bf5880b4`.
- Java runtime is produced with the pinned JDK's `jlink`; no `--strip-debug` /
  external `objcopy` dependency is required.

The Docker fixture proof was Linux ARM64. The pinned multi-platform base images
also package Linux AMD64; a successful local ARM64 proof does not prove a
production AMD64 render. The production bridge enforces the same resource limits
and must verify each actual worker outcome.
