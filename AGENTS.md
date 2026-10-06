# AGENTS.md — start here

**The project's instructions live in [`CLAUDE.md`](CLAUDE.md). Read it before touching
anything.** This file exists because not every agent harness reads `CLAUDE.md` automatically;
it is a pointer plus the few things that are specifically about *being an agent in this repo*.

**Do not copy `CLAUDE.md`'s content into here.** Two files describing the same architecture is
how one of them goes stale, and this project has already paid for that twice — see the
Documentation rules at the top of `CLAUDE.md`.

## What this is

A Next.js dashboard that controls three game servers — Minecraft, 7 Days to Die, Project
Zomboid — running in Docker on one 16 GB netcup box, behind Discord OAuth. **Only one world
runs at a time**; powering one on gracefully saves and stops whichever other one is up. Access
is per world: a user only sees the servers an admin has granted them.

It is in real use. Project Zomboid is played on daily by about five people and has 89 mods and
real save data. **Treat production as live, because it is.**

## The one rule that matters most here

> **This project's recurring defect is "reports success after doing nothing, or the wrong
> thing"** — not crashes. A route that writes nothing and returns `{success: true}`. A backup
> that archives the wrong directory and calls itself a rollback point. A deploy check that
> could not fail. A parser that read 1 of 58 rules and answered HTTP 200.

So: **make the success path prove it succeeded.** Read back what you wrote and compare, the way
the memory card shows the configured value next to the live one. If you cannot prove it, say
what you did not check rather than implying you did.

The corollary, which has caught real bugs here repeatedly: **when you add a test, break the
thing it tests and confirm the test goes red.** Several guarantees in this repo shipped with
tests that passed either way — a sort test that was vacuous on APFS, a guard test that passed
under `if (false && refusal)`, eleven undefended guarantees in one file.

## Before you start

```bash
npm test          # vitest. Must stay green. ~12 s, no Docker, no network, no server needed
npx tsc --noEmit  # must stay clean
npm run build     # the deploy build
npm run lint      # not run during build; pre-existing `any` warnings exist
```

`npx prisma …` needs Node ≥ 20.19 — on the default Node here every prisma command dies with
`ERR_REQUIRE_ESM`. Prefix it:
`PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH" npx prisma generate`.

`.env` is gitignored and holds every production secret. There is nothing to restore it from.

## Things that will bite you

Each of these cost real debugging time. They are documented at length in `CLAUDE.md` and the
per-game docs; this is the short list so you know what to go and read.

- **A container's env, ports and mounts are fixed when it is created.** `docker restart` can
  never apply a new memory value or image version — only a recreate can. Use
  `applyServiceEnv` / `setMemory`; never hand-build `docker run`.
- **An RCON reply over 4096 bytes does not fit one packet**, and the cached transport drops the
  rest. Anything that *enumerates* must use `rconCommandLong`. This silently cut one settings
  page from 137 values to 79, with no error.
- **Minecraft's RCON concatenates replies with no separator.** `help gamerule` is 5 KB with
  *zero* newlines; `banlist` runs one entry's reason straight into the next entry's name. Do
  not assume a reply is line-oriented — there are committed fixtures of both.
- **Production migrations are applied BY HAND.** Nothing runs on boot. Back the DB up first.
  `CLAUDE.md` has the exact form and a worked example.
- **`ufw` does not cover published container ports** — Docker's DNAT bypasses `INPUT`
  entirely, so every `ports:` entry is world-reachable. Rules go in `DOCKER-USER`.
- **Project Zomboid is stopped by asking the game to `quit` over RCON**, not by `docker stop` —
  the kernel discards uncaught signals sent to a namespace's PID 1. Read
  `docs/PROJECT-ZOMBOID.md` before touching it; that file was wrong about this twice.

## Deploying

`scripts/deploy.sh [--service web|zomboid] [--verify STR]`. Use it rather than hand-rolling —
it ships a git bundle (the box has no GitHub key), rebuilds, and then checks your change is in
the **built image** rather than merely at git HEAD. Pass `--verify` with a string from your
actual change; a correct checkout can sit in front of a stale container and `git rev-parse`
looks identical either way.

Pushing to GitHub from this checkout needs a repo-scoped `core.sshCommand` that is already
configured. If a fresh clone cannot push, that is why.

## Where to read next

`CLAUDE.md`'s deep-docs table routes by what you are working on. The ones worth knowing exist:

| | |
|---|---|
| `docs/OPERATIONS.md` | anything that takes more than ~10 s, and the operation ledger |
| `docs/CLOSED.md` | **check before reporting a defect** — every closed item with the measurement that closed it. Nothing in it is a to-do |
| `docs/MINECRAFT.md` | mods, modpacks, game rules, bans, the offline-UUID trap |
| `docs/PROJECT-ZOMBOID.md` | the live world. Read before touching PZ |
| `docs/7-DAYS-TO-DIE.md` | telnet, the config wipe, builds |
| `docs/SETTINGS.md` | configured-vs-live, and the write discipline every settings route obeys |

## Keeping the docs true is part of the job

`CLAUDE.md`'s first line says the docs are the only thing that survives a lost conversation,
and that is not rhetorical — a chat that built the Minecraft side was deleted and the work had
to be reconstructed from scratch.

Two habits this repo has learned the hard way:

- **A comment or doc line asserting behaviour you have not verified is worse than no comment.**
  One false comment ("the entrypoint traps SIGTERM") hid a five-minute restart through four
  audits. If you cannot check a claim, do not write it.
- **When you find something here that is wrong, fix the doc rather than working around it** —
  and if the wrong version was plausible enough to have been written down, record it as wrong
  rather than quietly deleting it. Several docs keep a **Corrections** section for exactly
  this, and they are some of the most useful prose in the repo.
