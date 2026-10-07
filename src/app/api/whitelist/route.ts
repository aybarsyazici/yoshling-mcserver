import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
// Same store the sign-in gate reads, so the page can't promise access it
// doesn't grant.
import { readWhitelist, saveWhitelist, WHITELIST_FILE } from "@/lib/whitelist";
import { hasPermission } from "@/lib/permissions";
import { discordIdList, discordUserId } from "@/lib/discord-identity";
import { db } from "@/lib/db";
import { runWhitelistWrite } from "@/lib/operations";
import { withFileRevision, withRevisionRead, FileRevisionConflictError } from "@/lib/file-revision";
import { conflictResponse, isConflict } from "@/lib/operation-response";

/**
 * Who may sign in at all is the same kind of authority as who gets which world,
 * so both are `users.manage` (ADMIN-only). This used to compare `role !== "ADMIN"`
 * by hand, which was correct but free to drift from `/whitelist`'s layout — and
 * the layout drifted: it let any signed-in user in and rendered this route's 403
 * as "No restrictions — anyone can sign in".
 */
function forbidden(role: "ADMIN" | "MOD" | "MEMBER"): boolean {
  return !hasPermission(role, "users.manage");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (forbidden(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return await withRevisionRead(async () => WHITELIST_FILE, async () => {
      const whitelist = await readWhitelist();
      // Never hand the page a list we aren't sure of: it PUTs back whatever it was
      // shown, so a stand-in would overwrite the real file on the next Save.
      if (whitelist.error) {
        console.error(`[whitelist] ${whitelist.error}`);
        return NextResponse.json({ error: `Couldn't read the whitelist: ${whitelist.error}` }, { status: 500 });
      }

      const known = await db.user.findMany({
        where: { discordId: { in: whitelist.users } }, select: { discordId: true, username: true },
      });
      return NextResponse.json({
        users: whitelist.users, source: whitelist.source,
        labels: Object.fromEntries(known.map(user => [user.discordId, user.username])),
        selfId: discordUserId(session.user.discordId),
      });
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof FileRevisionConflictError ? e.message : "The sign-in list could not be loaded." },
      { status: e instanceof FileRevisionConflictError ? 409 : 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (forbidden(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid whitelist request" }, { status: 400 });
  const { users, confirmEmpty, confirmSelfRemoval } = body as { users?: unknown; confirmEmpty?: unknown; confirmSelfRemoval?: unknown };

  if (!Array.isArray(users)) {
    return NextResponse.json({ error: "users must be an array" }, { status: 400 });
  }

  // IDs stay decimal strings: numeric coercion loses identity bits, and names
  // cannot identify invited accounts.
  const cleaned = discordIdList(users);
  if (!cleaned) {
    return NextResponse.json(
      { error: "Every entry must be a Discord user ID string. Usernames and display names do not identify invited accounts." },
      { status: 400 }
    );
  }
  const selfId = discordUserId(session.user.discordId);
  if (cleaned.length > 0 && selfId && !cleaned.includes(selfId) && confirmSelfRemoval !== true) {
    return NextResponse.json({ error: "This removes your Discord ID and ends your session. Confirm that another allowed admin can manage the list.", code: "confirm_self_removal" }, { status: 409 });
  }

  try {
    return await runWhitelistWrite(() => withFileRevision(request, async () => WHITELIST_FILE, async () => {

      // Clearing the list doesn't lock the door, it opens it (see `isWhitelisted`),
      // so it must never happen by accident. The page loads with a GET and then PUTs
      // back whatever it is holding, so before this guard one failed GET was enough
      // to replace six names with `[]` and let anyone with Discord sign in.
      if (cleaned.length === 0 && confirmEmpty !== true) {
        const current = await readWhitelist();
        if (current.error) return NextResponse.json({ error: "The current policy could not be verified; restore it before editing." }, { status: 500 });
        if (current.users.length > 0) {
          return NextResponse.json(
            {
              error: `Refusing to clear a whitelist that has ${current.users.length} ${
                current.users.length === 1 ? "entry" : "entries"
              } — an empty list lets anyone with a Discord account sign in. Send confirmEmpty to mean it.`,
              code: "confirm_empty",
              current: current.users.length,
            },
            { status: 409 }
          );
        }
      }

      await saveWhitelist(cleaned);

      return NextResponse.json({ success: true, users: cleaned });
    }));
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    if (e instanceof FileRevisionConflictError) return NextResponse.json({ error: e.message, stale: true }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The sign-in list could not be saved." }, { status: 500 });
  }
}
