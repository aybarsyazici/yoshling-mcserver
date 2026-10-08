import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { gameDataPath } from "@/lib/game-data-path";
import { getMinecraftDataRoot } from "@/lib/minecraft-profile-store";

/**
 * Minecraft identity: turning a username into the id the game actually matches on.
 *
 * This module exists because `ops.json` and `whitelist.json` were written with
 * `uuid: ""` for every entry added through the dashboard, and **Minecraft resolves
 * the UUID first and discards the whole entry when it can't**. Measured on the box:
 * `PUT /api/server/mc-whitelist [{"uuid":"","name":"ZZUuidProbe"}]` answered
 * `{"success":true,"count":1}` and the entry was on disk, while the game answered
 * "There are no whitelisted players". The same name with a real UUID gave
 * "There are 1 whitelisted player(s)". For ops it was worse: the API said
 * `count:3`, and after a restart the game had rewritten `ops.json` *without* the
 * entry, and `deop <name>` replied "Nothing changed. The player is not an operator".
 *
 * So every entry written from the dashboard has to carry a real UUID, and which
 * UUID that is depends on `online-mode`.
 */

/** 8-4-4-4-12 hex, the form Minecraft writes into both json files. */
export function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Java usernames. Deliberately the same `/^\w{1,16}$/` both routes already
 * validate with, so this module can't accept a name a route would reject (or the
 * other way round, which would make one of the two gates decorative).
 */
export function isValidMcName(name: string): boolean {
  return /^\w{1,16}$/.test(name);
}

function hyphenate(hex32: string): string {
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20, 32),
  ].join("-");
}

/**
 * Java's `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))` — a
 * version-3 (MD5) UUID. With `online-mode=false` this is the id the game itself
 * derives for a connecting player, so no network call is involved and the answer
 * cannot be wrong for a name the server will ever see.
 *
 * Verified against the game's own output rather than against a spec: the live
 * `ops.json` on the box was rewritten *by Minecraft*, and both entries in it match
 * this function exactly — `LinnMarie` → `cec627a9-5bfb-3db1-82de-b433dc37d3c3` and
 * `Yoshiane` → `607f15d3-e93b-303f-93af-6d1024a4d992`. That is the oracle; the
 * unit test pins those two plus `Notch` and `jeb_`.
 */
export function offlineUuid(name: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  // Set the version nibble to 3 and the RFC 4122 variant bits to 10x, exactly as
  // java.util.UUID.nameUUIDFromBytes does. Skipping this yields a plain MD5 digest
  // that *looks* like a UUID and that the game will not match.
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return hyphenate(bytes.toString("hex"));
}

/**
 * `online-mode` decides which id the game derives, so it decides how a name must
 * be resolved. Read from `server.properties` per request rather than cached: the
 * properties editor one route over can change it, and a stale answer here writes
 * UUIDs the game will silently discard — the exact failure this module exists for.
 *
 * Defaults to **true** when the file can't be read, because that is Minecraft's own
 * default. Guessing offline instead would mint offline UUIDs for a licensed server,
 * which is the same silent-discard bug with the sign flipped.
 */
export async function readOnlineMode(root?: string): Promise<boolean> {
  try {
    const content = await readFile(await gameDataPath(root ?? await getMinecraftDataRoot(), "server.properties"), "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("#")) continue;
      const [key, ...rest] = line.split("=");
      if (key.trim() === "online-mode") return rest.join("=").trim() !== "false";
    }
  } catch {
    // Falls through to the safe default below.
  }
  return true;
}

export type UuidResolution =
  | { ok: true; uuid: string }
  /** Mojang answered, and there is no such account. A typo — the user can fix it. */
  | { ok: false; reason: "unknown" }
  /** Mojang did not answer. Nothing is known, so nothing may be written. */
  | { ok: false; reason: "unreachable" };

/**
 * Returns a discriminated result, not `string | null`, because the two failures
 * need different HTTP statuses and different advice: a misspelt name is the user's
 * to fix (400) and an unreachable Mojang is ours (503, "try again"). Collapsing
 * them to `null` would put "check the spelling" in front of a network blip.
 */
export async function resolveUuid(
  name: string,
  opts: { onlineMode: boolean }
): Promise<UuidResolution> {
  if (!opts.onlineMode) return { ok: true, uuid: offlineUuid(name) };

  try {
    const res = await fetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    // 204 is Mojang's historical "no such user"; 404 is the current one. Both mean
    // the name is wrong, which is a different answer from "we couldn't ask".
    if (res.status === 204 || res.status === 404) return { ok: false, reason: "unknown" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !/^[0-9a-f]{32}$/i.test(body.id)) {
      return { ok: false, reason: "unreachable" };
    }
    return { ok: true, uuid: hyphenate(body.id) };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * Fill in the UUID for every entry that lacks a usable one, or refuse the whole
 * request.
 *
 * **All-or-nothing on purpose.** Writing the resolvable entries and dropping the
 * rest would reproduce the bug this module fixes one layer up: a file the game
 * accepts, missing the player the user came here to add, reported as success.
 * Both routes share this so ops and whitelist cannot drift apart in behaviour —
 * they already drifted once, in that only one of them was ever suspected.
 *
 * An entry that already has a valid UUID is left alone, so the two real operators
 * in the live `ops.json` keep the ids the game wrote for them.
 */
export async function resolveEntryUuids<T extends { uuid: string; name: string }>(
  entries: T[],
  root?: string
): Promise<{ ok: true; entries: T[] } | { ok: false; status: number; error: string }> {
  const needsResolving = entries.some((e) => !isValidUuid(e.uuid));
  if (!needsResolving) return { ok: true, entries };

  // One read per request, not one per entry.
  const onlineMode = await readOnlineMode(root);

  const resolved: T[] = [];
  for (const entry of entries) {
    if (isValidUuid(entry.uuid)) {
      resolved.push(entry);
      continue;
    }
    const r = await resolveUuid(entry.name, { onlineMode });
    if (!r.ok) {
      return r.reason === "unknown"
        ? {
            ok: false,
            status: 400,
            error: `"${entry.name}" isn't a Minecraft account — check the spelling.`,
          }
        : {
            ok: false,
            status: 503,
            error:
              `Couldn't reach Mojang to look up "${entry.name}". ` +
              `Nothing was saved — try again in a moment.`,
          };
    }
    resolved.push({ ...entry, uuid: r.uuid });
  }
  return { ok: true, entries: resolved };
}
