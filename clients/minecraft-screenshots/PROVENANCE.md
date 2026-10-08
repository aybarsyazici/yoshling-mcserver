# Companion 0.1.0 build provenance

Current public artifact:

- Minecraft 26.1.2, client Fabric Loader 0.19.5+, Java 25.
- Filename: yoshling-screenshots-0.1.0+mc26.1.2.jar
- Bytes: 37189
- SHA256: 78027c8b13086cb8717a5d28fa74458b0efbefa92cfc6ffca5ac36784860c133

## Pinned build inputs

| Input | Value |
| --- | --- |
| Build JDK | Eclipse Temurin 25.0.4.1+1, macOS aarch64 |
| JDK archive SHA256 | 61979887f7506a24a57439ff99adb8b3a7fc89977d9cfe3b8984f58a981b7b9d |
| Gradle | 9.7.1 |
| Gradle distribution SHA256 | acd53f1edaf02f1a8ff99879f8a34b302661a057d9b063ae9e35b552f804d20a |
| Loom | 1.18.3, non-remapping plugin |
| Fabric Loader | 0.19.5 |
| MixinExtras | 0.5.5, provided by Loader; compile-only API |
| Minecraft client SDK | 26.1.2, SHA1 4e618f09a0c649dde3fdf829df443ce0b8831e65 |
| Minecraft client SDK bytes | 38113927 |

The JDK and Gradle archives were compared with their official published
checksums before extraction. The Minecraft SDK matched Mojang's metadata.
Neither the toolchain nor Minecraft classes are included in the public mod jar.

Sources:
[Temurin release](https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.4.1%2B1),
[Gradle checksum](https://services.gradle.org/distributions/gradle-9.7.1-bin.zip.sha256),
[Loom metadata](https://maven.fabricmc.net/net/fabricmc/fabric-loom/1.18.3/fabric-loom-1.18.3.module),
[Mojang metadata](https://piston-meta.mojang.com/v1/packages/78941de799d2675be5bddca699b245d7cbd567ae/26.1.2.json).

## Verification

Two clean offline builds produced the identical runtime jar hash above.
The build's plain Java verification program passed 92 assertions, including
state/generation, commands, strict protocol receipts, bounds, HUD restoration,
whole-body deadlines, queue disposal and native bytecode hook targets.

Forty-four isolated compiled protection mutants failed. They used temporary
classpath overrides; repository protections remained intact. A subsequent
normal clean build passed. Public publication readbacks matched the jar bytes,
manifest hash/length, client-only metadata and Java 25 class version.

These checks did not run Minecraft, join a game, render a framebuffer or upload
from a real player. Actual capture, HUD/mod compatibility and the production
upload flow require a player trial.
