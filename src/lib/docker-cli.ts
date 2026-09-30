import { exec } from "child_process";
import { promisify } from "util";

/**
 * The runner every `docker` fork in `game-manager` goes through — and the seam that
 * makes that module testable.
 *
 * **Not the only place this app shells out.** The first draft of this comment said "the
 * one place this app shells out to the Docker CLI", which was false when it was written
 * and is falsified by 14 other files today (`grep -rl child_process src` — the backup
 * routes, `backup-create.ts`, `backup-store.ts`, `games/stats`, `7dtd/{reset,update,world}`,
 * `install-modpack`, `instrumentation.ts`, `operations.ts`, `zomboid-updates.ts`).
 * `/api/7dtd/update` still has its own `promisify(exec)`. The accurate scope is the
 * load-bearing part: a reader who believes the overclaim will not go looking for the
 * other fourteen.
 *
 * ## Why a seam and not `promisify(exec)` inline
 *
 * `game-manager.ts` is the highest-consequence module here (it is what evicts a
 * running world, recreates containers and holds the control lock) and it had **no
 * tests at all**, for exactly one reason: every function in it forked `docker`.
 * The properties worth pinning are not about Docker — they are about *ordering* and
 * *gating*:
 *
 *   - `powerOn` saves and stops every OTHER running world before starting the one
 *     asked for. When that ordering broke, this box ran two worlds and went 2 GB
 *     into swap.
 *   - `withGameStopped` captures `wasRunning` before stopping and gates both halves
 *     on it, so it can never start a world that was already stopped. Several audit
 *     findings claimed it did; all were refuted, and the property survived only as a
 *     comment.
 *   - `setMemory` / `applyServiceEnv` run `compose create`, never `compose up`, so a
 *     stopped world stays stopped instead of being booted into co-residency.
 *
 * Each of those is a statement about which commands run, in what order, under what
 * condition. Substituting the runner is enough to assert all of it, and it needs no
 * Docker, no network and no container — which is the bar `vitest.config.mts` sets.
 *
 * ## Why a module-level override rather than constructor injection
 *
 * `game-manager` exports ~25 functions used by ~20 routes. Threading a runner
 * through all of them would be a redesign of the call sites, and the call sites are
 * the part that is working. One swappable function keeps every caller byte-identical
 * and confines the change to this file.
 *
 * The override is refused when `NODE_ENV === "production"`, so the escape hatch
 * cannot be reached by the code that actually drives the box. That check is itself
 * tested — an untested guard is a comment.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Kill the child after this many ms. Used for `compose` and SteamCMD runs. */
  timeout?: number;
  /**
   * Bytes of stdout to buffer. Worth naming per call: `docker logs --tail NaN`
   * once dumped a 123 MB Project Zomboid log and the overrun was handed back to
   * the console pane as if the server had printed it.
   */
  maxBuffer?: number;
}

export type CommandRunner = (cmd: string, opts?: CommandOptions) => Promise<CommandResult>;

/**
 * The real thing: `/bin/sh -c <cmd>`, resolving with stdout/stderr and rejecting on
 * a non-zero exit. Commands are composed with pipes (`docker logs | awk`) and a
 * `cd` (`composeCmd`), so a shell is load-bearing here rather than incidental.
 */
const shellRunner: CommandRunner = promisify(exec) as unknown as CommandRunner;

let runner: CommandRunner = shellRunner;

/** Run a shell command. Every `docker` invocation in `game-manager` goes through here. */
export function runCommand(cmd: string, opts?: CommandOptions): Promise<CommandResult> {
  return runner(cmd, opts);
}

/**
 * Swap the runner. **Tests only** — refused under `NODE_ENV=production` so the
 * running server has no path to a fake Docker.
 */
export function setCommandRunner(next: CommandRunner): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setCommandRunner is a test seam and cannot be used in production");
  }
  runner = next;
}

/** Put the real runner back. Call from `afterEach`, or one test leaks into the next. */
export function resetCommandRunner(): void {
  runner = shellRunner;
}
