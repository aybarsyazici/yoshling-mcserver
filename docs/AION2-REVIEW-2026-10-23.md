# Aion 2 progression review — 2026-10-23

This is a diagnosis snapshot of the initial `2026.10.23.2` advice, not the current
backlog or a claim that every finding below remains unfixed. Current behavior belongs
in `AION2-HELPER.md`; the implementation and its regression tests determine remediation
status. Review covered the initial recipes, eligibility rules, observed official
equipment/skill data, current client-data references, and the October 7/14/21 Global
patches. No production migration, deployment, purchase or character change was made.

## Evidence and limits

Official armory responses establish equipped items, skill levels, item descriptions,
caps and board nodes at observation time. They do not expose inventory, unspent skill
points, currency, dungeon reward charges, weekly activity progress, selected Specialty
options or a player's combat role. NCSOFT patch notes establish their stated changes.
The linked Aion2Data/Aion2.gg pages are independently maintained client-data references
and build advice, not NC-authored documentation. Their interpretations and costs still
need the actual game's confirmation before spending.

Neither a higher item cap nor an available activity proves that investment is a good
next action. Priority requires the current item's lifetime, alternatives, marginal
effect, all costs, and the player's goal. The public profile alone cannot prove those.

## Audit matrix

| Claim or initial behavior | Current evidence | Required action | Limits / regression case |
| --- | --- | --- | --- |
| Enhance any weapon/guard below its observed cap | A cap is a capability, not a value comparison. Late unique enhancement has rising costs and failure risk in the [Spiritforged cost reference](https://aion2data.com/items/115030041-spiritforged-guard). | Remove cap headroom as a stand-alone spending priority. Compare replacement route and preview before proposing optional enhancement. | Guard/Spiritforged replacement research is a separate review; do not assert a universal best item or price. |
| Every fixed-line main hand should become an Aulamus Greatsword using a +15 Spiritforged donor | Fixed lines do not identify a story item, weapon family, class or transferable enhancement amount. [Urugugu's client table](https://aion2data.com/dungeons/urugugu-canyon) includes a rare greatsword drop; it does not make that route efficient for everyone. | Gate the concrete recipe to reviewed source item IDs, class/weapon family and actual enhancement. Other fixed items receive inspection guidance. | A Cleric fixed staff and a nonstory Gladiator fixed weapon must not receive Spiritforged/greatsword instructions. |
| Transfer the currently equipped donor immediately | [Client transfer strings/reference](https://aion2data.com/tools/succession) require source Soul Binding, an unequipped donor outside presets, and a valid recipient. The donor is consumed. Fixed-source Soul Binding lines do not transfer. Cross-tier/transfer-history and line-capacity constraints matter. | Prepare the donor, verify donor/recipient identity, costs, resulting enhancement and lines in the preview, then require the user to decide. | Do not generalize fixed-source behavior to random donors, Amplification or transfer crafting. A +10 donor cannot promise +15. |
| Revelation Amulet uses special scrolls rather than ordinary Enhance Stones | The [current amulet table](https://aion2data.com/items/311030001-revelation-amulet) lists scrolls **and** stones **and** Kinah. Full +0→10 reference cost: 10 scrolls, 200,980 stones and 5,026,000 Kinah, with 100% listed success. | Correct the cost explanation and inspect all material costs before spending. | Full-route totals are not the remaining cost from the observed level. Official item metadata establishes source/cap, not these numerical costs. |
| Noble Belt scrolls imply a free/direct damage upgrade | [Noble Belt](https://aion2data.com/items/215240001-noble-belt) full +0→10 reference cost is 10 scrolls, 63,060 stones and 1,579,000 Kinah. Its stats are HP/defense; official description says Stronghold scrolls and Morph after +10. | State the defense/progression purpose and combined costs. Retain the Morph inspection phase at +10. | The old `<10` trigger loses that phase after a refresh at cap. Do not promise an unclaimed reward or affordable Morph recipe. |
| Generic Monolith/Stronghold activity means a specific reward remains to claim | Official item descriptions link Revelation Amulet scrolls to Monolith Resonance and Noble Belt scrolls to Strongholds. They do not expose the player's completion/reward state. | Ask the player to inspect the activity's actual reward list and claim state. Link manual reset checklist only where the cadence/scope is reviewed. | Do not invent a chest, scroll count, reset period or already-unlocked region from an equipped item. |
| An empty equipped Arcana slot means the player must farm a new card | [Arcana guide](https://aion2.gg/guides/arcana-system-explained) allows equipping all five families at level 45. Inventory and unopened bags are private. | Inspect existing cards/bags and equip a useful card first; farm only after that check. Prefer owned Training Arcana and free mission rewards when suitable. | No equipped cards plus unknown inventory must start with a zero-cost check, not a 40-Odyle claim. |
| Shattered Arkanis is the first Arcana farm for every missing slot | [Shattered](https://aion2data.com/dungeons/shattered-arkanis) supplies Chalice/Parchment/Mirror; [Deus](https://aion2data.com/dungeons/deus-research-base) supplies Chalice/Compass/Bell. Both Stage 1 entries are level 45, GS 1600, 40 Odyle per cube. | Route by known missing family/skill pool. Compass/Bell needs Deus; Parchment/Mirror needs Shattered. Unknown slots get a pool comparison. Declare Deus's activity cost/requirements too. | Higher stages require previous-stage S rank; GS alone does not prove unlock or reliable clear. Stage 1 is a baseline, not an efficiency optimum for high-GS characters. |
| Arcana slot family can be inferred from arbitrary text | Two official equipped samples plus the [fixed-family guide](https://aion2.gg/guides/arcana-system-explained) establish 41 Chalice, 42 Parchment, 43 Compass, 44 Bell, 45 Mirror. Official frontend labels these Arcana1–5. | Use the reviewed numeric mapping when equipment coverage is known. An unambiguous family name may corroborate it. | Unknown/malformed coverage cannot establish a missing slot. Do not use Compass for Overhead Slam. |
| With all four board bonuses owned, checking purchased base skill rank is redundant | [Gladiator guide](https://aion2.gg/guides/gladiator-pve-build) separates purchased rank, four white-board bonuses and equipment/Arcana bonuses. The armory's total rank is not a purchased-rank proof. | Keep the free purchased-SP and selected-Specialty check unless a complete breakdown is observed. | Counterexample: total 14 = base 8 + boards 4 + gear 2; two purchased ranks can reach 16 without farming. |
| Overhead Slam 16 alone enables unrestricted boss spam | [Overhead skill reference](https://aion2.gg/database/skills/overhead-slam-11170000) and [Rage Burst](https://aion2.gg/database/skills/rage-burst-11390000) describe the Specialty and trigger conditions. Boss immunity and Rage's limited window matter. | Explain the level-16 Specialty selection and conditional Rage/boss context. Check actual acquired/equipped Rage before suggesting it. | Observed Gladiator already has Rage Burst 5 equipped; do not tell that character to acquire it. Never automatically remove a defensive skill. |
| A further Lunge upgrade is always the best stigma investment | [Lunge](https://aion2.gg/database/skills/lunge-stance-11400000), [Zikel](https://aion2.gg/database/skills/zikels-blessing-11250000), [Rage](https://aion2.gg/database/skills/rage-burst-11390000) and the [stigma guide](https://aion2.gg/guides/gladiator-pve-build#stigmas) give distinct breakpoints and escalating shard costs. | Present marginal effects and optional free-reset comparison, preserving role/defense choices. Zikel 5 is stagger damage; Zikel 10 adds PvE damage. | Observed Lunge 12→15 costs 12 shards; Zikel 1→5 costs 4, 1→10 costs 14. These effects are not a verified universal DPS ranking. No unspent shard balance is public. |
| Sync a random ring and stop only when Overhead appears | [Ring pool](https://aion2data.com/items/310330052-aulamus-ring) and [Soul Binding reference](https://aion2.gg/guides/soulbind-and-substats-explained) describe RNG/costs. Existing target-bearing rings and item-specific line pools matter. | Choose an exact eligible ring and replaceable line, preserve useful skill lines, inspect the preview and set a user-chosen spending stop. Compare owned-card alternatives first. | Do not pool replaceable lines across different rings, reroll an already-owned target unnecessarily, or claim guaranteed success. Gear duplicate-line restrictions are a client-reference interpretation, not official API proof. |
| Bind, Sync and Reset are interchangeable improvements | The same [Soul Binding reference](https://aion2.gg/guides/soulbind-and-substats-explained) separates improving existing values, replacing a line and rerolling all lines. | Preserve the distinct actions and show destructive consequences before a reset. | Bind does not guarantee a higher gear skill rank. Missing UI capability/private materials remain unknown. |
| Enough manually reported Odyle means an activity is ready | Reviewed dungeon tables also require level, GS, unlocks, cube charges and clear capability. A 30-minute manual balance is a report, not live game currency. | Apply public level/GS eligibility to every linked cost step; leave private entry checks conditional. | Unknown reward charges cannot become a green eligibility assertion. Completion checkboxes never decrement reported energy. |
| The original Checklist tab remains current without patch review | The October 14 Global patch supersedes its older Odyle morph quota. Current client rows distinguish server and character limits and weekly shop purchases from quest completion. | Implement an explicit reviewed reset catalog; retain source dates and scopes. Exclude stale quotas. | Home Command 12/week and lower Abyss Command 20/week describe scroll shop purchases, not quest-completion caps. |

## Reviewed reset-checklist interpretation

The supplied [Checklist tab](https://docs.google.com/spreadsheets/d/1bNxC1wd0S_ILGYAyWnO0aTo_G_AOrjkv7bTcOj_NRz8/edit#gid=1177705857)
is a useful activity inventory. Current client rows/patches must override stale counts.
In particular, [home Command scroll shop](https://aion2data.com/shops/1008-command-shop-quest-scroll)
is 12 purchases per week/server. Both the [Asmodian Lower Abyss shop](https://aion2data.com/shops/2009-command-shop-abyss-quest-scroll-asmodian-row)
and the [Elyos counterpart](https://aion2data.com/shops/1009-command-shop-abyss-quest-scroll-elyos-row)
have four tiers of five weekly purchases/server: 20 for the character's faction,
not 40 across duplicated faction rows. These are not hard limits on completing
quests; the quest rows expose no completion cap.

Manual checkmarks mean “I reported this activity done for this reset.” They cannot
prove a resource reward, skill milestone, equipped item, or all entries consumed.
Server scope is shared among the same Yoshling account's tracked characters on that
region/server; it is never shared across accounts tracking a public character.

The reviewed implementation catalog records 13 EU activities and nine pinned sources.
Daily Dungeon is 14 weekly server entries; Ascension Trial and Subjugation are three
weekly character entries each. Shugo's server and character key pools remain separate.
Recharge-task checkmarks reset daily, while the game's stored keys/attempts carry over;
the helper never calculates their current balance. Subscriber goods, stale morph
quotas, an unsupported Kina farming cap and activities with unresolved ownership
scope are excluded. The dated catalog expires on October 28 and requires the shared
source/patch freshness gate.

Focused implementation verification: 45 offline checklist domain/SQLite/API tests,
35 existing backend tests and 12 checklist component tests passed. Temporary mutations
proved account isolation, optimistic revision rejection, UTC/DST period boundaries
and changed-source mutation refusal fail when removed, then pass after restoration.
TypeScript and focused lint passed. This does not establish a live login or deployment.

## Recommended regression boundaries

- Separate class, exact item, stage and pool eligibility from generic capability.
- Exercise missing/private inventory, unspent points, charges and selected Specialty.
- Keep cheap inspection/equipment steps before paid/RNG actions; test remaining costs.
- Test breakpoint effects and prices without turning community priorities into DPS proof.
- Preserve existing useful lines and current gear until a destructive preview is reviewed.
- Distinguish reset-shop purchases, activity entries and unlimited quest completion.
- Reject stale reset submissions, wrong owners, stale source reviews and unsupported regions.
- Keep claims/curated advice withheld on source change or expiry; timestamps alone do not
  validate a strategy, and embedding similarity does not establish its truth.

Raw HTTP research captures remain outside the repository. Character identifiers,
credentials and private inventory were not added to this audit.

## Remediation verification

The reviewed 2026.10.23.3 implementation addresses the actionable rows above with
scoped recipes, inventory/SP checks, full material categories, entry gates, ring-line
preservation and reset activity reports. The guard rule uses conditional replacement
and donor budgeting, not a cap trigger. Optional stigma comparisons remain research
context, not an automatic redistribution order. The board uses official armory art.

Final local checks: 203 test files / 3,671 tests passed; normal build and lint passed
with the thirteen/seven existing warnings. TypeScript is checked after build to avoid
racing regenerated Next route types. New guard and source-check mutations were
restored and proved green. Production migration/deployment and a genuine login remain
separate from the captured-data preview.
