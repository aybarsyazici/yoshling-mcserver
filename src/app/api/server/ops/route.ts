import { errorCode, errorMessage } from "@/lib/error-details";
import { readFileSnapshot, recordFileRevision, assertFileRevision } from "@/lib/file-revision";
import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { revisionRead } from "@/lib/operation-response";
import { withMinecraftProfileRead, withMinecraftProfileFileWrite } from "@/lib/minecraft-active-profile";
import { resolveEntryUuids } from "@/lib/mc-identity";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import { gameDataPath } from "@/lib/game-data-path";

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
 * username.
 *
 * This comment used to end "the game matches ops by those", meaning by name and
 * level. **It doesn't — it matches by UUID**, and that mistake is most of why the
 * blank-UUID bug survived: the file looked correct by the standard written here.
 * Measured on the box: an entry with `uuid: ""` was accepted by this route, and
 * after a restart the game had rewritten `ops.json` *without* it, while
 * `deop <name>` answered "Nothing changed. The player is not an operator". A
 * missing UUID is therefore filled in before the write (see the PUT), not merely
 * tolerated.
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

  return withMinecraftProfileRead(context => revisionRead(() => gameDataPath(context.root, "ops.json"), async () => {
    try {
      const content = await readFileSnapshot(await gameDataPath(context.root, "ops.json"), "utf-8");
      return NextResponse.json(JSON.parse(content));
    } catch (e) {
      if (errorCode(e) === "ENOENT") return NextResponse.json([]);
      return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
    }
  }));
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
  return withMinecraftProfileFileWrite(request, async context => {

    const parsed = parseOps(await request.json());
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Operator is granted by UUID. An entry with a blank one is discarded by the game
    // — verified: this route reported `count:3`, the game rewrote the file without the
    // new entry on its next start, and `deop` said the player was not an operator. So
    // resolve every missing UUID, and refuse the whole request rather than write a
    // file that hands out operator to nobody while reporting success.
    //
    // Entries that already carry a valid UUID are untouched, so the two real operators
    // keep the ids Minecraft itself wrote for them.
    const withIds = await resolveEntryUuids(parsed.ops, context.root);
    if (!withIds.ok) {
      return NextResponse.json({ error: withIds.error }, { status: withIds.status });
    }

    try {
      const file = await gameDataPath(context.root, "ops.json");
      const written = JSON.stringify(withIds.entries, null, 2);
      await assertFileRevision(file);
      assertFileWriteActive();
      await writeFile(file, written, "utf-8");
      recordFileRevision(file, written);
      if (await readFile(file, "utf-8") !== written) throw new Error("Minecraft player list readback failed");
    } catch (e) {
      return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
    }

    try {
      await db.activity.create({
        data: {
          userId: session.user.id,
          action: "edit_file",
          details: JSON.stringify({
            game: "minecraft",
            profileId: context.profileId,
            file: "ops.json",
            count: withIds.entries.length,
          }),
        },
      });
    } catch (e) {
      // The write already landed; log rather than fail the request, but don't let a
      // missing audit trail be silent — granting operator is exactly what forensics
      // needs to be able to look up later.
      console.error("[mc-ops] activity log failed", e);
    }

    return NextResponse.json({ success: true, count: withIds.entries.length });

  }, context => gameDataPath(context.root, "ops.json"));
}
