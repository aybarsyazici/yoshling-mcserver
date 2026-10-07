import { lstat, readdir } from "fs/promises";
import path from "path";

export type UploadTreeCheck =
  | { ok: true }
  | { ok: false; entry: string; kind: "symbolic link" | "special file" };

/**
 * Admit only directories and regular files from an extracted upload. ZIP member
 * names cannot tell us whether an ordinary-looking name is a link, and following
 * one during placement, ownership changes or later file reads crosses the upload's
 * boundary. Inspect the whole work tree before selecting or moving any of it.
 * Filesystem errors propagate: an unreadable tree has not passed admission.
 */
export async function checkUploadTree(rootDir: string): Promise<UploadTreeCheck> {
  const pending = [rootDir];
  while (pending.length) {
    const entry = pending.pop()!;
    const st = await lstat(entry);
    const relative = path.relative(rootDir, entry) || ".";
    if (st.isSymbolicLink()) return { ok: false, entry: relative, kind: "symbolic link" };
    if (st.isDirectory()) {
      for (const name of await readdir(entry)) pending.push(path.join(entry, name));
    } else if (!st.isFile()) {
      return { ok: false, entry: relative, kind: "special file" };
    }
  }
  return { ok: true };
}
