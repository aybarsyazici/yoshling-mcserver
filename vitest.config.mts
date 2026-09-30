import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Pure-logic tests only. Nothing here may touch Docker, the network or a running
 * server: a suite that needs the box to be up is a suite nobody runs on a laptop,
 * and the whole reason this exists is that every fix in this repo has so far been
 * verified by hand against production.
 *
 * **This file must stay `.mts`.** As `vitest.config.ts` it is loaded through
 * `vitest/dist/config.cjs`, which `require()`s Vite — and Vite is ESM-only, so on
 * Node 20.12 (this project's default `node`) every run dies with
 * `ERR_REQUIRE_ESM` before collecting a single test. That is the same trap
 * `CLAUDE.md` records for the Prisma CLI, and the fix here is cheaper: the `.mts`
 * extension makes vitest load the config as ESM, and the suite then runs on 20.12
 * and on 22 alike. `tsconfig.json` already includes .mts files.
 *
 * `resolve.alias` rather than `vite-tsconfig-paths` on purpose — one fewer
 * devDependency for one line of config, and it has to agree with the "@" path
 * mapping in `tsconfig.json`.
 *
 * **vitest stays pinned to major 3.** vitest 4 requires Node >= 20.19, and the
 * local toolchain here is 20.12 — the same version that makes every `prisma`
 * command die. A vitest 4 bump would fail in exactly that confusing way, and the
 * `.mts` trick above would no longer be what is saving you.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // `src/**` is where the pure modules live; `tests/**` holds the suites.
    // Both trees: `tests/**` holds the suites written for the harness, `src/**`
    // the co-located ones. Two configs briefly existed with mutually exclusive
    // globs and no textual conflict between them, so `npm test` reported green
    // while silently running 80 of 197 tests. One config, one glob, both trees.
    //
    // `.tsx` is in the glob as well, for the component suites. **It has to be spelled
    // out**: `*.test.ts` does not match `*.test.tsx`, so adding a React suite without
    // widening this collects zero of it and `npm test` still reports green — which is
    // the same silent-green failure the two-configs incident produced, in a form that
    // is even easier to miss because there is no second file to notice.
    include: ["tests/**/*.test.ts?(x)", "src/**/*.test.ts?(x)"],
    /**
     * `node` stays the DEFAULT, and the component suites opt in per file with
     * `// @vitest-environment jsdom`.
     *
     * Not a global switch: the pure-logic tests have no DOM in them, and making every
     * one of them construct a jsdom window is a cost paid by the suite whose entire
     * selling point is that it runs in well under a second on a laptop. Measured on Node
     * 20.12: `environment` 381-462 ms and a total of 1.3-1.5 s with the two `.tsx` files,
     * against `environment 2 ms` / 654 ms total for the node-only tests before they
     * existed. So the whole DOM cost is ~0.4 s and it is confined to the two files that
     * need it.
     *
     * Deliberately no test COUNT in that sentence. The first version said "281 tests",
     * which was already wrong by one when it was written and goes stale on every test
     * anyone adds -- a measurement that decays is the thing this project keeps getting
     * bitten by. The environment cost is the figure this comment exists to record.
     */
    environment: "node",
    // Fixtures are read with `readFile`, so no setup file and no globals.
    globals: false,
  },
});
