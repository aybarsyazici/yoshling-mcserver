import { readFile, writeFile, mkdir, rename, rm, lstat, realpath, stat } from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { discordIdList, discordUserId } from "./discord-identity";
import { assertFileWriteActive } from "./operations";
import { assertFileRevision, readFileSnapshot, recordFileRevision } from "./file-revision";

/**
 * Who is allowed to sign in at all — the single source of truth for both the
 * Whitelist page and the sign-in gate in `auth.ts`.
 *
 * The file wins over an operator ID seed. Only genuine absence can use the
 * seed; unreadable, invalid or broken policy refuses access.
 *
 * This is about *sign-in*, not about which worlds someone can see — that's
 * `User.games`, granted on the Crew page.
 */
export const WHITELIST_FILE = process.env.WHITELIST_FILE || "/app/data/whitelist.json";

function fromEnv(): string[] {
  return (process.env.ALLOWED_DISCORD_IDS ?? process.env.ALLOWED_DISCORD_USERS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

/** A broken configured link is unknown policy, not a fresh missing file. */
async function policyIsAbsent(): Promise<boolean> {
  const file = path.resolve(WHITELIST_FILE);
  let ancestor = file;
  for (;;) {
    try {
      await lstat(ancestor);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
      continue;
    }
    if (ancestor === file) return false;
    try {
      await realpath(ancestor);
      return (await stat(ancestor)).isDirectory();
    } catch { return false; }
  }
}

export type WhitelistRead = {
  users: string[];
  /** Where ID strings came from — the file, or an operator env seed. */
  source: "file" | "env";
  /**
   * Unknown policy must refuse sign-in and editing. It is never an empty list
   * or permission to substitute the broader fresh-install seed.
   */
  error?: string;
};

/**
 * Read the list, and say where it came from: "loaded, and it's empty" and
 * "couldn't load it" are different answers, and every caller here has to treat
 * them differently. Returning a bare `string[]` for both is what let a failed
 * read pass for an empty whitelist.
 */
export async function readWhitelist(): Promise<WhitelistRead> {
  let raw: string;
  try {
    raw = await readFileSnapshot(WHITELIST_FILE, "utf-8");
  } catch (e) {
    // No file at all is the normal state of a fresh install, not a failure:
    // nothing has been saved yet, so the env var is the list.
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && await policyIsAbsent()) {
      const seed = discordIdList(fromEnv());
      return seed ? { users: seed, source: "env" } : {
        users: [], source: "env", error: "The sign-in seed must contain Discord user ID strings. Convert legacy names before deploying.",
      };
    }
    return {
      users: [], source: "file", error: "The sign-in whitelist could not be read.",
    };
  }

  try {
    const users = discordIdList(JSON.parse(raw));
    if (!users) throw new Error("invalid IDs");
    return { users, source: "file" };
  } catch {
    // Do not echo parser snippets: an incorrectly configured path may contain secrets.
    return {
      users: [], source: "file", error: "The sign-in whitelist must be a JSON array of Discord user ID strings. Convert legacy names before deploying.",
    };
  }
}

export async function saveWhitelist(users: string[]): Promise<void> {
  const ids = discordIdList(users);
  if (!ids) throw new Error("Every whitelist entry must be a Discord user ID string");
  await mkdir(path.dirname(WHITELIST_FILE), { recursive: true });
  const text = JSON.stringify(ids, null, 2);
  const temporary = path.join(path.dirname(WHITELIST_FILE), `.whitelist-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: "utf-8", mode: 0o600 });
    await assertFileRevision(WHITELIST_FILE);
    assertFileWriteActive();
    await rename(temporary, WHITELIST_FILE);
    if (await readFile(WHITELIST_FILE, "utf-8") !== text) {
      throw new Error("The whitelist write could not be verified; reload it before trying again");
    }
    recordFileRevision(WHITELIST_FILE, text);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Sign-in authority is the immutable Discord ID; names are display labels.
 *
 * **An empty list fails open** — anyone with a Discord account may sign in. That
 * is the behaviour this has always had and it stays, on purpose: a fresh install
 * has no file and may have no env var, and the *first* account to sign in is the
 * one that becomes ADMIN (see `auth.ts`), so failing closed would mean nobody can
 * ever get in without a shell on the box. The blast radius is small — a new
 * account arrives as MEMBER with no worlds and sees nothing until an admin grants
 * one — and it can now only be reached deliberately, because `/api/whitelist`
 * refuses to clear a populated list without an explicit confirmation.
 *
 * Unknown policy is never empty and never permission to use a broader seed.
 */
export async function isWhitelisted(value: unknown): Promise<boolean> {
  const id = discordUserId(value);
  if (!id) return false;
  const { users, error } = await readWhitelist();
  if (error) {
    console.error(`[whitelist] ${error}`);
    return false;
  }

  if (users.length === 0) {
    console.warn("[whitelist] the list is empty — anyone with a Discord account can sign in");
    return true;
  }

  return users.includes(id);
}
