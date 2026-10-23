# Aion 2 production rollout — 2026-10-23

The helper is deployed at [yoshling.xyz/aion2](https://yoshling.xyz/aion2), behind
the existing Discord invitation gate. Feature commit:
`b2ea35eb8564be769ffe9cbd0370ea053a473650`.
This records the observed rollout, including its verification limits.

## Included changes

Account-owned character lists, public armory tracking/history, reviewed progression
steps, official gear/skill/board images, Daevanion comparisons, reset checklists,
event timers and configurable browser reminders. The final presentation adds
lavender selections, gold/blue character metrics, teal/gold checklist periods,
green reports/entry windows and category accents for timers and alerts. Labels
remain functional. Hosting changes are limited to application-switch links.

The runtime semantic helper is explicitly admitted by `.dockerignore`; the offline
AWS embedding builder, credentials, databases and local captures remain excluded.

## Local checks

- All 209 test files / 3,759 tests passed with the suite running alone. An earlier
  parallel build run hit the unchanged Minecraft disk-budget test's timeout; the
  test and timeout were not modified.
- TypeScript, normal Next production build and lint passed. The existing thirteen
  tracing warnings and seven lint warnings remain.
- An actual Docker runner build passed both artifact guards. The narrow packaging
  regression failed with the semantic-core allowlist removed, then passed after
  restoration. The artifact test file passed all 20 tests.
- Captured-data preview spot checks at 1440 × 1000 and 390 × 844 covered dark/light
  themes, character metrics, daily/weekly selection, timer states and alert settings.
  No horizontal page overflow or failed image loads were observed. These checks
  used mocked account APIs and do not establish production account behavior or a
  complete keyboard/contrast audit.
- Direct HTTP source checks at 15:20 UTC matched every reviewed patch/body, guide,
  timer and checklist pin. The latest Global patch was October 21, article
  `6ad85be86cfe4756db5b8e92`, updated `2026-10-21T06:30:11.674Z`.
  Knowledge `2026.10.23.3`, timer and checklist reviews expire October 28 at 00:00 UTC.

## Consistent backup and additive migration

Production initially had no Aion tables. Existing SQLite integrity returned `ok`,
with no foreign-key violations. Before migration, libSQL `VACUUM INTO` created an
independent consistent backup; this avoids copying only the main file during writes.
The independent database was opened and its schema, counts, integrity and foreign
keys checked. The directory is mode 0700 and the file/receipt mode 0600.

Backup made at 15:32:46 UTC:

- Container: `/app/data/deploy-backups/aion2-before-20261023T153246094Z-f89e0c2e-2d3e-4c49-9fe1-e746e128ac04.db`
- Private host copy: `/root/yoshling-deploy-backup/aion2-before-20261023T153246094Z-f89e0c2e-2d3e-4c49-9fe1-e746e128ac04.db`
- Size: 274,432 bytes; both copies' SHA-256:
  `307c670cea878888910deed7af80539ce3faea95c140211e0a9a8787ebb5e162`.
- Private receipt: `/app/data/deploy-backups/aion2-before-migration.json`.

Reviewed SQL:
`prisma/migrations/20261023150000_add_aion2_tracking/migration.sql`, SHA-256
`078c70d541221c9e783e85ad48a3b209b0ee0063a72d9ba305fc5807d5760f94`.
It was applied in one libSQL write transaction after rechecking the backup hash,
integrity and receipt. The migration refused an existing/partial Aion schema.
All columns, defaults, primary keys, indexes and cascading foreign keys were verified
before commit and read back afterward. Original schema definitions and row counts
were unchanged inside the transaction. All three new tables started empty.

| Existing table | Rows before/after migration |
| --- | ---: |
| Activity | 264 |
| GameState | 1 |
| InstalledMod | 3 |
| MinecraftProfile / MinecraftRuntime | 1 / 1 |
| ModRequest | 0 |
| Modpack / ModpackMod | 10 / 569 |
| ServerConfig / SevenDaysConfig | 1 / 1 |
| User | 6 |
| ZomboidMod | 75 |

After deployment, SQLite again returned `ok`, no foreign-key violations and all
three Aion tables. No characters were assigned to a guessed account. Users add
characters after signing in. **Do not reapply this migration.** A future fresh
installation still requires a reviewed manual migration and verified backup.

The one-off backup/migration scripts were also exercised on disposable real libSQL
fixtures: success, legitimate concurrent old-table activity after backup, rerun
refusal, post-DDL validation rollback, tampered backup and missing backup. No restore
of the production backup was attempted. Because the schema is additive, rolling
back the web image can retain these tables; do not restore an older database over
newer user activity merely to reverse the UI.

## Running image and HTTP evidence

Deployment used the sanctioned command and passed its invitation/staging admission:

```bash
scripts/deploy.sh --service web --verify 'Track your progress'
```

The script verified the title in the actual running server bundle. Web started at
15:36:04 UTC with restart count zero:

- Container ID: `fd1cabfa7a91f570321a55993283d88137199c67f5e7b8d6df81ad47b32026bd`.
- Running image: `sha256:d0bccd07de2f85a659e1392c3162cc901603b19ed9e9388771155689d1849743`.
- The public helper chunk `/_next/static/chunks/3si-kb_q52n6v.js` returned HTTP 200,
  contained the title and matched the running file's SHA-256:
  `79fbd7aae0ef3ddd3f4373f55dac549016dc6b51f7a3aa8bc35f9c28cce7aee0`.

Public HTTP checks at 15:36:49 UTC confirmed `/login` returned 200 with Discord
sign-in, `/aion2` redirected 307 to `/login`, and character, knowledge, server and
timer APIs returned JSON 401 with `private, no-store`. The in-app browser confirmed
the login page. At 15:37:40 UTC, read-only requests from the running container to
the official EU server endpoint and Global patch feed returned JSON/HTTP 200.
Startup logged readiness; the observed startup window had no Aion tracker-read,
missing-Aion-table or Prisma request errors. This does not prove a populated
tracking refresh or source check through a real authenticated session.

## Hosted-game preservation and remaining limits

Minecraft remained `created`; 7DTD and PZ remained `exited`. Before/after comparisons
matched each game's full container ID, image, status, start/finish timestamps and
restart count. No game lifecycle operation, file edit or restore was submitted.

Production Discord login was unverified at this initial rollout. After the later
[issuer fix](CLOSED.md#2026-10-23--discord-login-callback-issuer), the user confirmed
fresh Discord authorization and sign-in after logout succeeded. Adding/refreshing
a character and saving checklist reports through a real account remain unverified;
local persistence/isolation tests cover those contracts. Actual OS notification
delivery, audible hardware output and
sleeping-device behavior remain unverified; reminders require the helper page to
remain open. Public armory fields still exclude Odyle, inventory and reset progress.

See [helper behavior](AION2-HELPER.md), [knowledge maintenance](AION2-KNOWLEDGE.md),
[reset/progression rules](AION2-PROGRESSION-AND-CHECKLIST.md) and
[browser alerts](AION2-ALERTS.md) for operating and update instructions.
