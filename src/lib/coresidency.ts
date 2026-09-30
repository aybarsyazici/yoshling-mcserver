import { GAMES, GAME_LIST, otherGames, type GameId } from "./games";

/**
 * Two worlds running at once: detecting it, saying so, and refusing to add to it.
 *
 * ## Why this module exists
 *
 * Only one world fits on this box (16 GB), and `powerOn` is the only path that evicts.
 * Nothing anywhere *detected* co-residency or reported it. It has happened: on
 * 2026-09-26 7 Days to Die had been up two days when Project Zomboid was started on top
 * of it, and the box was 2.2 GB into swap when the state was found — by accident, rather
 * than by the dashboard whose whole subject is which world holds the box. (The first
 * draft of this said "two worlds ran for two days"; `docs/AUDIT-2026-09-28.md` records
 * "7DTD 2d, PZ 3h", so two days is one world's uptime and the overlap itself was ~3 h.
 * The argument for detection does not need the bigger number.) Forensics proved the cause was a hand-run `docker start`, not app code — which is
 * precisely the argument for detection over prevention alone. The app cannot stop every
 * cause; it can refuse to be silent about the state.
 *
 * ## Why it is a separate, dependency-free module
 *
 * Everything here is pure: snapshots and numbers in, decisions and sentences out. No
 * Docker, no `fs`, no React. That buys two things this repo has paid for the absence of.
 * It is testable without the box being up (`__tests__/coresidency.test.ts`), which is
 * the seam `docs/OPERATIONS.md` names as missing from `game-manager`'s eviction logic.
 * And it is importable from **both** sides — the client components that must report the
 * state and the server paths that must refuse to worsen it — so the two cannot drift
 * into disagreeing about the same box, which is exactly how the power control ended up
 * in three copies with two missing a fix.
 *
 * The sentences live here too, next to the arithmetic that justifies them. A copy string
 * assembled at the render site is a claim no test can reach.
 */

/** The only field of a world's status snapshot any of this needs. */
export interface WorldRunState {
  containerRunning?: boolean;
}

/** English list: "a", "a and b", "a, b and c". */
function names(games: GameId[]): string {
  const list = games.map((g) => GAMES[g].name);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** 4 → "4", 15.6 → "15.6". Avoids "12.0 GB" and "4.00 GB". */
function gb(n: number): string {
  return `${Math.round(n * 10) / 10}`;
}

/**
 * Which worlds have a container up, in `GAME_LIST` order.
 *
 * **`containerRunning`, not `status`.** A container that is up but not answering RCON or
 * telnet reports `status: "offline"` — that split is the whole of the `a7d76b8` fix — and
 * it is still holding its memory and its port bindings. Deriving co-residency from
 * `status` would under-report exactly the wedged case, which is the one you most want
 * named. A missing or partial snapshot yields `[]`: "nothing known" must never render as
 * a claim about the box.
 */
export function runningWorlds(
  games: Partial<Record<GameId, WorldRunState>> | null | undefined
): GameId[] {
  if (!games) return [];
  return GAME_LIST.filter((g) => games[g.id]?.containerRunning === true).map((g) => g.id);
}

export interface CoResidency {
  /** Every world whose container is up, in `GAME_LIST` order. */
  running: GameId[];
  /** True when more than one is up — the state this box cannot support. */
  coResident: boolean;
  /**
   * One plain sentence naming the worlds and the consequence, or `null` when there is
   * nothing to report. `null` rather than an empty string so a caller cannot render a
   * blank warning row and so `{message && …}` is the whole guard.
   */
  message: string | null;
}

/**
 * The predicate. Everything that reports co-residency goes through this, so the landing
 * page, a world's overview and its server tab cannot word the same fact three ways.
 */
export function coResidency(running: GameId[]): CoResidency {
  const ordered = GAME_LIST.filter((g) => running.includes(g.id)).map((g) => g.id);
  if (ordered.length < 2) {
    return { running: ordered, coResident: false, message: null };
  }
  return {
    running: ordered,
    coResident: true,
    // States the fact and the rule, and claims nothing about the *effect*.
    //
    // The first draft ended "so it is swapping". Reading it rendered for every
    // combination is what caught it: with 7 Days to Die involved there is no heap figure
    // to add up, so swapping is not something this function can know — and the 2026-09-26
    // incident having swapped is history, not a guarantee about the next occurrence. That
    // is the measurement-you-have-not-checked trap, in the one module written to stop the
    // app from being wrong about the box. `ramNote` says the memory consequence, and only
    // where the arithmetic supports it.
    message: `${names(ordered)} are running at the same time. The box only has room for one — stop all but one.`,
  };
}

export interface RamUse {
  /** Host total in GB, as the status endpoint reports it. `null` = unknown. */
  hostGb: number | null;
  /** Running worlds with a configured heap. */
  metered: GameId[];
  /** Running worlds with no heap setting at all, so their usage is real but unknown. */
  unmetered: GameId[];
  /** Sum of the configured heaps of `metered`. A floor when `incomplete`. */
  meteredGb: number;
  /** `meteredGb` as a percentage of `hostGb`, clamped to 0…100. 0 when host is unknown. */
  pct: number;
  /** True when something running has no heap figure, i.e. `meteredGb` is not the total. */
  incomplete: boolean;
  /**
   * True when the heaps we *can* add up already exceed the host total. Deliberately
   * decided from arithmetic alone, so it is never claimed on the strength of an
   * unmetered world we cannot measure.
   */
  overCommitted: boolean;
}

/**
 * What the running worlds actually add up to.
 *
 * Replaces `ram-budget.tsx`'s `activeGame ? memoryGb[activeGame] ?? 0 : 0`, which had
 * two defects that reinforced each other:
 *
 *  - **One world.** It read the singular `activeGame`, so the one element on the landing
 *    page whose job is making the box's limit legible could not show the over-commit
 *    that limit exists to prevent.
 *  - **`?? 0` for an unmetered world.** `memoryGb["7dtd"]` is `null` *by design* — 7 Days
 *    to Die is a Unity native server with no JVM and no heap setting — so the bar read
 *    **0 / 16 GB**, i.e. "box idle", for the entire time 7DTD was the world holding the
 *    box. An unknown is not a zero; this splits them.
 */
export function ramUse({
  running,
  memoryGb,
  hostGb,
}: {
  running: GameId[];
  memoryGb: Partial<Record<GameId, number | null>>;
  hostGb: number | null;
}): RamUse {
  const metered: GameId[] = [];
  const unmetered: GameId[] = [];
  let meteredGb = 0;
  for (const g of GAME_LIST.filter((m) => running.includes(m.id)).map((m) => m.id)) {
    const heap = memoryGb[g];
    if (typeof heap === "number" && heap > 0) {
      metered.push(g);
      meteredGb += heap;
    } else {
      unmetered.push(g);
    }
  }
  meteredGb = Math.round(meteredGb * 10) / 10;
  return {
    hostGb,
    metered,
    unmetered,
    meteredGb,
    pct: hostGb && hostGb > 0 ? Math.min(100, (meteredGb / hostGb) * 100) : 0,
    incomplete: unmetered.length > 0,
    overCommitted: hostGb != null && hostGb > 0 && meteredGb > hostGb,
  };
}

/**
 * The sentence under the RAM bar.
 *
 * Here rather than in the component so its three hard cases are pinned by tests: an
 * unmetered world must never be worded as a 0 GB allocation; two worlds must both be
 * named; and the over-commit must be said in words rather than left to a full bar, because
 * a bar at 100% looks the same as a bar at exactly full.
 */
export function ramNote(use: RamUse): string {
  const { metered, unmetered, meteredGb, hostGb, overCommitted } = use;
  const box = hostGb != null ? `the box's ${gb(hostGb)} GB` : "the box";

  if (metered.length === 0 && unmetered.length === 0) return "All servers are stopped.";

  const parts: string[] = [];
  if (metered.length > 0) {
    parts.push(
      `${names(metered)} ${metered.length > 1 ? "are" : "is"} allocated ` +
        `${gb(meteredGb)} GB of ${box}`
    );
  }
  if (unmetered.length > 0) {
    // Never "0 GB". 7 Days to Die has no heap setting to report, and saying so is the
    // honest version of the number the bar cannot draw.
    parts.push(
      `${names(unmetered)} ${unmetered.length > 1 ? "have" : "has"} no heap setting, so ` +
        `${unmetered.length > 1 ? "their" : "its"} usage is not metered here`
    );
  }

  let text = `${parts.join(", and ")}.`;
  if (metered.length + unmetered.length > 1) {
    // The over-commit is stated as arithmetic — "more than the box has" — not as a
    // predicted effect. "It is swapping" was the first draft and is a measurement this
    // function cannot take: `-Xmx` is a reservation, and whether the kernel swaps depends
    // on what the worlds actually touch. The 2026-09-26 incident did swap; that is one
    // observation, not a rule.
    text += overCommitted
      ? ` That is more heap than the box has. Only one server is meant to run — stop all but one.`
      : ` Only one server is meant to run — stop all but one.`;
  } else {
    text += " Starting another one stops it first.";
  }
  return text;
}

export interface Ceiling {
  /** The per-world cap the server reports (`maxGameGb()`), or `null` if unknown. */
  maxGb: number | null;
  /** The other worlds currently up, which the cap does not account for. */
  otherRunning: GameId[];
  /**
   * The cap with those worlds' heaps subtracted — or `null` when it cannot be worked
   * out, which is the case whenever an unmetered world is up. Never negative: a cap
   * below zero is not a figure to render, it is a reason to read `note`.
   */
  honestGb: number | null;
  /**
   * The cap and the assumption behind it, in one sentence — `null` only when the cap
   * itself is unknown, because a sentence about a number we do not have says nothing.
   *
   * Present even when nothing else is running, which is the point. "Say the assumption out
   * loud where a user can see it" is the whole of open item 3; a note that appears only
   * once the assumption is *already violated* leaves the ceiling looking unconditional for
   * the entire time it matters most — while someone decides how much heap to ask for.
   */
  note: string | null;
}

/**
 * The RAM ceiling, said honestly.
 *
 * `maxGameGb()` in `game-manager` is `/proc/meminfo` MemTotal minus `HOST_RESERVE_GB`
 * (2.5) — ~13 GB on this 15.62 GB box — and it **subtracts nothing for whatever else is
 * running**. That is documented in `CLAUDE.md` and was nowhere a user could see it, so
 * the memory card would offer Minecraft 13 GB while Project Zomboid held 12: an offer
 * the box cannot honour, made by the one control in this app whose configured-vs-live
 * comparison is otherwise the most trustworthy report here.
 *
 * An unmetered neighbour yields `honestGb: null` on purpose. Subtracting zero for 7 Days
 * to Die would claim the full 13 GB is free, which is the same "unknown read as zero"
 * mistake as the RAM bar's — and the mistake would be *worse* here, because this number
 * gates a JVM that will not start if it is wrong.
 */
export function perWorldCeiling({
  maxGb,
  forGame,
  running,
  memoryGb,
}: {
  maxGb: number | null;
  forGame: GameId;
  running: GameId[];
  memoryGb: Partial<Record<GameId, number | null>>;
}): Ceiling {
  const otherRunning = GAME_LIST.filter(
    (g) => g.id !== forGame && running.includes(g.id)
  ).map((g) => g.id);

  const unknown = otherRunning.filter((g) => typeof memoryGb[g] !== "number");
  const taken = otherRunning.reduce((sum, g) => sum + (memoryGb[g] ?? 0), 0);

  const honestGb =
    maxGb == null
      ? null
      : otherRunning.length === 0
      ? maxGb
      : unknown.length > 0
      ? null
      : Math.max(0, Math.round((maxGb - taken) * 10) / 10);

  // No note without a number: a sentence about a ceiling we could not read is noise.
  if (maxGb == null) return { maxGb, otherRunning, honestGb, note: null };

  // Deliberately not phrased as "this ceiling" / "this server".
  //
  // The first draft was, and rendering it on the landing page is what showed the problem:
  // `/home` has no "this server" — it shows all three — so the sentence pointed at
  // nothing. Naming the limit instead reads correctly wherever it is mounted, which is the
  // property that lets a per-world memory card use the same string.
  const up = `${names(otherRunning)} ${otherRunning.length > 1 ? "are" : "is"}`;
  const them = otherRunning.length > 1 ? "they are" : "it is";

  if (otherRunning.length === 0) {
    return {
      maxGb,
      otherRunning,
      honestGb,
      note:
        `Any one server can be given up to ${gb(maxGb)} GB — the box total less a reserve for ` +
        `the OS and this dashboard. That ceiling assumes it is the only server running; it ` +
        `does not subtract anything else that is up.`,
    };
  }

  const opening = `Any one server can be given up to ${gb(maxGb)} GB, and that assumes it is the only one running.`;
  // When every running neighbour is the unmetered one, "7 Days to Die is up, and 7 Days to
  // Die has no heap setting" — so say it once.
  const gap =
    unknown.length === otherRunning.length
      ? `${up} up and ${unknown.length > 1 ? "have" : "has"} no heap setting`
      : `${up} up, and ${names(unknown)} ${unknown.length > 1 ? "have" : "has"} no heap setting`;
  const note =
    unknown.length > 0
      ? `${opening} ${gap}, so how much of that is really free cannot be worked out until ` +
        `${them} stopped.`
      : `${opening} ${up} up holding ${gb(taken)} GB, ` +
        (honestGb && honestGb > 0
          ? `so only about ${gb(honestGb)} GB of that is really free until ${them} stopped.`
          : `so none of it is really free until ${them} stopped.`);

  return { maxGb, otherRunning, honestGb, note };
}

export interface StartAdmission {
  /**
   * `start` — nothing else is up, go ahead.
   * `evict` — save and stop `evict` first (what `powerOn` does).
   * `refuse` — do not start; `message` names what is already up.
   */
  decision: "start" | "evict" | "refuse";
  /** The worlds to stop first. Empty for `start` and for `refuse`. */
  evict: GameId[];
  /** The sentence to show, or `null` when there is nothing to say. */
  message: string | null;
}

/**
 * The one funnel every start path answers to: evict, or refuse and name what is up.
 *
 * `mayEvict` is the whole decision and the two kinds of caller want opposite things.
 *
 *  - **A power operation** (`powerOn`) passes `true`. The user pressed Power on having
 *    been shown a "Switch servers?" dialog naming the world that goes down; stopping it
 *    is the thing they asked for.
 *  - **A non-power operation passes `false`.** `/api/7dtd/update` recreates the container
 *    with `START_MODE=3` and `start: true`, so it boots 7 Days to Die. It holds
 *    `POWER_RESOURCES`, so nothing can interleave with it — but it never evicted, so
 *    running it while Project Zomboid was up put two worlds on the box and reported
 *    success. Quietly stopping someone's world in the middle of a "check for updates" is
 *    the wrong repair: that is a power action nobody consented to, and it would be the
 *    "did something destructive and said it succeeded" defect wearing a fix's clothes.
 *    Refusing, with the blocker named, is right.
 *
 * Note what is deliberately *not* co-residency: the requested world being up already.
 * That is a no-op, and both `powerOn` and `powerOff` answer it before admission
 * specifically so it holds no resources and pre-empts no in-flight backup.
 */
export function admitStart({
  game,
  running,
  mayEvict,
}: {
  game: GameId;
  running: GameId[];
  mayEvict: boolean;
}): StartAdmission {
  const others = GAME_LIST.filter((g) => g.id !== game && running.includes(g.id)).map((g) => g.id);
  if (others.length === 0) return { decision: "start", evict: [], message: null };

  if (mayEvict) {
    return {
      decision: "evict",
      evict: others,
      message: `${names(others)} ${others.length > 1 ? "are" : "is"} running and will be saved and stopped first.`,
    };
  }
  return {
    decision: "refuse",
    evict: [],
    message: refusal(game, others),
  };
}

/** The refusal sentence, shared by `admitStart` and the two throwing helpers. */
function refusal(game: GameId, others: GameId[], what = "This"): string {
  return (
    `${names(others)} ${others.length > 1 ? "are" : "is"} running, and the box only has room ` +
    `for one server. ${what} would start ${GAMES[game].name} on top of ` +
    `${others.length > 1 ? "them" : "it"}, so nothing was done — stop ` +
    `${names(others)} first, then try again.`
  );
}

/**
 * Thrown by the guards below so a route can answer 409 rather than 500. Named for the
 * state, not for the guard, because it is the state a user has to act on.
 */
export class CoResidencyError extends Error {
  readonly running: GameId[];
  constructor(message: string, running: GameId[]) {
    super(message);
    this.name = "CoResidencyError";
    this.running = running;
  }
}

/** `admitStart` with `mayEvict: false`, as a throw. Synchronous; takes a known set. */
export function assertSoleWorld({
  game,
  running,
  what,
}: {
  game: GameId;
  running: GameId[];
  /** How to name the caller in the message, e.g. "The update". Defaults to "This". */
  what?: string;
}): void {
  const others = GAME_LIST.filter((g) => g.id !== game && running.includes(g.id)).map((g) => g.id);
  if (others.length === 0) return;
  throw new CoResidencyError(refusal(game, others, what), others);
}

/**
 * The server-side guard: probe every *other* world and refuse if one is up.
 *
 * The probe is injected rather than imported so this stays testable with no Docker —
 * callers pass `containerIsRunning` from `game-manager`. A probe that *throws* counts as
 * not running: a `docker inspect` hiccup must not become a refusal, because the guard's
 * job is to catch a world that is observably up, and turning an unrelated Docker error
 * into "your update is blocked" would be a new way to report the wrong thing.
 *
 * The world being started is never probed. Whether *it* is up is the caller's own
 * business, and asking would make an ordinary "already running" look like co-residency.
 */
export async function refuseCoResidency(
  game: GameId,
  isRunning: (g: GameId) => Promise<boolean>,
  what?: string
): Promise<void> {
  const up: GameId[] = [];
  for (const other of otherGames(game)) {
    try {
      if (await isRunning(other)) up.push(other);
    } catch {
      /* not observably up; see the docstring */
    }
  }
  assertSoleWorld({ game, running: up, what });
}
