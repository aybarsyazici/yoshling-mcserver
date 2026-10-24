# Gear substat priorities

The gear view opens one card per equipped item. It preserves the observed item
icon, grade, upgrade, stat/skill lines and binding/cap metadata, and places the
reviewed priority groups beside them. Equal ranks are alternatives, not a promise
that every listed line can coexist or has the same calculated damage gain.

## Evidence and scope

`src/data/aion2/gear-priorities.json` is a separately versioned catalog with 16
Gladiator PvE slot rules, 20 exact item pools and 23 sources. Its initial review
covers the EU example's 23 equipped rows and expires October 28, 2026. Other classes,
regions and unreviewed replacement items do not inherit Gladiator/item-specific
rankings. Adding reviewed data uses this catalog; no UI code change is required
for another supported item using the same mechanics.

The original Kanon substat list is explicitly ordered by **roll rarity**, not
damage value. The Gladiator guide provides community preferences and skill goals;
the item references establish potential pools. The UI identifies this basis and
uses tied groups where the sources do not establish a total benefit ordering.
It does not claim a DPS simulation, universal critical cap, affordable budget or
optimal roll combination. Source links accompany each item comparison.

The current skill condition prioritizes Overhead Slam levels below 20, explaining
16's cooldown Specialty first and 20's later slot goal. The actual bought rank,
selected Specialty and inventory still require in-game inspection. A skill missing
from an exact item's pool is filtered out, even if it appears in a generic slot rule.
For example, the reviewed current cloak cannot inherit an unavailable Perfect Chance
line merely because it appears in a general cloak list.

## Fixed, unknown and conflicting items

- Observed fixed metadata or an exact reviewed fixed pool produces no ranked
  reroll list. Spiritforged Guard, the reviewed story bracelets, belt, amulet and
  runes do not inherit generic random-item instructions.
- A reviewed fixed pool conflicting with observed random metadata is unverified;
  no rank or spending action is shown.
- An exact reviewed random pool and a matching mechanic support a filtered
  comparison list. If live capability/details are missing, it is labeled an item
  reference, has no observed-line badges and does not authorize rerolling. Unknown
  item pools still receive no substituted generic ranked list in the UI.
- Arcana use separate card skill pools. Random card rolls do not establish Sync
  or Reset capability, nor guarantee another desired skill level on enhancement.
- Critical Hit/Critical Attack and Weapon Damage Boost/Damage Boost are not fuzzy
  substring matches. Explicit IDs/names/aliases identify an observed line; ambiguous
  matches do not receive a priority badge.

Only items with current observed random capability can receive observed priority
badges. All displayed observed lines come from snapshot metadata. The derived report only
annotates an exact line match and cannot supply replacement observed values.

## Freshness and API behavior

`aion2-gear-validation.ts` validates the authored catalog and client report bounds,
source URLs, ranks, class/mechanic scope and item/slot identity. `aion2-gear-priorities.ts`
derives `character.gearPriorities` during the existing owner-isolated projection.
No database migration or stored gear-plan state is required.

Gear sources/version join the runtime and CLI source gate. Invalid, expired,
changed or unverified sources withhold ranks. Failed or older-than-30-minute character
reads do likewise; observed gear remains visible. The client also honors the overall
recommendation hold. The review-required message now covers updated references as
well as patches, rather than falsely asserting every changed source was a new patch.

The armory adapter keeps its single eight-second budget. It reads the base profile,
critical weapon/guard/ring details and white boards first, then other known equipment
including runes and Arcana slots using batches of at most two item requests. Unknown/cosmetic slots
are not probed. Optional failures preserve the verified base/earlier details and
never imply an empty stat or editable item. Observed stat IDs survive persistence;
older snapshots without IDs remain valid.

## Bedrock curation and index

The user authorized the renewed local `.env` AWS credentials for this update.
No SSO configuration was changed. Only authored game facts were sent for review
and embedding: no account identity, character observation, inventory or credentials.

A bounded Sonnet 5.5 audit exhausted its output allowance without a final answer.
A subsequent Sonnet 4.5 audit completed (16,734 input / 1,513 output tokens). Its
main concern was applying the generic weapon/guard rule to the fixed Spiritforged
Guard. Explicit fixed/conflict gates and regressions already enforce the required
withholding, including when observed details are absent. Its proposed blanket ban
on all guard skill lines was not adopted: a different random guard requires its own
reviewed pool. Several other severity labels contradicted their own “no contradiction”
reasons. Model output was manually checked, not treated as source truth or approval.

The index now binds **both** the main knowledge and gear catalog digests. It stores
90 authored chunks/six queries: 60 existing vectors reused and 36 new Titan V2
invocations, with 7,173 embedding input tokens. Gear chunks cannot displace a
progression rule's related step explanations. Edited catalogs invalidate saved
semantic evidence; the builder checks both inputs again before atomic publication.
The website still makes no AWS/model request during ordinary use.

Review artifacts are retained locally under `/tmp/aion2-gear-bedrock-audit/` and
`/tmp/aion2-update-20261024/gear-priorities/`. Source pins live in the catalog.
The general update workflow remains in [knowledge maintenance](AION2-KNOWLEDGE.md).

## Verification — October 24, 2026

The final suite passed 3,871 tests across 214 files. TypeScript, the normal
production build/artifact check and lint passed; the same 13 build tracing warnings
and seven lint warnings were present before this change. Regression protections
were removed or broken to prove failure, then restored: fixed/source/identity gates,
exact pool filtering, reference badge suppression, snapshot-only observed values,
the shared request deadline/order, rune detail inclusion and combined index binding.

A fresh public HTTP probe at 09:49 UTC returned knowledge `2026.10.24.2` and gear
status `current`, three progression plans and 23 equipped rows for the example:
three live verified comparisons, 13 exact-item references and seven fixed items.
All four white-board details were returned. Detail counts vary with upstream latency;
reference rows had no observed-match badges. All four catalogs' pinned sources
matched the final local source check. This proves public projection, not a signed-in
production account interaction.

Browser observation of the localhost preview was refused by the browser URL policy;
no visual browser approval is claimed. Component tests cover expanded cards, held
and fixed items, references, tied ranks, source links and malformed projections.
