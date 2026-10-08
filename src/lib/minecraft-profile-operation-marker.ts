import { randomUUID } from "node:crypto";
import { chmod, chown, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { gameDataPath } from "@/lib/game-data-path";
import { resolveSafeFilePath } from "@/lib/file-guard";
import path from "node:path";
import type { OpHandle } from "@/lib/operations";

export type MinecraftProfileOperationMarkerKind = "prepare" | "switch" | "adopt" | "delete";
export function minecraftProfileOperationDirectory(): string {
  // Production must use the persistent web volume that deploy.sh inspects.
  return process.env.NODE_ENV === "production" ? "/app/data/minecraft-profile-operations"
    : process.env.MC_PROFILE_OPERATIONS_DIR || "/app/data/minecraft-profile-operations";
}

/**
 * Presence survives a lost web process; deployment must treat every leftover as
 * active or unverified. Only the operation that created a marker removes it.
 */
export async function withMinecraftProfileOperationMarker<T>(
  op: OpHandle,
  kind: MinecraftProfileOperationMarkerKind,
  work: () => Promise<T>
): Promise<T> {
  if (!["prepare", "switch", "adopt", "delete"].includes(kind) || op.preempted) {
    throw new Error("This profile operation cannot create a lifecycle marker");
  }
  const configured = path.resolve(minecraftProfileOperationDirectory());
  const parent = path.dirname(configured);
  const root = await resolveSafeFilePath(parent, path.basename(configured), { allowMissing: true, allowRoot: false, followFinalSymlink: false });
  if (!root) throw new Error("The private profile operation directory could not be admitted");
  const existing = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Profile operations require a separate private directory");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined && (rootInfo.uid !== uid || rootInfo.gid !== gid)) await chown(root, uid, gid);
  await chmod(root, 0o700);
  const name = `.operation-${kind}-${randomUUID()}.json`;
  const marker = await gameDataPath(root, name, { followFinalSymlink: false });
  const bytes = JSON.stringify({ formatVersion: 1, kind, operationId: op.id });
  let created: { ino: number; dev: number } | undefined;
  try {
    const file = await open(marker, "wx", 0o600);
    try {
      const info = await file.stat(); created = { ino: info.ino, dev: info.dev };
      await file.writeFile(bytes, "utf8");
      await file.sync();
      if (await readFile(marker, "utf8") !== bytes) throw new Error("The private Minecraft operation marker could not be verified");
    } finally { await file.close(); }
    if (op.preempted) throw new Error("The Minecraft profile operation was interrupted before lifecycle work");
    return await work();
  } finally {
    if (created) {
      try {
        const current = await gameDataPath(root, name, { followFinalSymlink: false });
        const info = await lstat(current);
        if (!info.isFile() || info.isSymbolicLink() || info.ino !== created.ino || info.dev !== created.dev || await readFile(current, "utf8") !== bytes) {
          throw new Error("The operation marker was replaced");
        }
        await unlink(current);
        const remaining = await lstat(current).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (remaining) throw new Error("The operation marker remains present");
      } catch {
        // The world may already be ready. A bookkeeping cleanup fault must not
        // stop it, and must not claim marker removal; deployment stays guarded.
        op.fact({ label: "Deployment guard", value: "the private profile operation marker could not be cleared; inspect staging before deploying", verdict: "warn" });
      }
    }
  }
}
