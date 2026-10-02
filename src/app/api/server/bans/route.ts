import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { resolveEntryUuids } from "@/lib/mc-identity";
import { containerIsRunning } from "@/lib/game-manager";
import { sendCommand, sendCommandLong } from "@/lib/rcon";
import { classifyRconFailure, rconFailureMessage } from "@/lib/rcon-failure";
import { db } from "@/lib/db";
import {
  BANLIST_IPS,
  BANLIST_PLAYERS,
  addIpBan,
  addPlayerBan,
  banCommand,
  banDrift,
  banMessage,
  banlistProves,
  buildIpBan,
  buildPlayerBan,
  checkBanTarget,
  classifyBanReply,
  liveReadState,
  pardonCommand,
  parseBanlist,
  parseBannedIpsFile,
  parseBannedPlayersFile,
  removeIpBan,
  removePlayerBan,
  routeBanChange,
  sanitizeBanReason,
  sanitizeBanSource,
  serializeIpBans,
  serializePlayerBans,
  withCreatedIso,
  type BanKind,
  type BanOutcome,
  type BannedIpEntry,
  type BannedPlayerEntry,
  type BanlistReply,
} from "@/lib/mc-bans";
import { readFile, writeFile } from "fs/promises";
import path from "path";

/**
 * Minecraft bans — the missing third member of the whitelist/ops set.
 *
 * ## Shape: one target per request, not a whole-list PUT
 *
 * `/api/server/mc-whitelist` and `/api/server/ops` take the entire list and write it.
 * Bans deliberately do not, because the write is often not a write at all: while the
 * server is up a ban is an RCON `ban <name>`, and there is no "set the ban list to
 * exactly this" command to express a whole-list PUT as. A whole-list endpoint would have
 * to diff and then issue N commands, each of which can fail separately — one request
 * with several outcomes, which is the shape this project has repeatedly summarised
 * wrongly. So: POST adds one, DELETE removes one, each with its own verified outcome.
 *
 * ## Which path, and why there is never a fall-back
 *
 * `routeBanChange` decides, and `src/lib/mc-bans.ts` carries the reasoning. In short:
 * the game holds both lists in memory and rewrites the json files from that memory, so
 * a file edit made while it is running is an edit with a delete scheduled behind it.
 *
 * The decision is made on **a live RCON socket, not on docker's report**: if the game
 * answers, it is up and the change goes over RCON whatever `docker inspect` said — and
 * `containerState` answers `"missing"` for any inspect failure, so its "stopped" is not
 * evidence. Only "docker says stopped *and* RCON is silent" writes a file. The remaining
 * pair — container up, game silent — is refused with 503 rather than falling back, which
 * is the same inversion `a7d76b8` fixed for the power controls.
 *
 * ## The outcome is read back, never assumed
 *
 * Both paths finish by reading the new state and checking the target is (or is no
 * longer) in it — `banlist` over RCON, or the file off disk. The command's own reply is
 * only used to choose wording: those strings are vanilla translations and a version bump
 * can make all of them stop matching at once. Anything not confirmed answers **non-2xx**,
 * so a caller that checks only `res.ok` cannot report success for a ban that did not
 * happen.
 *
 * ## Why this is not a `runOperation`
 *
 * Three RCON round trips at most — the liveness probe, the command, the read-back — and they
 * are sequenced so the deadlines cannot stack beyond the sum of three. The worst case is
 * each one spending its whole budget: `BANLIST_RCON_TIMEOUT_MS` for the probe, then
 * `BAN_RCON_TIMEOUT_MS` for the command, then `BANLIST_RCON_TIMEOUT_MS` again for the
 * read-back. A probe that *times out* means the file path, so neither of the other two runs.
 *
 * So it can cross the ten seconds `docs/OPERATIONS.md` sets as the threshold, and it is
 * still deliberately not an operation: there is nothing to narrate. No eviction, no stages,
 * no artefact, no resumption — one command and its verification, which a toast carries. A
 * ledger record per ban would be noise in the strip, and `runOperation` is for work whose
 * progress a reader needs to follow, not for work that is merely sometimes slow.
 */

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const PLAYERS_FILE = path.join(MC_DIR, "banned-players.json");
const IPS_FILE = path.join(MC_DIR, "banned-ips.json");

/**
 * Generous, because `ban <name>` resolves the name through the profile cache and falls back
 * to a Mojang lookup *on the server thread* even with `online-mode=false` — the same hazard
 * the Ops card on the settings page documents for `/op`, where the default gave up on a
 * server that was fine and still working. 5 s is a guess at a bound, not a measurement:
 * nothing here has been run against the live server.
 *
 * **This value governs only because `rcon.ts` was fixed to let it.** `rcon-client` keeps its
 * own `config.timeout` (2000 ms) and rejects the send itself when it fires, so until the
 * cache started passing the caller's budget through at connect time, every number handed to
 * `sendCommand` was capped at two seconds and the outer race never ran. A constant that
 * explained a generosity it was not getting is the shape of defect this repo keeps finding,
 * so if that plumbing is ever reverted, delete this constant rather than leave the comment.
 */
const BAN_RCON_TIMEOUT_MS = 5000;

/**
 * The budget for a `banlist`, which is a different kind of slow from a `ban`.
 *
 * It goes over `sendCommandLong`, which opens its own socket: one handshake, then a reply
 * that may span several 4096-byte packets, then a quiet window to know it has ended. Longer
 * than the `ban` budget because the cost scales with how many bans there are, and shorter
 * than `rconCommandLong`'s own 9 s default because this runs twice per page load.
 */
const BANLIST_RCON_TIMEOUT_MS = 6000;

interface BanFiles {
  players: ReturnType<typeof parseBannedPlayersFile>;
  ips: ReturnType<typeof parseBannedIpsFile>;
}

/**
 * ENOENT is "nothing is banned yet", not an error: the game only creates these files
 * once it has something to put in them. Any other read failure is rethrown, because
 * reading EACCES as an empty list is how a writer ends up replacing a full ban file with
 * a one-entry one.
 */
async function readBanFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return "[]";
    throw e;
  }
}

async function readBanFiles(): Promise<BanFiles> {
  const [players, ips] = await Promise.all([readBanFile(PLAYERS_FILE), readBanFile(IPS_FILE)]);
  return { players: parseBannedPlayersFile(players), ips: parseBannedIpsFile(ips) };
}

/**
 * Written in place with a plain `writeFile`, **not** temp-file + `rename`.
 *
 * `rename` would be the torn-write-proof way to do it, and it is the wrong choice here:
 * it replaces the inode, so the new file is owned by the web container's root instead of
 * the uid the game runs as, and the next time the game saves its own ban list it hits
 * EACCES. An in-place `O_TRUNC` write keeps the inode and therefore the owner and mode.
 *
 * The residual risk is accepted knowingly: a torn `banned-players.json` fails to parse
 * and the game starts with *no* bans — a fail-open. It is a sub-kilobyte single write, and
 * trading it for a file the game cannot rewrite would be the worse bug. Same call the
 * ops and whitelist routes make, for the same reason.
 */
async function writeBanFile(file: string, json: string): Promise<void> {
  await writeFile(file, json, "utf-8");
}

/**
 * One RCON `banlist`, parsed. `null` when the server could not be asked.
 *
 * **`sendCommandLong`, not `sendCommand`** — `banlist` enumerates, and one RCON packet
 * carries at most 4096 bytes of payload. `rcon-client` resolves on the first packet and
 * silently discards the rest; measured on this box against Project Zomboid's `showoptions`,
 * a 6,789-byte reply came back as 4,102 and the page showed 79 of 137 settings with no
 * error (see `src/lib/rcon-frame.ts`). A `banlist` line is a name, a source and a free-text
 * reason, so a few dozen bans clears that cliff — and the truncation lands exactly where it
 * does the most harm: this reply **is** the read-back that decides whether a ban is reported
 * as applied, so a ban that fell off the end reads as absent and a real ban gets reported as
 * having failed. Confirming a *pardon* from a truncated list is the same hazard with the
 * sign flipped, which is why `banlistProves` refuses a reply it cannot vouch for.
 */
async function readBanlist(kind: BanKind): Promise<BanlistReply | null> {
  try {
    return parseBanlist(
      await sendCommandLong(
        kind === "player" ? BANLIST_PLAYERS : BANLIST_IPS,
        BANLIST_RCON_TIMEOUT_MS
      )
    );
  } catch {
    return null;
  }
}

function fileTargets(kind: BanKind, files: BanFiles): string[] {
  return kind === "player"
    ? files.players.entries.map((e) => e.name)
    : files.ips.entries.map((e) => e.ip);
}

// ── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  /**
   * `settings.read`, unlike the ops and whitelist GETs which gate on world access alone.
   * A ban list carries IP addresses, and handing a read-only MEMBER every address that
   * has been banned from the box is a privileged read rather than a browse — the same
   * argument the key's own comment makes about `ServerPassword` in the 7DTD config.
   */
  if (!hasPermission(session.user.role, "settings.read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let files: BanFiles;
  try {
    files = await readBanFiles();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: `Couldn't read the ban files: ${msg}` }, { status: 500 });
  }

  /**
   * The configured-vs-live comparison, the same idea as the memory card: ask the server
   * what it is actually enforcing and report any disagreement with the files. That is the
   * only way "this ban is real" is something the page can show rather than something the
   * reader assumes.
   *
   * Probed **unconditionally**, not only when docker says the container is up: it is the
   * same signal `routeBanChange` routes on, so the `path` this GET predicts is the path the
   * POST will actually take — a prediction derived differently from the decision is a
   * prediction that will eventually contradict it. A stopped world refuses or fails to
   * resolve immediately, so the cost is two fast failures per page load rather than two
   * timeouts.
   *
   * **The two `banlist` reads are sequential, and that is not an oversight.** Every other RCON
   * call site in this repo issues one command at a time, and there are two reasons to keep that
   * true here rather than wrap them in a `Promise.all`.
   *
   * `rconCommandLong` opens its own socket per call and ends a reply by waiting for the server
   * to go quiet — there is no length field and no end marker, so "it stopped talking" is the
   * only signal available. Two of those in flight at once means the game is interleaving two
   * multi-packet replies while each side's quiet window is already running, which makes the one
   * heuristic the drain depends on depend on the other command's timing.
   *
   * And if either of these ever moves back to the cached socket, concurrency becomes actively
   * wrong rather than merely wasteful: `getRcon` has no in-flight dedupe, so two callers that
   * find no cached socket both connect and the loser is overwritten in the map and leaked, and
   * `rcon-client` is `maxPending: 1`, so the second command queues behind the first while its
   * own deadline is already counting down.
   */
  const running = await containerIsRunning("minecraft").catch(() => false);
  const livePlayers = await readBanlist("player");
  const liveIps = await readBanlist("ip");

  const drift = {
    players: livePlayers && banDrift(fileTargets("player", files), livePlayers),
    ips: liveIps && banDrift(fileTargets("ip", files), liveIps),
  };

  return NextResponse.json({
    // `withCreatedIso` because the settings page cannot import this module at runtime —
    // `mc-bans` reaches `mc-identity`, which pulls in `crypto` and `fs/promises`. The
    // browser gets a date it can format; the Java date format is parsed only here.
    players: withCreatedIso(files.players.entries),
    ips: withCreatedIso(files.ips.entries),
    // Surfaced rather than swallowed: a shorter list with no explanation reads as the
    // page losing an entry instead of the file having a problem.
    unreadable: { players: files.players.skipped, ips: files.ips.skipped },
    malformed: { players: files.players.malformed, ips: files.ips.malformed },
    running,
    /**
     * Where a change made right now would go — from the same function the mutation uses, on
     * the same two signals. The UI says it *before* the button, so it has to be the same
     * answer the button will produce.
     *
     * `rconAnswering` is "either read got a reply", not "the players read got a reply". Both
     * go to the same socket, so in practice they agree — but the mutation probes whichever
     * kind it was asked about, so predicting from only one of the two would make this page
     * contradict its own button for an IP ban in exactly the moment the player read happened
     * to fail. "Something answered" is the signal `routeBanChange` is actually about.
     */
    path: routeBanChange({
      containerRunning: running,
      rconAnswering: livePlayers !== null || liveIps !== null,
    }).path,
    /**
     * Three states per list, not two — see `liveReadState`. "Did not answer" and "answered
     * with something unreadable" need different sentences on the page, and collapsing them
     * is what made an unrecognised reply report every ban on disk as unenforced.
     */
    live: { players: liveReadState(livePlayers), ips: liveReadState(liveIps) },
    /**
     * `null` per list when there was nothing to compare against — no reply, or a reply whose
     * entries could not be told apart. The UI must not render either as "no drift", because
     * nothing was compared. Kept per kind rather than collapsed to one nullable pair: the
     * player list can be readable while the IP list is not, and that is a comparison worth
     * reporting for the half that worked.
     */
    drift,
  });
}

// ── The two mutations ───────────────────────────────────────────────────────

/**
 * Everything POST and DELETE share: the gates, the lane, target validation, the routing
 * decision, the read-back, and the response. Split out because the two handlers differ
 * only in which command they send and which way the read-back has to come out — and
 * because the power control in this repo drifted into three copies where two missed a
 * fix, which is the argument for not having a second near-identical handler.
 */
async function applyBanChange(
  action: "ban" | "pardon",
  input: { kind: unknown; target: unknown; reason?: unknown }
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files — the same three lines the
  // properties, ops and whitelist writers use. It matters on *both* paths: a restore
  // would overwrite a file written through it, and an RCON ban issued mid-restore talks
  // to a server that is about to be stopped and have its save replaced.
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const checked = checkBanTarget(input.kind, input.target);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const { kind, target } = checked;

  /**
   * Two signals, and the RCON one decides.
   *
   * A live RCON socket is proof the game is up; `containerIsRunning` is a report, and
   * `containerState` answers `"missing"` for any `docker inspect` failure — so routing on
   * docker alone can send a write to a file that a running game will overwrite.
   *
   * The reply itself is deliberately **not** kept as a "before" state. It would be the cheap
   * way to decide a no-op, and it would be the wrong one: it is read before the command and
   * the question is what is true after. `classifyBanReply` cross-checked against the
   * read-back is what answers that, and the probe's only job is "did anything answer".
   *
   * Concurrent here, unlike the two `banlist` reads in the GET, and for a reason rather than
   * by accident: these are two different subsystems — one forks `docker inspect`, the other
   * opens a socket — so neither queues behind the other and there is no shared client for
   * them to race on.
   */
  const [running, probe] = await Promise.all([
    containerIsRunning("minecraft").catch(() => false),
    readBanlist(kind),
  ]);
  const routing = routeBanChange({ containerRunning: running, rconAnswering: probe !== null });

  // Container up, game silent. The one tempting thing — write the file — is the write
  // that disappears, so this refuses and says so instead of falling back.
  if (routing.path === "refuse") {
    return NextResponse.json({ error: routing.error }, { status: 503 });
  }

  const result =
    routing.path === "rcon"
      ? await applyViaRcon(action, kind, target, input.reason, running)
      : await applyViaFile(action, kind, target, input.reason, session.user.name);

  if ("response" in result) return result.response;

  const outcome: BanOutcome = {
    action,
    kind,
    target,
    path: routing.path,
    verified: result.verified,
    contradicted: result.contradicted,
    noop: result.noop,
  };
  const message = banMessage(outcome);

  // Only a confirmed change is logged. `docs/OPERATIONS.md`: a caller that writes the
  // row regardless "reintroduces a log of things that did not happen".
  if (result.verified && !result.noop) {
    try {
      await db.activity.create({
        data: {
          userId: session.user.id,
          action: action === "ban" ? "ban_add" : "ban_remove",
          details: JSON.stringify({
            game: "minecraft",
            kind,
            target,
            via: routing.path,
            ...(action === "ban" ? { reason: sanitizeBanReason(input.reason) } : {}),
          }),
        },
      });
    } catch (e) {
      // The change already landed; failing the response would invite a retry that
      // double-bans. Log rather than swallow — "who banned me" is a question this log
      // has to answer.
      console.error("[mc-bans] activity log failed", e);
    }
  }

  let files: BanFiles | null = null;
  try {
    files = await readBanFiles();
  } catch {
    // The lists are a convenience for the page, not the outcome. A read failure here
    // must not turn a verified ban into an error.
  }

  const body = {
    ...outcome,
    message,
    why: routing.why,
    reply: result.reply ?? null,
    players: files ? withCreatedIso(files.players.entries) : null,
    ips: files ? withCreatedIso(files.ips.entries) : null,
  };

  /**
   * **Non-2xx for anything not confirmed**, on purpose. A 200 whose body carries
   * `verified: false` relies on every present and future caller remembering to read that
   * field, and "reports success after doing nothing" is this project's recurring defect.
   * A no-op is a 200: nothing changed, and that is the honest, intended answer.
   */
  if (!result.verified) {
    return NextResponse.json({ ...body, error: message }, { status: 500 });
  }
  return NextResponse.json({ ...body, success: true });
}

type ChangeResult =
  | { response: NextResponse }
  | { verified: boolean; contradicted?: boolean; noop?: boolean; reply?: string };

/** The running-server path: ask the game, then ask it what it now thinks. */
async function applyViaRcon(
  action: "ban" | "pardon",
  kind: BanKind,
  target: string,
  reason: unknown,
  containerRunning: boolean
): Promise<ChangeResult> {
  const command =
    action === "ban" ? banCommand(kind, target, reason) : pardonCommand(kind, target);

  let reply: string;
  try {
    reply = await sendCommand(command, BAN_RCON_TIMEOUT_MS);
  } catch (e) {
    /**
     * `classifyRconFailure` rather than one regex over the message, because the two failures
     * that land here mean opposite things and the first version of this route read them as
     * one. `ETIMEDOUT` as a socket `code` is the kernel abandoning the handshake — nothing
     * answered. The bare `"timeout"` that `rcon.ts` raises is the opposite: the handshake
     * succeeded and the game went quiet, so the server is demonstrably there.
     *
     * **This is why the sentence cannot claim the ban did not happen.** The probe answered a
     * moment ago, and a `no-reply` means only that the *reply* never arrived — the command
     * was written to a live socket and the server may well have executed it, which on this
     * path means the server has already rewritten `banned-players.json` itself. The first
     * version of this body asserted both "the ban was not applied" and "Nothing was written
     * to the ban files"; neither is established, and the second would be false in precisely
     * the case that matters. Say what is known: the outcome is unknown, and re-reading the
     * list is how to find out.
     *
     * Still a 503 and still no fall-back to the file, for the same reason as
     * `routeBanChange`'s refusal: whether the game is on its way down or already gone, it
     * may yet rewrite both files from the list it had.
     */
    const failure = classifyRconFailure(e);
    if (failure !== "game-error") {
      const detail = rconFailureMessage(failure, containerRunning, "The Minecraft server");
      return {
        response: NextResponse.json(
          {
            error:
              `${detail} It answered moments ago, so whether it applied the ${action} ` +
              `before going quiet is unknown — reload this page to see its current list ` +
              `rather than retrying blind.`,
          },
          { status: 503 }
        ),
      };
    }
    return {
      response: NextResponse.json(
        { error: `RCON error: ${e instanceof Error ? e.message : "connection failed"}` },
        { status: 500 }
      ),
    };
  }

  const verdict = classifyBanReply(reply);

  // Two replies are the server telling us the request itself was wrong, and they are the
  // user's to fix. Hand back the game's own words — a friendlier sentence here would hide
  // the only specific information available (e.g. `ban` cannot resolve a player the
  // server has never seen, which looks identical to a typo from the outside).
  if (verdict === "noSuchPlayer" || verdict === "invalidAddress") {
    return { response: NextResponse.json({ error: reply, reply }, { status: 400 }) };
  }

  const after = await readBanlist(kind);
  // No read-back means no claim. Deliberately not treated as "the reply said Banned, so
  // it worked": the reply is a translation string and this is the check that outranks it.
  if (!after) return { verified: false, reply };

  /**
   * `banlistProves`, not `banlistContains`, because *absence* only proves a pardon when
   * the reply was readable — see that function's comment. A reply the parser could not
   * vouch for answers `null` here, which has to stay "not confirmed" rather than silently
   * satisfying the pardon case.
   */
  const proved = banlistProves(action, after, target);
  if (proved === null) return { verified: false, reply };

  // "Already banned" / "wasn't banned" is a no-op, and only believable when the read-back
  // agrees with it. Checking the state as well as the reply means a renamed translation
  // string cannot turn a real failure into a comfortable "nothing changed".
  const noop = (verdict === "already" || verdict === "notBanned") && proved;

  return { verified: proved, contradicted: !proved, noop, reply };
}

/** The stopped-server path: edit the json the game loads at boot, then read it back. */
async function applyViaFile(
  action: "ban" | "pardon",
  kind: BanKind,
  target: string,
  reason: unknown,
  actor: string | null | undefined
): Promise<ChangeResult> {
  const file = kind === "player" ? PLAYERS_FILE : IPS_FILE;

  let files: BanFiles;
  try {
    files = await readBanFiles();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      response: NextResponse.json({ error: `Couldn't read ${path.basename(file)}: ${msg}` }, { status: 500 }),
    };
  }

  const parsed = kind === "player" ? files.players : files.ips;
  /**
   * Refuse rather than rebuild. A new list written from a file we could not parse would
   * replace every existing ban with the one being added — and the page would then
   * truthfully show that one ban, which is the destructive form of this project's defect
   * class.
   */
  if (parsed.malformed) {
    return {
      response: NextResponse.json(
        {
          error:
            `${path.basename(file)} isn't valid JSON, so it can't be edited safely — ` +
            `rewriting it would delete the bans already in it. Fix or remove the file first.`,
        },
        { status: 409 }
      ),
    };
  }

  const source = sanitizeBanSource(actor);

  let json: string;
  let changed: boolean;

  if (kind === "player") {
    let next: BannedPlayerEntry[];
    /**
     * The entries this write is answerable for — the one being added, and nothing else.
     *
     * Passing the whole list made one pre-existing entry the dashboard dislikes (an older
     * version's, or a hand-edited one, with a blank `uuid`) refuse *every* file-path edit,
     * including the pardon that would have removed it, and the 500 it answered named that
     * entry rather than the player the request was about. See `serializePlayerBans`.
     */
    let requires: BannedPlayerEntry[];
    if (action === "ban") {
      const entry = buildPlayerBan({ name: target, source, reason });
      /**
       * The uuid arrives blank and is resolved here — the same `resolveEntryUuids` the
       * ops and whitelist routes use, for the same measured reason: Minecraft matches by
       * UUID and discards an entry it cannot resolve. For a ban the consequence has the
       * sign flipped and is worse than for the whitelist: the page shows the ban and the
       * player keeps connecting. All-or-nothing, so a name that will not resolve refuses
       * the write instead of persisting a blank.
       */
      const withIds = await resolveEntryUuids([entry]);
      if (!withIds.ok) {
        return {
          response: NextResponse.json({ error: withIds.error }, { status: withIds.status }),
        };
      }
      const added = addPlayerBan(files.players.entries, withIds.entries[0]);
      next = added.list;
      changed = added.added;
      requires = [withIds.entries[0]];
    } else {
      const removed = removePlayerBan(files.players.entries, target);
      next = removed.list;
      changed = removed.removed > 0;
      // A pardon adds nothing, so there is nothing for this write to be answerable for.
      requires = [];
    }
    const ser = serializePlayerBans(next, requires);
    // The backstop for the blank-UUID bug. Reaching it means something above skipped the
    // resolution, which is a bug worth a refusal rather than a file the game ignores.
    if (!ser.ok) return { response: NextResponse.json({ error: ser.error }, { status: 500 }) };
    json = ser.json;
  } else {
    let next: BannedIpEntry[];
    let requires: BannedIpEntry[];
    if (action === "ban") {
      const entry = buildIpBan({ ip: target, source, reason });
      const added = addIpBan(files.ips.entries, entry);
      next = added.list;
      changed = added.added;
      requires = [entry];
    } else {
      const removed = removeIpBan(files.ips.entries, target);
      next = removed.list;
      changed = removed.removed > 0;
      requires = [];
    }
    const ser = serializeIpBans(next, requires);
    if (!ser.ok) return { response: NextResponse.json({ error: ser.error }, { status: 500 }) };
    json = ser.json;
  }

  // Nothing to write, so nothing is written — and the file's mtime does not move, which
  // keeps "the ban file was touched" meaning something.
  if (!changed) return { verified: true, noop: true };

  try {
    await writeBanFile(file, json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      response: NextResponse.json({ error: `Couldn't write ${path.basename(file)}: ${msg}` }, { status: 500 }),
    };
  }

  /**
   * Read it back off disk and check for the target, rather than trusting that `writeFile`
   * resolving means the bytes say what we meant. This also re-parses through the same
   * reader the GET uses, so a file this route somehow made unreadable is caught here
   * instead of at the next server start.
   */
  let after: BanFiles;
  try {
    after = await readBanFiles();
  } catch {
    return { verified: false };
  }

  /**
   * The same absence-asymmetry as the RCON read-back: an *unparseable* file yields zero
   * entries, and "the target is not among zero entries" would confirm a pardon against a
   * file the game cannot read either. A torn write is the one thing that could produce
   * that here — see `writeBanFile` on why the tear is accepted — so it must come out as
   * "not confirmed", not as success.
   */
  const reread = kind === "player" ? after.players : after.ips;
  if (reread.malformed) return { verified: false, contradicted: true };

  const present = fileTargets(kind, after).some(
    (t) => t.toLowerCase() === target.toLowerCase()
  );
  const wanted = action === "ban" ? present : !present;
  return { verified: wanted, contradicted: !wanted };
}

// ── POST / DELETE ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  return applyBanChange("ban", { kind: b.kind, target: b.target, reason: b.reason });
}

export async function DELETE(request: NextRequest) {
  // Query params rather than a body: DELETE-with-body is supported unevenly by clients,
  // and the other DELETE handlers here (`/api/zomboid/mods`, `/api/server/files`) already
  // read their target off the URL.
  const { searchParams } = new URL(request.url);
  return applyBanChange("pardon", {
    kind: searchParams.get("kind"),
    target: searchParams.get("target"),
  });
}
