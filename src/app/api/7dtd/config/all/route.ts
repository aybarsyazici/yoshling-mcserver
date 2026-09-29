import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { escapeXml, unescapeXml } from "@/lib/sdtd-xml";

// The full sdtdserver.xml, exposed generically: read every <property>, keep its
// trailing comment as help text, and write back any subset the UI sends. This
// adapts automatically to whatever properties the server file actually has,
// rather than hardcoding the ~69 keys.
//
// The fallback is `/sevendtd-config`, matching the five other readers of this variable.
// It used to fall back to `RUNTIME["7dtd"].dir`, which is `/sevendtd` — the **saves**
// volume, where there is no `sdtdserver.xml` at all (verified on the box 2026-09-29).
// Latent only because SDTD_CONFIG_DIR is set in production.
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || "/sevendtd-config", "sdtdserver.xml");

export interface SdtdProperty {
  name: string;
  value: string;
  help: string;
}

// Matches: <property name="X" value="Y"/>   <!-- help -->
const PROP_RE = /<property\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>(?:\s*<!--\s*([\s\S]*?)\s*-->)?/g;

/**
 * This route is the only one that *round-trips* values through the XML, and for months
 * it only did half of it: the PUT escaped on the way in, and this parser handed the raw
 * attribute text back out. So a value containing `& < > "` came back as `&amp;`/`&lt;`
 * and the next Save escaped it again -- entities doubling on every edit, measured on
 * disk. `unescapeXml` is the missing half. See `src/lib/sdtd-xml.ts` for the full
 * reproduction and why `&amp;` must be substituted last.
 *
 * `help` is deliberately *not* unescaped: it is comment text, not attribute text, so it
 * was never escaped on the way in and is never written back.
 */
function parseProperties(xml: string): SdtdProperty[] {
  const out: SdtdProperty[] = [];
  let m: RegExpExecArray | null;
  PROP_RE.lastIndex = 0;
  while ((m = PROP_RE.exec(xml)) !== null) {
    out.push({
      name: m[1],
      value: unescapeXml(m[2]),
      help: (m[3] || "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

// Sensitive keys the UI must not expose/allow-edit through the generic editor
// (telnet password is app-managed; changing it here would break control).
const LOCKED = new Set(["TelnetPassword", "TelnetPort", "TelnetEnabled", "AdminFileName", "UserDataFolder"]);

/**
 * Properties whose values become filesystem path segments elsewhere.
 *
 * `GameWorld` and `GameName` are joined into `Saves/<world>/<name>` and handed to
 * `tar` and `rm -rf` by `/api/7dtd/{reset,backups}`. Those routes now validate
 * defensively too, but this is the writer -- the one place that can stop a bad
 * value existing in the first place.
 */
const PATH_SEGMENT_KEYS = new Set(["GameWorld", "GameName"]);

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  try {
    const xml = await readFile(XML_PATH, "utf-8");
    const properties = parseProperties(xml).filter((p) => !LOCKED.has(p.name));
    return NextResponse.json({ properties });
  } catch {
    return NextResponse.json(
      { properties: [], warning: "The 7DTD config file isn't present yet — start the server once to generate it." },
      { status: 200 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files. This write is sub-second and
  // needs no record of its own, but it does need the lane: a restore holds it for
  // minutes and would silently overwrite whatever was saved through it, while the page
  // toasted "Saved". Measured on production: this returned 200 in 17 ms mid-backup.
  const laneBusy = fileLaneBusy("7dtd");
  if (laneBusy) return laneBusy;

  const body = await request.json();
  const updates: Record<string, string> = body?.updates ?? {};
  // A locked key used to be dropped with no mention in the response: `PUT
  // {"TelnetPassword":"x","ServerDescription":"y"}` answered
  // `{"success":true,"applied":["ServerDescription"]}`. That is the same silent-drop the
  // `ignored` array below was added to fix, so name them the same way. Not reachable from
  // the UI (locked keys are never rendered), but this endpoint is the API too.
  const locked = Object.keys(updates).filter((n) => LOCKED.has(n));
  const names = Object.keys(updates).filter((n) => !LOCKED.has(n));
  if (names.length === 0) {
    return NextResponse.json(
      { error: "No editable settings provided", locked },
      { status: 400 }
    );
  }

  let xml: string;
  try {
    xml = await readFile(XML_PATH, "utf-8");
  } catch {
    return NextResponse.json({ error: "Config file not found yet — start the server once first." }, { status: 400 });
  }

  // Reject bad values before writing, not after something downstream trips over
  // them. This editor is the *only* way `GameWorld` and `GameName` get set, and
  // they are consumed as filesystem path segments (`Saves/<world>/<name>`) and as
  // `tar`/`rm` arguments by the reset and backup routes. An empty `GameWorld`
  // collapses `Saves/<world>` to `Saves/` and a `..` climbs out of it, so the
  // damage lands two routes away from the mistake — which is exactly why it has to
  // be caught at the writer.
  const rejected: { name: string; why: string }[] = [];
  for (const name of names) {
    const value = String(updates[name]);
    if (PATH_SEGMENT_KEYS.has(name)) {
      const bad =
        value.trim() === ""
          ? "cannot be empty"
          : value === "." || value === ".."
          ? "cannot be a relative path"
          : /[/\\]/.test(value)
          ? "cannot contain a path separator"
          : /^\s|\s$/.test(value)
          ? "cannot start or end with a space"
          : null;
      if (bad) rejected.push({ name, why: `${name} ${bad}` });
    }
  }
  if (rejected.length > 0) {
    return NextResponse.json(
      { error: rejected.map((r) => r.why).join("; "), rejected: rejected.map((r) => r.name) },
      { status: 400 }
    );
  }

  const applied: string[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const value = String(updates[name]);
    // Replace only the value of an existing property; leave the comment intact.
    // `name` is escaped because it comes from the request body: a value like
    // `a.*b` would otherwise be a live pattern and could match a *different*
    // property's line.
    const re = new RegExp(`(<property\\s+name="${escapeRegExp(name)}"\\s+value=")[^"]*(")`);
    if (re.test(xml)) {
      xml = xml.replace(re, `$1${escapeXml(value)}$2`);
      applied.push(name);
    } else {
      // The property is not in this XML. Silently dropping it is how two of the
      // quick settings (GameDifficulty, DayNightLength) appeared to save for
      // months while doing nothing at all — the caller has to be told.
      ignored.push(name);
    }
  }

  try {
    await writeFile(XML_PATH, xml, "utf-8");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Keep the curated DB row in sync for the fields it mirrors.
  const map: Record<string, string> = {
    ServerName: "serverName",
    ServerPassword: "password",
    ServerMaxPlayerCount: "maxPlayers",
  };
  const dbData: Record<string, string | number> = {};
  for (const [xmlKey, col] of Object.entries(map)) {
    if (updates[xmlKey] !== undefined) {
      dbData[col] = col === "maxPlayers" ? parseInt(updates[xmlKey], 10) || 8 : updates[xmlKey];
    }
  }
  if (Object.keys(dbData).length > 0) {
    try {
      await db.sevenDaysConfig.upsert({ where: { id: "main" }, update: dbData, create: { id: "main", ...dbData } });
    } catch {}
  }

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "7dtd", file: "sdtdserver.xml", count: applied.length }),
      },
    });
  } catch {}

  return NextResponse.json({ success: true, applied, ignored, locked });
}
