# Player-camera profile screenshots

## Scope

The profile detail page offers an optional **Capture from your game** panel beside
the existing manual JPEG, PNG and WebP cover controls. It uses a player's Minecraft
client camera, not a server renderer. The first companion targets Minecraft 26.1.2
with Fabric Loader 0.19.5+ and Java 25; it can join a compatible Fabric or vanilla server profile.
Other targets retain manual cover upload.

Install the downloaded companion in the **client** mods folder before launching
Minecraft. Fabric API is not required by this companion. The dashboard shows its version, file size and SHA-256 from a validated,
same-origin manifest. This does not provide a complete client modpack.

## Pairing flow

1. Start the desired profile through the ordinary profile picker and join its world.
2. On that profile's detail page, request a pairing session. Management permission,
   a ready supported profile and verified running/applied identity are required.
   Replacing an existing cover needs an explicit checkbox.
3. Enter the dashboard's local `/yoshling pair CODE` command in the client. The
   private code authorizes one image for this profile and expires after 15 minutes.
   Copy is explicit and reports success only after the Clipboard promise resolves.
4. The companion waits for the world to be loaded for 20 seconds and for pairing
   to last at least 3 seconds. `/yoshling capture` requests a capture manually.
5. The dashboard reports waiting, paired and uploading separately. It reports a
   saved screenshot only after the server's verified completion receipt and a
   separate canonical profile readback agree.

Pairing does not start or switch a game. Cancellation needs a matching server
receipt. Expiry disables the command and stops polling; another session requires
an explicit request. Commands remain in component memory, not browser storage.
Unknown mint results require explicit profile recheck before another request.
Named refusals retain their explanation and require the same fresh review; a stale
revision is not resubmitted until it has been rechecked.
Declining the discard confirmation or failing that read keeps pairing blocked.
The same explicit recheck is available while a supported profile is stopped,
starting or unverified. Status polling does not reset profile drafts to enable capture.
Unknown status reads
offer a status recheck without creating another grant. A new accepted grant
invalidates earlier live grants for the same profile.

## Drafts and manual overrides

Capture completion updates only a matching canonical profile snapshot. Unsaved
name, description, world-setting and selected manual-upload drafts remain intact.
A changed baseline, conflicting metadata, newer local cover receipt or failed
readback freezes further edits until explicit reload. Reload retains the normal
unsaved-change confirmation. A late capture cannot acquire permission to overwrite
a newer manual cover by refreshing its revision automatically.

## Trust and verification limits

The server validates the authorized grant, active profile/runtime and cover
publication. Those checks cannot independently prove which world or scene an
authorized client included in the image. Screenshots may contain player information;
review the scene before pairing. Successful storage/readback is not proof of image
contents or a successful game join.

The component and response-admission fixtures run without Minecraft or production
calls. They do not exercise a graphical client, rendering, live pairing, uploads,
mobile layout or the full browser keyboard flow. Live-client evidence and deployment
status belong in the release record after those checks are performed.
