# Operations — how the app says what it is doing

One registry tracks every long operation; one strip renders it on every page; toasts
cover the short ones. Built 2026-09-29 by a 13-agent design/build/audit workflow (six
adversarial lenses, 4 blockers and 23 majors found and repaired).

**If you add an operation that can take more than ten seconds, wrap it in
`runOperation`. Do not invent a second mechanism.**

Minecraft `profile.prepare`, `profile.adopt`, `profile.switch` and `profile.delete`
use the registry. Preparation/deletion own Minecraft files; adoption/switch claim
power only after preflight. A switch leases the exact reviewed running peers and
refuses occupied file lanes. It confirms saves, checkpoints, mount/target readback,
selection and actual RCON readiness as separate evidence. See
[MINECRAFT-PROFILES.md](MINECRAFT-PROFILES.md).

## Deployment admission

`scripts/deploy.sh` observes seeds and backup staging before checkout/build and again
immediately before web replacement. It revalidates the next Compose/image's invitation
policy first. Failed Docker inspection refuses replacement. Seed command text is used for
detection; only names/roles are reported.

Any `.work-*` backup staging is active or unverified, even when its size stays constant:
compression and checksumming can leave the staging data unchanged. Default deployment
refuses it; verify the operation before cleaning leftovers. Explicit `FORCE_OPS` is an
operator acknowledgement of possible interruption and is not enabled automatically.
These checks are observations rather than a maintained lock; avoid concurrent work during
rollout. Web uses `--no-deps`; PZ image deployment separately requires verified stopped state.

## Why it exists

Two measured failures, both of which are the same failure:

1. **2026-09-15** — a mod-update apply ran 18:30:25 → 18:36:23 with the power buttons
   correctly locked and **nothing anywhere saying why**. It read as the feature having
   done nothing. A toast lives 4 s; the operation took six minutes.
2. **The recurring defect class of this codebase is "reports success after doing
   nothing or the wrong thing."** A modpack apply that installed 0 of 166 mods toasted
   green. Two 7DTD settings wrote XML properties that do not exist and said "Saved".
   Every backup restore returned `{success:true}` without stopping the server.

So the design has one non-negotiable property: **a route cannot state an outcome.**

## The honesty contract, enforced by the compiler

`runOperation`'s callback returns `OpSuccess<T>`, which declares:

```ts
summary?: never;
outcome?: never;
```

Typed `never` rather than merely omitted, and the comment in `operations.ts` explains
why: TypeScript's excess-property check does **not** fire on an object literal returned
from an arrow whose return type is being inferred, so `async (op) => ({ summary: "Done",
value })` compiled cleanly and the field was silently dropped. Typed `never`, the same
line is a hard error.

`concludeOperation` writes the sentence, from the steps and facts that were actually
recorded. That is what makes "a route cannot write its own success sentence" a fact
about the compiler instead of a convention in a comment.

**Five** terminal outcomes (`Outcome`, `src/lib/operations-types.ts:87`). `concludeOperation`
(`operations.ts:639`) tests them in this order, first match wins: **`failed`**, **`nothing`**,
**`partial`**, **`unverified`**, **`ok`**. Two of them exist because of specific defects here:

- **`unverified`** — "it finished and I could not read the evidence back". Any operation
  that records no facts at all gets it, so not checking has a visible price.
- **`nothing`** — "it ran and changed nothing", and it is the **most common** outcome on
  this box: clicking the running world's card, or Stop on a world that is already down,
  produces one. Measured on production 2026-09-29, **eight of a full ring's twenty slots**
  were `nothing` records.

Each has its own `summarize()` branch, and `nothing` also has its own TTL class
(`isCleanOutcome`, `:259`) and its own eviction behaviour (`evictionIndex`, `:1165`).
**This said four outcomes and omitted `nothing`** — believable, because the four it listed
are the four a reader thinks of as verdicts and `nothing` was added later for the no-op
power path. Worth recording rather than deleting: a `summarize()` or UI `switch` written
from the short list loses the "Nothing to do — X was already Y" sentence that the whole
guard exists to produce, and TypeScript will not call a non-exhaustive `switch` with a
`default` an error.

### `op.reject()` is the one place a route decides anything, and the rule is narrow

Everything above says a route may not state an outcome. `op.reject(label)` is the single
exception worth a stated rule, because it is easy to read as a general escape hatch:

- **What it decides is the HTTP status, not the outcome.** Use it when the route refuses
  *input* on its own terms and wants a 4xx — an unsafe zip, a name it cannot derive, a
  client-only mod — then `return` a `NextResponse` with that status instead of throwing.
- **The outcome is still `failed`, and the route does not get a say.** `reject` pushes a
  step with `kind: "failed"` (`operations.ts:444`), and `concludeOperation` returns
  `failed` on any failed step before it reaches the `nothing` / `partial` branches. From
  the user's point of view the thing they asked for did not happen; all that changed is
  that the route owns the status code rather than falling through to a 500.
- **The label is the sentence.** For a `failed` record `summarize()` takes the reason from
  a thrown error first, then the rejected step's label, then a `bad` fact
  (`operations.ts:802`). So the label has to read as a reason, not as a step name.
- **It works before the first `op.step()`.** `/api/7dtd/reset` validates `GameWorld`
  before touching anything, and with no step to settle this used to record nothing at all
  — which `concludeOperation` read as "finished and checked nothing" → `unverified`, so a
  *rejected* request told the user to go and inspect a world list. `reject` now pushes its
  own failed step in that case.

## Traps, each paid for

- **`operations.ts` compiles into three separate server chunks.** Next builds route
  handlers, server components and `instrumentation.ts` into separate module graphs, so
  `const LIVE = new Map()` was **not one instance**: a route handler saw the running
  backup while a server component on the same process saw `[]`, and anything entered
  from the instrumentation timer (the PZ Workshop watcher — the operation nobody clicks)
  was invisible to both. Pinned to `globalThis.__yoshlingOperations`, the way
  `lib/db.ts` pins Prisma but **without** the `NODE_ENV` guard, since this is not an HMR
  workaround. **This is a general trap in this codebase**, not a one-off: any future
  module-level mutable state shared across those layers needs the same treatment.
  Note that `live` and `finished` alias by reference but `seq` is a number — it is
  mutated as `REGISTRY.seq += 1`, never copied into a local, or ids would collide per
  layer.
- **Before the RCON `quit` fix, every Project Zomboid stop recorded a
  `Shutdown: killed after 300s` warn fact**, so every operation that stopped PZ concluded
  `partial`. Clean PZ stops now exit through `quit`; the warn belongs only to a forced
  shutdown. **Corrected 2026-10-06:** the old present-tense claim was stale. The summary
  rule still holds: **a summary template must never branch on `outcome === "partial"` to make
  a specific claim.** Three separate blockers came from that one mistake, including a
  restore that said "stayed powered off" while restarting. Select on the fact you are
  actually about (`warnValue(entry, "Container")`, `factValue(entry, "Server")`), and use
  `sideNote()` + `WARN_CLAUSE` for warns a template does not understand.
- **`.cn-toast` must feed sonner CSS variables, never declare `background` / `border` /
  `border-radius` / `box-shadow` directly.** Sonner injects
  `[data-sonner-toast][data-styled=true]` at specificity (0,2,0), which beat the class
  (0,1,0) on exactly those four properties — so every toast looked identical regardless
  of severity and the class was, in effect, dead. Source order cannot help.
- **`.op-warn` / `.op-bad` exist because `text-chart-5` measures 2.15:1 in Latte.** Use
  them for any outcome stated as text. **The first version of this note claimed the
  foreground-mix "clears AA in Latte" and that was wrong** — measured on production it
  came out at 2.50–2.66:1, i.e. barely better than what it replaced. Latte now has a
  dedicated `--op-warn: #7c4d02` (5.47:1 on the strip wash, still amber); `.op-bad`
  keeps the mix, which does clear (4.43–4.70:1). Mocha was always fine (12.19:1). The
  lesson is the reusable one: **a colour token's contrast is a measurement, not a
  derivation** — a mix toward `--foreground` does not guarantee anything on a tinted
  background.
- **A stalled synthetic boot is a third reachability state** (`OperationView.stalled`),
  bounded by the same 12 minutes the controls use for "Not responding". **There are
  exactly two sites** — `grep -rn '12 \* 60 \* 1000' src` returns `BOOT_STALL_MS` in
  `src/lib/operations.ts:1362` and `STUCK_AFTER_MS` in `src/lib/operation-ui.ts:122`.
  Keep *those two* in step or the strip and the controls will disagree about the same
  container, which is what `a7d76b8` was about. **Not `game-controls.tsx`:** it holds no
  threshold of its own and calls the shared `powerState()` out of `operation-ui`, as
  `game-overview.tsx` does. This bullet named `game-controls.tsx` for months and
  `operations.ts:1352`'s own comment still does — adding a third copy there to satisfy
  either is precisely the drift `power-surfaces.test.tsx` and "Prefer a drift guard"
  (below) exist to prevent.
- **`busy` locks the buttons; `ownBusy` describes the world.** Conflating them made the
  Project Zomboid page report "Working…", wear the "Booting" pill and animate a blue
  Power Core while *Minecraft* was starting and PZ was stopped. Pre-dated this work (the
  same expression is in `08abbc8`); the registry only made it visible by naming the
  blocking world in the reason text. Anything that claims this world is doing something
  must read `ownBusy`.

## Rules the live run added

Two blockers came out of running this against real containers, and both are rules rather
than one-off fixes:

- **A fact may belong to a different world than its operation.** A hand-off is ONE
  operation whose `game` is the world coming *up*, and it records a `Shutdown` fact about
  the world going *down*. Before `OperationFact.game` existed, starting 7DTD over a
  running PZ summarised as *"7 Days to Die — started in 5m 04s, but **it** had to be
  killed after 300s"* — blaming the arriving world for the departing world's SIGKILL and
  sending anyone reading it to the wrong container. Any new summary template that names a
  world must read **the fact's** world and fall back to `entry.game` only when the fact
  carries none. Verified live afterwards: a dirty hand-off reads *"Switched to 7 Days to
  Die in 5m 03s — Project Zomboid had to be killed after 300s"* (`partial`), and a clean
  one reads *"Switched to Project Zomboid in 33s — 7 Days to Die stopped first"* (`ok`).
- **Never derive a verdict from `State.ExitCode` without having observed the container
  running.** The field persists across runs, so a stop against an already-stopped world
  read the *previous* run's exit code and fabricated a save, a stop, a `Shutdown`
  verdict and a durable `Activity` row for work that never happened — **and, because
  admission is what marks live file operations `preempted`, it deleted a valid 290 MB
  backup that was 11 minutes into copying.** All three power paths now check
  `containerState` first — but **they do not all answer the same way**, so read the one
  you are copying rather than the pattern:
  - **`powerOff`** (`game-manager.ts:1483`) and **`powerOn`**'s already-running-*and*-
    answering branch (`:1377`) return before admission with **`resources: []`** and settle
    a `noop` step, so they conclude **`nothing`**. Do not give the no-op
    `POWER_RESOURCES` for symmetry: a record that holds nothing can pre-empt nothing, and
    that is the whole repair. (`powerOn`'s *other* branch — container up, game silent —
    `op.reject`s and concludes `failed`. That is the honest answer and the one `a7d76b8`
    is about; it also holds no resources.)
  - **`restartGame`** (`:1637`) checks the same state and then **still starts the world**,
    recording `Shutdown: nothing to stop — it was already off` as a fact. It concludes
    **`ok`**, deliberately: a `noop` step would drag the record to `partial` and attach
    "but it did not go cleanly" to an operation that did exactly what was asked. It must
    never early-return either — a Restart is a request to have the world **up**, so one
    aimed at a world that is already down has to start it.
  - **`narratedStop`** (`:1214`) is an internal helper returning a boolean. It settles the
    `noop` step and sets **no outcome at all**; its callers decide.

  This bullet used to say all three "answer that case as outcome `nothing`". Copying that
  into a restart-shaped path turns Restart into a no-op for exactly the state in which
  somebody presses Restart, which is the `a7d76b8` recovery path undone.
- `powerOff` returns whether it actually stopped something and `powerOn` returns `[]`
  when nothing happened. **There is one caller.** `src/app/api/games/control/route.ts` is
  the only route that calls `powerOn` / `powerOff` / `restartGame` — the four other files
  that match those names only mention them in comments, there is no `/api/server/control`,
  and `src/lib/server-manager.ts` now exports nothing but `getModsDir()`. It gates the
  durable `Activity` row on one flag, `changed` (`:61`), which **`start` and `stop` set
  from the return value and `restart` deliberately leaves `true`** — a restart always acts,
  per the bullet above. The `GameState` write is gated on it for `stop` only (`:78`);
  `start` writes `activeGame` unconditionally, which is correct, because a world that was
  already up *is* the active one. A new caller that ignores the return value reintroduces
  "a log of things that did not happen". (This said "both control routes", which sends an
  auditor hunting for a second one.)
- **Quiet short-write reservations** use `runFileWrite` in the shared registry across
  read/modify/write/readback without adding a completion toast. Ordinary writers/backups
  refuse overlap; power/restore can preempt, and publication/terminal checks then return
  an honest interrupted response. In-flight effects may remain. `fileLaneBusy` remains
  a compatibility check, not a reservation. Single-mod installation enters `runOperation` as
  `mods.install`, holding `files:minecraft` throughout metadata/download/publication;
  its potentially long work cannot use a one-time lane check. Mod removal uses a quiet
  reservation (see [`MINECRAFT.md`](MINECRAFT.md#both-single-mod-writers-now-defer-to-filesminecraft)).
- **Pre-emption is global, so every confirm dialog must be.** `liveFileOperations()` +
  `namedFileOperations()` in `operation-ui.ts` are the one definition. `powerBlocker`
  stays per-world — that is the *disable* decision and it is correct.
- **Planning a destructive action must not interrupt another world's backup.** Pack
  application, 7DTD reset and update first hold only their target file lane. After
  preflight they call `claimOperationPower`, repeat any live-state checks, then change
  files or lifecycle. The synchronous claim refuses lost/preempted admission or a held
  power lane without preempting an unrelated file operation. Ordinary power recovery
  retains its ability to preempt file work.

## What is deliberately not fixed

- **A forced PZ shutdown produces an amber outcome**, because SIGKILL is a genuine warn.
  Clean RCON-`quit` shutdowns do not require that warn. **Corrected 2026-10-06:** this
  previously called SIGKILL unavoidable and every routine restore/update amber, contradicting
  the already-fixed driver. Preserve the warning when a forced shutdown really occurred.
- **Pre-emption cannot *interrupt* work — but it can stop more of it being started, and
  there are two guards for that.** A new long operation wants the second one more often
  than the first, and this list named only the first for months:
  - **`refuseIfPreemptedEarly(op, what)`** — `src/lib/backup-archive.ts`, used at
    step boundaries in `backup-create.ts`. The
    step-boundary check: it refuses the next step before publication and says that the
    step was not continued. Single-mod installation also uses it immediately before jar
    publication. It makes no claim that earlier steps changed nothing. It exists because of a
    measurement: on production 2026-09-29 `op.preempted` was set **94 s into a 9m 43s** PZ
    backup and the only check ran *after* the 291 MiB tar finished, so the app spent a
    further **~7m 55s** competing for disk for a result it had already condemned, then
    handed the user nothing. Two of three PZ attempts that afternoon were pre-empted.
  - **`refuseIfPreempted(op, what)`** — `operations.ts`, used by `backup-create.ts`.
    The post-artefact check: it declines to *publish* a
    torn archive, and the route's `catch` does the `rm`. That is why its sentence ends "It
    has been deleted" — and why calling it at a step boundary would be a lie, since
    nothing exists to delete yet.

  An in-flight copy, download or write cannot be interrupted retroactively. Pack
  application checks before further removal/install/start steps; single-mod installation
  checks immediately before publication. An interrupted replacement may be incomplete,
  so preserve that evidence rather than promising unchanged files.

  While you are in there: **`src/lib/backup-archive.ts` holds three things and its name
  only suggests one**, and no doc mentioned any of them. Besides `refuseIfPreemptedEarly`
  there is `BadArchiveError`, which is how an unreadable upload becomes a **400** rather
  than a 500; and the manifest **sidecar** (`manifestSidecarPath` /
  `writeManifestSidecar` / `readManifestSidecar`), which exists because reading the
  embedded `./manifest.json` costs a full gzip decompression for ~100 bytes — measured,
  `GET /api/7dtd/backups` took **7.9 s** for six 290 MB archives, and that is the backups
  page's first paint. **The sidecar is a cache; the copy inside the tar is the source of
  truth**, because the in-tar copy is what keeps an archive self-describing after it is
  copied off the box. Writing the sidecar is never fatal. Do not "simplify" to one of the
  two — that is an invariant somebody breaks by tidying.
- **A thrown failure writes no `Activity` row**, so the durable log is mostly successes —
  but **not only successes**, and anything reconciling over `Activity` has to know that.
  `/api/mods/install-modpack` writes its `apply_modpack` row at `route.ts:691`, *before*
  `applyReport` computes `complete` (`:716`), so a short apply — outcome `partial`, HTTP
  500 — does leave a durable row carrying `installed` and `total`. The route's own comment
  scopes the guarantee correctly ("written **after** the mods were replaced, never on a
  refusal path"), which is narrower than "only successes". `/api/mods/installed:72` already
  reads these rows with a `findFirst` to name the installed pack, so it can name a pack
  that only partly installed.
- **In-memory retention of a finished record is not one number.** `isCleanOutcome`
  (`operations.ts:259`) calls `ok` **and `nothing`** clean, and those get
  `FINISHED_TTL_MS = 10 min`; only `partial`, `failed` and `unverified` get
  `FINISHED_TTL_BAD_MS = 6 h`. Neither survives a web-container restart. This list said
  "non-`ok` records are kept for 6 hours", which is wrong for the most frequent outcome —
  and moving `nothing` back onto the six-hour side is the measured bug: eight of twenty
  ring slots held `nothing` records, starving the ring of room for the successes people
  were actually watching. Do not "restore consistency".
- ~~`/api/7dtd/world` buffers up to 2 GB with `Buffer.from(await file.arrayBuffer())`.~~
  **Fixed — and this list carried it as a standing constraint while the same file described
  the fix** (see the streaming-upload bullet under "Mutation checking", below). The upload
  now streams through `src/lib/upload-stream.ts`, a multipart reader with `pipeline()`
  back-pressure and an injectable `createSink`, pinned by `upload-stream.test.ts`; peak
  memory is one chunk. The old path held the payload twice — measured, **+104.9 MB of
  `arrayBuffers` for a 50 MB file** — and blocked the event loop while it did, which is
  what silenced the heartbeat during the one operation somebody was watching. So: do not
  attribute a heartbeat stall to this path, and do not cap upload size on its account.

## Proven on production, 2026-09-29

Deployed and exercised against real containers, not inferred:

- **The cross-layer `globalThis` fix is proven for all three layers.** A `backup.create`
  entered by a **route handler** appeared in `/api/operations` *and* in the
  server-rendered HTML of `/home` (the **server component** layer), so refresh-survival is
  real — confirmed three times on live operations with `curl`, no JS executed. The third
  layer, `instrumentation.ts`, could not be exercised *on this date*: there were 0 stale
  Workshop mods all session, so `zomboid-updates.ts` returns `{action:"none"}` before
  reaching either of its `runOperation` sites. The timer was observed ticking eight times,
  so it was alive; the only missing ingredient was a genuinely stale mod. **It was proven
  on 2026-09-30 and has run unattended since** — see "The instrumentation layer is finally
  proven", below. This bullet said "the last unproven path" in bold for days after that
  section was written three screens further down, which is how a reader who stops at the
  first relevant heading ends up avoiding work on the timer.
- **A real PZ backup's summary matched disk exactly.** `Backup created — 291 MB, world
  map included.` against a 291 M file; `tar -tzf` reads every member; the claimed parts
  are all present (`Saves` 444,028 members, `db` 7, `Server` 9, plus `manifest.json`).
  The `.work-` staging dir was cleaned up.
- **Both hand-off directions summarise correctly** — see the world-aware-facts rule
  above.
- **Stopping an already-stopped world does nothing and says so**, writes no `Activity`
  row, and leaves the backup count unchanged.
- **`busy` is null for operations that hold no power** (a backup), and non-null **with an
  `action`** for a power operation, with `beat` advancing while `since` stays put — the
  heartbeat-not-total-duration lock policy working.

**Measured, and worth knowing:** a PZ backup copies **442,064 files (1.9 GB) and takes
~11 minutes**. Recorded on production 2026-09-29 and now carried in the code too
(`backup-copy.ts:7`, `backup-create.ts:824`, `api/zomboid/backups/route.ts:131`), so it is
checkable without this doc. It is far past Cloudflare's 100 s origin timeout, so the
browser request is dead long before the work finishes — which is the whole argument for
the persistent ledger. (This sentence used to end "not the ~4m20s the route's own comment
predicts"; that comment is gone, and so is every other prediction in the backup path.
`op.progress` takes real counts only.)

**The world copy is no longer one opaque step — and this doc named that as "the obvious
next improvement" after it had already shipped.** `countTree()` and `copyTreeCounting()` in
`src/lib/backup-copy.ts` walk metadata first and then report a real count;
`backup-create.ts:841-856` opens *Counting the world's files*, then *Copying the world*
with `op.progress({kind:"count", done, total, noun:"files"})` per batch, and settles with
the count. The rule it follows is in `backup-copy.ts:11`: file count *is* knowable here, so
it reports a count rather than a percentage of anything — no byte total, no ETA. It then
drops back to `indeterminate`, or the file count would keep rendering as live progress
through the ten minutes of `tar` that follow, which is a number about the wrong step. Worth
recording as wrong rather than deleting, because "the obvious next improvement" is exactly
the line a fresh agent picks up first.

## Also verified by rendering it, not by reading it

Driven locally against a real build with a fixture operation — `npm run build && next
start`, plus a hand-minted session cookie.

**The recipe, because nothing else in this repo holds it.** This line used to say "see the
recipe in 'Local development'" and there is no such recipe in `CLAUDE.md`, any `docs/*.md`,
`MIGRATION.md` or `scripts/` — it lived only in one agent's private memory, which does not
travel. Without it every bullet below is unreproducible, and so is any future DOM assertion
or screenshot of an authed page:

1. **Discord OAuth cannot complete on localhost**, so there is no way to sign in for real.
2. Insert a row in `dev.db`'s `User` table with a `discordId`, the `role` you want and the
   `games` CSV you want (`"minecraft,7dtd,zomboid"` for everything). Role *and* `games` are
   independent axes — see "Roles & per-world access" in `CLAUDE.md`.
3. Mint the cookie with `encode()` from `next-auth/jwt`, using `AUTH_SECRET` from `.env`
   and `salt: "authjs.session-token"`. `src/lib/auth.ts` sets no custom `cookies` block, so
   the name is NextAuth v5's default: **`authjs.session-token`** over plain http — **no
   `__Secure-` prefix**, which is the part that silently fails if you copy a production
   cookie name.
4. Set that cookie in the browser. Playwright with `channel: "chrome"` drives the installed
   Chrome, so no browser download is needed.
5. **`ThemeProvider` uses `defaultTheme="dark"`** (`src/components/theme-provider.tsx:7`),
   so Playwright's `colorScheme: "light"` alone does nothing: `enableSystem` is on, but the
   OS preference only wins when the stored theme is `"system"`, and with nothing stored the
   explicit default applies. Set `localStorage.theme = "light"` via `addInitScript`, or you
   will capture dark twice and conclude the Latte contrast work never shipped.

What that setup established:

- the hand-off renders as **one** operation whose rail tint changes at a labelled
  `SWITCHING SERVERS` transfer row, PZ-blue steps above, MC-green below;
- step gaps are log-scaled from real elapsed time, so instant steps stack flush and a
  four-minute one opens up — no predicted bar anywhere;
- all three Power buttons confirmed `disabled=true` via the DOM with the reason
  rendered, on `/home` and on a per-game page;
- the failure state replaces the world glyph with a red severity mark, offers
  **Open the console**, keeps a **Dismiss** affordance that clean outcomes do not get,
  and its toast carries `data-type="error"` with a visibly distinct border and icon —
  which is how the `.cn-toast` fix was confirmed rather than assumed.

**An operation that starts and finishes between two polls produces no completion
toast**, by design: the client never saw it live, and replaying history as toasts was a
bug that was fixed during the build. Short operations get their toast from the route's
own response instead.

---

# The test suite — added 2026-09-30

The pre-remediation measurement on 2026-10-06 was **1502 tests, ~12.4 s, no Docker, no network, no running server.** (This said 199
and the section below said 549 — one file holding two different counts, which is how a number
stops being read.)

**The runtime went from ~2.1 s to ~12.4 s on 2026-10-02**, and that is a deliberate trade worth
knowing about: the mod-inventory and backup-archive suites create real files and run real `tar`
in temp directories, because the bugs they exist to catch are differences between what the
database says and what the filesystem holds. A faked `readdir` is a second place to write down
the answer being tested. 12 seconds is still inside "run it before you ship"; if it reaches a
minute, split the filesystem suites out rather than faking them.

That last constraint is the point: a suite that needs the box up is a suite nobody runs on a laptop,
and every fix in this repo had until now been verified by hand against production exactly
once and then never again.

## Why it exists

Two regressions that one assertion each would have caught:

- The power control drifted into **three copies** (`game-controls.tsx`,
  `mission-control.tsx`, `game-overview.tsx`). The running-but-unreachable recovery fix
  and the `can:` permission projection were each applied to only some of them, so the
  per-world landing pages kept offering "Power on" for a container that was already up and
  hid the Restart that is the documented way out.
- A `noop` step added to the backup routes mapped to outcome `partial`, so every clean
  Minecraft and 7DTD backup summarised as *"but part of it is missing. This is not a
  restore point."* — in amber, on the normal path, since both are usually stopped.

## Two load-bearing details

- **The config must stay `vitest.config.mts`.** As `vitest.config.ts` it is loaded through
  `vitest/dist/config.cjs`, which `require()`s Vite — and Vite is ESM-only, so on Node
  20.12 (this project's default `node`) every run dies with `ERR_REQUIRE_ESM` before
  collecting a single test. Same trap `CLAUDE.md` records for the Prisma CLI.
- **vitest stays on major 3.** vitest 4 requires Node ≥ 20.19, and would fail in exactly
  that same confusing way.

A second config briefly existed — `vitest.config.ts` with a mutually exclusive glob. There
was no textual conflict between them because the extensions differ, vitest prefers `.ts`,
and `npm test` therefore reported a green **80 passed** while running **zero** of the other
117. One config, one glob, both trees.

## A test that encodes behaviour instead of a property is worse than no test

The suite shipped with one, and it is worth keeping as the worked example. It asserted
that a **Minecraft** power operation pre-empts a **Project Zomboid** backup. That passed
only because `DEFAULT_RESOURCES.power` claimed every file lane on the box — i.e. starting
one world destroyed another world's backup. That really happened during the exercise run:
a `power start zomboid` holding all three lanes, and 105 s earlier the `backup.create 7dtd`
it killed, four `done` steps including "Wrote the archive — 290 MiB", deleted.

Narrowing that default was the fix, and the test turned red — so the test made a correct
change look like a break. It now exercises a genuine hand-off (PZ as the *outgoing* world,
whose lane really is taken), and a complement case pins the guarantee nothing covered: a
power operation on one world leaves another world's backup alone.

The same shape applies to `stopSeconds`. The old assertion was `< 60` — a bound, which
cannot catch staleness. `zomboid` sat at 300 (the timeout, not the stop) rendering "five
minutes", then at 30 after the RCON `quit` fix made it 11.4 s, rendering "half a minute".
Both were inside the bound and both were wrong by 3–25×. The measured values are now pinned
by equality, and `7dtd` is deliberately **not** pinned because it has never been timed in
isolation — pinning an estimate would dress a guess as a measurement.

## What it does not cover

> **This section said `game-manager.ts` was uncovered and called its eviction logic "the
> highest-value untested code left" — while the section thirteen lines below is headed
> "`game-manager.ts` is testable, and the seam is the point" and describes the suite that
> covers it.** One file, two opposite claims, a screen apart. Corrected 2026-10-06; the
> original is kept here because a doc disagreeing with itself is worth seeing once.

`game-manager.ts` **is** covered — `src/lib/__tests__/game-manager-control.test.ts`, 37 tests,
with the Docker calls behind the injectable seam the next section explains. The describe blocks
are the shape of it: *"`powerOn` is the only path that evicts, and it evicts every other
world"* (including *"evicts exactly the set `admitStart` says it will, for every
combination"*), *"`withGameStopped` gates both halves on `wasRunning`"*, *"`restartGame` is
stop-then-start"*, the PZ stop, the control lock, *"`setMemory` recreates without starting"*,
and the memory card's report. Those were the two things this section called untested, and they
are the two with the most assertions on them.

Also *partly* uncovered: the three flush helpers. They are module-private to
**`src/lib/backup-create.ts`** — `flushMinecraft` (`:425`), `flushSaves` (`:594`),
`flushWorld` (`:774`) — **not** to the three route files, which is where this used to send
people looking and where they find nothing. And the Minecraft one **is** covered:
`backup-create-minecraft.test.ts:149` ("flushes and pauses autosave when the server is up,
and resumes it") sets `serverRunning = true` specifically to exercise it and asserts the
exact RCON sequence `save-off` → `save-all flush` → `save-on`. The PZ (`flushSaves`) and
7DTD (`flushWorld`) ones are genuinely uncovered — there is no `backup-create-zomboid` or
`-7dtd` suite. Either way the honesty guarantee does not rest on any of them: it was moved
into `summarize()`, so the sentence no longer depends on each route author choosing `done`
over `noop`.

---

# Closing the last open items — 2026-09-30

The pre-remediation harness was measured at **1502 tests, ~12.42 s**, with no Docker,
network or server. Current verification is recorded in `CLOSED.md`; do not treat that
historical count as a current suite inventory.

## `game-manager.ts` is testable, and the seam is the point

Every `docker` fork now goes through `src/lib/docker-cli.ts`, which is injectable
(`setCommandRunner`, refused under `NODE_ENV=production`). That made the code the harness
author had named as the highest-value untested thing in the repo — **eviction ordering and
`wasRunning` gating** — pinnable. Both have caused real incidents.

`powerOn` deliberately **keeps its own eviction loop** rather than calling the shared
`admitStart`. Rewriting a path pinned by 37 tests (`game-manager-control.test.ts`, counted
2026-10-06) to remove a two-line probe loop is the churn that has broken this code before. Instead the two copies are asserted to **agree**
over every combination of running worlds — slicing the loop to one world reddens it.

## Mutation checking is the answer to "does this test pin anything"

The suite already shipped one test that encoded a bug rather than a property and turned a
correct fix red. The counter-measure used throughout this round: for each property, break
it deliberately and confirm the test goes red. Recorded where done — e.g. 15 mutants
against the `game-manager` suite, 15 caught, 0 survived.

Three tests were found **not** to pin what they claimed, and all three were fixable:

- The streaming upload's whole reason to exist. Replacing `pipeline()` with the
  `ws.write()` loop its own header warns against left every test green, because the bytes
  on disk are identical and that is all they checked. Telling them apart needs a sink that
  drains slowly, which a local file never does — hence an injectable `createSink`.
- The permissions reachability guard was satisfied by a **discarded call**: keeping
  `hasPermission(role, "settings.read")` and replacing its `if` with `if (false)` handed a
  MEMBER the live `ServerPassword` with everything green. The guard now requires each key
  to appear *negated with a 403* in the same block.
- `/home`'s `StatusPill` still paired "Stopped" with "Power off" — the surviving half of
  the `a7d76b8` honest-label fix, with no coverage either way.

**Prefer a drift guard to asserting one surface's markup.** The power control exists on
three surfaces and has twice drifted; the guards assert the three *agree*, so a fourth
surface fails loudly rather than silently missing a fix.

## Two destructive paths that looked fine

- **Retention deleted history, not bursts.** `keep: N` only bounds a burst bigger than N,
  and on this box it wasn't: 7DTD had six archives, five written within seven minutes. At
  `keep: 5` the count rule selected the 2026-07-23 and 2026-05-29 archives — in each case
  the only restore point older than a day — and kept near-identical copies of one moment,
  logging `outcome: "ok"`. **The oldest archive is now exempt from the count rule** (not
  from an explicit `maxAgeDays`, which is an operator asking for a date cutoff).
- **`.env` is now the app's write target and the only copy of every secret.** The first
  version read it with `catch { return "" }`, so an EACCES/EIO read as "no file yet" would
  have replaced `AUTH_SECRET`, `DATABASE_URL`, `DISCORD_CLIENT_SECRET` and all four game
  passwords with a four-line file — and the read-back guard runs *after* the write, so the
  operator would be told the setting failed while the box could no longer authenticate
  anyone. Unlike the compose file it replaced, `.env` is gitignored: there is nothing to
  `git checkout`. Now ENOENT-only, temp-file + `rename`, mode 0600, one `.env.bak`.

## Co-residency, verified in a browser

The oldest open item. Reproduced the 2026-09-26 condition on production with a raw
`docker start` — bypassing the hand-off, exactly as the incident did — and confirmed both
messages render:

> Minecraft and Project Zomboid are running at the same time. The box only has room for
> one — stop all but one.
>
> Minecraft and Project Zomboid are allocated 16 GB of the box's 15.6 GB. That is more
> heap than the box has.

The RAM sentence only appears where the arithmetic supports it: with 7 Days to Die
involved there is no heap figure to add up. An earlier draft ended "so it is swapping",
which rendering it for every combination caught as something the function cannot know —
the measurement-you-have-not-checked trap, inside the module written to stop the app being
wrong about the box. That also fixes `RamBudget` reading **0 GB** whenever 7DTD was live.

## The instrumentation layer is finally proven

`docs/OPERATIONS.md` recorded this as the last unverified layer of the `globalThis`
registry fix, because the Workshop watcher only enters an operation when a mod is stale and
none ever was. Exercised by lowering **one already-installed 45 KB mod's**
`WorkshopItemsInstalled.timeupdated` — so SteamCMD re-fetched bytes it already had: no new
mod, no `.ini` change, no risk to the 89-mod save. Then *without* forcing a check, the
watcher's own timer picked it up three minutes later and the registry recorded:

```
mods.update   startedBy=None   ok
"Finished in 53s. 1 mods updated, the server is back up."
```

`startedBy=None` is the proof — no human actor, so it came from the timer, in the
`instrumentation.ts` bundler layer. (That sentence also exposed a `"1 mods"` pluralisation
bug, now fixed and pinned.)

**And it has run unattended since, so the synthetic experiment is no longer the only
evidence.** Re-measured on production 2026-10-06: the watcher has applied **three** Workshop
updates by itself since 2026-10-01 — `W900 Semi-Truck [B42]`, `Mini Health Panel` and
`[B42] I Don't Need A Lighter` — each with the container's `StartedAt` inside a second of
the recorded `appliedAt`, and `lastError` empty throughout. If PZ restarts when nobody
asked it to, this is still the first place to look (`src/lib/zomboid-updates.ts`).

---

# The mod installers get a harness — 2026-10-02

`/api/mods/install-modpack` is the most destructive endpoint in the app (tar the world,
`removeMod` **every** installed jar, download up to 166 replacements) and it had **no
behavioural test at all**. The modules it delegates to were covered — `mod-plan`,
`mod-admission`, `mod-download` — and an adversarial recheck showed what that is worth on
its own by producing **eleven surviving mutants**, every one of them a variation on *the
route computes the right answer and then drops it on the floor*. Two files close them:

- **`src/lib/__tests__/mod-install-routes.test.ts`** — both installers driven as routes,
  **53 tests**.
- **`tests/modpack-report.test.tsx`** — the report dialog, rendered, **12 tests**.
  `modpacks.tsx` had no test of any kind, which left the whole UI half of the client-only
  filter unverified — and the filter's justification is that the user can *see* the
  decision.

Both counts were written as 36 and 9 at `ab0f1e3` and the very next commit (`934a2bd`,
"Give the mods page the single-mod install it never had") grew both suites without touching
this line. Re-counted 2026-10-06 two ways that agree: `vitest run --reporter=json`
per-file `assertionResults.length`, and `grep -c '^\s*it('` on each file. A reader
reconciling 36 against 53 cannot tell whether 17 tests arrived or whether the doc is
describing some other file, and the top of this section opens by complaining about exactly
that.

## Only the edges are faked, and that is the whole design

Faked: `auth`, Prisma, Modrinth, `mod-manager`'s three I/O functions, `fs/promises`,
`child_process` and `getModsDir`. **Not** faked: `mod-plan`, `mod-admission`,
`serverSideVerdict`, `game-gate`, `permissions` — and the **operation registry**, which is
load-bearing. Two of the eleven mutants are facts going missing from the *ledger*, and a
mocked registry cannot notice that; the tests read the record `runOperation` actually
concluded, through the real `listFinished()`.

**Do not stub the gates.** `tests/mc-bans-route.test.ts` does `denyGame: () => null` and
`hasPermission: () => true`, which means deleting the real calls from the route changes
nothing — the recheck flagged exactly that. These suites vary `role` **and** `games` on a
mocked `auth` and let the real gate run, the way `mc-gamerules-route.test.ts` does. Role and
world access are independent axes and only varying one leaves the other deletable.

Two mechanical traps worth not re-learning:

- **A per-test `vi.clearAllMocks()` is load-bearing**, because several tests assert
  `expect(installMod).not.toHaveBeenCalled()` on a request that refused. Delete the line and
  exactly three go red on the *previous* test's calls — which is also what the
  `installMod` "called 24 times on a request that refused" anecdote was.
  - This bullet first said those assertions would **pass** on accumulated history. Backwards,
    and self-contradictory with the anecdote in its own sentence. It also claimed
    `resetAllMocks()` "drops the implementations the module factories installed, leaving every
    fake returning `undefined`" — that is vitest **2** behaviour. This repo pins vitest 3,
    where `mockReset()` restores the implementation given to `vi.fn(impl)`, so swapping it in
    left all 36 tests green when measured (the file holds 53 now). `clearAllMocks` is the clearer statement of intent,
    not a requirement. Both halves were plausible, neither was checked, and a reviewer caught
    them by running the swap — which is the only reason this correction exists.
- **The `child_process` fake must be callback-shaped**, because the route wraps it in
  `promisify`. A promise-returning fake hangs forever waiting for a callback.

## Eleven mutants, applied and confirmed red

Each was applied to the tree, `npm test` run, and the tree restored (`git status` clean).

| # | Mutation | Caught by |
|---|---|---|
| 1 | `if (false && !side.install)` — the client-only filter deleted | `mod-plan` (4) **and** the route suite (5). Also checked against the nastier variant — drop the `continue` so the skip is still *reported* and downloaded anyway, which no assertion on the response's `skipped` can see: red in both (8 tests), because the route asserts which mods reached `installMod` |
| 2 | the unmapped-`environment` warning never pushed | `an environment value this app cannot read is reported` |
| 3 | `skipped.push(...plan.skipped)` deleted | 5 tests — response, ledger fact, *and* the status, because `applyReport` then computes a different denominator from the route's |
| 4 | `errors.push(...plan.errors)` deleted | 3 tests — `errors`, the `Failed` fact, the outcome |
| 5 | `/api/mods/install`'s client-only refusal → `if (false)` | `409s without installing anything` |
| 6 | `{status: complete ? 200 : 500}` → `200` | 4 tests |
| 7 | the no-download-source refusal removed | 2 tests |
| 8 | `unverified.push(mod.name)` suppressed | 2 tests, and **each of the two writer paths independently** — mutating one site reddens exactly one test |
| 9 | the `skipped.length > 0` disjunct dropped from the report-dialog condition | 4 tests |
| 10 | the skipped-rendering block in `modpacks.tsx` deleted | 6 tests |
| 11 | sha512 mismatch returning the corrupt buffer | **already defended** — `mod-download.test.ts`, 3 tests. No new test written |

Mutant 7 is the one worth reading the detail of, because the obvious assertion does not
catch it. With the `installable === 0` branch gone, `modsDirRefusal` catches the same pack
one step later and **also answers 409**, so a status assertion passes. What changes is the
sentence ("could not be installed on a server" instead of "has no download source —
re-import it"), which sends the operator looking for a server fault, and the body shape
(counts present instead of absent), which `modpacks.tsx` branches on. The test asserts the
sentence and the shape.

## The complements are not padding

Every mutant above is a *deletion*, and a deletion is caught by a test that demands the
thing exist. The opposite mutant — do it always — needs a test that demands it *not*
happen, so each guarantee is pinned from both sides: a clean apply answers 200 with an empty
`warnings`, a pack whose values the enum all knows warns about nothing, and an apply with no
skips and no failures opens **no** dialog and raises **no** toast. Without that last one,
"always open the report" passes every other test in the file.

## Background work — four timers in `src/instrumentation.ts`

The Workshop watcher and backup/overview timers have re-entry guards. The stats
collector has neither a re-entry guard nor command timeouts. Workshop updates can
restart PZ; overview generation performs no game lifecycle action. Historical
timer corrections are recorded in the dated audit.

| Timer | Cadence | Off switch |
|-------|---------|-----------|
| `collectStats` — the monitor graphs | 5 s | — |
| PZ Workshop watcher (`src/lib/zomboid-updates.ts`) — **restarts PZ itself when empty** | defaults: `PZ_UPDATE_PENDING_POLL_MS` 15 s tick, `PZ_UPDATE_POLL_MS` 5 min full check | `PZ_UPDATE_WATCH=false` in `.env`, then recreate web |
| `backupTick` (`src/lib/backup-schedule.ts`) | `BACKUP_CHECK_MS` 5 min; first run 5 min after boot | **`BACKUP_SCHEDULE=off`** |
| Minecraft overview queue (`minecraft-profile-overview-queue.ts`) | 60 s; first 90 s after boot | `MC_OVERVIEWS=false` |

Overview rendering holds `render:minecraft-overview`, with short Minecraft file
reservations for snapshots/publication. Docker labels also block overlapping
workers after web replacement. See [MINECRAFT-OVERVIEWS.md](MINECRAFT-OVERVIEWS.md).

The watcher switch and both cadences are interpolated from the operator environment.
Changing `.env` requires web recreation; restart cannot change container env. Local source
checks and an isolated recreated Compose fixture verified all three overrides. Production
toggle verification remains separate. The superseded literal override is recorded in the
dated audit rather than treated as a current instruction.

**Scheduled backups** — `shouldRunScheduledBackup` is the whole decision in one tri-state
function (`run`/`skip`/`probe`), so a `readdir` gates the expensive half of probing three
game servers. Default **24 h per world** (`BACKUP_SCHEDULE_HOURS[_<GAME>]`), and "when did
we last back up" is the newest archive's mtime — no state file to get stuck. It refuses
when: off; the last automatic attempt failed under `FAILURE_COOLDOWN_MS` (**1 h**) ago; the
newest archive is younger than the interval; the world is in any state but
`online`/`offline`; or **anyone is connected**.

**Retention deletes archives without asking, and every backup prunes — manual ones too**
(`applyRetention` from `backup-create.ts:359` unless `prune: false`), which is what "five
archives disappeared" means. `src/lib/backup-retention.ts`:
`DEFAULT_POLICY = { keep: 5, maxAgeDays: 0 }` (0 = no age rule), per world via
`BACKUP_KEEP[_<GAME>]` / `BACKUP_MAX_AGE_DAYS[_<GAME>]`, `keep` floored at 1, journalled to
`BACKUP_JOURNAL_FILE` (`/app/data/backup-journal.jsonl`), and reaching **only inside
`/app/data`** — the `/root` sets are nobody's job (open list). Three deliberate properties,
each easy to "simplify" away and all three reasoned out in that file's header: the two rules
are **OR, not AND**; **the newest archive is never a candidate**; and **the oldest is exempt
from the count rule but not the age rule**.
