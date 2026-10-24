# Aion 2 helper

`/aion2` is a separate authenticated application inside Yoshling. Home and the game
sidebar link to it; its header switches back to game hosting. Existing world routes,
grants and lifecycle controls retain their contracts. The helper has no hosted-world
identity and never starts, stops or modifies a game server.

## Visual presentation

The visual polish for this rollout extends the existing Catppuccin theme accents
across the character roster, Combat Power and Gear Score metrics, daily/weekly
checklist views, and event timers. Selected characters, reset periods and event
contexts use clearer surface, border and icon accents while retaining their labels.

The palette uses lavender for selection, blue for Gear Score, rifts, resets and alert
settings, teal for daily activities, play windows and sieges, green for reported
completion and open entry windows, and gold for Combat Power, weekly activities,
priority and community estimates. Tinted surfaces and borders accompany foreground
text; labels and icons carry each state as well.

Status text remains visible alongside colour: tracking or paused, current or stale,
reported checklist completion, scheduled entry/play windows, and community boss
estimates. Timer colours do not establish boss liveness. Source holds retain their
explanation and saved reports. Interface copy names the action or information, such
as **Add a character**, **Daily & weekly checklist**, **Daevanion board** and **Alerts**.

The captured-data preview was reviewed at 1440 × 1000 and 390 × 844 in dark and
light themes. Character metrics, weekly/daily views, timer states and alert settings
fit without horizontal page overflow; official images loaded. This was a visual
spot check, not a complete contrast, keyboard or live-account audit.

## Characters and observations

- Every currently permitted Discord account can use the helper without a world grant.
  Lists belong to the account, including for admins. Search by Global region, server
  and name, then add the selected canonical character. All classes can be tracked.
- Regions: EU, NA East, NA West, Latin America and Asia. KR/TW are not implemented.
  Identity is `(region, serverId, characterId)`, not a name or the profile's regionName.
- Limits: 12 characters/account and 100 total. A signed-in friend maintains their own
  list. Adding another person's public character does not grant access to their account.
- A 60-second server timer checks up to three due profiles sequentially. The normal
  refresh interval is 15 minutes. The site must remain running for unattended tracking;
  the browser can be closed. `AION2_TRACKING=false` disables the timer.
  Due profiles can wait longer under load; freshness gates still apply.
- Shared inflight requests and a 60-second character cache avoid duplicate reads.
  Database leases prevent concurrent timer/manual publication. Manual refresh has a
  60-second cooldown and respects failed-check backoff (up to two hours).
- History retains up to 200 changed observations from 30 days, always retaining the
  newest. An unchanged check advances lastSuccessAt without manufacturing a history
  point. API receipt time is not NCSOFT's underlying character-change time.
- A failed or malformed lookup preserves the last good snapshot and records the failure.
  Recommendations are withheld after a failed character check or when the snapshot is
  older than 30 minutes. Pausing does not erase history. Removing deletes that account's
  tracking row/history; an inflight refresh cannot recreate them.
- Odyle is not exposed in the verified public profile APIs. An optional, collapsed
  budget helper stores a manually reported balance and its timestamp per character.
  Public refreshes never alter that balance or claim it is live. Budget calculations
  use a report for at most 30 minutes and remain conditional on unseen reward charges.
  Unknown energy does not block the plan: it shows the cube cost and non-Odyle options.

`src/lib/aion2-api.ts` calls fixed official HTTP origins without login/cookies. Core
profile/equipment reads share an eight-second deadline. Optional item details for
critical weapon, guard and rings, plus the four white boards' node/effect details,
use that same deadline first. Remaining known gear/Arcana slots use optional bounded
requests within the leftover budget; missing capabilities stay unknown.
Item-specific caps and fixed/random lines take precedence over grade assumptions.
The armory provides skills, gear, equipped pet/wings, Pantheon stats and board progress.
Inventory, currencies, quests, daily entries, Odyle balance and full Genus progress are
unknown. Never interpret a missing/private field as completion, zero, or an empty slot.

Character, gear, skill and board images use the official public image origins with
safe fallbacks. The helper does not request NCSOFT credentials or reuse account cookies.

The gear view now provides item cards with observed lines and ranked substat
comparisons. [Gear priorities](AION2-GEAR-PRIORITIES.md) explains the reviewed
Gladiator/Cleric item-pool scope, tied groups, fixed/unknown items and source gates.
`gear-priorities.json` joins source validation and the offline index digest.
Read [source fingerprints](AION2-SOURCE-CHECKS.md) for the exact Overhead Slam
content scope and the review required before changing any source's hash input.

## Knowledge and recommendations

`src/data/aion2/knowledge.json` is the reviewed, versioned knowledge base. Each rule
names its strategy, class scope (empty means general), thresholds, exact source IDs,
evidence, review date and expiry. It currently contains general equipment/progression
goals, ordered action recipes and curated Gladiator and Cleric routes. It is not a
complete build optimizer; other classes retain general guidance until reviewed.
Cleric characters choose Group healing, Solo damage or Both in a per-character
browser preference. [Cleric coverage](AION2-CLERIC.md) records skills, gear, boards,
sources and limits. Preferences do not alter the game's preset or bypass freshness.

[Knowledge/index maintenance](AION2-KNOWLEDGE.md) describes the optional offline
Bedrock embedding build, source matching and temporary-credential workflow. AWS is
not required at application runtime.

Rules contain reviewed milestones and ordered steps. `activities` centralizes dungeon
entry requirements and per-claim energy costs; steps refer to activity IDs. The plan
renderer substitutes observed character facts and handles prerequisites, existing
random-line rings, already-owned board skill bonuses and unknown resources. Materials,
drop/roll RNG and transfer previews are explicit, rather than promises of success.
Bought skill ranks, stored cards and unopened bags are checked before an Odyle farm.
Every linked activity applies its level/GS gate even when reported energy is sufficient.
The cap-only guard spending rule was removed; replacement and donor planning are
scoped to reviewed items/classes. Amulet and belt scrolls supplement stones and Kina.
See [current progression and checklist behavior](AION2-PROGRESSION-AND-CHECKLIST.md)
and [the dated evidence matrix](AION2-REVIEW-2026-10-23.md) for the detailed review.
The [October 24 review](AION2-REVIEW-2026-10-24.md) corrects shared continuous dungeon
reward counters and removes an unsupported Shugo character-bank task. It refreshes
reviewed source pins without extending the October 28 expiry or changing the
Gladiator investment order. Automated knowledge compilation is not yet enabled.
For Gladiator, 14 first targets 16's cooldown option, then 20's third Specialty slot.
All four owned Overhead board bonuses suppress repeated board allocation, but not
the bought-SP-rank check. Boss use also requires the appropriate Rage Burst window.
Parchment/Chalice are eligible for Overhead; Compass is not. Card enhancement level
is never treated as a guaranteed increase to a particular skill.

Evidence kinds are explicit. Current NCSOFT item metadata verifies capabilities;
community guides provide labeled strategy advice. Client-data references provide
scoped skill-pool, specialty and dungeon data, distinct from NC-authored documentation.
Parchment/Chalice Overhead rolls were also observed in official public equipment
responses. No exact damage gain, universal crit cap, best
purchase or currency affordability is calculated.

The initial review read the October 7, 14 and 21 Global patches. October 14 supersedes
the spreadsheet's Odyle shop limits, which are excluded. October 21's Ariel fragments
come from the new Hard Expeditions (2600 GS); ordinary dungeons are not recommended as
their source. Revelation Amulet's verified description names Monolith Resonance;
Noble Belt's names Strongholds and explicitly mentions Morph after +10. Fixed-line
Spiritforged weapons are never told to reroll or amplify without item capability data.
Current client transfer text says fixed-source Soul Binding effects do not transfer;
only enhancement transfers. The recipe still requires checking the actual preview.

### Daevanion comparison

`boardPresets` declares reviewed class targets and an explicit, sourced path model.
Gladiator uses white boards 11–14; Cleric uses 71–74 with separate group/solo
comparisons. A shared reviewed class map governs detail fetching and paths. Nodes/effects/owned
state come from the official armory; orthogonal adjacency and grade-based crystal
costs come from a reviewed client-data reference. `Legend` in the official board API
corresponds to that reference's 3-crystal tier. The free Start node is a graph root
even when its API open flag is zero.

The planner preserves owned nodes and computes a weighted shortest additional route
to each missing target in preset priority order, reusing connectors. It does not
claim a globally optimal combined build or recommend a full respec. Available
Daevanion Crystals are unknown. Unsupported classes, unreviewed models or malformed
graphs cannot produce a guessed route/cost. The UI shows current nodes independently
from the comparison, with icons, target/path highlighting and ordered unlock chips.
The 2026-10-23 Yoshiane capture needs 12 additional modeled crystals on Triniel:
7 for the Experienced Counterstrike route and 5 for the Multi-hit corner route,
including six new nodes in total. The rest of the reviewed targets are already owned.

Before the first recommendations, then every 30 minutes while the helper is read or
tracked profiles are due, the server checks the official patch feed, all reviewed
patch revisions/bodies, pinned guide bytes, timer and checklist-source bytes. These reads share an eight-second
deadline. New/revised/missing patches, a changed pinned guide, an invalid manifest,
or an expired knowledge/timer/checklist review withhold recommendations. A detected change stays latched for
that running catalog combination; a process restart rechecks upstream baselines.
Network failures retain a previously verified source result for at most one hour;
afterward recommendations are withheld. Character observations/history remain usable.
The UI separately expires its last character/source read and hides stale advice.

Checking sources detects change; it does not prove that every strategy is correct.
The review process below is required before changing baselines or dates.

### Event timers

Per-event alerts support a custom lead time, sound and volume, with explicit browser
permission/audio controls. See [timer alerts](AION2-ALERTS.md) for storage, scheduling,
source checks and the limits of reminders while the helper remains open.

`src/data/aion2/timers.json` contains the reviewed EU schedules, source links and
review expiry. Other regions receive an unconfirmed state rather than EU times.
`aion2-timers.ts` projects each occurrence using its IANA time zone. Berlin events
follow daylight saving changes; daily/weekly resets remain at their reviewed UTC
time. An ambiguous repeated hour withholds that occurrence's countdown. Entry and
play windows are separate; a scheduled window never establishes boss liveness or
the character's remaining entries.

The Gartua card reads public, server-specific community reports through
`GET /api/aion2/timers?region=eu&serverId=2322`. The adapter independently matches
official and provider server ID, name and faction; Atiel maps to provider key
`eu-altgard`, not a guessed name-derived slug. All upstream requests are bounded
read-only GETs. The site does not submit kill/alive reports. A future spawn estimate
is labeled community data with kill/report/feed timestamps. A failed or stale feed
retains historical information without a countdown, and an elapsed estimate never
automatically advances another twelve hours. No authoritative boss status is claimed.

The timer panel refreshes community reports once a minute while visible. Its clock
updates independently from the character view. Current knowledge/source status is
required for countdowns; timer source expiry is also checked, including Gartua report
eligibility. Five stable schedule/reference URLs have SHA-256 pins checked alongside
the main sources. Shugo's HTML has changing CSP nonces and is linked as a corroborating
observation, rather than incorrectly raw-pinned. The Artifact card reminds at 21:00;
its detail distinguishes the reviewed 21:05–21:30 battle schedule. The manifest
validator checks shape, recurrence, source references, pins and dates, not strategy truth.

### Updating the knowledge base

1. Use Node 22 and run `npm run aion2:knowledge:check`. It validates the manifest,
   compares patch IDs/update times/normalized-body hashes, and checks pinned guide
   and timer-source bytes. Network failure is an unverified check, never an up-to-date result.
2. Read every new/edited official Global patch and announcement. Compare each affected
   rule with current official item/skill/content evidence and region-specific expert
   guidance. Conflicting or unverified advice must remain absent or explicitly labeled
   as community guidance. Check currently obtainable content, item caps and class IDs.
3. Edit the JSON rules, milestones, activities, step recipes, board presets and sources.
   Review `timers.json` separately: confirm region, clock zone, preparation versus
   battle start, entry/play duration, and any kill-dependent reports. Do not replace
   unknown boss state with a fixed recurrence. Renew timer dates only after review.
   To add another class skill target, use the existing `skill-target` strategy with an
   exact skill ID and nonempty class scope. New
   strategies require a reviewed TypeScript implementation and tests. Never map search
   pcId directly to a class ID; it also encodes race/gender.
4. Update source hashes only after reading changes. Record patch IDs, updatedAt and
   SHA-256 of `article.content.content` after CRLF-to-LF normalization and trim. Guide
   hashes use raw exported bytes, including a UTF-8 BOM. Keep review periods short.
5. Bump the knowledge version and review/expiry dates on the manifest, affected rules
   and sources. Run `npm run aion2:knowledge:validate`, the online source check, and the
   required repository checks. Test both matching and nonmatching classes, unknown
   fields, stale snapshots and expired/changed sources. Do not renew dates alone.
6. Deploy through the normal reviewed web deployment. No LLM, background worker or
   downloaded guide can automatically publish new game advice or change rule baselines.

Official feed URLs and pinned guide URLs live in the manifest. `aion2-knowledge.ts`
owns freshness; `aion2-recommendations.ts` applies the declared strategies. Source text
is never executed or treated as instructions.

## Database rollout

The additive migration is
`prisma/migrations/20261023150000_add_aion2_tracking/migration.sql`.
It adds `Aion2Character`, `Aion2Snapshot` and `Aion2ChecklistCompletion`, with account ownership and cascading
deletion, including nullable reported Odyle/context timestamp columns. There are no startup migrations. A missing schema returns a clear unavailable
response; existing hosting routes do not query these tables.

Production applied this migration on 2026-10-23; do not reapply it. See the
[rollout record](AION2-DEPLOYMENT.md) for schema and backup evidence.

For a fresh installation: follow CLAUDE.md's backup/manual-migration procedure, apply the reviewed
SQL, verify all three tables/indexes/foreign keys and existing user/game data, then deploy
the generated client and web via `scripts/deploy.sh --service web --verify 'Track your progress'`.
Read actual production state first; the quoted literal is present in the helper bundle.
Do not apply migrations or deploy merely because a local build passed.

Locally, use a disposable SQLite database with existing User schema before applying
this migration. Tests create real temporary SQLite databases and never migrate the
configured application database.

## Verification and limits

The adapter was exercised against Yoshiane/Atiel EU through direct official HTTP,
including item-specific caps, fixed lines and ring skill rolls. Source pins were
checked against the current Global patches and guide exports on 2026-10-23.

The updated offline Titan index was built on 2026-10-23: 54 authored knowledge chunks,
six predefined queries and 35 similarity groups. This rebuild reused 31 vectors and
made 29 model invocations with 3,430 input tokens.
Runtime retrieval requires no AWS access. See the maintenance document for the
limits of pre-embedded questions and the credentialed update command.

Offline tests cover owner isolation, actual SQLite persistence, history/backoff/leases,
pause/delete during refresh, API validation, class/coverage/staleness gates, knowledge
edits/expiry and client error handling. Regression mutations proved owner, character
identity and client identity protections fail their tests when removed and pass again
after restoration. These do not prove a production Discord login or deployment.

Final local verification on 2026-10-23: 209 test files / 3,759 tests passed;
TypeScript and the normal production build passed. Lint retained its seven existing
warnings and the build its thirteen existing tracing warnings. The actual Docker
runner build and its artifact guard passed. A packaging regression failed when the
pure semantic helper allowlist was removed and passed after restoration; the
credentialed embedding builder stays outside the build context. Added mutation checks
also proved timer-source change detection, timer/Gartua review expiry, community-feed
freshness, semantic class boundaries and source URL validation fail when removed,
then pass after restoration. The second review also proved item/class scope, entry
gates, retained target ring rolls, cheap inspection order, full material costs and
unique checklist/timer source drift checks fail when removed and pass on restoration.
The localhost preview uses captured public data and
mocked account APIs; it is not evidence of a live authenticated deployment.

The captured-data preview was checked on desktop and at 390px width for profile/gear
images, source links and horizontal overflow. The board now uses the actual grade/open
frames and class-start crests referenced by official armory CSS: all 17 asset URLs
returned PNG/HTTP 200. Owned, target, path and next-unlock states have distinct colors
and labels. Asset-state selection and failure recovery have mutation-tested regressions;
no paths are guessed. Artwork does not establish graph adjacency.

The three-table migration and web deployment completed on 2026-10-23. See the
[production rollout record](AION2-DEPLOYMENT.md) for backup, image, HTTP and unchanged
game-state evidence. The user confirmed production Discord sign-in after the issuer
fix; live helper add/refresh/checklist operations remain unverified.
NCSOFT's public web endpoints
have no published developer stability/rate guarantee identified in this research.
Invitation revocation removes access immediately on session resolution, but public
tracking rows continue polling until the account/rows are removed or tracking is paused.
