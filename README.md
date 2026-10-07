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
# Use supported Node 22; this is the installation on the development machine.
export PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH"
npm ci

# Required before anything else runs. The Prisma client is generated into
# src/generated/prisma, which is gitignored — so a fresh clone has no `@/generated/prisma`
# and every command below fails with a module-not-found until you do this.
#
npx prisma generate

npm run dev        # http://localhost:3000
```

You need a `.env` — see **Local development** in [`CLAUDE.md`](CLAUDE.md) for the required
keys. Local OAuth needs a matching registered callback; the repository still needs a
documented authenticated development recipe.

```bash
npm test           # temp files/loopback fixtures; no Docker or external services needed
npx tsc --noEmit
npm run build
```

The Docker build generates Prisma itself and uses `node:22-alpine`. Builds also remove
forbidden host inputs from the standalone artifact and verify it; `npm run verify:artifact`
checks an existing artifact without changing it.

## Stack

Next.js 16 (App Router) · React 19 · Prisma 7 on libSQL/SQLite · NextAuth v5 (Discord) ·
Tailwind v4 with shadcn/base-ui and Catppuccin theming. Server control works by shelling out
to the Docker CLI against a mounted socket.

## Working on it

**Read [`CLAUDE.md`](CLAUDE.md) first.** It holds current architecture, operating rules,
setup and open work. Per-topic depth lives in [`docs/`](docs/). Historical reasoning and
superseded notes live in [`MEMORY-HISTORY.md`](docs/MEMORY-HISTORY.md); verified repairs
live in [`CLOSED.md`](docs/CLOSED.md).

If you are an AI coding agent, start at [`AGENTS.md`](AGENTS.md).

Keep the current docs accurate with every change, and move completed work and incident
history out of the main memory file.

Before deploying the ID-based invitation gate, review legacy name lists using
[`AUTHENTICATION.md`](docs/AUTHENTICATION.md). The deploy script refuses an unreadable or
name-based policy before replacing the dashboard. No production migration runs automatically.
