# Authentication and application invitations

## Current identity and authorization

Discord account IDs are authority; usernames/display names are labels. IDs stay exact
decimal strings, including values above JavaScript's safe integer range. Copy the user ID
from Discord with Developer Mode enabled, or use the ID shown for an existing account.
Discord documents the separate ID and name fields in its
[user structure](https://docs.discord.com/developers/resources/user).

The app invitation list is distinct from Minecraft's in-game whitelist and from Crew world
grants. A permitted new account receives MEMBER/no worlds, except the first registered
account, which receives ADMIN/all worlds. Registration chooses that bootstrap role in one
atomic SQLite write and reads the account back; simultaneous sign-ins cannot both observe
an empty database and create admins. Profile changes preserve the stored role/world grants.

Every JWT resolution rechecks the DB account, role/grants and current invitation policy.
Deleted users and removed IDs lose their session at its next resolution. Name-only legacy
tokens require a new sign-in; immutable DB IDs/Discord subjects can resolve existing accounts.
Already-started work is not retroactively undone by session revocation. Direct upload tokens
also check the current invitation policy when spent, alongside role/world grants.

## Policy storage and editing

`WHITELIST_FILE` defaults to `/app/data/whitelist.json`. Its format is a JSON array of
Discord ID strings. A genuinely absent file uses `ALLOWED_DISCORD_IDS`, a comma-separated
seed; the deprecated `ALLOWED_DISCORD_USERS` alias accepts ID strings too. A present file
wins over either seed. Names, numeric JSON values, invalid data, read failures and broken
configured links refuse access; they are not permission to use a broader fallback seed.

A deliberately empty list permits any Discord account to sign in. It still grants no
world access to a new MEMBER. The UI and API require confirmation before clearing a populated
list. Removing the current admin's ID requires explicit self-removal confirmation and ends
that session after a verified save. Arrange another permitted admin before doing it.

The admin page shows known labels beside IDs and sends IDs only. Quiet registry admission
reserves the whole update, conditional revision headers detect stale snapshots, atomic
rename avoids partially written policies, and byte readback gates success. Failed reads
disable editing. A missing response is an unconfirmed result; reload current policy before
retrying. Labels never become invitation authority.

## Preparing legacy name lists before deployment

**Do this before deploying the ID gate.** The web deployment script reads the next service's
effective policy with a temporary Compose Node command and refuses unreadable/name-based
lists before replacing the dashboard. It prints no policy or environment contents. This
preparation changes policy data, not the DB schema; no automatic production migration runs.
The check runs before checkout/build and repeats afterward against the next Compose/image,
so a policy change during the build cannot bypass the final format check.
Its stdin is `/dev/null` so the temporary Compose container cannot consume the remaining
SSH deployment script.

1. Back up the current whitelist JSON separately. Keep the backup private.
2. Obtain exact IDs for the intended accounts. Preserve at least one admin who can manage
   access. Names alone cannot prove which Discord account was intended.
3. Use the planner to produce suggestions from existing stored usernames, or enter copied
   IDs manually. Unmapped/ambiguous labels refuse a shortened candidate. A display name
   that was never stored needs a manually verified ID.
4. Review every suggested account. The planner does **not** authenticate a legacy name or
   replace the live policy. Its optional candidate is a separate mode-0600 file.
5. Replace the policy with the reviewed ID array and read it back. If no file is used,
   set the ID seed in `.env` instead. Recreate web through the normal deployment script.
6. Verify one permitted admin login, a denied account, current world grants, and revocation.
   Keep the previous image/policy backup available for a coordinated rollback.

Run the planner on a local copy using supported Node 22:

```bash
node scripts/plan-discord-whitelist.mjs \
  --file /tmp/whitelist-before.json \
  --database file:/tmp/yoshling-copy.db \
  --output /tmp/whitelist-candidate.json
```

The command only reads an existing local SQLite DB and writes a separate candidate when
every entry resolves. It refuses source overwrite, existing output and a missing DB; review
its JSON report before using the candidate. The runner packages the planner and its shared
ID validator. Never paste `.env`, OAuth secrets or whole container environments into logs.

While preparing an existing deployment, its old authenticated admin session can save an ID
array through the old whitelist editor. The old name gate may reject new sign-ins during
that short transition; existing old sessions do not perform the new revocation check.
Complete the new deployment promptly. Do not confuse this transition with evidence that
the new authentication flow was verified against production.
