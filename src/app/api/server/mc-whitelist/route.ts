import { errorCode, errorMessage } from "@/lib/error-details";
import { readFileSnapshot, recordFileRevision, assertFileRevision } from "@/lib/file-revision";
import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { withGameFileWrite, revisionRead } from "@/lib/operation-response";
import { resolveEntryUuids } from "@/lib/mc-identity";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import { gameDataPath } from "@/lib/game-data-path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";

interface WhitelistEntry {
  uuid: string;
  name: string;
}

/**
 * This is Minecraft's *in-game* whitelist (who may join the world), not the app
 * sign-in list at `/whitelist` — see CLAUDE.md, conflating the two was its own bug.
 *
 * Same reasoning as ops.json: the route used to write back whatever JSON arrived,
 * and the game parses this file at boot. If it can't, nobody gets in while
 * `white-list=true` — so validate the shape here rather than discover it as a
 * server full of people who can't join.
 *
 * A missing `uuid` is accepted *here* and filled in by `resolveEntryUuids` before
 * the write, because the page only knows the name. It is never persisted empty —
 * see the PUT.
 */
function parseWhitelist(body: unknown): { entries: WhitelistEntry[] } | { error: string } {
  if (!Array.isArray(body)) return { error: "Expected an array of players" };

  const entries: WhitelistEntry[] = [];
  for (const [i, raw] of body.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `Player ${i + 1} is not an object` };
    }
    const entry = raw as Record<string, unknown>;

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!/^\w{1,16}$/.test(name)) {
      return { error: `"${name}" is not a valid Minecraft username` };
    }
    if (entry.uuid !== undefined && typeof entry.uuid !== "string") {
      return { error: `Player ${name} has a malformed uuid` };
    }

    entries.push({ uuid: typeof entry.uuid === "string" ? entry.uuid.trim() : "", name });
  }
  return { entries };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  return revisionRead(() => gameDataPath(MC_DIR, "whitelist.json"), async () => {
    try {
      const content = await readFileSnapshot(await gameDataPath(MC_DIR, "whitelist.json"), "utf-8");
      return NextResponse.json(JSON.parse(content));
    } catch (e) {
      if (errorCode(e) === "ENOENT") return NextResponse.json([]);
      return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
    }
  });
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
  return withGameFileWrite("minecraft", async () => {

    const parsed = parseWhitelist(await request.json());
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Minecraft matches whitelist entries by UUID and discards any entry whose UUID
    // it cannot resolve. Verified on the box: this route answered
    // `{"success":true,"count":1}` for `{"uuid":"","name":"ZZUuidProbe"}` — which is
    // byte-for-byte what the settings page used to send — and the game then said
    // "There are no whitelisted players". So a blank UUID is a successful write of a
    // file that grants nobody anything, and enabling `white-list` after using this
    // page would have locked everyone out.
    //
    // Refuse the whole request rather than persist a blank for the one name that
    // wouldn't resolve: a partial write is the same silent-nothing failure, just
    // harder to notice.
    const withIds = await resolveEntryUuids(parsed.entries);
    if (!withIds.ok) {
      return NextResponse.json({ error: withIds.error }, { status: withIds.status });
    }

    try {
      const file = await gameDataPath(MC_DIR, "whitelist.json");
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
            file: "whitelist.json",
            count: withIds.entries.length,
          }),
        },
      });
    } catch (e) {
      // The write already landed; log rather than fail, but don't swallow — "who
      // removed me from the whitelist" is a question this log has to answer.
      console.error("[mc-whitelist] activity log failed", e);
    }

    return NextResponse.json({ success: true, count: withIds.entries.length });

  }, { request, file: () => gameDataPath(MC_DIR, "whitelist.json") });
}
