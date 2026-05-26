import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const PROPS_FILE = path.join(MC_DIR, "server.properties");

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const content = await readFile(PROPS_FILE, "utf-8");
    const properties: Record<string, string> = {};

    for (const line of content.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const [key, ...valueParts] = line.split("=");
      properties[key.trim()] = valueParts.join("=").trim();
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

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updates = await request.json();

  try {
    const content = await readFile(PROPS_FILE, "utf-8");
    const lines = content.split("\n");
    const updatedKeys = new Set<string>();

    const newLines = lines.map((line) => {
      if (line.startsWith("#") || !line.includes("=")) return line;
      const [key] = line.split("=");
      const trimmedKey = key.trim();
      if (trimmedKey in updates) {
        updatedKeys.add(trimmedKey);
        return `${trimmedKey}=${updates[trimmedKey]}`;
      }
      return line;
    });

    // Add any new keys that weren't in the file
    for (const [key, value] of Object.entries(updates)) {
      if (!updatedKeys.has(key)) {
        newLines.push(`${key}=${value}`);
      }
    }

    await writeFile(PROPS_FILE, newLines.join("\n"), "utf-8");
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
