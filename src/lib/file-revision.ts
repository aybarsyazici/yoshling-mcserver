import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface Condition { file: string; match: string; conflict: boolean; initial?: string; published?: string }
interface Snapshot { file: string; revisions: Set<string> }
const shared = globalThis as unknown as {
  __yoshlingFileRevisions?: { key: Buffer; context: AsyncLocalStorage<Condition>; reads?: AsyncLocalStorage<Snapshot> };
};
const state = (shared.__yoshlingFileRevisions ??= { key: randomBytes(32), context: new AsyncLocalStorage<Condition>() });
const READ_CONTEXT = (state.reads ??= new AsyncLocalStorage<Snapshot>());

export class FileRevisionConflictError extends Error {
  constructor() { super("This file changed since you loaded it. Reload it before saving."); this.name = "FileRevisionConflictError"; }
}

function revisionBytes(file: string, bytes: Buffer | string | null): string {
  const hash = createHmac("sha256", state.key).update(path.resolve(file)).update("\0");
  if (bytes === null) hash.update("missing");
  else hash.update("present\0").update(bytes);
  return `"${hash.digest("hex")}"`;
}

/** Read and record the exact bytes subsequently parsed into an editable snapshot. */
export function readFileSnapshot(file: string): Promise<Buffer>;
export function readFileSnapshot(file: string, encoding: "utf-8" | "utf8"): Promise<string>;
export async function readFileSnapshot(file: string, encoding?: "utf-8" | "utf8"): Promise<Buffer | string> {
  const snapshot = READ_CONTEXT.getStore();
  const captured = (bytes: Buffer | null) => {
    if (snapshot && path.resolve(file) === path.resolve(snapshot.file)) snapshot.revisions.add(revisionBytes(file, bytes));
  };
  try {
    const bytes = await readFile(file);
    captured(bytes);
    return encoding ? bytes.toString(encoding) : bytes;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") captured(null);
    throw e;
  }
}

/** Random-key HMAC: revisions do not expose guessable hashes of hidden credentials. */
export async function fileRevision(file: string): Promise<string> {
  try { return revisionBytes(file, await readFile(file)); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return revisionBytes(file, null);
  }
}

function matches(condition: Condition, revision: string): boolean {
  if (condition.published) return condition.published === revision;
  // These are keyed edit tokens. A CDN's weak ETag prefix does not change the
  // token, and the custom header avoids compression/cache representation changes.
  return condition.match.split(",").map(value => value.trim().replace(/^W\//i, "")).includes(revision);
}

/** Recheck immediately before publication after potentially slow preparatory work. */
export async function assertFileRevision(file: string): Promise<void> {
  const condition = state.context.getStore();
  if (!condition || path.resolve(file) !== path.resolve(condition.file)) return;
  const revision = await fileRevision(file);
  if (!matches(condition, revision)) {
    condition.conflict = true;
    throw new FileRevisionConflictError();
  }
  condition.initial ??= revision;
}

/** The success ETag describes our published bytes, never a later unrelated rewrite. */
export function recordFileRevision(file: string, bytes: Buffer | string | null): void {
  const condition = state.context.getStore();
  if (condition && path.resolve(file) === path.resolve(condition.file)) condition.published = revisionBytes(file, bytes);
}

export async function withFileRevision<T extends Response>(request: Pick<Request, "headers">, file: () => Promise<string>, work: () => Promise<T>): Promise<T> {
  const match = request.headers?.get("X-Expected-File-Revision") || request.headers?.get("If-Match");
  if (!match) return work();
  const target = await file();
  const condition: Condition = { file: target, match, conflict: false };
  return state.context.run(condition, async () => {
    await assertFileRevision(target);
    const response = await work();
    if (condition.conflict) throw new FileRevisionConflictError();
    if (response.ok) {
      const revision = condition.published ?? condition.initial!;
      response.headers.set("ETag", revision);
      response.headers.set("X-File-Revision", revision);
    }
    return response;
  });
}

/** Attach the parsed bytes' revision only when they match the terminal source/identity. */
export async function withRevisionRead<T extends Response>(file: () => Promise<string>, work: () => Promise<T>): Promise<T> {
  const target = await file();
  const snapshot: Snapshot = { file: target, revisions: new Set() };
  const response = await READ_CONTEXT.run(snapshot, work);
  if (response.ok) {
    if (snapshot.revisions.size === 0) throw new Error("The editable file snapshot could not be verified");
    const terminal = await fileRevision(target);
    if (path.resolve(await file()) !== path.resolve(target) || [...snapshot.revisions].some(revision => revision !== terminal)) throw new FileRevisionConflictError();
    response.headers.set("ETag", terminal);
    response.headers.set("X-File-Revision", terminal);
  }
  return response;
}
