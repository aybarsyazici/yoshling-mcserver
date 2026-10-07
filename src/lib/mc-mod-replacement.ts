import { readFile, readdir } from "fs/promises";
import { modDirectoryPath, modFilePath } from "./mod-path";
import { checkIntegrity, digestsOf } from "./mod-admission";
import type { ModrinthFile } from "./modrinth";

/** Every loader-active jar participates in a pack switch, including untracked files. */
export async function activeModJars(modsDir: string, boundaryRoot: string): Promise<string[]> {
  const directory = await modDirectoryPath(modsDir, boundaryRoot);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const jars: string[] = [];
  for (const entry of entries) {
    if (!/\.jar$/i.test(entry.name)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Unsupported active mod entry: ${entry.name}`);
    await modFilePath(modsDir, entry.name, { boundaryRoot });
    jars.push(entry.name);
  }
  return jars.sort();
}

export interface ExpectedModJar {
  name: string;
  file: Pick<ModrinthFile, "filename" | "url" | "primary" | "size"> & {
    hashes?: { sha1?: string; sha512?: string };
  };
  /** Digest of the direct downloaded bytes; it is not a published registry hash. */
  sha512?: string;
}

export async function verifyModReplacement(modsDir: string, boundaryRoot: string, expected: ExpectedModJar[]): Promise<string[]> {
  const wanted = expected.map(item => item.file.filename).sort();
  let actual: string[];
  try { actual = await activeModJars(modsDir, boundaryRoot); }
  catch (e) { return [`The resulting mod directory could not be verified: ${(e as Error).message}`]; }
  const errors: string[] = [];
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`The resulting active jars differ from the requested set (wanted ${wanted.join(", ") || "none"}; found ${actual.join(", ") || "none"})`);
  }
  for (const item of expected) {
    try {
      const bytes = await readFile(await modFilePath(modsDir, item.file.filename, { boundaryRoot }));
      const digest = digestsOf(bytes);
      const check = checkIntegrity(item.file, digest);
      if (!check.ok || (item.sha512 && digest.sha512 !== item.sha512)) errors.push(`${item.name}: actual jar readback did not match its download`);
    } catch { errors.push(`${item.name}: actual jar readback failed`); }
  }
  return errors;
}
