# Cleric PvE guidance — October 24, 2026

Knowledge `2026.10.24.4` adds reviewed level-45 Cleric progression alongside the
existing Gladiator route. It applies by class and observed state, without a
character-name exception. Schmanya's tracked EU/Atiel profile was used as the
public example and checked again after it changed during this review.

## Choosing a focus

The character panel offers **Group healing**, **Solo damage** and **Both**. No role
is inferred from equipped skills or gear. The initial unselected state shows common
guidance and observed stats; role-specific plans and skill comparisons require a
choice. The preference belongs to that tracked character row in the current
browser. It does not change the in-game preset or synchronize between devices.
Storage failures keep a temporary choice and say that it was not saved.

The choice filters recommendations, gear skill priorities and Daevanion comparisons.
Common attack/healing/survival keepers remain available in either role. In particular,
damage contribution does not make Empyrean Lord's Grace or Condemnation solo-only.
Both displays the labeled alternatives; the board panel can switch comparison builds.
Source and character freshness holds remain authoritative for every choice.

## Reviewed progression

| Route | What the helper checks and explains |
| --- | --- |
| Group healing | Radiant Recovery, Healing Light and Light of Regeneration; the four-Stigma choice; cleansing and attack windows between urgent heals. |
| Solo damage | Chain of Torment → Earth Punishment → Condemnation, its prerequisites and selected specialty; a solo fourth-Stigma alternative and resource recovery. |
| Radiant Recovery | Bought rank first, missing white-board bonuses, owned Chalice/Parchment cards, then an eligible Shattered Arkanis reward claim if justified; level 16 option and later level 20 slot. |
| Healing Light | Bought rank and missing board contributions, Compass/Chalice comparison, eligible Deus Research Base claims; level 16 cooldown option. |
| Condemnation | The level 12 critical-reset option requires selection and Earth Punishment's level 5 tier while its mark is active. Later 16 adds a Multi-Hit choice and 20 opens the third Specialty slot. |
| Fixed story mace | Inspect owned candidates, compare a regular Urugugu Conquest Aulamus Mace candidate, preserve the existing enhancement through an accepted transfer preview, then polish only a verified random-line destination. |
| Stigma resources | Inspect existing allocation and unspent points first. Nightmare shop shards cost 1,500 Phantasmal Fragments, with a permanent 35-per-character allowance; remaining purchases are unknown. |

These are community build preferences supported by scoped client references, not a
measured damage/healing optimum. Numeric healing formulas, universal critical caps,
provisional maxed-board examples and inferred currency balances are excluded.
Stigma point allocation, selected Specialties, actual party needs and private
inventory require an in-game check. An equip flag on an unacquired level-zero Stigma
does not prove that it occupies one of the current four slots.

Every farm step retains the level/GS gate, actual stage-unlock check, reward-charge
uncertainty and normal cube cost. The general Arcana, amulet, belt, reset checklist
and timer systems still apply. A missing public Arcana row does not establish an
empty private inventory. Desired drops and Sync/enhancement outcomes are random.
The regular Urugugu guarantee is not a direct guaranteed mace; higher-tier transfer
candidates can require different donor groups and costs.

## Boards and gear

The reviewed white boards are Gladiator 11–14 and Cleric 71–74. A shared pure map
keeps API detail requests, validation, contribution counting, routing and UI links
class-specific. Azphel is outside this PvE model. Details retain the shared
eight-second deadline and at most two concurrent optional requests; a failed or
wrong-board response stays unknown.

The two Cleric presets preserve owned nodes and compare missing role targets using
the reviewed orthogonal model and grade costs. Connector nodes are included. The
combined greedy route is not claimed globally optimal, and available crystals are
unknown. Effects handle the official node-name variation for Empyrean Lord's Grace
by matching its canonical effect description rather than assuming a plural alias.

Gear catalog `2026.10.24.2` contains 16 rules per reviewed class and 46 exact
class-scoped pools, with 37 sources. Legacy unqualified pools remain Gladiator-only;
the same item ID can have a separate Cleric skill pool. All five Cleric Arcana
families have reviewed example pools. Fixed mace/guard/ring/bracelet/belt/rune/amulet
items have no reroll list. Unknown replacement items receive no guessed generic
roll list. Exact-pool references without current capability details carry no
observed-match badges. Focus-filtered badges require the actual skill ID as well
as the reviewed rank; a tied rank alone cannot identify a different skill.

Kanon's slot-stat table describes rarity keepers, not a DPS/HPS order. Cleric skill
choices come from the Cleric sources. Attack-related keepers can support healing,
but damage-only lines are not presented as a direct healing bonus. Exact item pools
filter unavailable lines even when a general slot rule mentions them.

## Evidence and maintenance

Reviewed sources include the original Bible, the Cleric PvE guide and board model,
exact skill/item/card references, official public board details and the unchanged
October 7/14/21 Global patch bodies. Six new main build/skill pins matched repeated
local reads, different encodings and production-network reads. New exact item/card
pins matched two captures. All review expiries remain October 28.

Evidence and private public-character captures are under
`/tmp/aion2-cleric-20261024/`. Character observations stay outside authored knowledge
and model input. The guide's older dataset was cross-checked against current client
references. A conflicting Healing Enhancement percentage renderer was excluded;
the qualitative Attack-to-healing relationship is retained without a formula.

A bounded Sonnet 4.5 review used 18,004 input and 1,864 output tokens. It prompted
clearer Radiant Recovery family eligibility and destination-specific transfer text.
Its duplicate-source warning combined separate catalogs' namespaces; those remain
independently reviewed while HTTP reads deduplicate URLs. Its suggested zero-board
interpretation was rejected: zero verified contribution does not mean four owned
bonuses. Model output is review assistance, never source approval.

The saved index now has 192 authored chunks and 12 queries. The expansion and two
small follow-ups made 105 Titan V2 calls with 13,647 input tokens in total; existing
vectors were reused. The final card-only build invoked two and reused 202 vectors.
Only authored game facts were sent. Ordinary site requests make no model call.
The reviewed build limit is 256 entries, 12,000 characters per text and two concurrent
invocations; exceeding the bound preserves the published index before credentials
or AWS are consulted. Class and optional role metadata isolate retrieval, and both
catalog digests bind the saved artifact.

Update instructions remain in [knowledge maintenance](AION2-KNOWLEDGE.md). No SSO,
scheduled compiler, schema migration or game-server lifecycle change is part of this
release.

## Verification

The baseline passed 3,939 tests; the final suite passed 3,976 across 216 files.
TypeScript and the normal build/artifact verification passed. Build retained the
existing 13 tracing warnings, and lint passed with the existing seven warnings.
Regression protections were deliberately removed or broken, then restored: class
board/pool isolation, direct recipe boundaries, role metadata, focus persistence,
filtered skill-ID badges, retrieval scope/budget and recommendation priority order.

Fresh official HTTP reads returned all four Cleric white-board details. The public
example advanced from 1,697 to 1,777 Gear Score during this review and equipped three
cards; the two newly observed card IDs were separately researched and pinned. The
final catalog covers all 23 reported gear rows with no unknown exact pools. Exact
live item-line comparisons remain partial under the eight-second request budget;
missing capabilities receive labeled references, never manufactured matches.

A read-only isolated production store projection at 11:39 UTC validated the actual
saved character against the new knowledge: current status, valid 23-row gear report,
no armory error and the role-tagged plans. The old stored observation had no Cleric
board details because of the prior hardcoded API IDs. A normal tracked-character
refresh after rollout is needed to publish those newly supported details. This
server-side check does not establish a signed-in browser interaction.
