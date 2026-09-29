import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const OPS_FILE = path.join(MC_DIR, "ops.json");

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

/**
 * ops.json hands out in-game operator — level 4 is "/op anyone, /stop the server,
 * edit the world". This route used to `JSON.stringify` whatever JSON arrived, so
 * an object, a string, or entries with arbitrary extra fields all went straight
 * into a file the game parses at boot, and a malformed one costs the whole ops
 * list at the next start with no error anywhere the dashboard can see.
 *
 * So normalise to exactly the four fields Minecraft reads and reject the rest.
 * `level` is 1-4 (Minecraft's permission levels) and `name` must look like a Java
 * username — the game matches ops by those, so anything else is a typo that would
 * sit in the file silently granting nobody anything.
 */
function parseOps(body: unknown): { ops: OpEntry[] } | { error: string } {
  if (!Array.isArray(body)) return { error: "Expected an array of operators" };

  const ops: OpEntry[] = [];
  for (const [i, raw] of body.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `Operator ${i + 1} is not an object` };
    }
    const entry = raw as Record<string, unknown>;

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!/^\w{1,16}$/.test(name)) {
      return { error: `"${name}" is not a valid Minecraft username` };
    }

    const level = typeof entry.level === "number" ? entry.level : NaN;
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      return { error: `Operator ${name} needs a level between 1 and 4` };
    }

    if (entry.uuid !== undefined && typeof entry.uuid !== "string") {
      return { error: `Operator ${name} has a malformed uuid` };
    }

    ops.push({
      uuid: typeof entry.uuid === "string" ? entry.uuid.trim() : "",
      name,
      level,
      bypassesPlayerLimit: entry.bypassesPlayerLimit === true,
    });
  }
  return { ops };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  try {
    const content = await readFile(OPS_FILE, "utf-8");
    return NextResponse.json(JSON.parse(content));
  } catch (e: any) {
    if (e.code === "ENOENT") return NextResponse.json([]);
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

  const parsed = parseOps(await request.json());
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await writeFile(OPS_FILE, JSON.stringify(parsed.ops, null, 2), "utf-8");
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
          file: "ops.json",
          count: parsed.ops.length,
        }),
      },
    });
  } catch (e) {
    // The write already landed; log rather than fail the request, but don't let a
    // missing audit trail be silent — granting operator is exactly what forensics
    // needs to be able to look up later.
    console.error("[mc-ops] activity log failed", e);
  }

  return NextResponse.json({ success: true, count: parsed.ops.length });
}
