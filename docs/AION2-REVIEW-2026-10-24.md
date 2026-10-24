# Aion 2 source review — 2026-10-24

Knowledge, checklist and timer version: `2026.10.24.1`. Review expiry remains
**2026-10-28 00:00 UTC**; this update does not automatically extend any expiry.

## What changed

The official Global patch feed still lists
[October 21](https://aion2.plaync.com/en-us/board/update/view?articleId=6ad85be86cfe4756db5b8e92)
as latest. Its ID, publication revision and normalized body hash match the previous
review, as do the October 7/14 articles. The Kanon Bible export is unchanged.

The drift check found 17 changed pins: ten item/dungeon/transfer references,
six checklist/shop/account references and the timer provider schedule. Each new
hash was checked against a second HTTP read. Layout/provenance edits explain much
of the drift, but the checklist also contains substantive author corrections to
the interpretation of the same October 21 client build. These are not a newly
announced Gladiator balance patch.

## Corrected or withheld claims

| Claim | Current handling | Evidence and limits |
| --- | --- | --- |
| Conquest had a separate +2/day, storage-14 bank per dungeon | One character pool shared across Conquest dungeons; current client-reference model is +1 every 8 hours, storage 21 | [Aion2Data checklist](https://aion2data.com/checklist), corroborated by the named counter table in [Aion2.gg](https://aion2.gg/guides/endgame-pve). Actual remaining charges are not public. |
| Transcendence had a separate storage-4 bank for each dungeon | One character pool shared across Transcendence dungeons; current reference model is +1 every 12 hours, storage 14 | Same scoped counter references; Shattered/Deus pages now agree. Recharge is continuous, not a daily-reset batch. |
| Shugo had an additional base character bank of +4/day, storage 28 | That checklist task is removed as unsupported; the reviewed shared-server task remains | Revised reference no longer supports the extra bank. An old raw client row does not establish an active Global entitlement. This does not prove that no character/membership-specific benefit can exist. |
| Weekly final-boss reward counters of 35/28 | Not added as actionable quotas | Reward charges, final-boss limits and the separate server unclaimed-clear counter are distinct. The helper still requires checking the actual game panel. |
| Raw Nightmare boss/Upper Abyss rows represented currently available content | No new availability claim added | Existing helper advice does not count these raw rows as unlocked content. |

The corroborating Aion2.gg counter table uses an October 16 dataset. Its old Hard
Expedition availability statement is superseded by October 21 and is excluded;
the new checklist source title explicitly restricts it to the counter table.
Neither reference is an official live account resource API.

The checklist now has 12 activities. A daily checkmark records reviewing a recharge
bank, not spending all charges or resetting it. Existing reports are retained;
removing a catalog row does not delete saved user data. Revised catalog identity
changes request revisions so old reports cannot be silently saved against new data.

## Guidance rechecked without changing its action order

- Overhead Slam 16/20, Rage Burst context, card pools and the white-board targets.
- Stage 1 level 45 / GS 1600 / 40-Odyle eligibility, and regular Urugugu/Vakron
  Conquest GS 1400 / 40-Odyle entry/reward context.
- Aulamus random skill pools, fixed Spiritforged lines, transfer restrictions and
  costs, guard voucher recipe and conditional donor spending.
- Revelation Amulet/Monolith and Noble Belt/Stronghold scroll sources, stones/Kina
  requirements, caps and belt Morph inspection.
- Daily Dungeon 14 weekly server entries, Duty five daily server missions, Trial
  and Subjugation three weekly character entries, Command purchase quotas and
  Nightmare shop quotas.

Some old raw captures were unavailable for Deus, amulet and belt. Their current
fields were re-read against the committed claims; no byte-only equivalence is
asserted for those sources. Main skill/gear recipes, activities and board presets
are unchanged. All timer recurrence, clock-zone and duration definitions are
unchanged; its provider edited provenance/build-check metadata only.

## Official announcements reviewed separately

- [EU temporary maintenance](https://aion2.plaync.com/en-us/board/notice/view?articleId=6acf216828c7452635072ccd)
  is scheduled for October 25 at **00:30 UTC**, duration 150 minutes, for the CEST
  to CET adjustment. That starts at **02:30 CEST**; if it lasts as announced it ends
  at **04:00 CET**. This is planned availability, not an observed outage or a class
  rebalance. Recurring event timers do not establish server availability.
- [Ludra announcement](https://aion2.plaync.com/en-us/board/notice/view?articleId=6adbaeb06cfe4756db5b8efb)
  announces November 4 content and Odyle item mail beginning after October 28
  maintenance. They are future content/rewards on this review date and are not
  presented as available farming or inventory.

This demonstrates why a future collector must monitor official announcements as
well as the patch-note board. A stable patch feed alone does not cover every notice.

## Index and updater status

A direct official public-armory read at 09:05 UTC observed Yoshiane at GS 1,861 /
CP 87,149, Overhead 14 and Rage Burst 5, an Aulamus Greatsword +15, Noble Belt +10
and Revelation Amulet +5. Three Arcana are equipped; Compass/Bell remain unobserved
in equipped slots, which does not establish inventory. The new catalog produced
current source/checklist status and stopped the obsolete fixed-weapon advice.
Its first milestone remains Overhead 16. The remaining white-board preset target
is Triniel Multi-hit, with a modeled additional route cost of ten crystals.

Known coverage limit: the belt rule currently stops displaying at its +10 target,
so it does not surface a standalone Morph inspection for this observed character.
Do not treat the helper as a complete optimizer or infer that no further belt
progression exists. The declared recipe/source already describes the Morph step;
post-cap recommendation applicability needs a separate regression-backed change.

The saved index was rebuilt against the new knowledge digest with 54 authored
chunks, six queries and 35 groups: **60 vectors reused, zero model calls, zero input
tokens**. No credential or `.env` read was needed for that cache-only build.

The embedding command now supports explicit AWS profiles, lazy credential loading
and the normal provider chain. No SSO profile/login was configured: the Start URL
and SSO Region are still missing. No automatic compiler or schedule was enabled.
The proposed evidence/draft/review/publication workflow and supported credential
routes are in [knowledge maintenance](AION2-KNOWLEDGE.md#automation-design-and-current-status).

Raw review captures, per-source diffs, repeated HTTP hashes and readback metadata
are retained locally under `/tmp/aion2-update-20261024/`. Reviewed pins are in the
versioned catalogs. Local checks and production rollout evidence are recorded in
`CLOSED.md` after completion; a local review is not a deployed update.
