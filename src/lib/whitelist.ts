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

export async function getWhitelist(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(WHITELIST_FILE, "utf-8"));
    // A hand-mangled file shouldn't lock everyone out — fall back instead.
    if (!Array.isArray(parsed)) return fromEnv();
    return parsed.map((u) => String(u).trim()).filter(Boolean);
  } catch {
    return fromEnv();
  }
}

export async function saveWhitelist(users: string[]): Promise<void> {
  await mkdir(path.dirname(WHITELIST_FILE), { recursive: true });
  await writeFile(WHITELIST_FILE, JSON.stringify(users, null, 2), "utf-8");
}

/**
 * Discord hands us a `username` (the @handle) and often a `global_name` (the
 * display name). People whitelist whichever one they see, so match either.
 * An empty list means the whitelist isn't in use and anyone may sign in — the
 * behaviour this has always had.
 */
export async function isWhitelisted(names: (string | null | undefined)[]): Promise<boolean> {
  const allowed = (await getWhitelist()).map((u) => u.toLowerCase());
  if (allowed.length === 0) return true;
  return names.some((n) => n && allowed.includes(String(n).trim().toLowerCase()));
}
