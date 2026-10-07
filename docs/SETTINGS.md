# Settings

Settings writes follow **write → read back → compare → report**. A saved file and a
running game are separate facts. Current deployment and live verification limits are in
[`../CLAUDE.md`](../CLAUDE.md); completed repairs and dated measurements are in
[`CLOSED.md`](CLOSED.md) and [`MEMORY-HISTORY.md`](MEMORY-HISTORY.md).

## Source contracts

| Layer | Source | Responsibility |
| --- | --- | --- |
| Minecraft properties | `src/lib/mc-properties.ts` | Help, hidden/locked keys and property policy. |
| 7DTD XML | `src/lib/sdtd-settings.ts`, `sdtd-xml.ts` | Allowed properties, strict XML parsing and literal attribute updates. |
| PZ INI | `src/lib/zomboid.ts`, `zomboid-ini-contract.ts` | Parsing/writing, `INFRA_KEYS`, card-owned keys, canonical names, restart rules and `showoptions` parsing. |
| PZ sandbox | `src/lib/sandbox-lua.ts`, `zomboid-sandbox.ts` | Option types, bounds, scopes, creation-only keys and guarded file publication. |
| Live comparison | `src/lib/live-settings.ts`, `game-manager.ts` | Game probes, redaction and evidence-based verdicts. |
| Shared editor | `src/components/config-panel.tsx`, `src/lib/config-change-review.ts`, `use-unsaved-settings.ts` | Drafts, filtering, review, revision-bearing writes and navigation warnings. |

7DTD XML and PZ INI help comes from comments in the current file. Minecraft properties
use a help table because the file does not document itself. PZ sandbox options retain the
file's comments, choices and bounds. Avoid duplicating these contracts in a second schema.

## Shared editor

`ConfigPanel` serves 7DTD XML, PZ INI and both PZ sandbox scopes. Minecraft properties
remain in their custom editor in `src/app/minecraft/settings/page.tsx`.
Specialized cards such as version/loader, quick settings, memory, mods/maps, bans and game
rules keep their own flows; the review below covers the shared panel.

- Search filters names/help; **Changed only** intersects that search with draft changes.
  Filtering never changes what Save submits. The full dirty count remains visible.
- **Save all** opens an old/new review. Only its confirmation writes. The review uses
  the exact last-read and draft strings, shows empty values explicitly, and masks
  password/token/secret values. Review masking does not remove those values from an
  authorized editor's write request.
- The review shows existing restart notes, PZ INI restart-key guidance and creation-only
  consequences from source contracts. It does not claim the game has applied a draft.
- **Discard changes** returns to the last successful read after confirmation. Reloading
  a dirty/stale draft also requires confirmation and then fetches current disk values.
- Edit/Save controls require a successful capability read with `settingsEdit` and the
  relevant world grant. Unknown permissions, initial load failure, an invalid response
  or a stale revision cannot submit defaults or an old draft. Read-only viewers can
  search and inspect values allowed by the server route.
- Dirty panels share one browser unload/same-tab app-link warning. Cancelling a link
  prevents its navigation; new-tab links and downloads remain independent. Client-side
  Back/Forward and programmatic routing are not intercepted. Browser unload prompt
  wording/display is controlled by the browser.

Snapshots bind endpoint and request generation. Writes send the opaque file revision;
stale replies freeze editing until explicit reload. Late replies for an old identity
must not replace the current draft. Successful saves use canonical readbacks and refresh
live comparisons. A readback revision must match the published receipt when one is supplied;
an intervening rewrite stays unconfirmed. An HTTP success alone is insufficient proof of application.

## Configured versus running

`liveSettings(game)` asks the game for its own values, with a ten-second cached probe.
`fetchLiveSettings(game, true)` requests a fresh probe immediately after a write.
The probe is opt-in through `/api/games/status?live=<game>` and requires world access plus
`settings.read`; normal status polls do not request a settings dump. Secret keys are
redacted before results leave the backend.

| Verdict | Meaning |
| --- | --- |
| `agrees` | The game reported an equivalent value. |
| `disagrees` | The game reported a different value. |
| `unknown` | No probe, failed/unreadable probe, or an unreported key. Use the `why` code for rendering. |
| `next-world` | A creation-only value applies to a future world; comparing it to the existing world is inappropriate. |

Creation-only classification runs before comparison. `valuesAgree` tolerates trimming,
case-insensitive boolean words and strict decimal numeric equivalence. It does not apply
general case folding, list-separator normalization or `1`/`0` boolean coercion.
Minecraft currently probes only difficulty/max-players. 7DTD parses `getgamepref`; PZ's
parser delegates to `parseShowOptions`. Enumeration uses the long-reply transports to
avoid silently losing RCON packets. A matching 7DTD `SandboxCode` string does not prove
its decoded settings have become live; see [`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md).

## Writer admission and results

1. Validate values, locked/deployment-owned keys, physical paths and lifecycle requirements
   before mutation. Resolve PZ keys to their unique canonical spelling.
2. Hold the world's quiet file reservation through read/modify/write/readback. Power or
   restore may preempt it; publication and terminal checks must detect interruption.
   Already-started I/O can remain, so interruption does not imply unchanged files.
3. Reject stale conditional snapshots before writes. Current editors send revisions;
   legacy revisionless requests remain supported by the API.
4. Read back published bytes and canonical values. Report ignored, locked and clamped
   keys explicitly, preserve partial/unknown outcomes, and refresh live evidence.

Minecraft service changes compare actual Compose/container values and persist the DB
mirror only after verified application. Unknown run state or unverified shutdown blocks
recreation/restore. Heap admission respects host and container budgets plus native overhead.
Read the game docs before changing files or lifecycle.

### PZ sandbox publication

The writer edits literal option spans while preserving the rest of the Lua file. Whole-file
admission checks outer delimiters and at least 200 parsed options; production routes must
not lower that floor. Each write uses a unique temp file, preserves the original through
a hard-linked `.bak`, and restores ownership/mode after rename. Missing files, structural
refusals and I/O/readback failures remain distinct responses. Sandbox settings need a
restart; creation-only settings retain their separate next-world consequence.

## Coverage and remaining checks

Coverage depends on the current file/game/mods. Use contracts and committed fixtures to
derive counts instead of assuming an old production measurement still applies. PZ INI
hides `INFRA_KEYS` and `CARD_OWNED_KEYS`; Mods, WorkshopItems and Map belong to dedicated
cards. Sandbox hides `VERSION` and `PRESET_ONLY` entries and splits world/mod scopes.
Minecraft rules are discovered from the running game rather than hardcoded as a fixed count.

Full mobile/keyboard/contrast validation, routing-wide draft protection and controlled live
apply/restart/gameplay checks remain separate from component fixtures. Regression evidence
for the shared review lives in `CLOSED.md`.
