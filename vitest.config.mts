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
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // `src/**` is where the pure modules live; `tests/**` holds the suites.
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Fixtures are read with `readFile`, so no setup file and no globals.
    globals: false,
  },
});
