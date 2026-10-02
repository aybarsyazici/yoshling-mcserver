# What has been closed, and what it cost

**This file exists so `CLAUDE.md` can be re-read.** Its own documentation rules say to keep
that file short enough to re-read and record that it stopped being true once it passed 723
lines; the Status section plus the audit summary had grown to **284 lines, 30% of the file**,
and almost all of it was history — "closed on date X, listed so nobody re-reports it". Every
session was paying to read the record of work that is already done.

So the *current* state and the *genuinely open* list stay in `CLAUDE.md`. What landed, and what
each thing cost to learn, is here.

**Nothing in this file is a to-do.** If something here reads like an open problem, it is not —
check `CLAUDE.md`'s "Genuinely open" list, which is the only place an open item lives. The
per-game depth is in [`MINECRAFT.md`](MINECRAFT.md), [`PROJECT-ZOMBOID.md`](PROJECT-ZOMBOID.md),
[`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md), [`SETTINGS.md`](SETTINGS.md) and
[`OPERATIONS.md`](OPERATIONS.md).

## The full audit, 2026-09-28

A 22-agent audit covered every feature and route: **[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md)**.
185 findings, each adversarially reviewed. Read its §5 (refuted/downgraded) before
acting on anything in it — **9 of 13 criticals were downgraded by their own
verifier**, several findings are simply wrong, and two prescribe fixes that don't
work. The corrections it produced are already applied throughout this file.

Two conclusions outrank the individual findings. **The recently-rewritten core is
good — don't spend time there**; the control lock, reachability states, staged
`restartGame`, scoped `patchServiceEnv` and `gameGate` all held up, and several
findings blaming them were refuted by forensics. And **the recurring defect class is
"reports success after doing nothing or the wrong thing"**, not crashes — so when you
add anything here, make the success path *prove* it succeeded, the way the memory
card's configured-vs-live comparison does.

Outstanding across the project:

**Fixed and deployed 2026-09-28** (kept here only so nobody re-reports them): the MC
backup shell injection; the public exposure of ports 3000/8080/8081; `install-modpack`
clobbering compose; restores that never stopped the server; the missing `mem_limit`s
and log rotation; the Minecraft version mismatch (**Minecraft now boots — verified,
`Done (1.661s)!`**); `/api/settings` starting a stopped world outside the lock; the
file-browser GETs exposing `rcon.password`; and the zombie-process leak. Details and
the per-finding corrections are in
[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

Still open — and the list is now short enough to state precisely.

**Closed 2026-09-29/30, listed only so nobody re-reports them:** PZ's five-minute
SIGKILL stop (now ~12 s, exit 0, via RCON `quit`); the app writing `docker-compose.yml`
(now `.env`, gitignored, survives `git checkout -f` — compose hashes verified identical
on deploy); no test suite (`npm test`, 1502 tests); no co-residency detection; backups
having no retention/pruning/checksums/download/schedule; Minecraft's in-game whitelist
and ops writing `uuid: ""`; the 7DTD `TelnetPassword` (rotated and telnet control
re-verified end to end); the 224 dead `ModpackMod` rows (re-imported). Details in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) and
[`docs/AUDIT-2026-09-28.md`](docs/AUDIT-2026-09-28.md).

**Closed 2026-10-02 — the Minecraft content revision.** A design review asked whether the
mods/modpacks feature was the right shape. It was not, and the answer **reversed a
recommendation this repo had written**: delegating pack installs to the image's
`mc-image-helper` would install nothing, because `applyServiceEnv` recreates with
`start: false` and Minecraft spends most of its time stopped. Depth, the measurements and the
two claims that were wrong: **[`docs/MINECRAFT.md`](docs/MINECRAFT.md)**.

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
   matched, every digest and byte count identical to an independent `sha512sum`.
   `InstalledMod.source` + `versionId` applied by hand (below).
5. **One page instead of three tabs.** "Browse mods / Installed / Modpacks" cut across the
   task — it nested a *source* under a *collection*, and the collection's empty state was where
   the install instructions lived. Now: the pack as a header (it is server state, not a library
   item), one list with **provenance per row**, saved sets secondary, and both searches as
   sheets. Rendered in Chrome in both themes to check it, which is how three copy bugs and a
   wrong accent colour were found that no test asserted.

Still open here: pack imports are **unpinned** (566 of 569 rows), so applying a saved pack
installs the newest build of each mod rather than the pack, and a re-import duplicates the row
instead of updating it. Both are one increment's work — `dependencies[].version_id` is already
in the API response and discarded. The apply also still runs with the world possibly up.

**Closed 2026-10-01 — the settings revision.** Every settings page now shows **configured
next to live**: the game is asked what it believes (`showoptions` over RCON for PZ,
`getgamepref` over telnet for 7DTD, `difficulty`+`list` over RCON for Minecraft) and the
answer is compared with the file, with "not reported" as a third verdict so an unanswered
question never renders as a disagreement. Full architecture, coverage numbers and the write
discipline: **[`docs/SETTINGS.md`](docs/SETTINGS.md)**. Also closed: the PZ sandbox options
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

Details, and the properties not to break: [`docs/MINECRAFT.md`](docs/MINECRAFT.md).
