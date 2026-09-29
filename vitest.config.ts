import { defineConfig } from "vitest/config";
import path from "path";

/**
 * The first test harness this project has had.
 *
 * Two constraints are load-bearing and neither is arbitrary:
 *
 * - **vitest is pinned to major 3.** vitest 4 requires Node >= 20.19; the local
 *   toolchain here is Node 20.12, which is the same version that makes every
 *   `prisma` command die with `ERR_REQUIRE_ESM`. A vitest 4 bump would fail in
 *   exactly that confusing way.
 * - **`environment: "node"` and `src/**\/*.test.ts` only.** Tests cover pure
 *   functions. Importing a route module pulls in `next/server`, Prisma and the
 *   Docker CLI, so logic that needs a test gets extracted into `src/lib` and
 *   exported — that extraction is the point, not a workaround.
 */
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
