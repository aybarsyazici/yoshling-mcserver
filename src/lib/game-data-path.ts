import { resolveSafeFilePath } from "@/lib/file-guard";

/** Admit configured game files before I/O, including parents of first-install files. */
export async function gameDataPath(
  root: string,
  relativePath: string,
  options: { allowRoot?: boolean; followFinalSymlink?: boolean } = {}
): Promise<string> {
  const file = await resolveSafeFilePath(root, relativePath, { allowMissing: true, ...options });
  if (!file) throw new Error("Refusing a path outside the configured game volume");
  return file;
}
