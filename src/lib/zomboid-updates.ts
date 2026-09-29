import { exec } from "child_process";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { parseInstalledVersions, parseLatestKnownVersions } from "@/lib/acf";
import { PZ_APP_ID, PZ_WORKSHOP_DIR, pzConsole, readModState } from "@/lib/zomboid";
import {
  COMPOSE_PROJECT,
  containerImage,
  getGameStatus,
  withGameStopped,
} from "@/lib/game-manager";
import {
  OperationConflictError,
  POWER_RESOURCES,
  listOperations,
  runOperation,
  type OpHandle,
} from "@/lib/operations";

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

/**
 * When this process started.
 *
 * An apply is orchestrated entirely in memory here — the stop, the SteamCMD run
 * and the start are awaited inside `runPoll` — so it cannot outlive the process
 * that started it. An `applyingSince` older than this process is therefore a
 * leftover from a crash, a redeploy or a box reboot, never a running apply.
 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * Longest an apply can still legitimately be in flight. The graceful stop is
 * capped at `PZ_STOP_TIMEOUT` (300s) and `seedMods` at SteamCMD's own 45-minute
 * exec timeout, after which it rejects and the marker is cleared — so ~51
 * minutes is the ceiling and an hour is safely past it. This only catches the
 * one case the process check cannot: a clearing write that was lost (all writes
 * here are best-effort) inside a process that never restarted.
 */
const APPLY_MAX_MS = 60 * 60 * 1000;

export interface StaleMod {
  id: string;
  title: string;
  /** Unix seconds: the version installed on disk, per Steam's manifest. */
  installed: number;
  /** Unix seconds: the version currently published. */
  published: number;
}

export interface WatchState {
  /** Workshop ids known to be out of date, so we only announce on a change. */
  pendingIds: string[];
  /** When the pending update was last announced in game. */
  announcedAt: number;
  /** When an update was last applied. */
  appliedAt: number;
  /** Titles of the pending mods, so the UI can name them. */
  pendingTitles: string[];
  /**
   * When a check last completed, successfully or not. Written on **every** tick
   * so the UI can distinguish "nothing to update" from "the watcher stopped
   * running" — which are otherwise identical from the outside.
   */
  checkedAt: number;
  /** Why the last check failed, or "" if it succeeded. */
  lastError: string;
  /**
   * When the current apply started, or 0 if none is running.
   *
   * Written **before** the stop/download/start begins, not after, because that
   * whole sequence takes ~6 minutes and nothing else reveals it: the tick logs
   * only on completion, and the `running` guard correctly suppresses further
   * ticks meanwhile. Without this the UI kept saying "waiting for everyone to log
   * off" while the server was already being restarted, which reads as the feature
   * having done nothing at all.
   *
   * Because it is written first, it can outlive the apply. `readWatchState`
   * reconciles that — never trust the raw file.
   */
  applyingSince: number;
  /** Titles being applied right now, so the UI can name them mid-flight. */
  applyingTitles: string[];
  /**
   * When an apply last *failed*, so we stop retrying it in a loop.
   *
   * Without this the retry is unbounded and it restarts the server every time.
   * `seedMods` throws for permanent reasons as readily as transient ones — a
   * Workshop item that was hidden or deleted can never download — and
   * `withGameStopped` now boots the world again on failure. So a single dead mod
   * produced: graceful stop, seed, fail, boot 89 mods, next tick, repeat. Forever,
   * on the world people play daily, each cycle a few minutes of downtime.
   *
   * The mod list is unchanged after a failure, so nothing about the next attempt
   * is different; only time can fix it (Steam recovering, or someone removing the
   * mod). Hence a flat cooldown rather than a backoff.
   */
  applyFailedAt: number;
}

const EMPTY_STATE: WatchState = {
  pendingIds: [],
  announcedAt: 0,
  appliedAt: 0,
  pendingTitles: [],
  checkedAt: 0,
  lastError: "",
  applyingSince: 0,
  applyingTitles: [],
  applyFailedAt: 0,
};

/**
 * How long to wait after a failed apply before trying again.
 *
 * Long enough that a permanently-broken mod costs one restart an hour instead of
 * one every few minutes, short enough that a genuine Steam outage recovers on its
 * own overnight.
 */
const APPLY_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * The same wait for the stopped-server path, which costs no downtime.
 *
 * Shorter than the apply cooldown because the two failures cost different things: a
 * failed *apply* spent the world's uptime, a failed *seed* spent CPU and Steam
 * bandwidth with nobody waiting and the world already down. Long enough that a dead
 * Workshop item costs four SteamCMD runs an hour instead of twelve, short enough
 * that the files are ready well before anyone asks for the world back.
 */
const SEED_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

let warnedStaleApply = false;

/**
 * The state as it should be believed — not quite what is on disk.
 *
 * `applyingSince` is written *before* the ~6 minute stop/download/start, so a
 * crash, a redeploy or a box reboot in that window leaves it set with nothing to
 * clear it: the `none` and `seeded` paths return a `next` that doesn't mention
 * it, and `{ ...state, ...next }` re-persists whatever was there. The card then
 * read "Updating now — restarting the server… Started 3 days ago" for good, with
 * `Check now` — its only control, and the one thing that could have moved the
 * state on — disabled precisely because an apply looked in-flight.
 *
 * Reconciling on read rather than on each `runPoll` return path means every
 * reader (this poll and the API the card polls) gets the same answer, the next
 * write persists the cleared value, and a genuinely in-flight apply is still
 * preserved for a concurrent poll — which explicitly zeroing those paths would
 * have wiped.
 */
export async function readWatchState(): Promise<WatchState> {
  let state: WatchState;
  try {
    state = { ...EMPTY_STATE, ...JSON.parse(await readFile(STATE_FILE, "utf-8")) };
  } catch {
    return { ...EMPTY_STATE };
  }
  if (!state.applyingSince) return state;

  const predates = state.applyingSince < PROCESS_STARTED_AT;
  const tooOld = Date.now() - state.applyingSince > APPLY_MAX_MS;
  if (!predates && !tooOld) return state;

  // Say so once: it means an apply was interrupted, so the mods on disk may be
  // half updated. The next poll re-finds them stale and redoes the whole thing,
  // but silently pretending nothing happened is how this went unnoticed before.
  if (!warnedStaleApply) {
    warnedStaleApply = true;
    console.warn(
      `[pz-updates] discarding apply marker from ${new Date(state.applyingSince).toISOString()}: ` +
        (predates
          ? "it predates this process, and an apply cannot outlive the process running it"
          : `it is older than the longest possible apply (${APPLY_MAX_MS / 60000}m)`)
    );
  }
  return { ...state, applyingSince: 0, applyingTitles: [] };
}

/**
 * The apply marker, preferring the registry and falling back to the file.
 *
 * The on-disk `applyingSince` is deliberately NOT deleted yet. It is the only
 * operation record in this app that survives a deploy, for the one operation nobody
 * clicked — and removing durable state in the same change that introduces the registry
 * would mean a registry bug silently breaks the one thing that already works. The
 * fields come out in a follow-up, once the registry has run for a week.
 *
 * A live registry entry wins because it cannot be orphaned: the entry exists exactly
 * as long as the awaiting frame does.
 */
export async function applyMarker(): Promise<{ since: number; titles: string[] }> {
  const state = await readWatchState();
  const live = listOperations().find((o) => o.kind === "mods.update" && o.game === "zomboid");
  // `since` from the registry when there is one; the titles still come off disk,
  // because they are written before the long part and the registry carries only the
  // truncated live detail line.
  return {
    since: live ? live.startedAt : state.applyingSince || 0,
    titles: state.applyingTitles || [],
  };
}

async function writeWatchState(state: WatchState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state), "utf-8").catch(() => {});
}

// The two version sources below are module-local on purpose: they are only
// meaningful *compared against each other*, and `findStaleMods` is that comparison
// — including the `latestKnownVersions` cross-check, which is stale whenever the
// server has been stopped. A caller reaching for one alone would be reading a
// number it cannot interpret.
//
// The parsing itself lives in `@/lib/acf.ts`, which imports nothing: this module
// reaches Docker and Prisma through `game-manager`, so the one part where a mistake
// is *silent* — reading `timeupdated` out of the wrong section, which makes every mod
// look current forever — was untestable while it lived here. See `tests/acf.test.ts`.

/** `timeupdated` per installed item — the version actually on disk. */
async function installedVersions(): Promise<Map<string, number>> {
  let text: string;
  try {
    text = await readFile(MANIFEST, "utf-8");
  } catch {
    return new Map(); // nothing downloaded yet
  }
  return parseInstalledVersions(text);
}

/**
 * `latest_timeupdated` per item from `WorkshopItemDetails` — Steam's own record
 * of the newest published version, maintained by the running server's Steam
 * client. Used only to cross-check the Steam API answer, because it goes stale
 * while the server is stopped and nothing refreshes it.
 */
async function latestKnownVersions(): Promise<Map<string, number>> {
  let text: string;
  try {
    text = await readFile(MANIFEST, "utf-8");
  } catch {
    return new Map();
  }
  return parseLatestKnownVersions(text);
}

/** Published `time_updated` + title per id, in ONE request for all of them. */
async function publishedVersions(
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
      // Node's fetch has no default timeout. Without this a hung Steam request
      // hangs the whole poll, and on 2026-09-15 that stalled the watcher for
      // 6 minutes starting five seconds before the last player logged off — so
      // the update everyone was waiting for never fired.
      signal: AbortSignal.timeout(15_000),
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
 * Marks the throwaway SteamCMD container so it can be told apart from the live
 * game container.
 *
 * It has to be a label: the seed deliberately runs the *same image* as
 * `yoshling-pz` (see `containerImage` below), it is unnamed because `--rm` plus a
 * fixed name collides with any leftover, and `--rm` itself isn't visible in
 * `docker ps`. `scripts/deploy.sh` refuses to deploy while a seed is in flight —
 * two SteamCMD runs race on the workshop volume and the loser updates nothing —
 * and it used to look for the image name, which meant it never fired once.
 * **If you rename this, rename it there too.**
 */
const SEED_LABEL = "yoshling.role=pz-seed";

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
    `docker run --rm --label ${SEED_LABEL} ` +
      `-v ${volume}:/home/steam/pz-dedicated/steamapps/workshop ` +
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
  const label = names.length === 1 ? "Update found for" : "Updates found for";
  return `${label} ${shown}${rest}: the server will restart to update once all players leave.`;
}

// The download narration, shared by the two paths that do it.
//
// `runPoll` has two branches that call `seedMods` — one with the world already
// stopped, one that stops it — and they carried byte-identical copies of these five
// lines. Copies of narration drift the way copies of anything else do, and the two
// would then describe the same SteamCMD run differently depending on why it started.

function downloadStep(op: OpHandle, titles: string[]): void {
  op.step("Downloading mods from Steam");
  op.detail(titles.slice(0, 3).join(", ") + (titles.length > 3 ? `, +${titles.length - 3} more` : ""));
}

/**
 * Only call this after `seedMods` has returned.
 *
 * `seedMods` throws unless SteamCMD reported every item downloaded, so reaching it IS
 * the read-back — the count is Steam's own, not ours.
 */
function settleDownload(op: OpHandle, ids: string[]): void {
  op.settle(`Downloaded ${ids.length} of ${ids.length} mods`, {
    count: { done: ids.length, total: ids.length, noun: "mods" },
  });
}

export type PollAction = "none" | "announced" | "applied" | "seeded" | "skipped";

/**
 * One poll. Safe to call on a timer and safe to call concurrently with the UI —
 * the control lock is what serialises it, and a busy lock just skips this round.
 *
 * Records `checkedAt` on **every** call, success or failure, because "everything
 * is up to date" and "the watcher stopped running" look identical otherwise.
 */
export async function pollModUpdates(): Promise<{ action: PollAction; stale: StaleMod[] }> {
  const state = await readWatchState();
  // Fields `runPoll` needs to persist even when it throws, merged into BOTH exit
  // paths below. It exists because `runPoll` writing them itself does not work, and
  // silently did not: this function captures `state` *before* the poll, and the
  // `catch` below re-persists `{ ...state, ... }` — so every `applyFailedAt` the
  // inner catch recorded was reverted a moment later by the outer one. The
  // documented one-hour cooldown therefore never engaged on a real failure, which is
  // exactly the loop it was added to stop. (The other fields that catch writes,
  // `applyingSince`/`applyingTitles`, happened to survive: they are set *inside*
  // `runPoll`, so the pre-poll snapshot still carries the cleared value it wanted.)
  const stamp: Partial<WatchState> = {};
  try {
    const { action, stale, next } = await runPoll(state, stamp);
    // `next` last: a success path clearing `applyFailedAt` must win over a stamp.
    await writeWatchState({ ...state, ...stamp, ...next, checkedAt: Date.now(), lastError: "" });
    return { action, stale };
  } catch (e) {
    // A refusal is not a failure: the `seeded` branch now enters an operation, and a
    // second "Check now" (or a tick racing one) is *supposed* to be turned away rather
    // than start a second SteamCMD run on the same volume. Recording it as `lastError`
    // would put "Project Zomboid is busy — downloading mod updates" on the card as
    // though the watcher had broken. It sets no stamp either — nothing was attempted,
    // so the next tick must be free to try.
    if (e instanceof OperationConflictError) {
      await writeWatchState({ ...state, checkedAt: Date.now(), lastError: "" });
      return { action: "skipped", stale: [] };
    }
    const message = e instanceof Error ? e.message : String(e);
    await writeWatchState({ ...state, ...stamp, checkedAt: Date.now(), lastError: message });
    throw e;
  }
}

/**
 * The decision itself. Returns the state changes it wants rather than writing —
 * except via `stamp`, which is for changes that must survive it throwing.
 */
async function runPoll(
  state: WatchState,
  stamp: Partial<WatchState>
): Promise<{ action: PollAction; stale: StaleMod[]; next: Partial<WatchState> }> {
  const stale = await findStaleMods();

  if (stale.length === 0) {
    return { action: "none", stale, next: { pendingIds: [], pendingTitles: [] } };
  }

  const ids = stale.map((s) => s.id);
  const snap = await getGameStatus("zomboid");

  // Mid-boot: mods are being loaded right now, so leave it alone.
  if (snap.status === "starting") return { action: "skipped", stale, next: {} };

  // Stopped anyway — bring the files up to date so the next start is clean and
  // the server never has to run its own crash-prone downloader.
  //
  // Tracked, and this is the branch that most needed it. `pollModUpdates` is entered
  // from BOTH the instrumentation timer and the "Check now" route, and only the timer
  // has a re-entry guard — so two clicks (or a click racing the 15s pending tick) ran
  // two SteamCMD containers against the same `pz-workshop` volume, which is the exact
  // documented race that once reported "updated 0 of 1 mods". And because Project
  // Zomboid is off whenever another world holds the box, this is the *normal* path, not
  // the edge case: a 45-minute download that entered no record, held no resource, wrote
  // no `applyingSince`, and left `powerOn("zomboid")` free to boot the game onto a
  // half-written workshop volume.
  if (snap.status !== "online") {
    // ...and the failure cooldown, which this branch had no version of at all.
    //
    // The only cooldown lived below, guarding the restart-the-world path. This branch
    // also had no try/catch, so it neither recorded a failure nor consulted one: a
    // Workshop item that can never download (hidden, deleted, or Steam refusing)
    // launched a SteamCMD container every POLL_MS — five minutes, forever, for a
    // download with no reason to go differently the 300th time. And the route's own
    // comment above calls this the *normal* path, so "forever" meant most of the time.
    const sinceSeedFailure = Date.now() - state.applyFailedAt;
    if (state.applyFailedAt && sinceSeedFailure < SEED_RETRY_COOLDOWN_MS) {
      const mins = Math.ceil((SEED_RETRY_COOLDOWN_MS - sinceSeedFailure) / 60000);
      console.log(`[pz-updates] download failed recently; not retrying for ~${mins} min`);
      // Pending ids handed back so the card keeps naming the mods, exactly as the
      // apply cooldown below does.
      return {
        action: "skipped",
        stale,
        next: { pendingIds: ids, pendingTitles: stale.map((s) => s.title) },
      };
    }

    const titles = stale.map((s) => s.title);
    try {
      await runOperation(
        {
          kind: "mods.update",
          game: "zomboid",
          title: "Downloading mod updates",
          // `POWER_RESOURCES`, not just `files:zomboid`: a boot landing mid-seed is the
          // harmful case, and the world is already stopped so nothing is being held
          // hostage that could not wait.
          resources: POWER_RESOURCES,
          // No `startedBy`: the watcher runs on a timer, and pinning it on whoever
          // happened to press "Check now" would be a small lie in the record.
          startedBy: null,
        },
        async (op) => {
          downloadStep(op, titles);
          await seedMods(ids);
          settleDownload(op, ids);
          op.fact({ label: "Power", value: "powered off" });
          return { value: undefined as void };
        }
      );
    } catch (e) {
      // Same distinction the online path makes: a refusal means nothing was
      // attempted, so it must not start the cooldown. `pollModUpdates`'s own catch
      // already turns an `OperationConflictError` into `action: "skipped"` with no
      // `lastError`; rethrowing here preserves that, while a real failure is
      // recorded first so the next tick backs off instead of looping.
      if (e instanceof OperationConflictError) throw e;
      stamp.applyFailedAt = Date.now();
      throw e;
    }
    return {
      action: "seeded",
      stale,
      next: {
        pendingIds: [],
        pendingTitles: [],
        appliedAt: Date.now(),
        // Success clears the cooldown, so a transient Steam failure stops
        // suppressing seeds the moment it stops being true.
        applyFailedAt: 0,
      },
    };
  }

  if (snap.players.online > 0) {
    const next: Partial<WatchState> = { pendingIds: ids, pendingTitles: stale.map((s) => s.title) };
    const changed = ids.join(",") !== state.pendingIds.join(",");
    const due = Date.now() - state.announcedAt > REANNOUNCE_MS;
    if (changed || due) {
      await pzConsole(`servermsg "${announcement(stale).replace(/"/g, "'")}"`).catch(() => {});
      next.announcedAt = Date.now();
    }
    return { action: "announced", stale, next };
  }

  // Empty, but the last attempt failed recently. Retrying immediately restarts the
  // server for an attempt that has no reason to go differently — see
  // `applyFailedAt`. Report it as pending so the card keeps naming the mods.
  //
  // Below the announce branch on purpose: a cooldown must not stop telling the
  // players still connected that a restart is coming.
  const sinceFailure = Date.now() - state.applyFailedAt;
  if (state.applyFailedAt && sinceFailure < APPLY_RETRY_COOLDOWN_MS) {
    const mins = Math.ceil((APPLY_RETRY_COOLDOWN_MS - sinceFailure) / 60000);
    console.log(`[pz-updates] apply failed recently; not retrying for ~${mins} min`);
    return {
      action: "announced",
      stale,
      next: { pendingIds: ids, pendingTitles: stale.map((s) => s.title) },
    };
  }

  // Empty: apply it. Publish that we have started BEFORE the long part, so the
  // dashboard can say "updating now" instead of "waiting for players to leave".
  const titles = stale.map((s) => s.title);
  await writeWatchState({
    ...state,
    pendingIds: ids,
    pendingTitles: titles,
    applyingSince: Date.now(),
    applyingTitles: titles,
    checkedAt: Date.now(),
    lastError: "",
  });

  // Logged here as well as on completion: the apply takes ~6 minutes during which
  // the `running` guard suppresses every other tick, so without this the log goes
  // silent at exactly the moment someone starts wondering what is happening.
  console.log(`[pz-updates] applying (server restart): ${titles.join(", ")}`);

  try {
    // `restartOnFailure` defaults to true and that is what we want here: a mod
    // that Steam cannot fetch should not cost the world its uptime.
    await withGameStopped(
      "zomboid",
      "restart",
      async (op) => {
        downloadStep(op, titles);
        await seedMods(ids);
        settleDownload(op, ids);
      },
      {
        kind: "mods.update",
        title: "Applying mod updates",
        // No `startedBy`: the watcher runs on a timer, and pinning it on whoever
        // happened to press "Check now" would be a small lie in the record.
        startedBy: null,
      }
    );
  } catch (e) {
    // Clear the in-flight marker on any exit path, or the UI shows a restart
    // that is no longer happening.
    //
    // Widened from `ControlBusyError`: a *file*-lane refusal (a Project Zomboid backup
    // in flight) is equally "nothing was attempted", and misreading it as a failed
    // apply would start the one-hour `applyFailedAt` cooldown and suppress every apply
    // for an hour over a conflict that resolves in minutes.
    const busy = e instanceof OperationConflictError;
    await writeWatchState({ ...state, applyingSince: 0, applyingTitles: [] });
    if (busy) return { action: "skipped", stale, next: {} };
    // A busy lock is not a failed apply — nothing was attempted, and the next tick
    // should be free to try. Only a real failure starts the cooldown, and it goes on
    // the `stamp` rather than in the write above: this frame throws, and the outer
    // `catch` re-persists the pre-poll snapshot, which used to revert it.
    stamp.applyFailedAt = Date.now();
    throw e;
  }
  return {
    action: "applied",
    stale,
    next: {
      pendingIds: [],
      pendingTitles: [],
      announcedAt: 0,
      appliedAt: Date.now(),
      applyingSince: 0,
      applyingTitles: [],
      // Success clears the cooldown, so a transient failure doesn't keep
      // suppressing applies for an hour after it stopped being true.
      applyFailedAt: 0,
    },
  };
}
