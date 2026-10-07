# AGENTS.md — start here

**Read [CLAUDE.md](CLAUDE.md) before touching anything.** It is the current project memory and routes topic-specific work to the right docs. This file contains only agent rules; do not copy the architecture here.

## Working rules

- Treat production game data as live. Read the relevant game doc before changing its files, settings or lifecycle.
- Make success prove it succeeded: read back writes and compare. Distinguish refused, partial, unchanged and unverified outcomes.
- When adding a regression test, remove or break its protection and confirm the test fails. Restore the protection before final checks.
- Run the project checks before work and before delivery. Tests need no Docker, network or running server.

```bash
npm test
npx tsc --noEmit
npm run build
npm run lint
```

Use supported Node 22. On this machine, prefix commands with:
`PATH="$HOME/.local/share/mise/installs/node/22.18.0/bin:$PATH"`.
Generate Prisma after install/schema changes: `npx prisma generate`.
Lint is separate from build; record its current result rather than assuming it passed or classifying every failure as a warning.

- Never print `.env`, passwords, or whole container environments. `.env` is gitignored; preserve it and its backups.
- Use sanctioned lifecycle, operation and file guard helpers. Never hand-build replacement game containers or bypass admission with raw starts.
- Production migrations are manual. Back up first and verify schema/data afterward; follow the current migration instructions.
- Deploy with `scripts/deploy.sh` and a literal `--verify` from the actual change. PZ deployment requires dashboard power-off and preserves stopped state.
- Keep documentation current with each meaningful change. `CLAUDE.md` holds current instructions and open work only; move completed fixes and obsolete explanations to `docs/CLOSED.md` or `docs/MEMORY-HISTORY.md`.
- State verification limits plainly. A successful local test or build is not a production deployment, game join, or restore exercise.
