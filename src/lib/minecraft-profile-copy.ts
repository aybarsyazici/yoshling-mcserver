import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, readdir, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { resolveSafeFilePath } from "@/lib/file-guard";
import type { OpHandle } from "@/lib/operations";

export interface MinecraftTreeEntry {
  path: string;
  kind: "directory" | "file";
  mode: number;
  uid: number;
  gid: number;
  bytes: number;
  sha256: string | null;
}

const DISK_RESERVE = 1024 ** 3;
const MAX_ENTRIES = 250_000;

async function admitted(root: string, file: string, allowMissing = false): Promise<string> {
  const canonical = await resolveSafeFilePath(root, "", { allowRoot: true });
  if (!canonical) throw new Error("The Minecraft storage boundary could not be resolved");
  const lexical = path.relative(path.resolve(root), path.resolve(file));
  const relative = lexical === "" || (!lexical.startsWith(`..${path.sep}`) && lexical !== ".." && !path.isAbsolute(lexical))
    ? lexical : path.relative(canonical, file);
  const safe = await resolveSafeFilePath(canonical, relative, { allowMissing, allowRoot: true });
  if (!safe) throw new Error("A Minecraft profile file escaped its configured volume");
  return safe;
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertActive(op?: OpHandle): void {
  if (op?.preempted) throw new Error("The Minecraft profile copy was interrupted; the copied files are unverified");
}

async function sourceFile(root: string, file: string, excluded: ReadonlySet<string>): Promise<string> {
  const safe = await resolveSafeFilePath(root, path.relative(root, file), { allowRoot: true });
  if (!safe || excluded.has(path.relative(root, safe).split(path.sep)[0])) {
    throw new Error("A Minecraft source link escaped its server tree or entered excluded profile storage");
  }
  return safe;
}

/** Full inventory, including empty directories. Contained regular-file aliases are materialized. */
export async function inventoryMinecraftTree(
  source: string,
  boundaryRoot: string,
  options: { excludeTopLevel?: readonly string[]; op?: OpHandle; hash?: boolean } = {}
): Promise<MinecraftTreeEntry[]> {
  const entries: MinecraftTreeEntry[] = [];
  const excluded = new Set(options.excludeTopLevel ?? []);
  const root = await admitted(boundaryRoot, source);
  async function walk(file: string, relative: string): Promise<void> {
    assertActive(options.op);
    let info = await lstat(file);
    const safe = await sourceFile(root, file, excluded);
    if (info.isSymbolicLink()) {
      info = await stat(safe);
      if (!info.isFile()) throw new Error(`Cannot preserve ${relative}: profile copies refuse directory links and special files`);
    }
    if (!info.isDirectory() && !info.isFile()) {
      throw new Error(`Cannot preserve ${relative || "the server root"}: profile copies refuse special files`);
    }
    if (entries.length >= MAX_ENTRIES) throw new Error("The Minecraft server exceeds the 250,000-entry profile copy limit");
    entries.push({ path: relative, kind: info.isDirectory() ? "directory" : "file", mode: info.mode & 0o777, uid: info.uid, gid: info.gid,
      bytes: info.isFile() ? info.size : 0, sha256: info.isFile() && options.hash !== false ? await digest(safe) : null });
    if (!info.isDirectory()) return;
    const children = (await readdir(safe)).sort((a, b) => a.localeCompare(b));
    for (const name of children) {
      if (relative === "" && excluded.has(name)) continue;
      await walk(path.join(safe, name), relative ? `${relative}/${name}` : name);
    }
  }
  await walk(root, "");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function requireMinecraftCopySpace(root: string, bytes: number): Promise<void> {
  const space = await statfs(root);
  const available = space.bavail * space.bsize;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(available) || available < bytes + DISK_RESERVE) {
    throw new Error("Not enough free space to preserve this Minecraft server and leave 1 GiB available");
  }
}

/** A copy earns publication only after destination and stopped source match the initial hashes. */
export async function copyVerifiedMinecraftTree(
  source: string,
  destination: string,
  boundaryRoot: string,
  options: { excludeTopLevel?: readonly string[]; op?: OpHandle } = {}
): Promise<{ files: number; bytes: number; entries: MinecraftTreeEntry[] }> {
  const original = await inventoryMinecraftTree(source, boundaryRoot, options);
  const files = original.filter(entry => entry.kind === "file");
  const bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  await requireMinecraftCopySpace(boundaryRoot, bytes);
  const target = await admitted(boundaryRoot, destination, true);
  const sourceRoot = await admitted(boundaryRoot, source);
  const insideSource = path.relative(sourceRoot, target);
  if (insideSource === "" || (!insideSource.startsWith(`..${path.sep}`) && insideSource !== ".." && !path.isAbsolute(insideSource) &&
      !(options.excludeTopLevel ?? []).includes(insideSource.split(path.sep)[0]))) {
    throw new Error("A Minecraft profile copy cannot be created inside the tree being preserved");
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await readdir(target)).length) throw new Error("Refusing to overwrite an existing Minecraft profile copy");
  let done = 0;
  for (const directory of original.filter(entry => entry.kind === "directory").sort((a, b) => a.path.length - b.path.length)) {
    assertActive(options.op);
    const file = await admitted(boundaryRoot, path.join(target, directory.path), true);
    await mkdir(file, { recursive: true, mode: directory.mode });
    const owner = await lstat(file);
    if (owner.uid !== directory.uid || owner.gid !== directory.gid) await chown(file, directory.uid, directory.gid);
    await chmod(file, directory.mode);
  }
  for (const entry of files) {
    assertActive(options.op);
    const from = await sourceFile(sourceRoot, path.join(sourceRoot, entry.path), new Set(options.excludeTopLevel ?? []));
    const to = await admitted(boundaryRoot, path.join(target, entry.path), true);
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const owner = await lstat(to);
    if (owner.uid !== entry.uid || owner.gid !== entry.gid) await chown(to, entry.uid, entry.gid);
    await chmod(to, entry.mode);
    done++;
    if (done % 100 === 0 || done === files.length) {
      options.op?.progress({ kind: "count", done, total: files.length, noun: "files" });
      options.op?.detail(entry.path);
      await requireMinecraftCopySpace(boundaryRoot, 0);
    }
  }
  assertActive(options.op);
  const copied = await inventoryMinecraftTree(target, boundaryRoot, { op: options.op });
  const sourceAfter = await inventoryMinecraftTree(source, boundaryRoot, options);
  if (JSON.stringify(copied) !== JSON.stringify(original) || JSON.stringify(sourceAfter) !== JSON.stringify(original)) {
    throw new Error("The complete Minecraft profile copy did not match its source; it was not published");
  }
  return { files: files.length, bytes, entries: copied };
}
