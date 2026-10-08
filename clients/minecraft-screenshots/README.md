# Yoshling Screenshots companion

Version 0.1.0 supports Minecraft Java 26.1.2 with client Fabric Loader 0.19.5 or
later and Java 25. It uses the player's actual rendered framebuffer. It does not
install anything on the Minecraft server or use a map renderer.

## Using the companion

1. Download the jar named in /companions/manifest.json and compare its SHA256
   with that manifest. Put it in the mods folder of your **client's** Fabric
   26.1.2 game instance. Fabric API is not required.
2. Start that client and connect to mc.yoshling.xyz on port 25565.
3. In the dashboard, open the applied, running profile and request a screenshot
   pairing code. Copy the complete local command.
4. Paste /yoshling pair CODE into Minecraft chat. Close chat and compose the view.
   The companion checks the code with the dashboard before taking a picture.
5. It attempts one image after the world has been present for 20 seconds and at
   least 3 seconds have passed since pairing. /yoshling capture explicitly
   requests the image sooner, after the same 3-second compose delay.

One code authorizes one image and expires 15 minutes after the dashboard issues
it. A verified upload clears the local code. Leaving the supported server,
expiration or an unconfirmed upload also clears it. Use a new dashboard code
for another image. A failed context read can be rechecked explicitly with
/yoshling capture; it never automatically retries an image upload.

Pairing commands are intercepted before vanilla chat history and before network
command packets. Ordinary chat is preserved. Codes remain in memory only;
there are no screenshot files, saved credentials or companion configuration.
The image is delivered through fixed HTTPS endpoints at yoshling.xyz.

The backend requires the paired profile, runtime identity and exact metadata
revision. Switching profiles or editing a cover/metadata invalidates pending
captures. A late image cannot replace a newer manual cover. The dashboard,
rather than the client's local message, confirms the final saved cover.

## Capture limits

The readback refuses framebuffers larger than 16 million pixels. Output
preserves aspect ratio within 1280 by 800 pixels, with a 5 MiB PNG bound. Odd
window sizes use native full-size readback followed by an in-memory resize.
Native images are closed after encoding or when a request becomes obsolete.

Vanilla HUD extraction is suppressed for one frame and the user's HUD setting
is restored even if rendering throws. Modded overlays may still appear. No
camera position, game world, server setting or file is changed.

There is one I/O worker and at most one queued task. Superseded queued work is
discarded, including any native image it owns. Context and upload exchanges
have whole-response deadlines, bounded JSON bodies and no redirect following.
Network/malformed upload replies remain unconfirmed and are not retried.

## Building and checking

Required: JDK 25. The checked-in Gradle wrapper pins Gradle 9.7.1 and verifies
its official distribution SHA256. Loom 1.18.3 and Fabric Loader 0.19.5 are pinned.
Minecraft 26.1.2 is unobfuscated; this build uses the non-remapping Loom plugin
and no Yarn mappings. Loader provides MixinExtras 0.5.5.

    cd clients/minecraft-screenshots
    JAVA_HOME=/path/to/jdk25 ./gradlew --no-daemon clean build

On Windows, set JAVA_HOME to the JDK 25 folder and use gradlew.bat.
Outputs are in build/libs. Build checks include the standalone verifyGuards
program under src/guardTest. It covers state, generation, local commands,
strict receipts, output bounds, HUD restoration, response deadlines, queue
disposal and exact native method signatures without graphics, network or a
running game. A normal build needs network access to fetch SDK dependencies;
after those are cached, an offline clean build is supported.

    ./gradlew --offline --no-daemon clean build

Jar entries have stable ordering and timestamps. To publish, copy only the
runtime jar into public/companions and regenerate manifest.json with its actual
SHA256 and byte length. Source and generated test/cache files stay out of the
dashboard's Docker build context.

    PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH" node scripts/publish.mjs

### Official build/API references

- [Fabric 26.1 migration](https://fabricmc.net/2026/03/14/261.html)
- [Fabric's 26.1.2 example](https://github.com/FabricMC/fabric-example-mod/tree/26.1.2)
- [Loom for 26.1.2](https://docs.fabricmc.net/26.1.2/develop/loom/)
- [Mojang 26.1.2 metadata](https://piston-meta.mojang.com/v1/packages/78941de799d2675be5bddca699b245d7cbd567ae/26.1.2.json)

Compilation and offline guards do **not** prove a real screenshot or game join.
Framebuffer output, HUD behavior, other client mods and the complete live
upload flow require a player trial with this jar. No live client was exercised
while preparing this release.
