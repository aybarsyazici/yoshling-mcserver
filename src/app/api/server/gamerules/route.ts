import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { containerIsRunning } from "@/lib/game-manager";
import { classifyRconFailure, rconFailureMessage } from "@/lib/rcon-failure";
import { db } from "@/lib/db";
import {
  MC_GAME_RULE_LIST_COMMAND,
  assessGameRuleList,
  checkGameRuleValue,
  gameRuleCommand,
  inferGameRuleType,
  parseGameRuleList,
  parseGameRuleReply,
} from "@/lib/mc-gamerules";

/**
 * Minecraft's game rules, read and written over RCON.
 *
 * The table, the parsing and the value checks are all in `@/lib/mc-gamerules` — this file
 * is the transport and the permission gate and nothing else, for the same reason
 * `mc-properties.ts` exists: none of that logic was testable while it was private to a
 * route handler, and the settings page needs the same knowledge to label the rows.
 *
 * ## The ids come from the server, every time
 *
 * `help gamerule` first, then one query per id it named. That is not caution for its own
 * sake: 26.1 renamed every game rule (`keepInventory` answers `Incorrect argument` on
 * 26.1.2) and the rename was not mechanical (`enable-command-block` became
 * `command_blocks_work`), while 1.21.4 is still on the volume and still selectable. A
 * hardcoded id list would be right for at most one of the two builds and would fail by
 * rendering an empty panel, which looks like "no rules to show".
 *
 * It is also the write path's safety: the PUT refuses any rule the server did not just
 * list, so the only ids ever interpolated into a console command are ids the game printed.
 *
 * ## Two transports, and the list read needs the long one
 *
 * **`sendCommandLong` for `help gamerule`, `sendCommand` for everything else.** The list
 * reply is 5,082 bytes on 26.1.2 and one RCON packet carries 4096; `rcon-client` resolves on
 * the first packet and drops the rest, which was measured through this dashboard — the reply
 * arrived cut at exactly 4096 and a dozen rules went missing silently. A single
 * `gamerule <id>` answer is ~50 bytes and stays on the cached socket, which is the right
 * transport for it.
 *
 * `sendCommand` goes through `src/lib/rcon.ts`, which keeps **one cached authenticated
 * socket per target** — so ~58 sequential calls are ~58 round trips on one connection, not
 * 58 connections. Opening a connection per question is the documented trap here (it is why
 * `telnetSession()` exists for 7DTD), and the fix for it is already in the transport.
 * Sequential rather than parallel because the socket is shared and ordering a reply to the
 * question that produced it is the other documented RCON trap (`scripts/pz-rcon.sh`: a
 * naive client reads the auth reply as the first command's answer and every response is
 * shifted by one).
 *
 * ## Nothing here reports a short read as a complete one
 *
 * `assessGameRuleList` is the floor. The first version of this route answered **200 with one
 * rule and no warning** — the parser could not read the reply and the route presented the
 * result as the build's rule list. Every path that could produce a short or unverified
 * answer now says so: `assessGameRuleList` refuses an implausible list, `unread` names rules
 * that were listed but not read, a write re-reads and 502s on disagreement, and the PUT will
 * not call a rule unknown on the strength of a list it could not read.
 */

/**
 * Per-call window, and the total the GET may spend asking.
 *
 * **Neither number is a measurement of this deployment** — per-command RCON latency against
 * a live Minecraft server has not been timed here. They are a budget, chosen so the worst
 * case cannot reach the ten seconds at which `docs/OPERATIONS.md` requires an operation
 * record: a GET is a page load, and entering one in the ledger on every page load would make
 * the ledger useless.
 *
 * **The worst case is `LIST_TIMEOUT_MS + READ_BUDGET_MS + RCON_TIMEOUT_MS`**, and all three
 * terms are needed: the list read can burn its whole deadline, the per-rule loop can burn
 * its whole budget, and because the budget is checked *before* a query is issued, a query
 * starting one millisecond inside it still runs to its own timeout. 3000 + 4000 + 2000 =
 * 9000. The first version of this comment made the same claim over constants summing to
 * 13,000 — the bound was asserted rather than computed, which is the only reason it was
 * wrong. If you change one of these, redo the addition.
 *
 * The budget is spent, not assumed: a rule not reached inside it is reported in `unread`
 * rather than dropped, so a slow server produces a short list that says it is short instead
 * of a complete-looking list that is missing rows.
 *
 * `LIST_TIMEOUT_MS` is larger than the per-rule window because that read is a 5 KB
 * multi-packet drain with a quiet-period tail (see `rcon-long.ts`), not a 50-byte answer.
 */
const RCON_TIMEOUT_MS = 2000;
const LIST_TIMEOUT_MS = 3000;
// 3000 + 4000 + 2000 = 9000 ms worst case, which is the arithmetic the comment above
// claims and which these three numbers now actually satisfy. They were 5000 + 6000 +
// 2000 = 13,000, i.e. the comment asserted a bound its own constants broke — and the
// trailing 2000 is easy to miss, because the budget is checked *before* a query is
// issued, so a query starting at `deadline - 1` still runs its full timeout.
const READ_BUDGET_MS = 4000;

/**
 * A ceiling on how many rules one GET will query, so a datapack or mod that registers a
 * great many cannot turn a page load into a thousand RCON commands on the server thread.
 * The deployed 26.1.2 build has 58. Anything past this is reported in `unread`, same as a
 * rule the budget ran out on — the panel says the list is incomplete either way.
 */
const MAX_RULES = 200;

/**
 * Turn a thrown RCON error into a status and a sentence, through the shared classifier.
 *
 * `@/lib/rcon-failure` rather than a copy: it is the module that gets the `ETIMEDOUT`
 * subtlety right (as a socket `code` it means the handshake never completed, so nothing
 * answered; the bare message `"timeout"` that `rcon.ts` raises means the handshake succeeded
 * and the game went quiet) and it takes `containerRunning` so it can never tell someone to
 * press Power on for a container that is already running — a no-op that toasts success.
 *
 * One `docker inspect`, only on the failure path, so the happy path pays nothing for it.
 * `null` on failure rather than a guess: a message that said "powered off" because the docker
 * call broke would be the same false certainty this is here to remove.
 */
async function rconFailure(e: unknown): Promise<{ status: number; error: string }> {
  const failure = classifyRconFailure(e);
  if (failure === "game-error") {
    // An RCON error the game itself produced is information; hiding it behind a friendly
    // sentence is how a real fault becomes invisible.
    const msg = e instanceof Error ? e.message : "";
    return { status: 500, error: `RCON error: ${msg || "connection failed"}` };
  }
  const running = await containerIsRunning("minecraft").catch(() => null);
  // 503, not 500: nothing is broken, the server is simply not there to ask — or is there and
  // busy. Either way the command did not run and retrying is the right next move.
  return { status: 503, error: rconFailureMessage(failure, running, "Minecraft") };
}

export async function GET() {
  const gate = await gameGate("minecraft");
  if (!gate.ok) return gate.response;

  // World access and nothing more — the same gate `/api/server/properties`' GET uses.
  //
  // This asked for `settings.read` on a cost argument (one GET runs ~58 commands on
  // Minecraft's main thread). The argument is real but it bought the wrong thing: the Game
  // rules panel sits directly under the properties editor on `/minecraft/settings`, so a
  // MEMBER saw every other panel on that page render and this one alone show a red error box.
  // "One panel is broken for you" is a worse answer than either showing it or hiding the
  // page, and the neighbouring read is ungated, so this follows it.
  //
  // The cost is handled where cost belongs — `MAX_RULES` caps the command count and
  // `READ_BUDGET_MS` caps the wall time — rather than by a role check that also changed what
  // the page looked like. A game rule holds nothing credential-shaped either (unlike 7DTD's
  // `ServerPassword` or PZ's `DiscordToken`, which is what `settings.read` was added for).

  const { sendCommand, sendCommandLong } = await import("@/lib/rcon");

  let listReply: string;
  try {
    // The long read. `sendCommand` loses this reply's tail at 4096 bytes — see the header.
    listReply = await sendCommandLong(MC_GAME_RULE_LIST_COMMAND, LIST_TIMEOUT_MS);
  } catch (e) {
    const { status, error } = await rconFailure(e);
    return NextResponse.json({ error }, { status });
  }

  const discovered = parseGameRuleList(listReply);
  // The floor. A reply the parser could not read is reported as a reply the parser could not
  // read — with the parsed count, the reply's size and how often it says `gamerule` in the
  // message — and never as "this build has no game rules", which is a cause this route cannot
  // establish and which was false on the one occasion it was shown.
  const verdict = assessGameRuleList(discovered, listReply);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.error, discovered: discovered.length, replyLength: listReply.length },
      { status: 502 }
    );
  }

  const rules: { id: string; value: string }[] = [];
  const unread: string[] = [];
  // Seeded with the list read's own warning (a reply that landed on exactly one packet's
  // worth), so a truncated list cannot be reported as a complete one. `??=` below then keeps
  // the first warning rather than overwriting it.
  let warning: string | null = verdict.warning;
  const deadline = Date.now() + READ_BUDGET_MS;

  for (const [i, id] of discovered.entries()) {
    if (i >= MAX_RULES) {
      unread.push(id);
      warning ??=
        `This build lists ${discovered.length} game rules and this page reads at most ` +
        `${MAX_RULES} of them in one go.`;
      continue;
    }
    if (Date.now() >= deadline) {
      unread.push(id);
      warning ??=
        `Ran out of time reading the game rules after ${rules.length} of ${discovered.length}. ` +
        `Reload to read the rest.`;
      continue;
    }
    let reply: string;
    try {
      reply = await sendCommand(gameRuleCommand(id), RCON_TIMEOUT_MS);
    } catch (e) {
      // Stop on the first failure instead of retrying 57 more times: if the world went down
      // mid-read, every remaining call would burn its own timeout and the page would hang
      // for a minute and a half before saying anything.
      const { status, error } = await rconFailure(e);
      if (rules.length === 0) return NextResponse.json({ error }, { status });
      unread.push(...discovered.slice(i));
      warning = `Read ${rules.length} of ${discovered.length} game rules, then stopped: ${error}`;
      break;
    }
    const parsed = parseGameRuleReply(reply);
    // A rule the server listed but whose answer does not parse — an `Incorrect argument`,
    // or a reply shape this build changed. It is reported unread, never given a value: a
    // fabricated value here would render a switch in a position the world is not in.
    if (!parsed) unread.push(id);
    else rules.push({ id, value: parsed.value });
  }

  // Discovered rules but read none of them: an error, not an empty list. A 200 carrying
  // `rules: []` is indistinguishable from "this server has no game rules" to any client that
  // only checks `res.ok`, and every Minecraft build has them — so this is the route reporting
  // success for having done nothing, which is the one shape this codebase keeps producing.
  // Reachable two ways: the budget expiring before the first query, or every reply failing to
  // parse (a build whose reply wording changed).
  if (rules.length === 0) {
    return NextResponse.json(
      {
        error:
          `The server listed ${discovered.length} game rules but wouldn't report a value for ` +
          `any of them. ${warning ?? "Run \"gamerule pvp\" in the console to see the raw reply."}`,
        unread,
        discovered: discovered.length,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    rules,
    unread,
    discovered: discovered.length,
    ...(warning ? { warning } : {}),
  });
}

export async function PUT(request: NextRequest) {
  const gate = await gameGate("minecraft");
  if (!gate.ok) return gate.response;

  if (!hasPermission(gate.session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  /**
   * Same lane guard the seven other config writers take, for a reason that is specific
   * here: a game rule lives in `level.dat` and is persisted by a world save, so a write
   * landing during a hand-off, a stop or a restore is a write into a world that is about
   * to be replaced or is already flushing. The other half of it is that a power operation
   * declares every file lane, so this refuses with a 409 that explains itself instead of
   * an RCON error about a world that was shutting down.
   */
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const body = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected { rule, value }" }, { status: 400 });
  }
  const { rule, value } = body as { rule?: unknown; value?: unknown };
  if (typeof rule !== "string" || rule.trim() === "") {
    return NextResponse.json({ error: "Which game rule?" }, { status: 400 });
  }
  const id = rule.trim();

  const { sendCommand, sendCommandLong } = await import("@/lib/rcon");

  // 1. The rule has to be one this build has. This is both the correctness check (a rule
  //    26.1 renamed does not exist under its old name, and writing it would be a green
  //    toast over an `Incorrect argument`) and the injection guard: nothing reaches
  //    `gameRuleCommand` that the server did not itself print.
  let listReply: string;
  try {
    listReply = await sendCommandLong(MC_GAME_RULE_LIST_COMMAND, LIST_TIMEOUT_MS);
  } catch (e) {
    const { status, error } = await rconFailure(e);
    return NextResponse.json({ error }, { status });
  }
  const known = parseGameRuleList(listReply);

  // The list is the only evidence for "this build has no such rule", so a list that cannot
  // be trusted cannot support that conclusion. Checked BEFORE `known.includes(id)`: the
  // earlier version skipped this and answered 400 "this build has no game rule called
  // fall_damage" for a rule the server had listed 116 times, because the parser had read one
  // id out of the reply. Refusing here means the worst case is "we could not read the list",
  // which is true, instead of a confident claim about the rule.
  const verdict = assessGameRuleList(known, listReply);
  if (!verdict.ok) {
    return NextResponse.json(
      {
        error:
          `Nothing was written. ${verdict.error} Until that list reads correctly this ` +
          `dashboard can't tell whether ${id} is a rule on this build.`,
        discovered: known.length,
        replyLength: listReply.length,
      },
      { status: 502 }
    );
  }

  if (!known.includes(id)) {
    // Says what was read and names no cause. This used to add "Reload the page — 26.1
    // renamed the rules, so a tab opened before a version change lists the old names",
    // which is a specific explanation the route has no evidence for: the same 400 is what a
    // typo, a datapack that unloaded, and a misread list all produce. The list read above is
    // now verified, so the one fact this can state — the rule is not in the N the server just
    // listed — is true.
    return NextResponse.json(
      {
        error:
          `${id} is not one of the ${known.length} game rules this server just listed, so ` +
          `nothing was sent. Re-read the panel to see the list this build actually has.`,
        discovered: known.length,
      },
      { status: 400 }
    );
  }

  // 2. Read it first, to learn its type from the live value rather than from a table that
  //    could disagree with the running build.
  let before: { id: string; value: string } | null;
  try {
    before = parseGameRuleReply(await sendCommand(gameRuleCommand(id), RCON_TIMEOUT_MS));
  } catch (e) {
    const { status, error } = await rconFailure(e);
    return NextResponse.json({ error }, { status });
  }
  if (!before) {
    return NextResponse.json(
      { error: `${id} is listed by this server but would not report its current value.` },
      { status: 502 }
    );
  }

  const checked = checkGameRuleValue(value, inferGameRuleType(before.value));
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, value: before.value }, { status: 400 });
  }

  // 3. Write, then **re-read**. The write's own reply ("… is now set to: x") is the server
  //    echoing the command back and is not evidence that anything stuck, which is this
  //    project's whole recurring defect. A separate query is, so the value this route
  //    reports is always the one the fresh read produced — never the one that was typed.
  try {
    await sendCommand(gameRuleCommand(id, checked.value), RCON_TIMEOUT_MS);
  } catch (e) {
    const { status, error } = await rconFailure(e);
    return NextResponse.json({ error }, { status });
  }

  let after: { id: string; value: string } | null;
  try {
    after = parseGameRuleReply(await sendCommand(gameRuleCommand(id), RCON_TIMEOUT_MS));
  } catch (e) {
    // The write went out and the confirmation did not come back. `docs/OPERATIONS.md` has a
    // name for this state — `unverified` — and the point of having one is that "I did it and
    // could not check" is sayable instead of being rounded to success or to failure.
    const { status } = await rconFailure(e);
    return NextResponse.json(
      {
        error:
          `Sent ${id} = ${checked.value}, but couldn't read the value back to confirm it. ` +
          `Reload the page to see what the rule is actually set to.`,
        requested: checked.value,
      },
      { status }
    );
  }

  if (!after) {
    return NextResponse.json(
      {
        error:
          `Sent ${id} = ${checked.value}, but the server's reply to the follow-up query was ` +
          `unreadable, so this is unconfirmed. Check it in the console.`,
        requested: checked.value,
      },
      { status: 502 }
    );
  }

  if (after.value !== checked.value) {
    // The game accepted the command and the rule is not what was asked for. Reported as a
    // failure with both values rather than a 200 carrying `applied: false`, so a caller that
    // only checks `res.ok` still cannot read this as success.
    return NextResponse.json(
      {
        error: `${id} is still ${after.value} — the server did not take ${checked.value}.`,
        rule: id,
        requested: checked.value,
        value: after.value,
      },
      { status: 502 }
    );
  }

  const changed = before.value !== after.value;

  // Only when something changed. A row saying somebody "set the game rule X to false" when
  // it was already false is a false entry in the one log that is supposed to say what was
  // done to this box — and the toggles are idempotent, so re-pressing one was writing
  // history. The write still happened and the response still reports it; the log records
  // changes.
  if (changed) {
    try {
      await db.activity.create({
        data: {
          userId: gate.session.user.id,
          action: "set_gamerule",
          details: JSON.stringify({
            game: "minecraft",
            rule: id,
            value: after.value,
            from: before.value,
          }),
        },
      });
    } catch (e) {
      // The rule is already set; failing the response would invite a retry that changes
      // nothing. Same call as the properties route makes, for the same reason.
      console.error("[mc-gamerules] activity log failed", e);
    }
  }

  return NextResponse.json({
    success: true,
    rule: id,
    requested: checked.value,
    // The read-back, which is what the UI renders. `changed` distinguishes a real edit from
    // pressing a toggle that was already in that position, the way the version card's
    // `savedConfig` comparison does.
    value: after.value,
    previous: before.value,
    changed,
  });
}
