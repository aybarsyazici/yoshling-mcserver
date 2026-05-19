import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const WHITELIST_FILE = "/app/data/whitelist.json";

async function getWhitelist(): Promise<string[]> {
  try {
    const content = await readFile(WHITELIST_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    const envList = (process.env.ALLOWED_DISCORD_USERS || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    return envList;
  }
}

async function saveWhitelist(users: string[]): Promise<void> {
  await writeFile(WHITELIST_FILE, JSON.stringify(users, null, 2), "utf-8");
}

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
