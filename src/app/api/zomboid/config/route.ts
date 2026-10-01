import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { INFRA_KEYS, readIniProperties, reloadLiveOptions, updateIni } from "@/lib/zomboid";
import {
  CARD_OWNED_KEYS,
  canonicalKey,
  canonicalKeyIndex,
  restartKeysIn,
  type PzIniSaveReport,
} from "@/lib/zomboid-ini-contract";

// The whole server .ini, exposed generically: PZ ships a `#` comment above every
// key, so the file documents itself and the UI can render help text without us
// hardcoding the ~139 settings. Same request/response shape as the 7DTD "all
// settings" route, so both share one editor component.

// Keys the generic editor must not touch: the deployment's own settings (see
// INFRA_KEYS), plus the keys another card owns (see CARD_OWNED_KEYS) — editing one of
// those in two places lets one view silently clobber the other, and for `Map` it is
// worse than that: the next boot regenerates the line and deletes anything typed here.
const LOCKED = new Set<string>([...INFRA_KEYS, ...Object.keys(CARD_OWNED_KEYS)]);

export async function GET() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  // `LOCKED` (via INFRA_KEYS) hides `RCONPassword`, but not `Password` (the join
  // password) or `DiscordToken`. Both are empty on production today (checked
  // 2026-09-30) — so this is the leak *waiting* rather than the leak happening, and
  // it is the same one 7DTD's `ServerPassword` already had: world access was the
  // whole gate on a route that reads a secrets-bearing file, while
  // `/api/zomboid/files` refused the same file to the same user.
  if (!hasPermission(gate.session.user.role, "settings.read")) {
    // `config-panel.tsx` toasts `data.error` verbatim, so say why rather than
    // "Forbidden" — an unexplained 403 is how the power-button gate got reported.
    return NextResponse.json(
      { error: "These settings include the server password, so reading them needs the admin or moderator role." },
      { status: 403 }
    );
  }

  try {
    const properties = (await readIniProperties()).filter((p) => !LOCKED.has(p.name));
    return NextResponse.json({ properties });
  } catch {
    return NextResponse.json(
      {
        properties: [],
        warning:
          "The Project Zomboid config file isn't there yet — start the server once to generate it.",
      },
      { status: 200 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files. This write is sub-second and
  // needs no record of its own, but it does need the lane: a restore holds it for
  // minutes and would silently overwrite whatever was saved through it, while the page
  // toasted "Saved". Measured on production: this returned 200 in 17 ms mid-backup.
  const laneBusy = fileLaneBusy("zomboid");
  if (laneBusy) return laneBusy;

  const body = await request.json();
  const raw: Record<string, unknown> = body?.updates ?? {};

  // The file's own key set has to be read *before* anything is matched against it,
  // because it is what decides all three verdicts below. Without it the route could
  // only ask "is this name in LOCKED", and anything else was appended and called
  // applied.
  let fileKeys: string[];
  try {
    fileKeys = (await readIniProperties()).map((p) => p.name);
  } catch {
    return NextResponse.json(
      { error: "Config file not found yet — start the server once first." },
      { status: 400 }
    );
  }
  const canonical = canonicalKeyIndex(fileKeys);

  const updates: Record<string, string> = {};
  const locked: string[] = [];
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    // Resolve to the spelling the file uses first. A lowercase `rconpassword` or `mods`
    // used to miss `LOCKED` entirely, get appended as a brand-new line, and be reported
    // as applied — two lines for one setting, and the game reads the other one.
    const key = canonicalKey(canonical, name);
    if (key === undefined) {
      ignored.push(name);
      continue;
    }
    if (LOCKED.has(key)) {
      locked.push(key);
      continue;
    }
    updates[key] = String(value);
  }

  if (Object.keys(updates).length === 0) {
    // Name the owner rather than saying "not editable". `config-panel.tsx` toasts
    // `data.error` verbatim, and "Map is not editable" with no sequel is how someone
    // ends up hand-editing the .ini in the file browser instead of using the card that
    // is the only thing able to make the change survive a boot.
    const owners = Array.from(
      new Set(locked.map((k) => CARD_OWNED_KEYS[k]).filter((o): o is string => !!o))
    );
    const error =
      owners.length > 0
        ? `${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} managed on ${owners.join(" and ")}, not here.`
        : locked.length > 0
        ? `${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} this deployment's own setting${locked.length === 1 ? "" : "s"} and cannot be changed from the dashboard.`
        : "No editable settings provided";
    return NextResponse.json({ error, locked, ignored }, { status: 400 });
  }

  let applied: string[];
  try {
    // `append: false`: in the generic editor an unmatched key is a typo or a stale
    // field, never a key worth inventing. See `setIniValues` for why the default is the
    // other way round for the import and the mod/map writers.
    const result = await updateIni(updates, { append: false });
    applied = result.applied;
    ignored.push(...result.ignored);
  } catch {
    return NextResponse.json(
      { error: "Config file not found yet — start the server once first." },
      { status: 400 }
    );
  }

  // Most of the .ini does not need a boot, and the UI said it did for all of it.
  // Measured against the live server 2026-10-01: 144 keys in the file, 8 of them in
  // `RESTART_KEYS`. So ask the game to re-read the file, and only report "restart" for
  // the keys a reload genuinely cannot carry — changing `MaxPlayers` used to cost a
  // restart that kicked everyone off.
  const restartNeeded = restartKeysIn(applied);
  const reloadable = Object.fromEntries(
    Object.entries(updates).filter(([k]) => !restartNeeded.includes(k) && applied.includes(k))
  );
  const live =
    Object.keys(reloadable).length > 0 ? await reloadLiveOptions(reloadable) : null;

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "zomboid", file: "server.ini", count: applied.length }),
      },
    });
  } catch {}

  const report: PzIniSaveReport = { applied, ignored, locked, restartNeeded, live };
  return NextResponse.json({ success: true, ...report });
}
