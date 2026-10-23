# Progression and reset checklist

This describes the reviewed 2026.10.23.3 guidance. The dated audit and its source
matrix are in [AION2-REVIEW-2026-10-23.md](AION2-REVIEW-2026-10-23.md).

## Spending and farm choices

- An enhancement cap is not a reason to spend. The fixed Spiritforged Guard has a
  conservative +10 temporary baseline, an early Vakron replacement comparison and
  an optional funded donor plan. Lower-level enhancement can cost less and retain
  value on transfer; +15 is neither automatically wasted nor the default priority.
- Guard vouchers do not directly select a Guard: the current recipe needs two
  vouchers and Kina. Existing vouchers and partial pity progress are unknown.
  First-transfer history, accepted source, material cost, retained lines and resulting
  enhancement must match the actual preview before the old piece is consumed.
- The named Spiritforged Greatsword recipe applies only to the reviewed Gladiator
  source item. It uses the observed enhancement and requires unequipping/removing
  presets. Other classes and unrelated fixed weapons cannot inherit that recipe.
- Skill-point and inventory checks precede RNG farms. Four board bonuses do not
  establish the bought rank. Stored cards/bags can fill an empty equipped slot.
  Shattered and Deus are selected by missing card families. Higher tiers remain
  conditional on unlock, clear ability and their own reward cost.
- Rings already carrying Overhead are excluded from that Sync route. Remaining
  rings each preserve their own useful skills and identify their own unwanted line.
  Multiple distinct skills on one Aulamus Ring were corroborated by official samples.
  A user-chosen spending limit applies even if the desired roll never appears.
- Amulet and belt scrolls are additional requirements alongside Enhance Stones and
  Kina. Their progression purpose and combined cost matter; collecting a scroll
  does not prove an upgrade is affordable. Stigma comparisons remain role-dependent.

## Actual daily and weekly activities

`src/data/aion2/checklist.json` contains 13 reviewed EU activities from the supplied
Checklist tab (gid 1177705857), current client references and patch review. Daily
Dungeon has a base 14 weekly server entries. Home Command 12 and Lower Abyss Command
20 describe weekly scroll purchases, not quest completion caps. Recharge banks and
character/server ownership remain separate. Stale Odyle quotas and unresolved
activities are excluded. Catalog/source dates expire on October 28 unless reviewed.

Today / This week show manual reports, reward types, sources and reset times. Reports
are persisted via `PATCH /api/aion2/characters/[id]/checklist` with activity, period,
revision and completion. Auth, owner, source, period and revision checks precede a
transactional write/readback. The client validates the receipt and reloads the full
roster. Late replies cannot change character selection.

Server reports share within one Yoshling account's roster on that region/server;
friends' accounts remain isolated. This treats a roster as one game account for
server allowances. Separate NCSOFT account groups are not modeled. Character-scoped
activities use the canonical character identity. Recent reports are retained 35 days.

Daily reports roll at 07:00 UTC; weekly reports roll Wednesday at 07:00 UTC, independent
of Berlin DST. Unsupported regions get no inferred EU schedule. Source holds disable
writes/current totals/countdowns but retain read-only last reports and timestamps.
Checking a recharge task does not calculate or reset its stored keys/attempts.

Only explicit resource links annotate guidance. Reporting weekly Daily Dungeon work
updates the amulet/belt stone-gathering step and the next remaining resource check.
It does not mark a skill level, item upgrade, currency reward or all charges consumed
as observed. One-time upgrade goals do not become daily checkboxes.

## Maintenance

Review patch revisions, the exact source claim and its client version before changing
a baseline. Recheck purchase-versus-completion limits, scope, reset versus recharge,
temporary patch windows and membership assumptions. Cheap inspection/owned resources
come before paid/RNG plans. Item-specific routes require class/item/stage guards.

The shared validator checks cross-catalog activity references. The runtime and CLI
check source hashes, versions and expiry, including ISO checklist source timestamps.
Embedding similarity is a retrieval aid; it cannot approve a strategy or a quota.
Run the documented source check, embedding update and repository checks after review.
The manual three-table migration was applied and verified in production on
2026-10-23; do not reapply it. See the [rollout record](AION2-DEPLOYMENT.md).
