import path from "node:path";
import { realpath } from "node:fs/promises";
import { gameDataPath } from "./game-data-path";
import { resolveSafeFilePath } from "./file-guard";

/** The lexical parent comes from getModsDir's configured Minecraft data root. */
function boundaryFor(modsDir: string, boundaryRoot?: string): string {
  return boundaryRoot ?? (process.env.MC_SERVER_DIR || path.dirname(path.resolve(modsDir)));
}

/** A derived mods shortcut is not an independently trusted filesystem root. */
export async function modDirectoryPath(modsDir: string, boundaryRoot?: string): Promise<string> {
  const root = boundaryFor(modsDir, boundaryRoot);
  const canonicalRoot = await realpath(root);
  const absolute = path.resolve(modsDir);
  // Canonicalize the parent, keeping the final directory link subject to admission.
  // Both configured roots and derived data paths may use macOS /var aliases.
  const anchored = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  return gameDataPath(canonicalRoot, path.relative(canonicalRoot, anchored));
}

/** Admit ordinary/new jar paths and contained links before reads or mutations. */
export async function modFilePath(modsDir: string, fileName: string, options: {
  boundaryRoot?: string;
  followFinalSymlink?: boolean;
} = {}): Promise<string> {
  if (typeof fileName !== "string" || !fileName || path.basename(fileName) !== fileName || fileName.includes("\\")) {
    throw new Error("Refusing an invalid mod filename");
  }
  const root = boundaryFor(modsDir, options.boundaryRoot);
  const directory = await modDirectoryPath(modsDir, root);
  let file: string | null;
  try {
    file = await resolveSafeFilePath(directory, fileName, {
      boundaryRoot: root, allowMissing: true, allowRoot: false,
      followFinalSymlink: options.followFinalSymlink,
    });
  } catch (error) {
    // The game volume and existing parent tree were admitted above. A mods
    // directory that has not been created yet is a safe missing suffix.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.join(directory, fileName);
    throw error;
  }
  if (!file) throw new Error("Refusing a mod path outside its configured directory");
  return file;
}
