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
| **Contract** (pure, tested) | `mc-properties.ts`, `sdtd-settings.ts`, `zomboid-ini-contract.ts` | Per-game knowledge: which keys exist, which are secret, which are pinned by the deployment, which need a restart, which are creation-only, and the help text. No I/O, so it can be asserted. |
| **Live** (pure + one probe) | `live-settings.ts` + each driver's `readLive()` in `game-manager.ts` | Ask the *game* what it believes, compare with the file, produce a verdict per setting. |
| **Surface** | `config-panel.tsx` (shared), the per-game settings pages | One generic expander for 7DTD's XML and PZ's `.ini`, because both document themselves with a comment per setting. Minecraft needs its own help table — `server.properties` has no comments. |

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
| 7 Days to Die | telnet `getgamepref`, one session | **153** `GamePref.X = Y` lines | Everything the XML has except eight keys. See [`7-DAYS-TO-DIE.md`](7-DAYS-TO-DIE.md) for the `SandboxCode` caveat — that one row's green tick means "the string matches", not "the options are live". |
| Project Zomboid | RCON `showoptions`, one call, 6,789 bytes, ~101 ms, **multi-packet** | **137** `* Key=Value` lines | All 144 `.ini` keys except `Password`, `RCONPassword`, `RCONPort`, `DiscordToken` and three Discord channel names. |

**Any reply over 4096 bytes needs `rconCommandLong`, not the cached socket.** Source RCON
splits a longer reply across packets with the same request id, and `rcon-client` resolves on
the first one and discards the rest. PZ's `showoptions` arrived as **79** settings for as long
as this feature existed — the first 4,102 of 6,789 bytes — with no error, `available: true`
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

Three verdicts, and the third one matters: a setting the game **does not report** reads
"not reported", never amber. An unanswered question is not a disagreement, and rendering it
as one would train everybody to ignore the chips. `NOT_REPORTED_REASON` is the sentence.

`valuesAgree` is deliberately tolerant about *form* — `70` vs `70.0`, a `;`-list with and
without its trailing separator, `True` vs `true` — because **reporting a false failure is
the same defect as reporting a false success, wearing the other hat**. It is not tolerant
about case in general: a case-insensitive compare for everything would make a renamed
server agree with its old name. Where a value is known to be an enum (Minecraft's
`difficulty`), the lowercasing happens in that game's parser, where the type is known.

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

`sandbox-lua.ts` + `zomboid-sandbox.ts` rewrite a 74,711-byte Lua file holding **742
options** — 253 at the top level, the rest contributed by mods — the world's entire ruleset, with no backup other than the one this writer
makes. So it carries guards nothing else needs:

- **A structural guard.** `assertWholeFile` refuses to rewrite unless the first non-blank
  line is `SandboxVars = {`, the last is `}`, and at least `MIN_PLAUSIBLE_OPTIONS` (200)
  options parsed. A partial read — the server rewriting the file at that moment — would
  otherwise be serialised back as the whole truth and take the other ~700 options with it.
  The floor is injectable so tests can use a short fixture; production uses 200 against a
  real **742** — so it is a 27 % floor, not the comfortable 60 % that an earlier version of
  this page implied by quoting 335. **335 is what the API returns for one `scope`**, because
  `/api/zomboid/sandbox` filters by scope and drops preset-only keys; the *file* is 742, and
  the file is what the writer rewrites. Do not confuse a panel's row count with the blast
  radius.
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
   That last fact is the important one: a complete rewrite of all 1,803 lines and **742**
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
| Minecraft | `server.properties` via a generic panel with a hand-written help table, plus version/loader, memory, in-game whitelist and ops | ~90 properties, 48+ game rules, bans | Game rules and bans were unreachable from the dashboard; see Status below. |
| 7 Days to Die | **64 of 219** XML properties, plus a quick-settings card and the sandbox code | 219 properties | Deliberate: the audit's verdict was "ours is adequate" — pasting a sandbox code is the right design for the long tail, and 7DTD has no memory control (Unity native server, no JVM). |
| Project Zomboid | **137 of 144** `.ini` keys + the sandbox options (742 in the file; the panel shows 335 for the world scope and the rest under mods) + the mod/map order cards | 144 + 742 | 7 hidden: 4 `INFRA_KEYS` (ports and the RCON password, deployment-owned) and 3 `CARD_OWNED_KEYS` (`Map`, `Mods`, `WorkshopItems` — owned by the mod cards, which is why a generic editor must not also offer them). |

The 137/132 accounting is **derived, not a constant** — recompute it from `INFRA_KEYS` and
`CARD_OWNED_KEYS` rather than trusting a number. An earlier comment said "133 of the 138"
and was made wrong by `Map` joining `CARD_OWNED_KEYS` one commit away.

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
