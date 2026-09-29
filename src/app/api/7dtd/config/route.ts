import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";

// sdtdserver.xml lives in the ServerFiles mount. The docker image reads it on
// boot; we edit the curated subset of <property name=".." value=".."/> lines.
//
// The fallback is `/sevendtd-config`, matching the five other readers of this variable
// (`7dtd/reset`, `7dtd/world` ×2, `7dtd/files`, `7dtd/backups`). It used to fall back to
// `RUNTIME["7dtd"].dir`, which is `/sevendtd` — the **saves** volume, where there is no
// `sdtdserver.xml` at all (verified on the box 2026-09-29: `/sevendtd/sdtdserver.xml`
// does not exist, `/sevendtd-config/sdtdserver.xml` does). Latent only because
// SDTD_CONFIG_DIR happens to be set in production; without it every read here would
// ENOENT and the route would report "the server config file isn't present yet".
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || "/sevendtd-config", "sdtdserver.xml");

// Maps our friendly config keys → the sdtdserver.xml property names.
const XML_KEYS: Record<string, string> = {
  serverName: "ServerName",
  password: "ServerPassword",
  maxPlayers: "ServerMaxPlayerCount",
  gameDifficulty: "GameDifficulty",
  dayLength: "DayNightLength",
  sandboxCode: "SandboxCode",
};

// Field labels as the Settings page shows them, so a message about a setting
// that didn't land can name it the way the person reading it saw it.
const LABELS: Record<string, string> = {
  serverName: "Server name",
  password: "Password",
  maxPlayers: "Max players",
  gameDifficulty: "Difficulty",
  dayLength: "Day length",
  sandboxCode: "Sandbox code",
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

  // Refuse while an operation holds this world's files. This write is sub-second and
  // needs no record of its own, but it does need the lane: a restore holds it for
  // minutes and would silently overwrite whatever was saved through it, while the page
  // toasted "Saved". Measured on production: this returned 200 in 17 ms mid-backup.
  const laneBusy = fileLaneBusy("7dtd");
  if (laneBusy) return laneBusy;

  const body = await request.json();

  // The existing row, so a key the client omits keeps its stored value instead of
  // snapping back to `DEFAULTS`.
  //
  // This matters now that the Settings page no longer submits `gameDifficulty`,
  // `dayLength`, `version` or `maxMemory` (their controls were deleted — the two XML
  // properties do not exist on this server, and the other two are read by nothing).
  // With `?? DEFAULTS.x` as the only fallback, renaming the server would have quietly
  // reset the stored difficulty to 2 and the day length to 60 — and this row is the only
  // config that survives a fresh SteamCMD install, so that is the copy a recovery reads.
  // Silently rewriting the recovery source is exactly the defect class this is cleaning up.
  const existing = await db.sevenDaysConfig.findUnique({ where: { id: "main" } }).catch(() => null);
  const prev = { ...DEFAULTS, ...(existing ?? {}) };

  const data = {
    serverName: String(body.serverName ?? prev.serverName).slice(0, 80),
    password: String(body.password ?? prev.password),
    maxPlayers: clampInt(body.maxPlayers, 1, 16, prev.maxPlayers),
    gameDifficulty: clampInt(body.gameDifficulty, 1, 5, prev.gameDifficulty),
    dayLength: clampInt(body.dayLength, 10, 120, prev.dayLength),
    version: String(body.version ?? prev.version),
    maxMemory: String(body.maxMemory ?? prev.maxMemory),
    // Sandbox code is an encoded A-Z preset string; strip anything else.
    sandboxCode: String(body.sandboxCode ?? prev.sandboxCode)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4000),
  };

  await db.sevenDaysConfig.upsert({
    where: { id: "main" },
    update: data,
    create: { id: "main", ...data },
  });

  // Best-effort sync to the XML on disk (may not exist until first install).
  let xmlWarning: string | undefined;
  // Keys whose property this server's config doesn't have **and whose value this
  // request actually changed**. We store them in the DB regardless (that row is the
  // only thing that survives a fresh install), so without reporting them the page
  // toasts "Settings saved" for a value that changed nothing in-game. As of V3.3 b14
  // the live sdtdserver.xml has 69 properties and neither GameDifficulty nor
  // DayNightLength is among them — both moved into the sandbox preset, i.e. into
  // SandboxCode.
  //
  // The "actually changed" half is the fix. This used to report every missing property
  // on every PUT, so renaming the server raised an amber "Difficulty had no effect
  // in-game" warning about a field the user never touched — and this page's warning
  // toast is its *only* honesty channel, so firing it on every save trains people to
  // dismiss it unread. A warning nobody reads is worth less than no warning.
  const skipped: string[] = [];
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
      } else if (value !== String((prev as Record<string, unknown>)[key])) {
        skipped.push(xmlName);
      }
    }
    await writeFile(XML_PATH, xml, "utf-8");
    if (skipped.length > 0) {
      const named = skipped.map((x) => `${labelFor(x)} (${x})`).join(" or ");
      xmlWarning =
        `Saved, but the server config has no ${named} property, so ${skipped.length > 1 ? "those settings" : "that setting"} ` +
        `had no effect in-game. Current 7DTD versions fold them into the sandbox preset — set them in Sandbox code instead.`;
    }
  } catch (e) {
    xmlWarning =
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? "Saved. The server config file isn't present yet — settings will apply once 7DTD finishes its first install."
        : `Saved here, but writing the server config failed, so nothing changed on the server: ${(e as Error).message}`;
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

  // `skipped` is the honest part of "success": these keys reached the DB but not
  // the server. The page can drop the controls for them once it reads this.
  return NextResponse.json({ success: true, warning: xmlWarning, skipped });
}

function labelFor(xmlName: string): string {
  const key = Object.keys(XML_KEYS).find((k) => XML_KEYS[k] === xmlName);
  return (key && LABELS[key]) || xmlName;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(v), 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
