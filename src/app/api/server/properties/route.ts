import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import {
  escapeMcValue,
  gameRuleReplacing,
  isLockedMcProperty,
  sanitizeMcValue,
  unescapeMcValue,
} from "@/lib/mc-properties";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const PROPS_FILE = path.join(MC_DIR, "server.properties");

/**
 * The lock set, the escaping and the "this key moved to a game rule" table all live in
 * `@/lib/mc-properties` rather than here, for two reasons: the settings page needs the
 * same knowledge to label the fields (and a second copy of it would be the thing that
 * drifts), and none of it was testable while it was private to a route handler.
 */

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
      if (isLockedMcProperty(name)) continue;
      // Unescaped on the way out, re-escaped on the way in (see `unescapeMcValue`).
      // The file holds `level-type=minecraft\:normal`, measured on the box, which never
      // matched the dropdown's `minecraft:normal` — so the select rendered empty on every
      // load and picking any entry silently changed the world type.
      properties[name] = unescapeMcValue(valueParts.join("=").trim());
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

  // The version the dashboard believes is configured, which decides whether the four
  // game-rule keys below are inert. Read per request (one indexed lookup) rather than
  // hardcoded: 1.21.4 is still on the volume and still selectable, and on 1.21.4 those
  // four properties do work.
  const configured = await db.serverConfig
    .findUnique({ where: { id: "main" }, select: { mcVersion: true } })
    .catch(() => null);

  // A Map, not an object: `"constructor" in {}` is true, so an object lookup would
  // treat inherited names as settings to write.
  const updates = new Map<string, string>();
  // Locked keys are collected, not just skipped. Dropping them silently meant a
  // PUT containing `rcon.password` answered `{success: true}` with the key in
  // neither `applied` nor `ignored` -- which is exactly what a browser tab opened
  // before this deploy will submit, since it still has the field on screen.
  const locked: string[] = [];
  // Keys this Minecraft version does not read any more. Writing them is the project's
  // defect class in miniature — flip PVP off, get a green toast, PVP stays on forever —
  // so they are refused and the game rule that replaced each one is named back to the
  // caller. The page renders them read-only, so reaching here means a stale tab or a
  // direct request; both deserve the real answer rather than a silent drop.
  const noEffect: { key: string; gameRule: string }[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (isLockedMcProperty(key)) {
      locked.push(key);
      continue;
    }
    const gameRule = gameRuleReplacing(key, configured?.mcVersion);
    if (gameRule) {
      noEffect.push({ key, gameRule });
      continue;
    }
    updates.set(key, escapeMcValue(sanitizeMcValue(value)));
  }

  const gameRuleWarning =
    noEffect.length > 0
      ? `Minecraft ${configured?.mcVersion} doesn't read ` +
        `${noEffect.map((n) => n.key).join(", ")} from server.properties any more — ` +
        `${noEffect.length === 1 ? "it is" : "they are"} now the game ` +
        `${noEffect.length === 1 ? "rule" : "rules"} ` +
        `${noEffect.map((n) => n.gameRule).join(", ")}. Set ` +
        `${noEffect.length === 1 ? "it" : "them"} from the console, e.g. ` +
        `"gamerule ${noEffect[0].gameRule} false". Nothing was written for ` +
        `${noEffect.length === 1 ? "that key" : "those keys"}.`
      : null;

  if (updates.size === 0) {
    // Answering "No editable settings provided" for a PUT that contained only the four
    // game-rule keys would be true and useless. Say which keys, and where they went.
    return NextResponse.json(
      { error: gameRuleWarning ?? "No editable settings provided", noEffect, locked },
      { status: 400 }
    );
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
    noEffect,
    ...(locked.length > 0 || gameRuleWarning
      ? {
          warning: [
            locked.length > 0
              ? `${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} managed by the ` +
                `dashboard and cannot be edited here. Reload the page to see the current settings.`
              : null,
            gameRuleWarning,
          ]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
  });
}
