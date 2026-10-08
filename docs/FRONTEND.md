# Frontend state and outcome rules

## Operational results

The shared ledger owns tracked completion. Response IDs/receipts remain attached to the
requested action; a gateway page, malformed receipt or lost network response is unconfirmed,
not proof of failure, success, continued work or unchanged files. Refresh the ledger and
current values before retrying. Known pre-admission 4xx refusals keep their explanation.
Partial exports name unresolved entries; bulk download requires a complete export and its
saved target. Do not infer a server target or installer from the currently running world.

## Editable snapshots

Editors bind data to endpoint/game/root/path and a request generation. Discard late results
for old identities. New writes carry the opaque file revision, prefer the custom revision
headers and retain ETag compatibility. A stale reply freezes the draft until explicit reload;
never retry old data against a fresh revision automatically. Failed/invalid initial reads
offer retry and cannot submit defaults or empty lists.

Minecraft editors also pin `X-Minecraft-Context` from a verified read. Once that
identity changes they require reload; a late old reply cannot enable the draft again.
Recovery Restart sends the identity of its accepted status snapshot; emergency Stop
remains available. Recovery logs carry no action-granting identity when unverified.
Profile selection, exact pack builds, adoption and inactive settings are documented
in [MINECRAFT-PROFILES.md](MINECRAFT-PROFILES.md).

Profile polling separates initial `loading` from background `refreshing`. An
in-flight refresh retains the last validated snapshot and does not disable its
controls. Failed, malformed or denied reads disable actions until a valid recovery;
older replies cannot replace a newer profile identity. The picker still expires
server status after fifteen seconds and respects power/file-operation admission.
Explicit recovery rechecks keep an unconfirmed action blocked until profile,
status and validated operation reads each report acceptance. Failed or superseded
reads cannot clear that block; timer polls do not overlap the current ledger read.

PZ quick/maps/mods/updates validate their response shapes and distinguish initial failure
from stale prior data. Mod drafts/cancel/save retain actual enabled/disabled variant tokens;
an unchanged save cannot enable disabled variants or erase unrelated loaded tokens.

## Settings review

The shared 7DTD/PZ `ConfigPanel` offers Changed only, confirmed discard and an old/new review before
Save. Search and filtering do not narrow the write payload. The review hides secret values
and uses the existing restart/creation-only contracts. Editing requires verified capabilities
and a valid, current snapshot; permission loss while reviewing disables confirmation.

Reviewed writes require a valid applied receipt and a validated read of the same config
endpoint afterward. Its revision must match the published receipt when one is supplied.
Display canonical disk values/revisions, preserve unanswered drafts only
against an unchanged baseline, and freeze an unconfirmed result until explicit reload.
Dirty panels share unload and ordinary same-tab app-link warnings. Back/Forward and
programmatic routing are outside that guard. See `SETTINGS.md` for the current contract.
Minecraft's custom settings cards retain their existing flows; they do not use this review.

## Mod list filtering

Minecraft searches names, filenames and recorded IDs, with separate actual file-state and
recorded-origin filters. PZ searches titles, Workshop IDs and provided/enabled mod IDs, with
downloaded/pending/enabled/disabled-variant/no-ID filters. Disabled means at least one known
provided ID is not enabled; missing metadata cannot prove a disabled variant.

Counts distinguish the visible subset from the full collection. Filtering preserves source
order, full-list diagnostics, pack action counts and pending-download polling. Unpaired PZ
IDs use text search only and do not acquire a guessed Workshop/download state. Filter
changes are paused during an ID draft. Background polling also pauses and old background
replies cannot discard an edit; Save/Cancel resumes it. Empty results offer Reset/Show all
without hiding permitted Add/Browse or full-list refresh actions.

Active PZ drafts pause sibling Add/Edit/Remove. Permission/read failure makes the draft
read-only with Cancel available; explicit Retry keeps its current reload behavior.

Minecraft removal requires its success receipt and re-reads inventory. A lost/malformed
reply remains unconfirmed, triggers a read-current attempt and never automatically retries
the deletion or promises unchanged files.

## Player join panel

Home cards and game overviews share copyable `GAMES` addresses and a scrollable How to join
dialog. Clipboard success waits for the browser promise; failure offers manual selection.
Availability reuses the parent's status snapshot, with a fifteen-second expiry and explicit
unknown/stopped/unresponsive/operation states. It does not start a game or verify a join.

Opening Minecraft guidance requests `/api/games/join?game=minecraft` once. That player-safe
route requires authentication/world access and projects only an exact configured version
and loader that agree with the created container. Aliases, drift, missing evidence and
malformed/failed/wrong-world responses remain unknown with retry. Show the check time;
recheck after settings change. A verified target does not prove the running build, loader
build number or a complete compatible client pack. 7DTD/PZ exact builds stay unknown here.
Changing worlds closes the old dialog and discards its target/clipboard session.

## Permission and Crew controls

Privileged controls/reads start disabled while capabilities are unknown. Render edit,
delete, console execution, update and user-management actions only for their capabilities.
World membership alone does not grant these actions.

ADMIN effective access is all worlds; stored grants remain separate and survive a role
change. Serialize mutations per user in the same browser, disable that row while saving,
and consume canonical server readbacks without optimistic grant changes. Ambiguous failures
refetch current users; failed reconciliation keeps the row locked with Retry. This does not
claim cross-browser edit serialization.

## Monitoring and update checks

The monitor tracks last successful poll, current failure and expiry. Values older than
15 seconds cannot animate or claim Live. Shared game-status failures appear on all three
power surfaces; stale PZ update state cannot claim Updating now.

Up to date requires checked, consistent installed/upstream build IDs. Missing IDs, failed
lookups and partial Workshop results remain unknown and disable unverified update actions.
The 7DTD backend maps stable to Steam public and reads the configured Compose branch.

Regression evidence lives in `CLOSED.md`. Full mobile, keyboard and contrast coverage and
real client joins remain separate validation; component fixtures are not live gameplay.
