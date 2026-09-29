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
- **`.op-warn` / `.op-bad` exist because `text-chart-5` measures 2.15:1 in Latte.** They
  mix the tone toward `--foreground`, which clears AA in Latte and is automatically
  right in Mocha. Use them for any outcome stated as text.
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

## What is deliberately not fixed

- **A routine PZ restore or mod update shows an amber toast, not green**, because PZ's
  unavoidable SIGKILL is a genuine `warn`. The summaries are correct and the colour
  agrees with them. Making `concludeOperation` ignore that warn would trade a truthful
  amber for a comfortable lie.
- **Pre-emption cannot cancel work.** `refuseIfPreempted` declines to *publish* a torn
  archive and deletes it, so the confirm dialog's promise is true for backups. An
  in-flight `cp -r` or a 166-mod install still runs to completion; the mod path has no
  artefact to delete, so its dialog's "some mods will be missing" remains a prediction.
- **No `Activity` row on any operation's failure path**, so the durable log still records
  only successes. Non-`ok` records are kept in memory for 6 hours, which covers a
  distracted admin but not a web-container restart.
- `/api/7dtd/world` still buffers up to 2 GB with `Buffer.from(await file.arrayBuffer())`,
  which blocks the event loop and is what stalls the heartbeat on a large upload. A
  pre-existing performance defect, not a notification one.

## Verified by rendering it, not by reading it

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
