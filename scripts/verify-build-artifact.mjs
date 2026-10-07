import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenName = (name) =>
  name.startsWith(".env") ||
  [".git", ".claude", ".codex", ".worktrees"].includes(name) ||
  /\.(?:db|sqlite3?)(?:-(?:wal|shm|journal)|\.(?:bak|backup)(?:[.-].*)?)?$/i.test(name) ||
  /\.(?:pem|key)$/i.test(name);

// Next copies loaded env files explicitly and instrumentation's trace does not
// honor route tracing exclusions. Remove host inputs from local standalone output
// too; Docker's allowlisted context prevents them entering a build layer at all.
export async function sanitizeStandalone(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (forbiddenName(entry.name)) {
        await rm(fullPath, { force: true, recursive: entry.isDirectory() });
      } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".next") {
        await visit(fullPath);
      }
    }
  }
  await visit(root);
}

export async function verifyBuildArtifact(root) {
  const base = await realpath(root);
  const violations = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(base, fullPath);
      if (forbiddenName(entry.name)) {
        violations.push(relative);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await realpath(fullPath);
        const targetRelative = path.relative(base, target);
        if (targetRelative.startsWith(`..${path.sep}`) || targetRelative === ".." || path.isAbsolute(targetRelative)) {
          violations.push(`${relative} (link leaves artifact)`);
        }
      } else if (entry.isDirectory()) {
        await visit(fullPath);
      }
    }
  }

  await visit(base);
  if (violations.length) {
    throw new Error(`Forbidden files in build artifact:\n${violations.sort().join("\n")}`);
  }

  // An empty/missing output is not a successful verification.
  for (const required of ["server.js", ".next/BUILD_ID", ".next/server", "node_modules/next/package.json"]) {
    await lstat(path.join(base, required));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sanitize = args[0] === "--sanitize-standalone";
  if (sanitize) args.shift();
  const root = args[0] || ".next/standalone";
  try {
    if (sanitize) await sanitizeStandalone(root);
    await verifyBuildArtifact(root);
    console.log("Build artifact verified: no forbidden env, database, key or checkout files.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
