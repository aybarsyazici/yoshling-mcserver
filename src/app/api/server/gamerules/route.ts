import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { classifyRconFailure, rconFailureResponse } from "@/lib/rcon-reachability";
import { db } from "@/lib/db";
import {
  MC_GAME_RULE_LIST_COMMAND,
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
 * ## One connection, N round trips
 *
 * `sendCommand` goes through `src/lib/rcon.ts`, which keeps **one cached authenticated
 * socket per target** — so ~50 sequential calls are ~50 round trips on one connection, not
 * 50 connections. Opening a connection per question is the documented trap here (it is why
 * `telnetSession()` exists for 7DTD), and the fix for it is already in the transport.
 * Sequential rather than parallel because the socket is shared and ordering a reply to the
 * question that produced it is the other documented RCON trap (`scripts/pz-rcon.sh`: a
 * naive client reads the auth reply as the first command's answer and every response is
 * shifted by one).
 */

/**
 * Per-call window, and the total the GET may spend asking.
 *
 * **Neither number is a measurement of this deployment** — nothing in this change talked to
 * the box, and per-command RCON latency against a live Minecraft server has not been timed
 * here. They are a budget, chosen so the worst case cannot reach the ten seconds at which
 * `docs/OPERATIONS.md` requires an operation record: a GET is a page load, and entering one
 * in the ledger on every page load would make the ledger useless.
 *
 * The budget is spent, not assumed: a rule not reached inside it is reported in `unread`
 * rather than dropped, so a slow server produces a short list that says it is short instead
 * of a complete-looking list that is missing rows.
 */
const RCON_TIMEOUT_MS = 2000;
const READ_BUDGET_MS = 6000;

/**
 * A ceiling on how many rules one GET will query, so a datapack or mod that registers a
 * great many cannot turn a page load into a thousand RCON commands on the server thread.
 * Vanilla is around 50. Anything past this is reported in `unread`, same as a rule the
 * budget ran out on — the panel says the list is incomplete either way.
 */
const MAX_RULES = 200;

export async function GET() {
  const gate = await gameGate("minecraft");
  if (!gate.ok) return gate.response;

  /**
   * `settings.read`, not world access alone, and the reason is cost rather than secrecy:
   * a game rule holds nothing credential-shaped (unlike 7DTD's `ServerPassword` or PZ's
   * `DiscordToken`, which is what that key was added for), but one GET runs ~50 commands
   * on Minecraft's main thread. That is not a load a read-only MEMBER should be able to
   * impose by refreshing, and this panel is an operator control in any case. The UI shows
   * the refusal rather than an empty panel — a blank panel reads as "this server has no
   * game rules", which is the failure `zomboid-quick-settings.tsx` records.
   */
  if (!hasPermission(gate.session.user.role, "settings.read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sendCommand } = await import("@/lib/rcon");

  let listReply: string;
  try {
    listReply = await sendCommand(MC_GAME_RULE_LIST_COMMAND, RCON_TIMEOUT_MS);
  } catch (e) {
    const { status, error } = rconFailureResponse(
      classifyRconFailure(e),
      "Minecraft",
      e instanceof Error ? e.message : ""
    );
    return NextResponse.json({ error }, { status });
  }

  const discovered = parseGameRuleList(listReply);
  if (discovered.length === 0) {
    // Answered, but with nothing this parser recognised. Not dressed up as "no game rules":
    // every Minecraft build has them, so an empty list means the reply was not what we
    // expected and the honest report is that we could not read it.
    return NextResponse.json(
      {
        error:
          `The server answered "${MC_GAME_RULE_LIST_COMMAND}" but listed no game rules this ` +
          `dashboard could read. Run it in the console to see the raw reply.`,
      },
      { status: 502 }
    );
  }

  const rules: { id: string; value: string }[] = [];
  const unread: string[] = [];
  let warning: string | null = null;
  const deadline = Date.now() + READ_BUDGET_MS;

  for (const [i, id] of discovered.entries()) {
    if (i >= MAX_RULES) {
      unread.push(id);
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
      // Stop on the first failure instead of retrying 48 more times: if the world went down
      // mid-read, every remaining call would burn its own timeout and the page would hang
      // for a minute and a half before saying anything.
      const kind = classifyRconFailure(e);
      const { status, error } = rconFailureResponse(
        kind,
        "Minecraft",
        e instanceof Error ? e.message : ""
      );
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

  const { sendCommand } = await import("@/lib/rcon");

  const fail = (e: unknown) => {
    const { status, error } = rconFailureResponse(
      classifyRconFailure(e),
      "Minecraft",
      e instanceof Error ? e.message : ""
    );
    return NextResponse.json({ error }, { status });
  };

  // 1. The rule has to be one this build has. This is both the correctness check (a rule
  //    26.1 renamed does not exist under its old name, and writing it would be a green
  //    toast over an `Incorrect argument`) and the injection guard: nothing reaches
  //    `gameRuleCommand` that the server did not itself print.
  let known: string[];
  try {
    known = parseGameRuleList(await sendCommand(MC_GAME_RULE_LIST_COMMAND, RCON_TIMEOUT_MS));
  } catch (e) {
    return fail(e);
  }
  if (!known.includes(id)) {
    return NextResponse.json(
      {
        error:
          `This Minecraft build has no game rule called ${id}. Reload the page — 26.1 renamed ` +
          `the rules, so a tab opened before a version change lists the old names.`,
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
    return fail(e);
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
    return fail(e);
  }

  let after: { id: string; value: string } | null;
  try {
    after = parseGameRuleReply(await sendCommand(gameRuleCommand(id), RCON_TIMEOUT_MS));
  } catch (e) {
    // The write went out and the confirmation did not come back. `docs/OPERATIONS.md` has a
    // name for this state — `unverified` — and the point of having one is that "I did it and
    // could not check" is sayable instead of being rounded to success or to failure.
    const { status } = rconFailureResponse(classifyRconFailure(e), "Minecraft", "");
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

  return NextResponse.json({
    success: true,
    rule: id,
    requested: checked.value,
    // The read-back, which is what the UI renders. `changed` distinguishes a real edit from
    // pressing a toggle that was already in that position, the way the version card's
    // `savedConfig` comparison does.
    value: after.value,
    previous: before.value,
    changed: before.value !== after.value,
  });
}
