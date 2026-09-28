import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

/**
 * Who is allowed to sign in at all — the single source of truth for both the
 * Whitelist page and the sign-in gate in `auth.ts`.
 *
 * These used to be two disconnected stores: the page wrote this file while
 * `signIn` only ever read `ALLOWED_DISCORD_USERS`, so adding someone in the UI
 * silently did nothing and they were refused at the Discord callback. The file
 * now wins, and the env var is only the seed for a fresh install.
 *
 * This is about *sign-in*, not about which worlds someone can see — that's
 * `User.games`, granted on the Crew page.
 */
const WHITELIST_FILE = process.env.WHITELIST_FILE || "/app/data/whitelist.json";

function fromEnv(): string[] {
  return (process.env.ALLOWED_DISCORD_USERS || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

export type WhitelistRead = {
  users: string[];
  /** Where `users` came from — the file, or the `ALLOWED_DISCORD_USERS` seed. */
  source: "file" | "env";
  /**
   * Set when the file exists but couldn't be read or parsed, so `users` is the
   * env seed standing in for a list we don't actually know. The sign-in gate can
   * live with the stand-in; the Whitelist page must not, because it PUTs back
   * whatever it was shown and would overwrite the real file with it.
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
    raw = await readFile(WHITELIST_FILE, "utf-8");
  } catch (e) {
    // No file at all is the normal state of a fresh install, not a failure:
    // nothing has been saved yet, so the env var is the list.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { users: fromEnv(), source: "env" };
    return {
      users: fromEnv(),
      source: "env",
      error: `couldn't read ${WHITELIST_FILE}: ${(e as Error).message}`,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
    return { users: parsed.map((u) => String(u).trim()).filter(Boolean), source: "file" };
  } catch (e) {
    // A hand-mangled file shouldn't lock everyone out — fall back to the env
    // seed, but flag it, because that seed is a guess and not the list.
    return {
      users: fromEnv(),
      source: "env",
      error: `${WHITELIST_FILE} isn't a usable whitelist (${(e as Error).message})`,
    };
  }
}

export async function saveWhitelist(users: string[]): Promise<void> {
  await mkdir(path.dirname(WHITELIST_FILE), { recursive: true });
  await writeFile(WHITELIST_FILE, JSON.stringify(users, null, 2), "utf-8");
}

/**
 * Discord hands us a `username` (the @handle) and often a `global_name` (the
 * display name). People whitelist whichever one they see, so match either.
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
 * What is emphatically *not* fail-open is "we couldn't read the list". Unknown is
 * not empty: if the file exists but can't be parsed and the env seed is empty
 * too, nobody gets in, loudly. Otherwise one unreadable file would quietly turn
 * an invite-only dashboard into a public one.
 */
export async function isWhitelisted(names: (string | null | undefined)[]): Promise<boolean> {
  const { users, error } = await readWhitelist();
  if (error) console.error(`[whitelist] ${error}`);

  if (users.length === 0) {
    if (error) return false;
    console.warn("[whitelist] the list is empty — anyone with a Discord account can sign in");
    return true;
  }

  const allowed = users.map((u) => u.toLowerCase());
  return names.some((n) => n && allowed.includes(String(n).trim().toLowerCase()));
}
