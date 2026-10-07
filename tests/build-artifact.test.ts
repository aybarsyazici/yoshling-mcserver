import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeStandalone, verifyBuildArtifact } from "../scripts/verify-build-artifact.mjs";

const roots: string[] = [];

async function file(root: string, relative: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "fabricated fixture content");
}

async function artifact() {
  const root = await mkdtemp(path.join(tmpdir(), "yoshling-artifact-"));
  roots.push(root);
  await file(root, "server.js");
  await file(root, ".next/BUILD_ID");
  await mkdir(path.join(root, ".next/server"), { recursive: true });
  await file(root, "node_modules/next/package.json");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deployment artifact boundary", () => {
  it("accepts the required runtime structure", async () => {
    const root = await artifact();
    await file(root, "node_modules/@prisma/client/runtime/query_compiler_fast_bg.sqlite.mjs");
    await expect(verifyBuildArtifact(root)).resolves.toBeUndefined();
  });

  it.each([
    ".env", ".env.production", "nested/.env.backup", "dev.db", "data/save.db-wal",
    "nested/save.db.bak", "nested/save.sqlite", "nested/save.sqlite3-shm",
    ".git/config", "nested/.claude/worktrees/old/source.ts", ".codex/config.toml",
    ".worktrees/old/source.ts", "nested/private.pem", "nested/private.key",
  ])("refuses %s anywhere in the artifact", async (relative) => {
    const root = await artifact();
    await file(root, relative);
    await expect(verifyBuildArtifact(root)).rejects.toThrow("Forbidden files");
  });

  it("refuses an empty output", async () => {
    const root = await artifact();
    await rm(path.join(root, "server.js"));
    await expect(verifyBuildArtifact(root)).rejects.toThrow();
  });

  it("refuses a link outside the artifact", async () => {
    const root = await artifact();
    const outside = await artifact();
    await symlink(path.join(outside, "server.js"), path.join(root, "linked.js"));
    await expect(verifyBuildArtifact(root)).rejects.toThrow("link leaves artifact");
  });

  it("allows an internal package link", async () => {
    const root = await artifact();
    await symlink("server.js", path.join(root, "linked.js"));
    await expect(verifyBuildArtifact(root)).resolves.toBeUndefined();
  });

  it("removes traced host inputs and preserves package runtime assets", async () => {
    const root = await artifact();
    await file(root, ".env");
    await file(root, ".env.production");
    await file(root, "nested/private.pem");
    await file(root, "dev.db");
    await file(root, "node_modules/@prisma/client/runtime/query_compiler_fast_bg.sqlite.mjs");
    await sanitizeStandalone(root);
    await expect(verifyBuildArtifact(root)).resolves.toBeUndefined();
    // Package assets are never silently pruned. The final recursive guard still
    // refuses a secret if a dependency unexpectedly introduces one.
    await file(root, "node_modules/package/.env");
    await sanitizeStandalone(root);
    await expect(verifyBuildArtifact(root)).rejects.toThrow("Forbidden files");
  });
});
