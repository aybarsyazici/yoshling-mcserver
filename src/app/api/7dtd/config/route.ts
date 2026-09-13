import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";

// sdtdserver.xml lives in the ServerFiles mount. The docker image reads it on
// boot; we edit the curated subset of <property name=".." value=".."/> lines.
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || RUNTIME["7dtd"].dir, "sdtdserver.xml");

// Maps our friendly config keys → the sdtdserver.xml property names.
const XML_KEYS: Record<string, string> = {
  serverName: "ServerName",
  password: "ServerPassword",
  maxPlayers: "ServerMaxPlayerCount",
  gameDifficulty: "GameDifficulty",
  dayLength: "DayNightLength",
  sandboxCode: "SandboxCode",
};

const DEFAULTS = {
  serverName: "Yoshling 7DTD",
  password: "",
  maxPlayers: 8,
  gameDifficulty: 2,
  dayLength: 60,
  version: "stable",
  maxMemory: "5G",
  sandboxCode: "",
};

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  const config = await db.sevenDaysConfig.findUnique({ where: { id: "main" } });
  return NextResponse.json(config ?? { id: "main", ...DEFAULTS });
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
  const data = {
    serverName: String(body.serverName ?? DEFAULTS.serverName).slice(0, 80),
    password: String(body.password ?? ""),
    maxPlayers: clampInt(body.maxPlayers, 1, 16, DEFAULTS.maxPlayers),
    gameDifficulty: clampInt(body.gameDifficulty, 1, 5, DEFAULTS.gameDifficulty),
    dayLength: clampInt(body.dayLength, 10, 120, DEFAULTS.dayLength),
    version: String(body.version ?? DEFAULTS.version),
    maxMemory: String(body.maxMemory ?? DEFAULTS.maxMemory),
    // Sandbox code is an encoded A-Z preset string; strip anything else.
    sandboxCode: String(body.sandboxCode ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 4000),
  };

  await db.sevenDaysConfig.upsert({
    where: { id: "main" },
    update: data,
    create: { id: "main", ...data },
  });

  // Best-effort sync to the XML on disk (may not exist until first install).
  let xmlWarning: string | undefined;
  try {
    let xml = await readFile(XML_PATH, "utf-8");
    for (const [key, xmlName] of Object.entries(XML_KEYS)) {
      const value = String((data as Record<string, unknown>)[key]);
      const re = new RegExp(
        `(<property\\s+name="${xmlName}"\\s+value=")[^"]*(")`,
        "i"
      );
      if (re.test(xml)) {
        xml = xml.replace(re, `$1${escapeXml(value)}$2`);
      }
    }
    await writeFile(XML_PATH, xml, "utf-8");
  } catch {
    xmlWarning =
      "Saved. The server config file isn't present yet — settings will apply once 7DTD finishes its first install.";
  }

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "7dtd", file: "sdtdserver.xml" }),
      },
    });
  } catch {}

  return NextResponse.json({ success: true, warning: xmlWarning });
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(v), 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
