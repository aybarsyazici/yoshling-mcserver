import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";

// The full sdtdserver.xml, exposed generically: read every <property>, keep its
// trailing comment as help text, and write back any subset the UI sends. This
// adapts automatically to whatever properties the server file actually has,
// rather than hardcoding the ~69 keys.
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || RUNTIME["7dtd"].dir, "sdtdserver.xml");

export interface SdtdProperty {
  name: string;
  value: string;
  help: string;
}

// Matches: <property name="X" value="Y"/>   <!-- help -->
const PROP_RE = /<property\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>(?:\s*<!--\s*([\s\S]*?)\s*-->)?/g;

function parseProperties(xml: string): SdtdProperty[] {
  const out: SdtdProperty[] = [];
  let m: RegExpExecArray | null;
  PROP_RE.lastIndex = 0;
  while ((m = PROP_RE.exec(xml)) !== null) {
    out.push({ name: m[1], value: m[2], help: (m[3] || "").replace(/\s+/g, " ").trim() });
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Sensitive keys the UI must not expose/allow-edit through the generic editor
// (telnet password is app-managed; changing it here would break control).
const LOCKED = new Set(["TelnetPassword", "TelnetPort", "TelnetEnabled", "AdminFileName", "UserDataFolder"]);

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

  const body = await request.json();
  const updates: Record<string, string> = body?.updates ?? {};
  const names = Object.keys(updates).filter((n) => !LOCKED.has(n));
  if (names.length === 0) {
    return NextResponse.json({ error: "No editable settings provided" }, { status: 400 });
  }

  let xml: string;
  try {
    xml = await readFile(XML_PATH, "utf-8");
  } catch {
    return NextResponse.json({ error: "Config file not found yet — start the server once first." }, { status: 400 });
  }

  const applied: string[] = [];
  for (const name of names) {
    const value = String(updates[name]);
    // Replace only the value of an existing property; leave the comment intact.
    const re = new RegExp(`(<property\\s+name="${name}"\\s+value=")[^"]*(")`);
    if (re.test(xml)) {
      xml = xml.replace(re, `$1${escapeXml(value)}$2`);
      applied.push(name);
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

  return NextResponse.json({ success: true, applied });
}
