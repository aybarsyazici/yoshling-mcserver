import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discordUserId as numericId } from "../src/lib/discord-identity.ts";

/** Suggestions from stored labels need owner review; no live policy is modified. */
export function planDiscordWhitelist(entries, knownUsers) {
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || !entry.trim())) {
    throw new Error("The source must be a JSON array of non-empty strings");
  }
  const resolved = [];
  const unresolved = [];
  for (const original of entries) {
    const entry = original.trim();
    const id = numericId(entry);
    if (id) { resolved.push({ entry, discordId: id, basis: "explicit ID" }); continue; }
    const matches = knownUsers.filter(user => typeof user.username === "string" &&
      user.username.toLowerCase() === entry.toLowerCase() && numericId(user.discordId));
    const ids = [...new Set(matches.map(user => numericId(user.discordId)))];
    if (ids.length === 1) resolved.push({ entry, discordId: ids[0], basis: "stored username — review this identity" });
    else unresolved.push({ entry, reason: ids.length ? "ambiguous stored usernames" : "no stored username match; copy the account's Discord ID" });
  }
  return {
    complete: unresolved.length === 0,
    users: [...new Set(resolved.map(entry => entry.discordId))],
    resolved, unresolved,
    warning: "Review every suggested identity against the intended Discord account before replacing the sign-in policy.",
  };
}

export async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--file", "--database", "--output"].includes(args[i]) || !args[i + 1]) throw new Error("Use --file PATH --database file:PATH [--output CANDIDATE]");
    options[args[i]] = args[i + 1];
  }
  if (!options["--file"] || !options["--database"]) throw new Error("Use --file PATH --database file:PATH [--output CANDIDATE]");
  const source = path.resolve(options["--file"]);
  const output = options["--output"] && path.resolve(options["--output"]);
  if (output === source) throw new Error("Choose a separate candidate file; the current policy is never overwritten");
  const database = options["--database"];
  if (!database.startsWith("file:")) throw new Error("Only a local SQLite database is supported");
  await stat(decodeURIComponent(database.slice(5))); // refuse silently creating a wrong, empty DB
  const entries = JSON.parse(await readFile(source, "utf8"));
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: database });
  let plan;
  try {
    const data = await client.execute('SELECT "discordId", "username" FROM "User"');
    plan = planDiscordWhitelist(entries, data.rows);
  } finally { client.close(); }
  if (output && plan.complete) {
    const text = JSON.stringify(plan.users, null, 2) + "\n";
    await writeFile(output, text, { mode: 0o600, flag: "wx" });
    if (await readFile(output, "utf8") !== text) throw new Error("The candidate write could not be verified");
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  if (!plan.complete) process.exitCode = 2;
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    // Parser/DB errors may contain sensitive source snippets. Report no contents.
    process.stderr.write("Whitelist planning failed. Check the source format, database path and candidate destination. No live policy was changed.\n");
    process.exitCode = 1;
  });
}
