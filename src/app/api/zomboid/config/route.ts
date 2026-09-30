import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { INFRA_KEYS, readIniProperties, updateIni } from "@/lib/zomboid";

// The whole server .ini, exposed generically: PZ ships a `#` comment above every
// key, so the file documents itself and the UI can render help text without us
// hardcoding the ~139 settings. Same request/response shape as the 7DTD "all
// settings" route, so both share one editor component.

// Keys the generic editor must not touch: the deployment's own settings (see
// INFRA_KEYS), plus the two mod lists, which belong to the Mods page — editing
// them in two places would let one view silently clobber the other.
const LOCKED = new Set<string>([...INFRA_KEYS, "Mods", "WorkshopItems"]);

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
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (LOCKED.has(name)) continue;
    updates[name] = String(value);
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No editable settings provided" }, { status: 400 });
  }

  let applied: string[];
  try {
    applied = await updateIni(updates);
  } catch {
    return NextResponse.json(
      { error: "Config file not found yet — start the server once first." },
      { status: 400 }
    );
  }

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "zomboid", file: "server.ini", count: applied.length }),
      },
    });
  } catch {}

  return NextResponse.json({ success: true, applied });
}
