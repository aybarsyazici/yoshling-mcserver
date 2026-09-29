import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const PROPS_FILE = path.join(MC_DIR, "server.properties");

/**
 * Keys this editor must neither show nor write. 7DTD has the same set as `LOCKED`
 * and Project Zomboid as `INFRA_KEYS`; this is Minecraft's, and it exists for the
 * same two reasons.
 *
 * **Read:** the GET below is deliberately open to anyone with Minecraft access
 * (a MEMBER may browse settings), so every key it returns is a key every viewer
 * can read — and the page renders each one in a plain `<Input>`. Until this set
 * existed, `/minecraft/settings` printed the live RCON password
 * (`rcon.password`, verified present in the file on the box) into the browser of
 * anyone who could see the world.
 *
 * **Write:** `enable-rcon` / `rcon.password` / `rcon.port` are the dashboard's own
 * control channel, and it authenticates with `RCON_PASSWORD` from the container
 * env, so a value typed here can only ever *disagree* with the one in use — the
 * same trap already paid for with 7DTD's `TelnetPassword`. `server-port` is fixed
 * by the compose port mapping; moving it makes the server listen where nothing is
 * forwarded, which reads as "connect hangs, nothing in the logs".
 *
 * `level-name` is locked for a different reason: the backup route hardcodes the
 * `world/` directory (`tar -C /minecraft world`, `rm -rf /minecraft/world`).
 * Rename the level and backups quietly archive a directory the server no longer
 * writes, while a restore deletes nothing and unpacks over nothing — a backup
 * page that still looks like it works while protecting an empty folder.
 */
const LOCKED = new Set([
  "enable-rcon",
  "rcon.password",
  "rcon.port",
  "server-port",
  "level-name",
]);

/**
 * A newline in a value would end the line early and turn the rest into further
 * `key=value` pairs — which is how a locked key gets set through an unlocked one
 * (`motd=hi\nlevel-name=other`). Same guard as PZ's `sanitizeValue`.
 */
function sanitizeValue(v: unknown): string {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  try {
    const content = await readFile(PROPS_FILE, "utf-8");
    const properties: Record<string, string> = {};

    for (const line of content.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const [key, ...valueParts] = line.split("=");
      const name = key.trim();
      if (LOCKED.has(name)) continue;
      properties[name] = valueParts.join("=").trim();
    }

    return NextResponse.json(properties);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return NextResponse.json({});
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files. This write is sub-second and
  // needs no record of its own, but it does need the lane: a restore holds it for
  // minutes and would silently overwrite whatever was saved through it, while the page
  // toasted "Saved". Measured on production: this returned 200 in 17 ms mid-backup.
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const body = await request.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected an object of settings" }, { status: 400 });
  }

  // A Map, not an object: `"constructor" in {}` is true, so an object lookup would
  // treat inherited names as settings to write.
  const updates = new Map<string, string>();
  // Locked keys are collected, not just skipped. Dropping them silently meant a
  // PUT containing `rcon.password` answered `{success: true}` with the key in
  // neither `applied` nor `ignored` -- which is exactly what a browser tab opened
  // before this deploy will submit, since it still has the field on screen.
  const locked: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (LOCKED.has(key)) {
      locked.push(key);
      continue;
    }
    updates.set(key, sanitizeValue(value));
  }
  if (updates.size === 0) {
    return NextResponse.json({ error: "No editable settings provided" }, { status: 400 });
  }

  let content: string;
  try {
    content = await readFile(PROPS_FILE, "utf-8");
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return NextResponse.json(
        { error: "server.properties doesn't exist yet — start the server once first." },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  const applied: string[] = [];
  const newLines = content.split("\n").map((line) => {
    if (line.startsWith("#") || !line.includes("=")) return line;
    const trimmedKey = line.split("=")[0].trim();
    if (!updates.has(trimmedKey)) return line;
    applied.push(trimmedKey);
    return `${trimmedKey}=${updates.get(trimmedKey)}`;
  });

  // Update-only, never append: Minecraft generates the whole file, so every real
  // key is already in it and one that isn't is a typo or a crafted request. This
  // used to push unknown keys onto the end, where they were invisible to the UI
  // (the GET only reports what it can parse back) yet permanent on disk.
  const ignored = [...updates.keys()].filter((k) => !applied.includes(k));

  try {
    await writeFile(PROPS_FILE, newLines.join("\n"), "utf-8");
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({
          game: "minecraft",
          file: "server.properties",
          count: applied.length,
        }),
      },
    });
  } catch (e) {
    // The edit already landed; failing the response would invite a pointless
    // retry. Log it instead of swallowing — a missing audit trail should be
    // visible somewhere.
    console.error("[mc-properties] activity log failed", e);
  }

  return NextResponse.json({
    success: true,
    applied,
    ignored,
    locked,
    ...(locked.length > 0
      ? {
          warning:
            `${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} managed by the dashboard ` +
            `and cannot be edited here. Reload the page to see the current settings.`,
        }
      : {}),
  });
}
