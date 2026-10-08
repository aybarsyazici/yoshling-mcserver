# Minecraft spotlight onboarding

The Minecraft layout owns a persistent Driver.js tour. It dims the screen,
highlights actual page elements and uses guided Next/Previous navigation across
Profiles, profile details when available, Mods, Backups, Server and permitted
Settings. The **Take tour** button stays available on Minecraft pages, including
small screens. The old `/minecraft/guide` URL redirects to `/minecraft?tour=1`
for an explicit replay; the retired chapter guide is recorded in memory history.

## Automatic entry and completion

`User.minecraftTourDone` is an account preference, default false. Authenticated
Minecraft visitors read their own flag through `/api/minecraft/tour`. A verified
unfinished preference can start onboarding after the UI is ready. Failed or
unknown reads are not an unfinished result and do not trigger automatically.
Manual replay does not reset the database or require an unfinished flag.

**Finish tour** and explicit **Skip tour** acknowledge onboarding. The client
submits exactly `{version:1,done:true}` and checks the own-user response/readback
before reporting that it was saved. A lost response is reconciled through GET;
failed or mismatched readings remain unconfirmed and offer recovery. Closing for
now or pressing Escape leaves the flag false. Interrupted visits may offer the
tour again; a saved acknowledgement suppresses future automatic entry.

GET and POST require current Minecraft access, matching session/database
identity and invitation policy. Members can acknowledge their own tutorial; no
management capability is needed. Both calls require an expected-user header
(`X-Minecraft-Tour-User`) that must match the authenticated account before any
body is consumed or preference written. It is a precondition, never a mutation
target; stale tabs cannot mark a different sign-in complete. There is no reset
operation. Database writes are transactional, one-way and idempotent. Reads
never create users or flags. Both endpoints are private/no-store.

## Interaction and navigation

Tour targets use `data-minecraft-tour` attributes rather than label guesses.
Targets are read after the destination route renders. Missing targets, empty
profile collections and failed data reads need honest explanatory fallbacks;
only visible elements can be highlighted. Management-only steps follow current
capabilities. Settings must not be opened without confirmed settings access.

The tour blocks activation of app controls, including keyboard activation. It
never starts a server, prepares a profile, installs mods, restores an archive,
changes settings or pairs a screenshot. It can navigate to read-only screens.
Existing drafts and dialogs take precedence over automatic entry; guided route
navigation uses the unsaved-settings guard. User changes, route departure and
unmount dispose the current driver and outstanding asynchronous work. Temporary
focus/interaction changes must be restored. Motion respects reduced-motion;
popovers use the site's theme and visible focus indicators.

## Schema rollout

The additive migration is
`prisma/migrations/20261008170000_add_minecraft_tour_done/migration.sql`.
Apply it manually **before deploying the regenerated Prisma client**: auth reads
select the whole User row, so the new client requires the column. Existing
clients remain compatible with the added column. No migration runs on boot.

Create a consistent private SQLite snapshot first and verify integrity, foreign
keys and user data. After applying reviewed SQL, verify the column/default,
existing identities/roles/grants, unchanged rows in other tables, and database
integrity. Existing and newly registered users default to false. Preserve a
verified pre-tour web rollback image; removing the column is unnecessary for an
old-client rollback. Dated backups, applied migration and deployment evidence
belong in `CLOSED.md`; do not replay an already applied ALTER statement.

## Sources and verification

Driver.js is pinned to 1.9.0. Official references:
[configuration](https://driverjs.com/docs/configuration),
[asynchronous steps](https://driverjs.com/docs/async-tour), and
[API methods](https://driverjs.com/docs/api).

Tests need no Docker, network or running game. Real database tests cover defaults,
own-user authorization, invitation/grant loss, registration compatibility,
idempotency and verified completion. UI fixtures cover automatic/replay entry,
route/target timing, permissions, drafts, cleanup and unconfirmed outcomes.
Live browser and accessibility coverage are separate from component fixtures;
record actual verification limits in `CLOSED.md`.
