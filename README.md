# Yoshling

A web dashboard for running three game servers — **Minecraft**, **7 Days to Die** and
**Project Zomboid** — on one box, from a Discord login.

One box, three worlds. Only one game runs at a time (16 GB of RAM between them), so powering
one on gracefully saves and stops whichever other one is up. Access is per world: you only see
the servers an admin has granted you.

Live at **https://yoshling.xyz**.

## What it does

- **Power** — start, stop and restart each world, with a hand-off confirmation when starting
  one means stopping another, and a progress ledger that names the step it is on.
- **Backups** — create, restore, download, prune. Checksums and a manifest per archive.
- **Mods** — search Modrinth and install to the server; Workshop mods for Project Zomboid,
  with a watcher that applies updates by itself when nobody is connected.
- **Settings** — every server's config, showing what you configured next to **what the game
  says it is actually running**.
- **Console, live logs, a file browser, RAM allocation**, per-world player counts and graphs.
- **Crew** — roles and per-world access, so a moderator can run one world and never see the
  others.

## Running it locally

```bash
npm install

# Required before anything else runs. The Prisma client is generated into
# src/generated/prisma, which is gitignored — so a fresh clone has no `@/generated/prisma`
# and every command below fails with a module-not-found until you do this.
#
# It also needs Node >= 20.19: on older Node every `prisma` command dies with
# ERR_REQUIRE_ESM, because prisma@7 require()s an ESM-only dependency. There is
# deliberately no `postinstall` doing it for you, since on the wrong Node that would make
# `npm install` itself fail.
PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH" npx prisma generate

npm run dev        # http://localhost:3000
```

You need a `.env` — see **Local development** in [`CLAUDE.md`](CLAUDE.md) for the required
keys. Discord OAuth cannot complete against `localhost`, so viewing the signed-in UI locally
needs a hand-minted session cookie; that is written up in the same place.

```bash
npm test           # vitest — ~1500 tests, no Docker, no network, no server needed
npx tsc --noEmit
npm run build
```

(The Docker build does the generate itself — `Dockerfile:12` — and `node:20-alpine` is new
enough, which is why this trap only bites locally.)

## Stack

Next.js 16 (App Router) · React 19 · Prisma 7 on libSQL/SQLite · NextAuth v5 (Discord) ·
Tailwind v4 with shadcn/base-ui and Catppuccin theming. Server control works by shelling out
to the Docker CLI against a mounted socket.

## Working on it

**Read [`CLAUDE.md`](CLAUDE.md) first — it is the project's memory**, not a summary. It carries
the architecture, the deployment runbook, and a long list of traps that each cost real
debugging time. Per-topic depth lives in [`docs/`](docs/), routed by a table at the top of
`CLAUDE.md`.

If you are an AI coding agent, start at [`AGENTS.md`](AGENTS.md).

Keeping those files true is part of changing the code here. The reason is written into the
first line of `CLAUDE.md`: a previous conversation that built the Minecraft side was deleted,
and the work had to be reconstructed from scratch.
