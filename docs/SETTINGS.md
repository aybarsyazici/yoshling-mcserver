# Settings — the shared layer

How the three games' settings pages are built, and the one rule they all obey.

> **The rule: a settings page may not claim a value was applied. It has to go and look.**
>
> Every settings bug this project has shipped was a route that reported success for a
> write that did not happen or landed somewhere else. Two 7DTD quick settings wrote XML
> properties that do not exist in the file. The PZ map-order card wrote the `.ini` and the
> next restart reverted it. Minecraft's whitelist wrote `uuid: ""`, which matches nobody,
> and locked everyone out with a green toast. None of those crashed; all of them said
> "Saved". So the shape of every settings write here is **write → read back → report what
> you found**, and the shape of every settings *display* is **what we configured, next to
> what the game says it is running**.

## Three layers

| Layer | Files | Job |
|-------|-------|-----|
| **Contract** (pure, tested) | `mc-properties.ts`, `sdtd-settings.ts`, `zomboid-ini-contract.ts`, `sandbox-lua.ts` | Per-game knowledge: which keys exist, which are secret, which are pinned by the deployment, which need a restart, which are creation-only, and the help text. No I/O, so it can be asserted. |
| **Live** (pure + one probe) | `live-settings.ts` + each driver's `readLive()` in `game-manager.ts` | Ask the *game* what it believes, compare with the file, produce a verdict per setting. |
| **Surface** | `config-panel.tsx` (shared), the per-game settings pages | One generic expander for 7DTD's XML and PZ's `.ini`, because both document themselves with a comment per setting. Minecraft needs its own help table — `server.properties` has no comments. |

**PZ's contract is split across two files and this table only used to name one.** The
`.ini` **parser and writer** (`parseIni`, `setIniValues`), `splitList`, `bareModId` and
**`INFRA_KEYS`** — the four deployment-owned keys the panel hides — are all in
**`src/lib/zomboid.ts`**, which sits beside that driver's RCON control and so is not a pure
Contract module. `zomboid-ini-contract.ts` holds the rest: `CARD_OWNED_KEYS`,
`RESTART_KEYS`, `parseShowOptions`. Adding a PZ setting usually needs both, and `zomboid.ts`
is the one no settings doc mentioned — so "the obvious place to look" held half the answer.

## Configured vs. live

`liveSettings(game)` returns the game's own view of its settings, cached `LIVE_TTL = 10 s`
(`cachedProbe`: hard TTL, no background refresh). `liveSettings(game, {fresh: true})`
bypasses the cache — the settings panel uses it for the re-read **immediately after a
write**, because a 10-second-old snapshot would show the pre-write value and the page would
render an amber "disagrees" chip for a save that worked.

What each game can answer, measured 2026-10-01 against production:

| Game | Probe | Returns | Covers |
|------|-------|---------|--------|
| Minecraft | RCON `difficulty` + `list` | 2 values | `difficulty`, `max-players`. That is all RCON will tell you about `server.properties`. |
| 7 Days to Die | telnet `getgamepref`, one session | **153** `GamePref.X = Y` lines | **`sdtdserver.xml` on this box carries 69 properties** — not the game's full 219, see Coverage below — and `getgamepref` reports **61** of them. The panel hides 5 of the 8 it does not report, so **61 of the 64 settings the panel shows are checkable** and exactly three read "not reported": `ServerPassword`, `TelnetFailedLoginLimit`, `TelnetFailedLoginsBlocktime`. See [`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md) for the `SandboxCode` caveat — that one row's green tick means "the string matches", not "the options are live". |
| Project Zomboid | RCON `showoptions`, one call, **~6.8 kB**, ~101 ms, **multi-packet** | **137** `* Key=Value` lines | All 144 `.ini` keys except `Password`, `RCONPassword`, `RCONPort`, `DiscordToken` and three Discord channel names. |

The 7DTD row used to read "everything the XML has except eight keys", which is true of the
**69** properties this box's `sdtdserver.xml` actually holds and contradicts the "64 of 219"
in Coverage below: 219 − 8 = 211, not 153. The missing fact was the 69, and without it
anyone recomputing the table concludes the telnet probe is losing 58 settings and goes to
debug `parseGamePrefs` for a non-bug. Source: the `readLive` jsdoc in
`src/lib/game-manager.ts:663`, measured on production 2026-10-01 (153 lines, 5,453 bytes,
last byte 31 / 81 / 57 ms on three consecutive runs).

**PZ's byte count is not settled, and this doc inherited one of two disagreeing numbers.**
`game-manager.ts`'s `readLive` jsdoc (`:920`) says the reply is **6,774 bytes**; an inline
comment nine lines later in the same function (`:938`) says **6,789**, and both are
presented as measured on 2026-10-01. Nothing in the repo tells them apart, so this table
says ~6.8 kB. Unverified since 2026-10-01; settle it with
`scripts/pz-rcon.sh showoptions | wc -c`. The **137** and the **~101 ms** are not in doubt —
both are in that same jsdoc and the 137 is reproduced by the key arithmetic under Coverage.

**Any reply over 4096 bytes needs `rconCommandLong`, not the cached socket.** Source RCON
splits a longer reply across packets with the same request id, and `rcon-client` resolves on
the first one and discards the rest. PZ's `showoptions` arrived as **79** settings for as long
as this feature existed — the first 4,102 bytes of a ~6.8 kB reply — with no error, `available: true`
and the chips rendering. See `src/lib/rcon-frame.ts`. This applies to Minecraft too:
`banlist` and a busy `list` pass 4096 just as easily.

**Verified end to end against production 2026-10-01**, by running the real
`compareSettings` over the real `/api/*/config` and `?live=` responses:

| Game | Shown | Agree | Not reported | Next world | **Disagree** | Tone |
|------|-------|-------|--------------|-----------|-------------|------|
| 7 Days to Die | 64 | 59 | 3 | 2 | **0** | muted |
| Project Zomboid | 137 | 131 | 5 | 1 | **0** | muted |

Zero disagreements on either, so the resting state is quiet — which is the property that
makes an amber chip mean something. PZ's 137 = 131 agreeing + 5 unreported + 1 creation-only,
i.e. exactly the **132 checkable** the derivation predicts.

**Four verdicts** (`LiveVerdict`, `src/lib/live-settings.ts:41`), and the two that are
neither `agrees` nor `disagrees` are the ones that do the work:

- **`unknown`** — no evidence either way, never amber. It carries a `why` **code**
  (`not-read` / `unreadable` / `not-reported`) *and* a `reason` **sentence**, and they are
  separate on purpose: "the game does not report this key" belongs on the field, while
  "the server is stopped" belongs once at the top of the page rather than on all 137 rows.
  A UI that told the three apart by matching on the sentence would re-break the moment the
  wording improved. `NOT_REPORTED_REASON` is the `not-reported` sentence.
- **`next-world`** — a creation-only key (`CREATION_ONLY`, `:78`; PZ's is `ResetID`,
  7DTD's are `GameWorld` and `GameName`, Minecraft's are `level-seed`, `level-type` and
  the two `initial-*` pack lists). The live value belongs to the world that already exists
  and the configured one to the next world, so comparing them answers the wrong question
  **even when the game does report a value** — and `ResetID`, `GameWorld` and `GameName`
  are all reported live, which is precisely why they need this case rather than falling
  through to `not-reported`. It gets its own verdict and is labelled rather than silently
  omitted, because silence is how someone concludes the comparison covers everything.
  `NEXT_WORLD_LABEL` is the words. The `Next world` column in the table above is this
  verdict: 7DTD's 2 and PZ's 1.

An unanswered question is not a disagreement, and rendering either of these as one would
train everybody to ignore the chips. The guard order inside `compareSetting` is the
contract: creation-only first, then no-probe/failed-probe, then not-reported, and only then
a value compare.

> This said **three** verdicts and named only `not-reported`. Believable, because the
> production table five lines above has four verdict columns and prose only called out one
> of them — but it is the omission that costs: a renderer written from the short list drops
> `next-world`, so `ResetID` / `GameWorld` / `level-seed` render as disagreements, which is
> the exact false-confident statement `CREATION_ONLY` exists to prevent. Collapsing
> `not-read`/`unreadable` into `not-reported` is the other way to get it wrong — it puts
> "the server doesn't report this setting" on all 137 rows of a stopped server.

`valuesAgree` (`live-settings.ts:152`) is tolerant about *form* in **exactly three ways,
and its own jsdoc ends "Nothing else."**: trim-then-compare-exactly; boolean **words**
case-insensitively (`BOOLEAN_WORDS` — `getgamepref` prints `True` where the XML stores
`true`, and measured on production 2026-10-01 that accounted for **all 11** of the
raw-string differences among the 61 keys both sides report); and strict decimals
numerically (`NUMERIC_RE`, so `40` == `40.0` and `007` == `7`, while `26.1.2` stays a
string). `1`/`0` are deliberately **not** booleans, because 7DTD ships
`GameDifficulty = 1`. The reason for any tolerance at all is that **reporting a false
failure is the same defect as reporting a false success, wearing the other hat** — and the
reason there is no more of it is that a coercion which is only usually right manufactures
exactly the false agreement this project keeps shipping. It is not tolerant about case in
general: a case-insensitive compare for everything would make a renamed server agree with
its old name. Where a value is known to be an enum (Minecraft's `difficulty`), the
lowercasing happens in that game's parser, where the type is known. `compareSetting` and
`compareSettings` add no normalisation of their own.

> This claimed a fourth tolerance that **does not exist**: "a `;`-list with and without its
> trailing separator". There is no list or separator handling in `valuesAgree`, in
> `compareSetting`, or in the tests — `live-settings.test.ts` pins booleans, numbers,
> leading zeros, trim and exact strings, and nothing else. Plausible because PZ really does
> keep `;`-lists in `Mods` and `WorkshopItems`, and `splitList`/`bareModId` really do exist
> — in `zomboid.ts`, for the mod cards, nowhere near the comparison. Recorded rather than
> deleted because **both readings cause harm**: believe it and a spurious amber chip on
> `Mods` stands unexplained; "restore" it and a genuine `Mods` / `WorkshopItems` / `Map`
> mismatch is suppressed, which is the false-agreement defect class this module's own
> comments say to avoid.

`redactSecretKeys` runs on every probe result before it leaves `readLive`. The reason is
not hypothetical: `/api/settings` used to return the whole `ServerConfig` row including
`rconPassword`, byte-identical to the live RCON password, to anyone with Minecraft access.

### One wire format, one parser

`parsePzOptions` (the generic live layer) **delegates** to `parseShowOptions`
(`zomboid-ini-contract.ts`). They were briefly two regexes that disagreed — one tolerated
`* Key =Value`, the other did not — which means the save report and the live chip could
disagree about whether a key *exists at all*. That is worse than either being wrong: the
same key reads as "not reported" in one view and as a value in the other. The test is
mutation-checked (re-inlining the old regex turns it red).

## Writing

Every settings writer in this app:

1. **Refuses before writing, not after.** A value pinned by the deployment (`ServerPort`,
   `WebDashboardPort` — compose publishes one port and only one), a path segment with a
   `/` in it, a heap below the container's `MIN_MEMORY`, a Minecraft version the world and
   the installed mods contradict. Writing the row and *then* refusing is how the configured
   and running versions came to disagree for weeks.
2. **Names what it dropped.** A key that is not in the file comes back in `ignored`; a
   locked key comes back in `locked`; a clamped number comes back in `clamped` with the
   value that was actually stored. `PUT maxPlayers=99` storing 16 and answering
   `{success:true}` with `99` still in the box is the thing this prevents.
3. **Takes the file lane.** A sub-second config write still has to hold it, or a restore
   running for minutes will silently overwrite whatever was saved through it while the page
   toasts "Saved". Measured: a 7DTD config PUT returned 200 in 17 ms in the middle of a
   backup.
4. **Reads back.** See the rule at the top.

### The PZ sandbox file is the concentrated risk

`sandbox-lua.ts` + `zomboid-sandbox.ts` rewrite a 74,711-byte, 1,803-line Lua file holding
**742 options** — 253 at the top level, the rest contributed by mods — the world's entire
ruleset, with no backup other than the one this writer
makes. So it carries guards nothing else needs:

> **This said 335, which is a real number about something else: it is what
> `GET /api/zomboid/sandbox?scope=world` returns.** The file holds 742 (counted on
> production 2026-10-01; `sandbox-lua.ts:6` and the `sandbox-lua.test.ts:22` fixture header
> both record it, and the committed `fixtures/pz-sandboxvars.lua` is a verbatim trimmed
> excerpt of that read). The arithmetic reconciles exactly: 253 top-level options + 86 in
> the five `VANILLA_BLOCKS` tables = **339** in the `world` scope, minus `VERSION` and the
> three `PRESET_ONLY` names the route filters out (`sandbox/route.ts:72`) = **335**; the
> other **403** live in 21 mod tables (`BurdJournals` alone has 182) and are served as
> `?scope=mods`. Believable because 335 really is what one request answers and the page
> *does* render two panels, so a reader who saw one number saw a true one. Worth recording
> because it halves the apparent stake of every guard below — the risk this writer manages
> is 742 options, not 335.

- **A structural guard.** `assertWholeFile` refuses to rewrite unless the first non-blank
  line is `SandboxVars = {`, the last is `}`, and at least `MIN_PLAUSIBLE_OPTIONS` (200)
  options parsed. A partial read — the server rewriting the file at that moment — would
  otherwise be serialised back as the whole truth and take the other ~540 options with it.
  The floor is injectable **only so the tests can use a verbatim 38-option excerpt**
  instead of committing 1,803 lines; production uses 200 against a real 742, i.e. the guard
  trips only below **27 %** of the file. That looseness is deliberate and the module says
  why: it is a floor rather than an equality so a build or a mod that adds *or removes*
  options does not start refusing every save. The delimiter checks are the primary guard
  and this is the backstop for a read that is somehow well-formed and nearly empty. **The
  route must never lower it.**
- **A unique temp name per write.** The settings page renders two sandbox panels and both
  Save buttons PUT the same route, so a fixed `.tmp` let two concurrent writes rename each
  other's half-written file over the live one.
- **A `.bak` published by hard link**, not copied. `link()` gives the backup the original's
  inode, so it is byte-identical and carries the original's owner and mode by construction,
  with no window in which it is partly written. A read-then-write copy had all three
  failure modes: a truncated backup if it died mid-copy, `root:root 0644` beside a
  `1000:1000 664` original, and silence when it failed.
- **Owner and mode restored after the rename.** The game runs as uid 1000 and the web
  container is root. Hand the game back a root-owned file and it logs `Unable to save
  options to filename` and carries on — quiet degradation noticed weeks later.
- **Three distinct error paths, not one sentence.** A bare `catch` around the whole write
  answered `400 "Couldn't read the sandbox file — start Project Zomboid once first."` for an
  ENOSPC on the temp write, an EXDEV on the rename, *and* a failed post-rename read-back:
  false in both halves, **after the file was already replaced**, with no activity row. Now
  404 for a genuinely absent file, 409 for the structural guard (nothing was written, say
  so), 500 naming the real errno and pointing at the `.bak`.

**Verified against the live file 2026-10-01**, which it had never run against before. Three
writes:

1. `DayLength=4` when it was already `4` — a semantic no-op, but a full parse → serialise →
   rename. It produced a **new inode** carrying the original's `node:node 664`, a `.bak` on
   the **original inode** with the original mtime, and a file whose md5 was **unchanged**.
   That last fact is the important one: a complete rewrite of all 1,803 lines and 742
   options reproducing the file byte for byte is the strongest available evidence that the
   round trip is lossless. Had the writer dropped, reordered or reformatted anything, the
   md5 would have moved.
2. `DayLength=5` — landed on disk (`DayLength = 5,` at line 53), confirming the mutation
   path, not just the identity path.
3. `DayLength=4` — returned the file to its **exact starting md5**.

No orphaned `.tmp` or `.bak.<uuid>` files after any of the three; both renames consume their
temps.

## Coverage — what is exposed vs. what each game supports

| Game | Exposed | Supported | Gap |
|------|---------|-----------|-----|
| Minecraft | `server.properties` via a generic panel with a hand-written help table, plus version/loader, memory, in-game whitelist, ops, **game rules and bans** | ~90 properties, **58** game rules, bans | None known. Game rules landed 2026-10-01 (`/api/server/gamerules` + the Game rules panel) and bans the same day (`/api/server/bans` + a card); both are on the MC settings page, both hold `files:minecraft`, and both have route *and* component tests. Depth: [`MINECRAFT.md`](MINECRAFT.md#game-rules) and [`MINECRAFT.md`](MINECRAFT.md#bans). |
| 7 Days to Die | **64 of 219** XML properties, plus a quick-settings card and the sandbox code | 219 properties | Deliberate: the audit's verdict was "ours is adequate" — pasting a sandbox code is the right design for the long tail, and 7DTD has no memory control (Unity native server, no JVM). |
| Project Zomboid | **137 of 144** `.ini` keys + **738 of 742** sandbox options + the mod/map order cards | 144 + 742 | 7 `.ini` keys hidden: 4 `INFRA_KEYS` (ports and the RCON password, deployment-owned) and 3 `CARD_OWNED_KEYS` (`Map`, `Mods`, `WorkshopItems` — owned by the mod cards, which is why a generic editor must not also offer them). 4 sandbox options hidden: `VERSION` and the 3 `PRESET_ONLY` names, which nothing in the game reads. |

**Two things that table used to get wrong, both of which sent readers somewhere useless.**
The Minecraft row read "48+ game rules" and "Game rules and bans were unreachable from the
dashboard; see Status below" — the server reports **58** on 26.1.2
(`mc-gamerules.test.ts:183` asserts 58 distinct ids off the committed
`fixtures/mc-help-gamerule.txt`; 48 is the older 1.21.4 figure), both features shipped on
2026-10-01, and **there is no "Status" section in this file**. The rule ids are discovered
with `help gamerule` and never hardcoded, so do not write a parser floor against either
number. And the 7DTD row's 219 is the *game's* property count, not this box's file's — see
the 69 under "Configured vs. live" above.

The 137/132 accounting is **derived, not a constant** — recompute it rather than trusting a
number. An earlier comment said "133 of the 138" and was made wrong by `Map` joining
`CARD_OWNED_KEYS` one commit away. **The two constants live in different files, which is
the part this used to leave out:** `INFRA_KEYS` (4) is in **`src/lib/zomboid.ts:101`** and
`CARD_OWNED_KEYS` (3) in **`src/lib/zomboid-ini-contract.ts:43`**. The walk, against
`tests/fixtures/pz-server.ini` (a real copy — 144 unique `Key=` lines, verified
2026-10-06): 144 − 4 − 3 = **137 shown**; of those, 5 are unreported (`Password`,
`DiscordToken`, the three Discord channels) → **132 checkable**; minus 1 creation-only
(`ResetID`) → **131 agreeing**, which is the PZ row in the production table above.
`RCONPassword` and `RCONPort` are in both the hidden set and the unreported set, so the
overlap costs nothing. The sandbox side derives the same way: 742 − `VERSION` − 3
`PRESET_ONLY` = **738** exposed, split by `scopeOf` into 335 `world` and 403 `mods`.

## No declarative settings schema, by decision

7DTD's XML and PZ's `.ini` both carry a comment per setting, so the generic panel reads its
help straight out of the file the game ships and cannot go stale. A schema in this repo
would be a second copy of the game's own documentation, rotting at its own pace. The two
places that *do* need hand-written knowledge are the things the file cannot know — what the
*deployment* does to a setting (which ports compose pins, which keys the host firewall makes
inert) and Minecraft's `server.properties`, which has no comments at all.

## Corrections

Kept because a wrong explanation plausible enough to be written down is worth recording as
wrong rather than quietly deleted.

- **Four claims were corrected in place on 2026-10-06** and annotated with a blockquote
  where each stood, rather than restated here: `valuesAgree` was said to tolerate a
  `;`-list's trailing separator (it tolerates nothing of the kind); the verdict set was
  said to have three members (it has four — `next-world` was missing); the sandbox file
  was said to hold 335 options (742 — 335 is one `scope`'s worth); and the Minecraft
  Coverage row listed game rules and bans as gaps months after both shipped, while
  pointing at a "Status" section this file has never had. The first two would have caused a
  wrong change to the comparison path, the third halved the apparent stake of every guard
  on the sandbox writer, and the fourth invites building a second game-rules surface.
- **"`getgamepref` is deliberately not wired into the page"** — `docs/7-DAYS-TO-DIE.md` said
  this for a day after it *was* wired. The sentence was true when written and the reason it
  gave is still true; it survives as a per-row exception for `SandboxCode`. This is how a
  doc goes wrong while every sentence in it once passed review.
- **"133 of the 138 settings it shows are checkable"** — correct when measured, falsified by
  a sibling branch in the same revision. Replaced with the derivation.
- **"137 settings"** — right about the server and wrong about the app, for a day. It was
  measured with `scripts/pz-rcon.sh`, which drains multi-packet replies; the dashboard's own
  probe saw **79**. Both numbers were honestly obtained and one of them was the number that
  mattered. **Measure through the path the user actually uses** — a figure taken with a
  different client is a figure about that client. Fixed 2026-10-01; the app now reports 137,
  verified including `PerkLogs` (the key at the old cutoff) and `ServerWelcomeMessage` (the
  last line, 448 characters).
