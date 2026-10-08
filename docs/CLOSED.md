# What has been closed, and what it cost

**This file exists so `CLAUDE.md` can be re-read.** Its own documentation rules say to keep
that file short enough to re-read and record that it stopped being true once it passed 723
lines; the Status section plus the audit summary had grown to **284 lines, 30% of the file**,
and almost all of it was history — "closed on date X, listed so nobody re-reports it". Every
session was paying to read the record of work that is already done.

So the *current* state and the *genuinely open* list stay in `CLAUDE.md`. What landed, and what
each thing cost to learn, is here.

**Nothing in this file is a to-do.** Entries record dated evidence and may have a narrower
scope than a later finding. Check `CLAUDE.md`'s "Current remediation status" for outstanding
work and live verification. The
per-game depth is in [`MINECRAFT.md`](MINECRAFT.md), [`PROJECT-ZOMBOID.md`](PROJECT-ZOMBOID.md),
[`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md), [`SETTINGS.md`](SETTINGS.md) and
[`OPERATIONS.md`](OPERATIONS.md).

That guarantee is what makes this file cheap to read, and **it had stopped being true**: a
"Still open here:" paragraph listing three live problems sat near the bottom until 2026-10-06,
duplicating what `CLAUDE.md` already said. Both halves of that are bad — a reader either
re-evaluates every paragraph here for open-ness, which is the cost the split was done to
remove, or trusts the guarantee, skims the paragraph, and misses the real item. The three
items were moved to `CLAUDE.md`'s open list; its current heading is "Current remediation status".

**Where a thing lives, now that there are three files.** The split only works if each has
one job:

| File | Holds | Does not hold |
|------|-------|---------------|
| `CLAUDE.md` "Current remediation status" | current work, grouped by status, with references to dated evidence | closed stories |
| **this file** | what closed, dated, with the measurement that closed it | anything open |
| dated audits | frozen diagnosis, reasoning, refutations and mechanisms | current closure status; their priority tables are **not** current backlogs |
| [`MEMORY-HISTORY.md`](MEMORY-HISTORY.md) | preserved superseded memory and explanations | current instructions |

So "was this already fixed?" is a question for this file; "has anyone looked at this before,
and what did they conclude?" is a question for the audit.

## The full audit, 2026-09-28

A 22-agent audit covered every feature and route: **[`AUDIT-2026-09-28.md`](AUDIT-2026-09-28.md)**.
185 findings, each adversarially reviewed. Read its §5 (refuted/downgraded) before
acting on anything in it — **9 of 13 criticals were downgraded by their own
verifier**, several findings are simply wrong, and two prescribe fixes that don't
work. Two rows *in §5 itself* were also wrong and are marked as such; one of them
("the PZ entrypoint saves on SIGTERM") is the belief that stopped three audits finding
the five-minute SIGKILL stop. The corrections it produced are already applied
throughout this file.

**The earlier closure review on 2026-10-06 recorded 24 of the 25 rows as closed.** Its
remaining claim about **#9** was wrong: current `pz/search_folder.sh:113` reads the saved
`Map=` and preserves that order before appending newly found maps. `entry.sh` still writes
the scanner output, but that does not mean the saved order is discarded. The follow-up audit
did not perform a fresh live reorder, so this is a correction to the source claim, not a new
production closure measurement.

The follow-up also showed that **#8's honest-failure repair did not cover failed-apply
retries**. Historical closure evidence describes the checks that passed, not every mechanism
in that route. Current status belongs in `CLAUDE.md`; mechanisms and evidence are in
[`AUDIT-2026-10-06.md`](AUDIT-2026-10-06.md). Nine original rows were recorded below and
sixteen were recorded nowhere, which is why the table read as a backlog for a week; the
original per-row evidence stays in its header.

Two conclusions outrank the individual findings. **The recently-rewritten core is
good — don't spend time there**; the control lock, reachability states, staged
`restartGame`, scoped `patchServiceEnv` and `gameGate` all held up, and several
findings blaming them were refuted by forensics. And **the recurring defect class is
"reports success after doing nothing or the wrong thing"**, not crashes — so when you
add anything here, make the success path *prove* it succeeded, the way the memory
card's configured-vs-live comparison does.

**Fixed and deployed 2026-09-28** (kept here only so nobody re-reports them): the MC
backup shell injection; the public exposure of ports 3000/8080/8081; `install-modpack`
clobbering compose; restores that never stopped the server; the missing `mem_limit`s
and log rotation; the Minecraft version mismatch (**Minecraft now boots — verified,
`Done (1.661s)!`**); `/api/settings` starting a stopped world outside the lock; the
file-browser GETs exposing `rcon.password`; and the zombie-process leak. Details and
the per-finding corrections are in
[`AUDIT-2026-09-28.md`](AUDIT-2026-09-28.md).

**Closed 2026-09-29/30, listed only so nobody re-reports them:** PZ's five-minute
SIGKILL stop (now ~12 s, exit 0, via RCON `quit`); the app writing `docker-compose.yml`
(now `.env`, gitignored, survives `git checkout -f` — compose hashes verified identical
on deploy); no test suite (`npm test`, 1502 tests); no co-residency detection; backups
having no retention/pruning/checksums/download/schedule; Minecraft's in-game whitelist
and ops writing `uuid: ""`; the 224 dead `ModpackMod` rows (re-imported). Details in
[`OPERATIONS.md`](OPERATIONS.md) and
[`AUDIT-2026-09-28.md`](AUDIT-2026-09-28.md).

> **The 7DTD `TelnetPassword` was in that list as "rotated and telnet control re-verified
> end to end", and the second half is not true of the current password.** It has now been
> exposed in a transcript **twice** and rotated twice — 2026-09-30, and again **2026-10-06**
> after an agent printed the web container's whole env. The 2026-10-06 rotation is verified
> on the env side only (the xml value and the `.env` value byte-equal, the recreated web
> container's `process.env` matching), because 7DTD is **stopped** and only reads the xml at
> server start. **End-to-end telnet is unverified until 7DTD next starts**, and that first
> start is the moment to confirm the dashboard still sees the world. A mismatch between
> `sdtdserver.xml` and `.env` is exactly what blinds the dashboard to 7DTD. Kept as a
> correction rather than deleted, because this is the shape to watch for: "closed" was
> written truthfully about a credential that was then rotated underneath the claim, so a
> closure note about a *secret* has a shorter shelf life than one about code. Depth:
> [`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md).

**Closed 2026-10-02 — the Minecraft content revision.** A design review asked whether the
mods/modpacks feature was the right shape. It was not, and the answer **reversed a
recommendation this repo had written**: delegating pack installs to the image's
`mc-image-helper` would install nothing, because `applyServiceEnv` recreates with
`start: false` and Minecraft spends most of its time stopped. Depth, the measurements and the
two claims that were wrong: **[`MINECRAFT.md`](MINECRAFT.md)**.

Shipped and verified on the live box, in five increments:

1. **The mods page no longer offers controls that 403.** `can` carries `modsInstall` /
   `modsRemove`; this was the same defect as the power buttons and had never been fixed here.
2. **An `Install` button exists at last** — `/api/mods/install` was hardened, tested and had
   *zero* UI callers — and the Modrinth search is bound to the server's own version and loader
   (it listed mods for every Minecraft version ever against a 26.1.2 server).
3. **The apply's "Rollback point" actually rolls back.** It archived `world`, the one directory
   the apply never touches, and nothing of the mods it deletes. Now both, with the restore
   putting both back and the `InstalledMod` rows carried in the manifest — the jars alone are
   not a restore, because `removeMod` deletes each row with its file and a filename carries no
   Modrinth id. The apply also no longer **prunes other people's backups**, which it briefly did.
4. **The inventory is reconciled against the directory.** `/api/mods/installed` was a bare
   `findMany()` and nothing had ever compared it with `/minecraft/mods`; it now reports
   `matched` / `untracked` / `missing` **by name**, with optional sha512. Verified live: three
   matched, 0 untracked, 0 missing, every digest and byte count identical to an independent
   `sha512sum` (re-read live 2026-10-06).
   `InstalledMod.source` + `versionId` were applied to production by hand — **verified
   applied 2026-10-06**: `PRAGMA table_info(InstalledMod)` carries both columns and all
   three rows read `source: manual`. The SQL and the reasoning are under "Applying DB
   migrations in production" in [`../CLAUDE.md`](../CLAUDE.md), not here; this used to say
   "(below)" and point at nothing, which is a bad way to lose a migration whose backfill
   `WHERE` clause is the part that must not be dropped — a second paste without it rewrites
   every `pack` row to `manual`.
5. **One page instead of three tabs.** "Browse mods / Installed / Modpacks" cut across the
   task — it nested a *source* under a *collection*, and the collection's empty state was where
   the install instructions lived. Now: the pack as a header (it is server state, not a library
   item), one list with **provenance per row**, saved sets secondary, and both searches as
   sheets. Rendered in Chrome in both themes to check it, which is how three copy bugs and a
   wrong accent colour were found that no test asserted.

Three things the revision did **not** close — unpinned pack imports, the duplicating
re-import, and the apply running with the world possibly up — were recorded in `CLAUDE.md`'s
then-current open list. Current status is in "Current remediation status" and is deliberately not restated here, so this file keeps its promise to hold
nothing open. They used to be stated twice, which is how the same work drifts in two places.

**Closed 2026-10-01 — the settings revision.** Every settings page now shows **configured
next to live**: the game is asked what it believes (`showoptions` over RCON for PZ,
`getgamepref` over telnet for 7DTD, `difficulty`+`list` over RCON for Minecraft) and the
answer is compared with the file, with "not reported" as a third verdict so an unanswered
question never renders as a disagreement. Full architecture, coverage numbers and the write
discipline: **[`SETTINGS.md`](SETTINGS.md)**. Also closed: the PZ sandbox options
are editable from the dashboard and the writer is **verified against the live 74 KB /
335-option file** (new inode, hard-linked `.bak`, a real value round-tripped and the file
returned to its exact starting md5); the `server.properties` help layer; the 7DTD
`ServerMaxPlayerCount` silent clamp; the XML entity-doubling round trip; and the console
route calling a busy-but-running server "powered off" (see `src/lib/rcon-failure.ts` —
`ETIMEDOUT` as a socket code and the bare message `"timeout"` mean opposite things).

**Closed 2026-10-02 — a modpack apply is reversible for the mod set.** `install-modpack`
tarred the world and then deleted every installed jar, so its "Rollback point" preserved the
one directory the apply never touches; the mods directory was archived nowhere. It now
archives `mods` too, **and the restore puts it back** — adding one without the other would
have reported success while discarding the mods, since the restore renamed only `world` into
place and deleted the staging dir. Routine backups stay world-only.

**And the inventory goes with the jars**, because the files alone are not a restore: `removeMod`
deletes each `InstalledMod` row with its file, and a filename carries no Modrinth project id, so
the apply records the rows **in the archive's manifest before it deletes anything** and the
restore writes them back. Without that half the jars came back and the Mods page still claimed
nothing was installed — "reversible for the mod set" was true of the bytes and false of the app's
record of them, which is the quiet version of the same defect.

**The apply does not prune.** `sealArchive` runs retention by default, which is right for a
scheduled backup and wrong for an archive taken as a side effect of a destructive operation —
wired in without the opt-out, pressing Apply deleted other people's restore points. It passes
`prune: false`; a test fails if that is removed.

Details, and the properties not to break: [`MINECRAFT.md`](MINECRAFT.md).

## Local critical remediation, 6 October 2026

This records the first remediation batch against the `6a4d288` audit snapshot. It was
validated in the local worktree and an isolated Docker image. **No production deployment,
credential rotation, game power change, join or live restore was performed in this batch.**
Current deployment and outstanding work belong in `CLAUDE.md`; the dated audit retains
the original mechanisms rather than becoming a second backlog.

| Finding | Local repair and evidence |
| --- | --- |
| F01 | Physical admission on all game browser reads/writes/deletes, upload destinations, configuration/player-list readers and writers, backup/restore sources and destinations, and mod producers. Extracted ZIP links/special files refuse. Temporary filesystem cases cover escaped, dangling and contained aliases, missing parents, PZ shortcuts and root deletion. Real tar roundtrips prove top-level alias backups contain world/mod bytes. Final deletion/staging links are unlinked themselves, preserving contained targets. |
| F02 | Allowlisted Docker context, tracing exclusions, standalone cleanup and independent assembled-runner verification exclude env/database/key/checkout files and escaped/dangling links. Empty/missing output fails verification. Both local and Docker artifacts passed; removing guards made fixture checks fail. These are file-boundary checks, not a source-literal secret scanner. |
| F03 | Next/eslint-config-next 16.3.8, React/DOM 19.2.8, NextAuth beta.32/Core 0.41.3, ws 8.22.0 and proxy-addr 2.0.8 replace the original affected ranges; runner uses Node 22. This closes the original critical runtime package repair, not the entire dependency audit. |
| F04 | Upload POST checks the world grant before body/admission. Token spending rechecks current DB user, role and worlds; deleted/revoked users refuse. Missing/default signing secret cannot mint or verify tokens. Actual multipart/temp-ZIP route fixtures cover the authorization branches. |
| F06 | PZ deploy refuses live/unknown state before checkout and after build, uses stopped Compose create, then verifies stopped state, image ID and service label. It cannot auto-start a second world. Tests execute the remote Bash body with isolated command fakes; no real deployment was used as a test. |
| F07–F08 | Reset protects the new safety copy plus newest older copy by mtime and verifies surviving bytes before wiping. Files-only preflight claims power after admission and rechecks peers before changes; refusals preserve unrelated backups. Strict shutdown gates deletion, literal GameName readback gates start, terminal state gates HTTP success. The existing “Reset & start fresh” confirmation deliberately starts a sole stopped world; peers refuse. Real tar extraction recovers the old progress fixture. |
| F09–F10 | Heap bounds include host reserve, configured/existing container limits and the PZ floor. Unknown limits refuse writes. Settings mirror persistence happens after verified application; busy/failing applies retain retryability, and no-op claims compare real config/container env. GET can provide a verified first-install initializer without persisting it. Fault and retry tests cover every stage. |
| F11 | Strict XML parsing and span replacement preserve literal dollar signs/entities/quotes/comments, reject malformed/duplicate settings, and compare written bytes plus parsed values. Quick reads/partial writes use file truth. Both writers and reset have actual-file readback-failure tests. |
| F12 | MC version/player lists and 7DTD quick settings become editable only after successful, valid initial reads. Error/retry states preserve independent readiness; no failed read can submit defaults or empty lists. DOM tests cover HTTP, shape, null and network failures plus the real first-use GET→PUT→GET path. |
| F13 | 7DTD restore preflights archived saves/map/XML before replacement, preserves current deployment ports/paths/control credentials, verifies current telnet agreement and reads back restored XML before restart. Gameplay/join settings come from the archive; legacy archives without XML retain current XML. Real-file route fixtures cover obsolete credentials and invalid archives. |
| F14 | Pack preflight holds Minecraft files, then claims power. Shutdown is verified before rollback tar/removal/write. A complete replacement can resume only a previously running world; incomplete work stays off. Terminal state gates success. Direct downloads now use physical path admission and exact jar readback too. Tests cover live/paused/unknown peers, failed stop/backup/removal/download/start, preemption and late exits. |
| F17–F18 | Single installs verify the required dependency closure, compatibility, pinned identity and actual jar digests; missing/unverifiable dependencies refuse before publication. The tracked install owns its files and checks preemption directly before writing. Imports resolve every named project or return all failures without saving a shortened pack. Actual route/filesystem tests prove refusal and complete creation. |
| F31 | Memory drift allows reapplying an unchanged desired value; invalid historical selections require a valid choice. Read-only roles receive values without apply controls. DOM tests distinguish drift, unknown live value, already-applied values and roles. |

Additional repairs in this batch: upstream mod HTML/Markdown sanitization with safe rich
content preserved; strict shared lifecycle observations and terminal checks; safe 7DTD update
preflight/create/start/mode-cleanup; precise handoff errors after earlier peer stops; and
ledger-owned single-mod feedback. A lost install response reports an unconfirmed result,
never “nothing changed”. All added protections were deliberately removed or bypassed in
focused checks, observed red, and restored before the combined run.

### Combined verification at this milestone

- `npm test`: **106 files / 1,984 tests passed**, 30.50 s; baseline was 78 / 1,502.
- TypeScript passed before and after the successful local deploy build. A separate
  non-mutating `verify:artifact` passed. The build retained nine dynamic-tracing warnings.
- Lint: **36 errors / 14 warnings**, versus baseline 45 / 14. All 36 reported error lines
  were already present in `HEAD`; lint was not represented as green. Diff checks passed.
- Final combined image: `yoshling-security-audit-web:final`,
  `sha256:e52d2fb353714757b3a1b860ec2aa2ad9672b5bd1e1718cf338768dfbca4c742`.
  Builder, assembled-runner and isolated-runtime artifact guards passed. Six compiled
  change markers were checked. Node 22.23.3, Compose 5.1.4 and root operation were retained.
- Isolated smoke used fabricated settings, no production mounts/socket, no network and
  no upstream OAuth. Login returned 200; protected game/config/backup/install requests
  returned 401; anonymous session was null; only Discord was offered. Native libSQL
  create/write/readback passed. The actual compiled auth callback/generated Prisma adapter
  lookup replaced fabricated ADMIN/all-world claims with the fixture DB's MEMBER/no-world row.
- Dependency snapshot: 30 total entries (2 critical development entries); 25
  production-labeled entries (0 critical, 17 high, 6 moderate, 2 low). Prisma CLI,
  shadcn, Vitest/tinypool and the removed HTML parser were absent as physical runner
  packages; blanket `@prisma` copying still included dev/config packages. Bundled modules
  are not proven absent by missing manifests. This measurement does not declare every
  transitive advisory safe.

`CLAUDE.md` was reduced from 1,052 to 154 lines at this milestone and `AGENTS.md` to
29 lines. Superseded memory and current-looking run-state claims were preserved in
`MEMORY-HISTORY.md`. A regression enforces the main memory's 220-line / 2,400-word /
18,000-character limits and document links; restoring the old memory made it fail.

## Remaining audit remediation, 6 October 2026

The second local batch covers the remaining dated findings and adds the identity migration
preparation. These entries record source/fixture evidence, not a production rollout.

| Finding | Local repair and focused proof |
| --- | --- |
| F05 | Invitations use exact Discord ID strings. Names/numbers cannot authorize, including IDs above 2^53. Every JWT checks current policy/account/role/grants; deleted/revoked accounts return null and name-only tokens cannot bind a different user. Registration's actual atomic SQLite statement produces one ADMIN under concurrent independent clients and preserves profile-update role/grants. Policy/API/UI tests cover unknown/broken files, atomic private saves/readback, revisions, deliberate empty and explicit self-removal. A planner creates separate reviewed candidates; web deploy refuses legacy/unreadable policy before checkout/build. Token spending now checks policy too. |
| F15 | Quiet shared reservations cover complete short-write intervals, normal overlap/backup conflicts, retry of disjoint edits and cross-module context. Power may preempt; before-publication and terminal checks return truthful interruption with possible prior effects. Parsed-byte/path-bound HMAC revisions reject stale and ABA projections, late preparation changes and wrong identities. Published revision cannot adopt an unrelated later rewrite. Legacy requests remain compatible; all current editors carry opaque revisions. Custom headers and weak-token compatibility handle documented CDN ETag transformations. |
| F16 | Declared bytes/entries/footer consistency and disk headroom gate extraction; 8 GiB / 250,000-entry budget and 1 GiB reserve are monitored against actual non-following walks, disk/preemption and final output. Cancelled unzip is killed/closed before staging cleanup; partial output cannot publish. Tiny subprocess/ZIP fixtures exercised limits and cancellation; no live exhaustion. Polling may overshoot and is not an OS quota. |
| F19–F20 | Export resolves saved targets/exact pins, exposes named incomplete entries and bulk download refuses them. Import selects a supported compatible target from the build instead of rejecting by array position and retains validated dependency pins. Saved loader copy no longer recommends a different installer. Tests cover targets/pins/unsupported leading values and partial exports. |
| F21 | Pack archives embed portable metadata inside tar plus sidecar integrity, including explicit empty inventory, IDs/source/version pins/original owner/timestamps and verified target. Restore validates before downtime, rejects explicit target mismatch, transactionally writes/reads back inventory and rolls DB changes back on failed readback. Missing legacy metadata remains unknown. Real tar and actual SQLite/Prisma tests prove portability, empty clearing and rollback. |
| F22 | Every active jar, including untracked and contained final aliases, is preflighted/snapshotted/removed; inactive files remain. Resulting names/digests are compared with intended downloads before restart. Real directories cover omitted removals and incorrect resulting sets. Configured/applied target agreement is checked independently of a stale DB mirror, including under-power before-stop checks. |
| F23 | Shared client response classification preserves receipts/IDs, refreshes the ledger and treats gateway HTML/malformed/network results as unconfirmed. It cannot assert failure, continued work or unchanged data without evidence. Known refusals retain explanations. Component/deferred tests cover all tracked caller groups and adjacent import ambiguity. |
| F24 | Real PZ component→PATCH→temporary INI regression proves unchanged save preserves enabled/disabled variants and unrelated loaded tokens byte-for-byte. Cancel/refresh drafts retain the enabled state; stale headers refuse automatic retries. |
| F25–F26 | Crew keeps stored grants separate from ADMIN's effective all-world access, serializes each row's same-browser writes, consumes canonical DB receipts, and reconciles unknown outcomes. Failed reconciliation keeps Retry/locking; clear authorization refusal stops controls. Deferred and actual API readback tests cover demotion and out-of-order results. Cross-browser serialization is not claimed. |
| F27–F29 | File identity/request generations discard late listing/content replies and bind root/path/endpoint/revision. Capability fences start false and cover privileged controls/reads. PZ quick/maps/mods/updates validate HTTP/shapes with error/retry and prior-data warnings. Real rendered deferred/error/role fixtures cover the guards. |
| F30 | Monitor records last success/error and 15-second expiry; stale values cannot claim/animate Live. Shared game-state failures appear across power surfaces, and stale Workshop status cannot claim Updating now. Timer and failed-poll component/hook tests cover the transitions. |
| F32 | Compose interpolates watcher/off/cadence operator values. Four source tests and three reversed-binding mutants passed; a no-network/no-mount isolated recreated Compose fixture actually received false / 90000 / 7000. No live watcher toggle occurred. |
| F33 | Telnet requires prompt/explicit login, rejects auth/command denial, timeout and incomplete close, strips a unique completion fence and requires known status/save acknowledgements. Controlled loopback/parser fixtures prove partial replies cannot become success. One benign rejected fence/log entry is added per batch; first controlled live game compatibility remains a separate check. |
| F34 | Steam stable maps to public; configured Compose branch is authoritative. Missing installed/upstream IDs, failed lookup and incomplete Workshop responses report unknown with null updateAvailable. UI requires checked/consistent evidence for Up to date and disables unverified actions. Controlled backend and rendered component cases cover both paths. |

Focused groups at this stage passed: 321 reservation/budget/telnet cases, 196 content/update
cases, 368 frontend cases, 57 auth cases and 75 invitation/revision cases, with overlap
between groups. Separate guard mutations were killed and restored. Initial weak tests were
strengthened where fallback protection or a zero-test filter hid removal of the intended
guard; the final proof used the actual spawn/SQL/readback/assertion seams. Full combined
quality/build/runtime measurements are recorded below after their run, rather than summing
overlapping groups or presenting these as live game verification.

### Final combined quality gate

- Full Vitest run: **137 files / 2,373 tests passed**, 30.97 s. Compared with the original
  78 / 1,502 baseline, this is a net increase of 871 cases, not a sum of overlapping focus runs.
- TypeScript passed. Lint exited zero: **0 errors / 7 warnings** (five raw external-image
  performance warnings, intentional full-page error recovery navigation, and an existing
  unused operation type import). The original gate had 45 errors / 14 warnings.
- Local build and standalone artifact verification passed. Final source includes the
  packaged planner/validator and an exact Docker context exception for that planner.
- Backend type cleanup uses checked tag/error shapes and a typed process-global Prisma
  singleton. Frontend cleanup uses subscriptions/keyed sessions and typed nullable gallery
  data; it also fixes a system-dark theme click that previously selected the existing theme.
  Eight frontend and four backend quality guard mutations were killed and restored.

These are local quality results. Final isolated-image runtime evidence is recorded separately;
no entry here represents a production deploy, real Discord exchange or live game exercise.

### Final isolated runner evidence

The final combined local image is `yoshling-security-audit-web:final`,
`sha256:16cfd39c5050a529d30fcb08cd48c0085bce6ae652c82f04473efaac2237d0c7`,
746,355,390 bytes, **linux/arm64**. Target-host deployment rebuilds from source; this
measurement does not claim production architecture/runtime validation.

Builder, assembled-runner and isolated-runtime artifact guards passed. Eleven actual compiled
change markers were checked. Node 22.23.3, Compose 5.1.4 and root operation were retained.
The smoke container had no network, mounts, Docker socket, published ports, upstream OAuth
or game actions. Native libSQL create/write/readback and the actual compiled Prisma/auth
lookup replaced fabricated ADMIN/all-world claims with an exact numeric-ID MEMBER/no-world
fixture. Removed ID, malformed legacy policy and deleted account produced null sessions.

The packaged planner/shared ID validator executed in the runner. A complete candidate
retained the exact ID, used mode 0600, read back correctly and left source unchanged;
ambiguous duplicate labels exited 2 without a candidate. Raw helper import emits a nonfatal
Node MODULE_TYPELESS warning; package module mode was not changed merely to hide it.

The scripts context rule was corrected after an executable probe refuted a textual
assumption: admitting the scripts directory alone had admitted every descendant. Explicit
`scripts/**` exclusion plus verifier/planner exceptions was then tested: missing planner
exception failed the build; unrelated deploy-script COPY failed; removing the directory
guard admitted it. Protections were restored before the final image build.

Production policy conversion/deployment and real game/telnet/restore checks remain recorded
as current verification requirements in `CLAUDE.md`, not implied by the fixture results.

## Player UI enhancements, 7 October 2026

The first local feature batch adds:

- **Minecraft/PZ installed-mod search and filters.** Names, filenames and recorded IDs
  are searchable. MC separates actual file state from recorded origin; PZ separates
  download state, enabled IDs, disabled variants and absent IDs. Unpaired PZ IDs use
  text search. Counts/no-results/reset preserve existing order, full diagnostics and
  permitted full-list actions; filtering makes no API writes or new reads.
- **Shared 7DTD/PZ settings review.** Save opens a masked old/new review; Changed only
  and confirmed discard/reload preserve the full dirty set. Restart/creation consequences
  reuse existing contracts. Valid, unique/disjoint applied/ignored receipts require a
  canonical readback. Published/readback revisions must match when a receipt supplies one;
  intervening writes stay unconfirmed. Unanswered drafts require an unchanged baseline.
  Permission/error/stale states block confirmation. Controls have explicit labels, table
  scopes and a bounded scrollable dialog. Browser unload and ordinary same-tab app links
  warn for dirty panels; Back/Forward/programmatic routing remain outside this guard.
  Minecraft's custom settings cards retain their existing flows.
- **Home/overview join panels.** Copy waits for clipboard acknowledgement and offers manual
  selection on failure. Shared status expires after fifteen seconds; stopped/unresponsive/
  operation/unknown states remain distinct. Minecraft guidance reads an authenticated,
  world-gated nonsecret target projection on opening, with check time and retry. Exact
  configured/created-container agreement does not establish a running build, complete client
  pack or successful join. Version aliases and unavailable 7DTD/PZ exact builds stay unknown.

Related integration defects were repaired: Minecraft removal requires its success receipt
and re-reads inventory after ambiguous replies without automatically retrying DELETE;
PZ polling pauses during ID drafts and rejects earlier background replies. Filters and
sibling mutations pause until Save/Cancel. Permission/read loss retains a read-only draft
with Cancel available. Settings saves read canonical values instead of accepting draft
strings or malformed 200 receipts as saved.

### Local validation and limits

- Before work: 136 files / 2,363 tests passed; the ten loopback Telnet fixtures failed
  with sandbox `EPERM` on `127.0.0.1` listen. Types passed; lint had 0 errors / 7 warnings.
  The default build was blocked by Turbopack's local port binding; ordinary webpack also
  could not fetch Google Fonts in this restricted session.
- Final full run: **144 files / 2,544 tests passed**. The same Telnet file's ten cases were
  blocked, so `npm test` exited nonzero (145 files / 2,554 total). All 181 added cases passed.
  No failing fixture was skipped or weakened for the sandbox.
- Focused evidence: join 47 cases, shared settings 101 (81 new / 20 existing), mod flows
  126 (53 new plus existing coverage). Groups overlap with the full run. **56 distinct guard
  mutations** failed meaningful assertions and were restored: join 6, settings 29, mods 21.
  An initially weak world-switch test was strengthened to assert dialog identity before its
  final mutation proof. Independent source reviews caught the settings readback race and
  verified the repaired join/access and review/navigation contracts.
- TypeScript passed before and after alternate compilation. One concurrent type/build
  attempt raced Next's generated-file cleanup; sequential rerun passed. Lint exited zero,
  **0 errors / 7 existing warnings**. Diff checks passed.
- `npm run build` remained blocked by sandbox port admission. An alternate **webpack build
  passed**, replaying three real font families/14 existing cached WOFF2 assets through a
  temporary Next font response file; no font/source/package configuration was changed.
  Standalone cleanup/verification and a separate `npm run verify:artifact` passed. This
  records alternate compilation, not a green default build or a new Docker runtime smoke.
  Actual compiled chunks contain the join/filter/review literals and the final published-
  revision guard, confirming this artifact includes the repaired source.
- Browser provider inventory was empty, so no screenshot/mobile/keyboard visual pass was
  possible. DOM/select/timer fixtures do not establish live game joins, saves or restores.
  This batch was not deployed and made no production game or policy changes.

`CLAUDE.md` remains bounded current memory. The settings guide was rewritten as current
contracts, with its old incident narratives, corrections and measurements moved to the
dated snapshot in `MEMORY-HISTORY.md`. Current behavior is in `FRONTEND.md`/`SETTINGS.md`;
feature/live/infrastructure gaps remain in current memory rather than added as closed stories.

## Release attempt, 7 October 2026

The owner authorized pushing the pending work to `aybarsyazici/yoshling-mcserver` and
deploying. Read-only release review found 242 expected source/test/documentation/build paths,
with no accidental env/DB/key/cache/binary additions or known credential markers. Package/
lockfile and artifact packaging remain coherent; Prisma changes are comments/formatting,
so this snapshot introduces no DB migration. The intended deployment is web-only through
`scripts/deploy.sh --service web --verify 'Review settings changes'`; the ID policy gate and
seed/backup/Compose safeguards remain required before any replacement.

Execution stopped at concrete permission boundaries:

- `git add --all`: `.git/index.lock` creation returned `Operation not permitted`.
- `git ls-remote origin refs/heads/main`: GitHub hostname resolution failed.
- Batch-mode SSH to the production IP: port 22 connection returned `Operation not permitted`.

No commit, push, bundle upload, policy conversion or production deployment occurred. The
session is workspace-write with protected Git metadata, restricted networking and approval
prompts disabled. The owner request authorizes the work; the execution profile must permit
Git writes/networking before it can continue. Production policy/current run state remain
unverified because the connection was blocked. Local checks repeated the same 2,544 passing
cases / ten blocked Telnet fixtures, passing types, 0 lint errors / 7 warnings and the
default-build port restriction. Earlier alternate compile evidence is recorded above.

### Deployment admission repaired before release

Release review found that the old seed/growing-backup checks ran only before a potentially
long build. A seed or backup started during that build could be interrupted by web replacement.
The script now repeats invitation validation against the actual next Compose/image, then
seed/staging checks, immediately before `up -d --no-deps web`. Docker inspection errors
refuse; seed command contents are used for detection without being printed.

Static `.work-*` data is now active-or-unverified and also refuses by default. The backup
pipeline leaves it unchanged while tar/checksum output is written elsewhere, so static size
had not proved an orphan or safe deletion. Explicit inherited `FORCE_OPS` remains an operator
acknowledgement; it was not used in this work. The check/apply interval is not a maintained
lock, and production quiescence was not verified through the blocked connection.

Actual remote-shell fixtures passed **31 cases** (ten new / 21 existing). Nine deliberate
mutation scenarios failed meaningful assertions and were restored, including during-build
seed/growing/static staging changes, invitation changes, unknown Docker inspection, seed
heuristics and command redaction. Outer/extracted Bash syntax, scoped lint and diff checks
passed. No production operation occurred.

Combined post-guard validation: **145 files / 2,554 tests passed**; the same ten Telnet
fixtures remained blocked (146 files / 2,564 total). TypeScript and lint passed, with
0 lint errors / 7 existing warnings. The default build remained port-blocked; the same
cached-real-font webpack compilation and standalone verification passed. Initial compile
caught a test-only environment annotation missing Next's required `NODE_ENV` type;
`NodeJS.ProcessEnv` fixed it without changing fixture behavior. Current release paths total
243. Git staging/network permissions still prevent committing, pushing or live checks.

## Release validation after access enabled, 7 October 2026

The owner supplied the verbatim handoff commit `e1ac21c` on `codex/handoff-work`, directly
above the original `6a4d288` base. Its 243 changed paths match the reviewed source. After
permissions changed, GitHub/production SSH succeeded and normal local checks passed:
**146 files / 2,564 tests**, TypeScript, the normal Turbopack build with artifact verification,
and lint **0 errors / 7 existing warnings**. The previous sandbox failures are historical.

Production was observed at `6a4d288`, with web/PZ running, about 10 GiB available host memory,
and no seed container, backup staging or dirty checkout found by the read-only preflight.
These observations are not a maintained deployment lock. The release introduces no DB
migration and targets web only.

The live invitation file contains six legacy labels, each resolving uniquely to an existing
registered account with an exact Discord ID. A complete candidate, original-byte backup
and review metadata were created privately under the web data volume and read back. The
live policy remains unchanged pending the planner's required owner identity review. Roles
and world grants are preserved; individual IDs/policy contents are not committed here.

The validated release and preparation notes were pushed to GitHub `main` at
`1ba66ede650a8aeb5ab50c43d7abdb858a20704f`; a fresh remote ref read matched the local SHA.
The release bundle verified. The prior live image was tagged as
`yoshling-web:rollback-6a4d288-20261007T094727Z` and its immutable image ID read back as
`sha256:c32232078c025677139220cf02ea7de3208f1cae5511f31da1f803470fbded4b`.
Private policy review material is under `/app/data/deploy-policy-review-JCgPdK` in web's
data volume. The candidate digest is `0efbee2a441ea31b9b92ddce8e2158791a02ebbc8a924f92b5e63aa8576f677b`.
Owner review was requested with all six name→ID mappings. No live policy publication or
web replacement has occurred while that approval remains pending.

The owner subsequently approved retaining these six accounts and continuing deployment.
The candidate will be published only if the original policy digest and selected account
records still match the reviewed snapshot; the same registered roles/world grants are kept.

### SSH-stream deployment guard correction

The first authorized live attempt exited zero after the invitation check, without checkout,
build or web replacement. Direct readback still showed production at `6a4d288` and the old
image. Compose run keeps stdin attached by default even with `-T`; its Node policy check
consumed the rest of the `ssh ... bash -s` input. Exit status/`done` had not proved rollout.

The check now reads from `/dev/null`. An actual streamed-Bash fixture models Compose's
stdin consumption and requires the complete ordered checkout/build/rechecks/up/final-state
sequence. Removing the redirect reproduced zero exit with missing steps and failed that
assertion; the protection was restored. All 32 focused deployment cases, Bash syntax,
scoped lint and diff checks passed.

The original invitation bytes were temporarily restored and verified against their private
backup while the old image remained live, preserving its sign-in behavior during the fix.
The owner-approved candidate and account records remain available for the guarded retry.

Combined checks after the correction passed: 146 files / **2,565 tests**, TypeScript,
normal build/artifact verification and lint with 0 errors / 7 existing warnings.

## Verified production web rollout, 7 October 2026

The corrected deployment script shipped `411f77cb5b4d3ab53f18283fca5330c4f2f7755e` after
republishing the owner-approved six-ID candidate. Original-policy and account snapshots
were checked before publication; byte/mode and role/grant readbacks passed. The script then
performed checkout, build, final next-image policy/background checks, web-only replacement
and an actual compiled `Review settings changes` check. No guard override was used.

The running web image and built tag both read back as
`sha256:707a06c74b6a40e3aa63ff42647aaee8c3efbf758e2b843b4d5b8e01d380ce53`, service `web`.
Node 22.23.3, UID 0 and Compose 5.1.4 were retained. Expected game/data/deploy/socket mounts
were present; Workshop remained read-only. Search/review/revision compiled markers passed.
The exact image passed the artifact guard in an isolated read-only container with no
network, mounts or Docker socket; the live mounted `/app` was not used for that image-only check.

The deployed ID validator parsed six unique approved strings. Candidate digest/bytes and
private mode matched; all six registered accounts remained covered, with six allowed
admins and unchanged selected role/world-grant records. No database migration was applied.

PZ remained running on image `sha256:ce9bc0f6611d0ddd129bab4e86fc84eb9b75e4810838d17ef506f17349a5393c`,
with the same `2026-10-06T18:23:46.534790239Z` start time and restart count 0. Minecraft and
7DTD remained stopped on their existing images/start times. No game power action was issued.

Both origin HTTP and public HTTPS from production returned: login 200 HTML, anonymous
session 200/null, Discord-only providers 200, and status/join/whitelist 401 objects.
Independent external curl checks agreed. External Python requests hit Cloudflare's 1010
browser-signature rule; no DNS/WAF/challenge changes were made. These checks verify
availability and anonymous fences, not genuine OAuth login/denial/revocation, authenticated
UI behavior, game joins or gameplay restores. Those remain current manual checks.

Rollback image and private original/candidate policy material are retained as recorded above.
The final documentation synchronization uses the same guarded script and records any image
change separately after readback; documentation is excluded from Docker build inputs.


## Minecraft profiles implemented locally — 2026-10-08

Delivered the profile gallery, exact-source create flow, named pack-build choices,
private screenshot covers, detail metadata/inactive world settings and confirmed
inactive deletion. Start opens a picker; switch/restart selects an isolated complete
server directory with fixed Minecraft, loader and Java targets. Existing mods,
files, identity/player tools, settings and backups bind to the selected profile.

Runtime admission verifies the exact reviewed peers, saves before shutdown, checks
space/tree shape before power changes, preserves three private full checkpoints,
recreates through Compose volume subpaths, verifies mount/target/image policy before
committing selection, and requires actual RCON readiness. Failure recovery retains
stopped verified data; unresolved identity drift refuses ordinary writes. Verified
peer shutdowns retain activity rows even when later startup fails; optional play
history/audit failures do not stop an already verified server.

Preparation streams downloads, ZIP overrides and properties to guarded staging
with independent file hash readback. It preserves exact pack/build/mod pins,
server override precedence and client-file exclusions. The 2 GiB total server
budget does not become 2 GiB of live buffers in the 2 GiB web container. Archive/file
and configuration limits are documented in `MINECRAFT-PROFILES.md`.

Additive schema and manual SQL are included; no automatic migration or GET seeding
occurs. Adoption preserves original data and inventory identity/provenance/history.
Reserved legacy-directory collisions and known world downgrades refuse before game
changes. Private durable markers and deployment checks cover lifecycle/source/
checkpoint/deletion work and nested Minecraft backup staging.

Independent reviews repaired concrete integration defects: cross-profile backup
retention, scheduler identity handoff, old live-cache results, recovery Restart
headers, stale confirmation for newly appeared peers, ineffective bundled-world
seed overrides, normal vanilla jar aliases, copied ownership, delayed read
reactivation, oversized configuration/memory buffering, and deployment admission.
The older single-world pack-switch proposal moved to `MEMORY-HISTORY.md`.

### Verification

- Supported Node 22.18.0; baseline 146 files / 2,565 tests; final **171 files / 2,927
  tests passed**. TypeScript and normal production build/artifact checks passed.
  Full lint: **zero errors, seven existing warnings**. Diff checks passed.
- Real temporary SQLite/filesystem tests cover schema absence, selection and
  inventory transactions, metadata revisions, covers, safe paths, settings,
  publication, quarantine, retention and scheduled identity. DOM/deferred/timer
  tests use the real client hook for stale identity and action readiness.
- Added regression protections were removed/broken, observed failing assertions,
  restored and checked green. Focused logs/manifests are under
  `/tmp/yoshling-profile*` and `/tmp/minecraft-profile-*`; these are local evidence,
  not production artifacts.
- Disposable Docker/Compose fixtures proved volume subpaths, scoped public env
  inspection and UID/GID 1000 reading copied protected files. Fixtures were cleaned;
  game containers and production volumes were not mounted.
- Streaming data exercise used 12 MiB; limit/metadata/adversarial checks cover the
  2 GiB/128 MiB/256 MiB/20,000-entry budgets. No complete 2 GiB pack/RSS benchmark,
  authenticated visual-browser pass, real game boot/join, restore or production
  migration/adoption/deployment was performed.

Production rollout remains open in `MINECRAFT-PROFILES.md`. Current web remains the
previous deployed release; local test/build success is not deployment evidence.
