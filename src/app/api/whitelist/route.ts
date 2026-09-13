import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
// Same store the sign-in gate reads, so the page can't promise access it
// doesn't grant.
import { getWhitelist, saveWhitelist } from "@/lib/whitelist";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await getWhitelist();
  return NextResponse.json({ users });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { users } = await request.json();

  if (!Array.isArray(users)) {
    return NextResponse.json({ error: "users must be an array" }, { status: 400 });
  }

  const cleaned = users.map((u: string) => u.trim().toLowerCase()).filter(Boolean);
  await saveWhitelist(cleaned);

  return NextResponse.json({ success: true, users: cleaned });
}
