import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
// Same store the sign-in gate reads, so the page can't promise access it
// doesn't grant.
import { readWhitelist, saveWhitelist } from "@/lib/whitelist";
import { hasPermission } from "@/lib/permissions";

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

  const whitelist = await readWhitelist();
  // Never hand the page a list we aren't sure of: it PUTs back whatever it was
  // shown, so a stand-in would overwrite the real file on the next Save.
  if (whitelist.error) {
    console.error(`[whitelist] ${whitelist.error}`);
    return NextResponse.json({ error: `Couldn't read the whitelist: ${whitelist.error}` }, { status: 500 });
  }

  return NextResponse.json({ users: whitelist.users, source: whitelist.source });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (forbidden(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { users, confirmEmpty } = await request.json();

  if (!Array.isArray(users)) {
    return NextResponse.json({ error: "users must be an array" }, { status: 400 });
  }

  // Reject non-strings rather than coercing: `String({})` is "[object Object]",
  // which would be saved as a real whitelist entry that can never match anyone and
  // is indistinguishable from a typo when someone later reads the list.
  const bad = users.filter((u: unknown) => typeof u !== "string");
  if (bad.length > 0) {
    return NextResponse.json(
      { error: `Every entry must be a name. Got ${bad.length} that ${bad.length === 1 ? "isn't" : "aren't"}.` },
      { status: 400 }
    );
  }
  const cleaned = users.map((u: string) => u.trim().toLowerCase()).filter(Boolean);

  // Clearing the list doesn't lock the door, it opens it (see `isWhitelisted`),
  // so it must never happen by accident. The page loads with a GET and then PUTs
  // back whatever it is holding, so before this guard one failed GET was enough
  // to replace six names with `[]` and let anyone with Discord sign in.
  if (cleaned.length === 0 && confirmEmpty !== true) {
    const current = await readWhitelist();
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
}
