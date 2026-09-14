import { exec } from "child_process";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { PZ_APP_ID, PZ_WORKSHOP_DIR, pzConsole, readModState } from "@/lib/zomboid";
import {
  COMPOSE_PROJECT,
  containerImage,
  getGameStatus,
  withGameStopped,
  ControlBusyError,
} from "@/lib/game-manager";

const execAsync = promisify(exec);

/**
 * Keeping the server's Workshop mods in step with Steam.
 *
 * ## The problem
 *
 * When a mod author republishes, players' Steam clients update it within
 * minutes, but the server keeps serving the version it downloaded. The mismatch
 * is enforced **client-side** — the server sends its Workshop list, the client
 * compares and refuses — so the server logs nothing at all and simply looks
 * broken: nobody who logs off can get back in, and players still connected hit
 * item/inventory bugs because their definitions no longer match the server's.
 * Only a restart fixes it. With ~9 updates a week across this collection, that
 * happens more than once a day.
 *
 * ## Why this polls
 *
 * There is no push option. Steam has no webhook for Workshop items; PICS
 * changelists carry only appIDs and packageIDs, never published files, and are
 * themselves a timer poll; Project Zomboid has no server option and no Lua event
 * that fires on an upstream change; and because the version check is client-side
 * there is no failed-join event to react to. So: poll.
 *
 * ## What it compares
 *
 * Not file mtimes. Steam's own manifest, `appworkshop_<appid>.acf`, records a
 * `timeupdated` per installed item — the version actually on disk — and
 * `GetPublishedFileDetails` returns `time_updated` for the published version.
 * Comparing those two is exact, and costs one small file read plus one batched
 * HTTP request for every mod at once (not one per mod, which is what makes
 * frequent polling cheap enough to be uninteresting).
 *
 * ## What it does about it
 *
 * Never interrupts play: if anyone is connected it announces the update in game
 * and waits. It only applies one when the server is empty. Downloads go through
 * SteamCMD rather than letting the server fetch them, because a failed Workshop
 * download throws an unhandled exception inside the server and kills it.
 */

const STATE_FILE = "/app/data/pz-updates.json";
const MANIFEST = path.join(PZ_WORKSHOP_DIR, `appworkshop_${PZ_APP_ID}.acf`);
/** Re-announce a still-pending update this often, so latecomers see it too. */
const REANNOUNCE_MS = 30 * 60 * 1000;

export interface StaleMod {
  id: string;
  title: string;
  /** Unix seconds: the version installed on disk, per Steam's manifest. */
  installed: number;
  /** Unix seconds: the version currently published. */
  published: number;
}

interface WatchState {
  /** Workshop ids known to be out of date, so we only announce on a change. */
  pendingIds: string[];
  /** When the pending update was last announced in game. */
  announcedAt: number;
  /** When an update was last applied. */
  appliedAt: number;
  /** Titles of the pending mods, so the UI can name them. */
  pendingTitles: string[];
}

const EMPTY_STATE: WatchState = { pendingIds: [], announcedAt: 0, appliedAt: 0, pendingTitles: [] };

export async function readWatchState(): Promise<WatchState> {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(await readFile(STATE_FILE, "utf-8")) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeWatchState(state: WatchState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state), "utf-8").catch(() => {});
}

/**
 * The body of a named Valve-KeyValues block, found by matching braces.
 *
 * Bounding the block matters: `appworkshop_<appid>.acf` contains **two** sections
 * keyed by workshop id — `WorkshopItemsInstalled` (what is on disk) and
 * `WorkshopItemDetails` (what Steam knows about it, including
 * `latest_timeupdated`). Both carry a `timeupdated`. Reading from the first
 * section to end-of-file lets the second section's values win, which silently
 * makes installed == published for every mod and the staleness check a no-op that
 * always answers "nothing to do". That is exactly the bug this replaced.
 */
function kvSection(text: string, name: string): string | null {
  const key = `"${name}"`;
  const at = text.indexOf(key);
  if (at < 0) return null;
  const open = text.indexOf("{", at + key.length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** `timeupdated` per installed item — the version actually on disk. */
export async function installedVersions(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = await readFile(MANIFEST, "utf-8");
  } catch {
    return out; // nothing downloaded yet
  }

  const section = kvSection(text, "WorkshopItemsInstalled");
  if (!section) return out;

  // Per-item blocks hold only scalars, so no nesting to worry about here.
  const itemRe = /"(\d{6,})"\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(section)) !== null) {
    const updated = /"timeupdated"\s*"(\d+)"/.exec(m[2]);
    if (updated) out.set(m[1], Number(updated[1]));
  }
  return out;
}

/**
 * `latest_timeupdated` per item from `WorkshopItemDetails` — Steam's own record
 * of the newest published version, maintained by the running server's Steam
 * client. Used only to cross-check the Steam API answer, because it goes stale
 * while the server is stopped and nothing refreshes it.
 */
export async function latestKnownVersions(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = await readFile(MANIFEST, "utf-8");
  } catch {
    return out;
  }

  const section = kvSection(text, "WorkshopItemDetails");
  if (!section) return out;

  const itemRe = /"(\d{6,})"\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(section)) !== null) {
    const latest = /"latest_timeupdated"\s*"(\d+)"/.exec(m[2]);
    if (latest) out.set(m[1], Number(latest[1]));
  }
  return out;
}

/** Published `time_updated` + title per id, in ONE request for all of them. */
export async function publishedVersions(
  ids: string[]
): Promise<Map<string, { updated: number; title: string }>> {
  const out = new Map<string, { updated: number; title: string }>();
  if (ids.length === 0) return out;

  const body = new URLSearchParams();
  body.set("itemcount", String(ids.length));
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const res = await fetch(
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`Steam returned ${res.status}`);

  const json = await res.json();
  for (const d of json?.response?.publishedfiledetails ?? []) {
    const updated = Number(d?.time_updated);
    if (d?.publishedfileid && Number.isFinite(updated) && updated > 0) {
      out.set(String(d.publishedfileid), { updated, title: String(d.title ?? "") });
    }
  }
  return out;
}

/** Mods whose published version is newer than the one installed. */
export async function findStaleMods(): Promise<StaleMod[]> {
  const { workshopIds } = await readModState();
  const ids = Array.from(new Set(workshopIds.filter((id) => /^\d{6,}$/.test(id))));
  if (ids.length === 0) return [];

  const [installed, published, localLatest] = await Promise.all([
    installedVersions(),
    publishedVersions(ids),
    latestKnownVersions(),
  ]);

  // A manifest that exists but yields nothing is a parse failure, not an empty
  // server. Say so instead of reporting "nothing to update" forever.
  if (installed.size === 0 && existsSync(MANIFEST)) {
    throw new Error(`Parsed 0 installed items from ${MANIFEST} — manifest format changed?`);
  }

  const stale: StaleMod[] = [];
  for (const id of ids) {
    const inst = installed.get(id);
    // No manifest entry means it was never downloaded. That's the seeding path's
    // job on next start, not an "update", so it isn't reported here.
    if (inst === undefined) continue;

    const pub = published.get(id);
    // Trust whichever source reports the newer version: the API is authoritative
    // but can hiccup, and the local record is exact but goes stale while the
    // server is stopped.
    const newest = Math.max(pub?.updated ?? 0, localLatest.get(id) ?? 0);
    if (newest > inst) {
      stale.push({ id, title: pub?.title || id, installed: inst, published: newest });
    }
  }
  return stale.sort((a, b) => b.published - a.published);
}

/**
 * Download the given items with SteamCMD, in a throwaway container sharing the
 * workshop volume.
 *
 * `validate` so a half-written item is repaired rather than trusted. The
 * manifest (`appworkshop_*.acf`) is deliberately left alone: deleting it makes
 * every item look missing, and the next start then tries to re-download the
 * whole collection one item at a time — the exact path that kills the server.
 */
export async function seedMods(ids: string[]): Promise<void> {
  const safe = ids.filter((id) => /^\d{6,}$/.test(id));
  if (safe.length === 0) return;

  const image = await containerImage("zomboid").catch(
    () => "danixu86/project-zomboid-dedicated-server:latest"
  );
  const volume = `${COMPOSE_PROJECT}_pz-workshop`;
  const items = safe.map((id) => `+workshop_download_item ${PZ_APP_ID} ${id} validate`).join(" ");

  const inner =
    `chown -R steam:steam /home/steam/pz-dedicated/steamapps/workshop 2>/dev/null; ` +
    `runuser -u steam -- /home/steam/steamcmd/steamcmd.sh ` +
    `+force_install_dir /home/steam/pz-dedicated +login anonymous ${items} +quit`;

  const { stdout } = await execAsync(
    `docker run --rm -v ${volume}:/home/steam/pz-dedicated/steamapps/workshop ` +
      `--entrypoint sh ${image} -c ${JSON.stringify(inner)}`,
    { maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 }
  );

  const ok = (stdout.match(/Success\. Downloaded item/g) ?? []).length;
  if (ok < safe.length) {
    throw new Error(`SteamCMD updated ${ok} of ${safe.length} mods`);
  }
}

function announcement(stale: StaleMod[]): string {
  const names = stale.map((s) => s.title);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const noun = names.length === 1 ? "A mod has" : "Mods have";
  return (
    `${noun} been updated on Steam: ${shown}${rest}. ` +
    `The server will restart to apply the update once everyone has logged off.`
  );
}

/**
 * One poll. Safe to call on a timer and safe to call concurrently with the UI —
 * the control lock is what serialises it, and a busy lock just skips this round.
 */
export async function pollModUpdates(): Promise<
  { action: "none" | "announced" | "applied" | "seeded" | "skipped"; stale: StaleMod[] }
> {
  const state = await readWatchState();
  const stale = await findStaleMods();

  if (stale.length === 0) {
    if (state.pendingIds.length > 0) {
      await writeWatchState({ ...state, pendingIds: [], pendingTitles: [] });
    }
    return { action: "none", stale };
  }

  const ids = stale.map((s) => s.id);
  const snap = await getGameStatus("zomboid");

  // Mid-boot: mods are being loaded right now, so leave it alone.
  if (snap.status === "starting") return { action: "skipped", stale };

  // Stopped anyway — bring the files up to date so the next start is clean and
  // the server never has to run its own crash-prone downloader.
  if (snap.status !== "online") {
    await seedMods(ids);
    await writeWatchState({
      ...state,
      pendingIds: [],
      pendingTitles: [],
      appliedAt: Date.now(),
    });
    return { action: "seeded", stale };
  }

  if (snap.players.online > 0) {
    const changed = ids.join(",") !== state.pendingIds.join(",");
    const due = Date.now() - state.announcedAt > REANNOUNCE_MS;
    if (changed || due) {
      await pzConsole(`servermsg "${announcement(stale).replace(/"/g, "'")}"`).catch(() => {});
      await writeWatchState({
        ...state,
        pendingIds: ids,
        pendingTitles: stale.map((s) => s.title),
        announcedAt: Date.now(),
      });
    }
    return { action: "announced", stale };
  }

  // Empty: apply it.
  try {
    await withGameStopped("zomboid", "restart", () => seedMods(ids));
  } catch (e) {
    if (e instanceof ControlBusyError) return { action: "skipped", stale };
    throw e;
  }
  await writeWatchState({
    pendingIds: [],
    pendingTitles: [],
    announcedAt: 0,
    appliedAt: Date.now(),
  });
  return { action: "applied", stale };
}
