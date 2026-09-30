# Operations — how the app says what it is doing

One registry tracks every long operation; one strip renders it on every page; toasts
cover the short ones. Built 2026-09-29 by a 13-agent design/build/audit workflow (six
adversarial lenses, 4 blockers and 23 majors found and repaired).

**If you add an operation that can take more than ten seconds, wrap it in
`runOperation`. Do not invent a second mechanism.**

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

Four terminal outcomes: `ok`, `partial`, `failed`, and **`unverified`** — the last
exists specifically because this codebase needed "it finished and I could not read the
evidence back" to be sayable.

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
- **Every Project Zomboid stop records a `Shutdown: killed after 300s` warn fact**, so
  every operation that stops PZ concludes `partial`. That is correct and should stay —
  but it means **a summary template must never branch on `outcome === "partial"` to make
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
  bounded by the same 12 minutes `game-controls.tsx` uses for "Not responding". Keep the
  two thresholds in step or the strip and the controls will disagree about the same
  container — which is what `a7d76b8` was about.
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
  backup that was 11 minutes into copying.** `powerOff`, `restartGame` and
  `narratedStop` now check state first and answer that case as outcome `nothing`.
  The no-op deliberately runs with **`resources: []`** so it can pre-empt nothing — do
  not give it `POWER_RESOURCES` for symmetry.
- `powerOff` returns whether it actually stopped something and `powerOn` returns `[]`
  when nothing happened; both control routes gate the durable `Activity` row and the
  `GameState` write on that. A new caller that ignores it reintroduces "a log of things
  that did not happen".
- **`assertResourceFree()` / `fileLaneBusy()`** is how a sub-second writer joins the
  resource lanes without entering a record of its own (a record would double-toast).
  Seven config/settings routes use it; a new config writer should.
- **Pre-emption is global, so every confirm dialog must be.** `liveFileOperations()` +
  `namedFileOperations()` in `operation-ui.ts` are the one definition. `powerBlocker`
  stays per-world — that is the *disable* decision and it is correct.

## What is deliberately not fixed

- **A routine PZ restore or mod update shows an amber toast, not green**, because PZ's
  unavoidable SIGKILL is a genuine `warn`. The summaries are correct and the colour
  agrees with them. Making `concludeOperation` ignore that warn would trade a truthful
  amber for a comfortable lie.
- **Pre-emption cannot cancel work.** `refuseIfPreempted` declines to *publish* a torn
  archive and deletes it, so the confirm dialog's promise is true for backups, and a
  live pre-empted record now says so in the strip. But an in-flight `cp -r` or a
  166-mod install still runs to completion; the mod path has no artefact to delete, so
  its dialog's "some mods will be missing" remains a prediction.
- **No `Activity` row on any operation's failure path**, so the durable log still records
  only successes. Non-`ok` records are kept in memory for 6 hours, which covers a
  distracted admin but not a web-container restart.
- `/api/7dtd/world` still buffers up to 2 GB with `Buffer.from(await file.arrayBuffer())`,
  which blocks the event loop and is what stalls the heartbeat on a large upload. A
  pre-existing performance defect, not a notification one.

## Proven on production, 2026-09-29

Deployed and exercised against real containers, not inferred:

- **The cross-layer `globalThis` fix is proven for two of three layers.** A
  `backup.create` entered by a **route handler** appeared in `/api/operations` *and* in
  the server-rendered HTML of `/home` (the **server component** layer), so
  refresh-survival is real — confirmed three times on live operations with `curl`, no JS
  executed. **The third layer, `instrumentation.ts`, is still unproven**: there were 0
  stale Workshop mods all session, so `zomboid-updates.ts` returns `{action:"none"}`
  before reaching either of its `runOperation` sites. The timer was observed ticking
  eight times, so it is alive — the only missing ingredient is a genuinely stale mod.
  **This is the last unproven path and it is the one nobody clicks.**
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

**Measured, and worth knowing:** a PZ backup copies **442,064 files and takes ~11
minutes**, not the ~4m20s the route's own comment predicts. It is far past Cloudflare's
100 s origin timeout, so the browser request is dead long before the work finishes —
which is the whole argument for the persistent ledger. The world copy is also a single
opaque step for 10.5 of those minutes; file count *is* knowable here, so that row is the
least informative in the system and is the obvious next improvement.

## Also verified by rendering it, not by reading it

Driven locally against a real build with a fixture operation
(`next start`, a hand-minted session cookie — see the recipe in
"Local development"):

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

`npm test` → **199 tests, ~430 ms, no Docker, no network, no running server.** That last
constraint is the point: a suite that needs the box up is a suite nobody runs on a laptop,
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

`game-manager.ts` entirely — `powerOn` / `powerOff` / `restartGame` / `withGameStopped` /
`setMemory` / `applyServiceEnv`. Every one shells out to Docker. **The eviction logic and
the `wasRunning` gating are the highest-value untested code left**, and both have caused
real incidents. Testing them needs the Docker calls behind an injectable seam.

Also uncovered: the three backup routes' flush helpers (module-private, they call
`containerIsRunning`), which is why the honesty guarantee was moved into `summarize()`
instead — the sentence no longer depends on each route author choosing `done` over `noop`.

---

# Closing the last open items — 2026-09-30

`npm test` is now **549 tests, ~1.6 s**, still with no Docker, network or server.

## `game-manager.ts` is testable, and the seam is the point

Every `docker` fork now goes through `src/lib/docker-cli.ts`, which is injectable
(`setCommandRunner`, refused under `NODE_ENV=production`). That made the code the harness
author had named as the highest-value untested thing in the repo — **eviction ordering and
`wasRunning` gating** — pinnable. Both have caused real incidents.

`powerOn` deliberately **keeps its own eviction loop** rather than calling the shared
`admitStart`. Rewriting a path pinned by 34 tests to remove a two-line probe loop is the
churn that has broken this code before. Instead the two copies are asserted to **agree**
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
